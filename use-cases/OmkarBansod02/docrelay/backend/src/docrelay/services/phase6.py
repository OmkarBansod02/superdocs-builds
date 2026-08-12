import hashlib
import inspect
import json
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any, cast
from uuid import UUID

from pydantic import BaseModel, ConfigDict, JsonValue, ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from docrelay.domain.effects import require_effect_transition
from docrelay.domain.enums import (
    BackupStatus,
    ChangeDecision,
    ConflictChoice,
    EffectOutcome,
    EffectType,
    ProposalOperation,
    Provider,
    ReviewRoundResolution,
    SuperDocsJobStatus,
    SyncRunState,
    VerificationStatus,
    WriteAuthorizationState,
)
from docrelay.domain.state_machine import require_transition
from docrelay.domain.write_plan import GoogleDocsBatchUpdate, SealedWritePlan
from docrelay.integrations.google.canonical import sha256_json
from docrelay.integrations.google.contracts import (
    CommitClassification,
    CurrentGoogleDocument,
    Phase6GooglePort,
)
from docrelay.integrations.google.errors import GoogleIntegrationError
from docrelay.integrations.google.read_only import GOOGLE_DOC_MIME
from docrelay.integrations.google.write_back import GoogleEffectOutcomeUnknown
from docrelay.mapping.production import SealedMappingProof, write_plan_identity
from docrelay.persistence.models import (
    Backup,
    CloudConnection,
    CloudDocument,
    ExternalEffect,
    MappingProof,
    ProposedChange,
    ReviewDecision,
    ReviewRound,
    RunTransition,
    SourceSnapshot,
    SuperDocsDocument,
    SuperDocsExport,
    SuperDocsJob,
    SuperDocsSession,
    SyncRun,
    VerificationResult,
    WatchedItem,
    WatchRunLink,
    WriteConflict,
    WritePlan,
    WritePlanLineage,
)
from docrelay.services.phase3 import RunNotFound

EFFECT_LEASE = timedelta(minutes=15)


class Phase6Error(RuntimeError):
    code = "PHASE6_ERROR"

    def __init__(self, message: str) -> None:
        self.safe_message = message
        super().__init__(message)


class WriteBackNotEligible(Phase6Error):
    code = "WRITE_BACK_NOT_ELIGIBLE"


class ExactFileWriteAuthorizationRequired(Phase6Error):
    code = "EXACT_FILE_WRITE_AUTHORIZATION_REQUIRED"


class WatchedFileOutOfScope(Phase6Error):
    code = "WATCHED_FILE_OUT_OF_SCOPE"


class ConflictDecisionInvalid(Phase6Error):
    code = "CONFLICT_DECISION_INVALID"


class WriteBackStatus(StrEnum):
    READY = "READY"
    IN_PROGRESS = "IN_PROGRESS"
    WRITE_VERIFIED = "WRITE_VERIFIED"
    CONFLICT = "CONFLICT"
    ATTENTION = "ATTENTION"
    VERIFICATION_FAILED = "VERIFICATION_FAILED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    REVIEW_LATEST = "REVIEW_LATEST"


class _Phase6Model(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ConflictView(_Phase6Model):
    baseline_revision_id: str
    latest_revision_id: str | None
    detection_stage: str
    detected_at: datetime
    backup_created: bool
    decision: ConflictChoice | None


class WriteBackView(_Phase6Model):
    run_id: UUID
    status: WriteBackStatus
    write_plan_id: UUID
    write_plan_sha256: str
    backup_created: bool
    backup_verified: bool
    source_revision_verified: bool
    write_applied: bool
    structurally_verified: bool
    baseline_revision_id: str
    resulting_revision_id: str | None
    attention_code: str | None
    conflict: ConflictView | None


ProviderFactory = Callable[[AsyncSession, UUID], Phase6GooglePort | Awaitable[Phase6GooglePort]]


@dataclass(frozen=True, slots=True)
class _Context:
    run_id: UUID
    connection_id: UUID
    document_id: UUID
    provider_file_id: str
    parent_id: str
    plan_row_id: UUID
    plan: SealedWritePlan
    snapshot_id: UUID
    requires_exact_file_authorization: bool


class Phase6ExecutionService:
    def __init__(
        self,
        *,
        sessions: async_sessionmaker[AsyncSession],
        owner_subject: str,
        provider_factory: ProviderFactory,
    ) -> None:
        self._sessions = sessions
        self._owner_subject = owner_subject
        self._provider_factory = provider_factory

    async def execute(self, run_id: UUID) -> WriteBackView:
        claimed, existing = await self._claim(run_id)
        if existing is not None:
            return existing
        assert claimed is not None
        provider = await self._provider(claimed.connection_id)

        async with self._sessions() as session:
            backup, backup_effect, write_effect = await self._effect_state(
                session, claimed.run_id, claimed.plan_row_id
            )

        if write_effect is not None:
            if write_effect.outcome is EffectOutcome.STARTED:
                if not _lease_expired(write_effect.started_at):
                    return await self.get_status(run_id)
                await self._mark_effect_unknown(
                    run_id,
                    effect_key=write_effect.effect_key,
                    attention_code="GOOGLE_BATCH_UPDATE_OUTCOME_UNKNOWN",
                )
                return await self._reconcile_unknown_write(claimed, provider)
            if write_effect.outcome is EffectOutcome.UNKNOWN:
                return await self._reconcile_unknown_write(claimed, provider)
            if write_effect.outcome is EffectOutcome.SUCCEEDED:
                return await self._verify_after_write(claimed, provider)

        assert backup is not None and backup_effect is not None
        if backup_effect.outcome is EffectOutcome.STARTED:
            if not _lease_expired(backup_effect.started_at):
                return await self.get_status(run_id)
            await self._mark_backup_unknown(run_id, backup.id, backup_effect.effect_key)
            return await self.get_status(run_id)
        if backup_effect.outcome is EffectOutcome.UNKNOWN or backup.status is BackupStatus.UNKNOWN:
            return await self.get_status(run_id)
        if backup.status is BackupStatus.FAILED:
            return await self.get_status(run_id)

        if backup.status is BackupStatus.PLANNED:
            current = await self._read_precheck(claimed, provider, stage="BEFORE_BACKUP")
            if current is None:
                return await self.get_status(run_id)
            receipt = await self._create_backup(claimed, provider, current.name)
            if receipt is None:
                return await self.get_status(run_id)

        async with self._sessions() as session:
            backup, _, _ = await self._effect_state(session, claimed.run_id, claimed.plan_row_id)
        assert backup is not None
        if backup.status is BackupStatus.CREATED:
            verified = await self._verify_backup(claimed, provider, backup)
            if not verified:
                return await self.get_status(run_id)

        current = await self._read_precheck(claimed, provider, stage="AFTER_BACKUP")
        if current is None:
            return await self.get_status(run_id)
        return await self._commit(claimed, provider)

    async def get_status(self, run_id: UUID) -> WriteBackView:
        async with self._sessions() as session:
            context = await self._load_context(session, run_id, for_update=False)
            return await self._view(session, context)

    async def decide_conflict(self, run_id: UUID, choice: ConflictChoice) -> WriteBackView:
        async with self._sessions() as session:
            context = await self._load_context(session, run_id, for_update=True)
            conflict = await session.scalar(
                select(WriteConflict).where(WriteConflict.sync_run_id == run_id).with_for_update()
            )
            if conflict is None:
                raise ConflictDecisionInvalid("the run has no write-back conflict")
            if conflict.decision is not None and conflict.decision is not choice:
                raise ConflictDecisionInvalid("the conflict already has a different decision")
            if conflict.decision is None:
                conflict.decision = choice
                conflict.decided_at = datetime.now(UTC)
                conflict.decided_by_subject = self._owner_subject
            await session.commit()
        return await self.get_status(context.run_id)

    async def _claim(self, run_id: UUID) -> tuple[_Context | None, WriteBackView | None]:
        async with self._sessions() as session:
            context = await self._load_context(session, run_id, for_update=True)
            run = await session.get(SyncRun, run_id)
            assert run is not None
            existing = await self._view(session, context)
            resumable_attention = existing.status is WriteBackStatus.ATTENTION and run.state in {
                SyncRunState.COMMITTING,
                SyncRunState.VERIFYING,
            }
            if existing.status not in {WriteBackStatus.READY, WriteBackStatus.IN_PROGRESS} and not (
                resumable_attention
            ):
                return None, existing
            await self._require_exact_file_authorization(session, run, context)

            backup, backup_effect, write_effect = await self._effect_state(
                session, run_id, context.plan_row_id
            )
            active = next(
                (
                    effect
                    for effect in (write_effect, backup_effect)
                    if effect is not None
                    and effect.outcome is EffectOutcome.STARTED
                    and not _lease_expired(effect.started_at)
                ),
                None,
            )
            if active is not None:
                return None, existing
            if (
                run.state is SyncRunState.COMMITTING
                and backup_effect is not None
                and backup_effect.outcome is EffectOutcome.NOT_STARTED
                and run.failure_code != ExactFileWriteAuthorizationRequired.code
                and not _lease_expired(run.updated_at)
            ):
                return None, existing

            self._validate_eligibility(
                session=session,
                run=run,
                context=context,
                effects_started=backup_effect is not None or write_effect is not None,
            )
            await self._validate_persisted_lineage(session, context)
            if run.state is SyncRunState.REVIEWED_EXPORT_READY:
                await self._transition(
                    session,
                    run,
                    SyncRunState.READY_TO_COMMIT,
                    "immutable WritePlan passed Phase 6 eligibility",
                )
                await self._transition(
                    session,
                    run,
                    SyncRunState.COMMITTING,
                    "exclusive Google write-back workflow claimed",
                )
            elif run.state in {
                SyncRunState.READY_TO_COMMIT,
                SyncRunState.PREVIEW_READY,
            }:
                await self._transition(
                    session,
                    run,
                    SyncRunState.COMMITTING,
                    "exclusive Google write-back workflow claimed",
                )
            elif run.state not in {SyncRunState.COMMITTING, SyncRunState.VERIFYING}:
                raise WriteBackNotEligible("WritePlan is not in a current READY state")

            if backup_effect is None:
                backup_effect = ExternalEffect(
                    sync_run_id=run.id,
                    effect_key=f"google-backup:{context.plan_row_id}",
                    effect_type=EffectType.GOOGLE_BACKUP_COPY,
                    outcome=EffectOutcome.NOT_STARTED,
                    request_fingerprint=_hash_json(
                        {
                            "operation": "drive.files.copy",
                            "plan_sha256": context.plan.integrity_sha256,
                            "file_id": context.provider_file_id,
                            "parent_id": context.parent_id,
                            "revision": context.plan.payload.source.baseline_revision_id,
                        }
                    ),
                    request_metadata={
                        "write_plan_sha256": context.plan.integrity_sha256,
                        "source_file_id": context.provider_file_id,
                        "source_revision": context.plan.payload.source.baseline_revision_id,
                        "destination_parent_id": context.parent_id,
                    },
                    attempt_count=0,
                )
                session.add(backup_effect)
                await session.flush()
                backup = Backup(
                    sync_run_id=run.id,
                    write_plan_id=context.plan_row_id,
                    external_effect_id=backup_effect.id,
                    status=BackupStatus.PLANNED,
                    baseline_revision_id=context.plan.payload.source.baseline_revision_id,
                )
                session.add(backup)
            await session.commit()
            return context, None

    async def _provider(self, connection_id: UUID) -> Phase6GooglePort:
        async with self._sessions() as session:
            value = self._provider_factory(session, connection_id)
            return await value if inspect.isawaitable(value) else value

    async def _read_precheck(
        self,
        context: _Context,
        provider: Phase6GooglePort,
        *,
        stage: str,
    ) -> CurrentGoogleDocument | None:
        try:
            current = await provider.inspect_current(
                file_id=context.provider_file_id,
                destination_parent_id=context.parent_id,
            )
        except GoogleIntegrationError as exc:
            await self._set_attention(
                context.run_id,
                "GOOGLE_PREWRITE_CHECK_UNAVAILABLE",
                {"provider_code": exc.code.value, "stage": stage},
            )
            return None
        if (
            context.requires_exact_file_authorization
            and current.safe_provider_metadata.get("is_app_authorized") is not True
        ):
            await self._mark_exact_file_authorization_required(context.run_id)
            raise ExactFileWriteAuthorizationRequired(
                "Authorize this exact Google document with Picker before write-back"
            )
        plan = context.plan.payload
        baseline_payload = await self._baseline_payload(context.snapshot_id)
        if current.revision_id != plan.source.baseline_revision_id:
            await self._record_conflict(
                context,
                latest_revision_id=current.revision_id,
                stage=stage,
                evidence={"reason": "provider_revision_changed"},
            )
            return None
        identity_ok = (
            current.identity.file_id == context.provider_file_id
            and current.identity.mime_type == GOOGLE_DOC_MIME
            and current.identity.parent_ids == plan.source.parent_ids
            and current.identity.drive_id is None
        )
        snapshot_ok = (
            current.native_raw_sha256 == plan.source.native_raw_sha256
            and current.canonical_sha256 == plan.source.native_canonical_sha256
            and current.canonical_schema_version == _payload_schema(baseline_payload)
            and current.canonical_payload == baseline_payload
        )
        capabilities = current.capabilities
        capability_ok = all(
            (
                capabilities.can_edit,
                capabilities.can_modify_content,
                capabilities.can_copy,
                capabilities.destination_can_add_children,
            )
        )
        if not identity_ok or not snapshot_ok or not capability_ok:
            await self._fail_run(
                context.run_id,
                "GOOGLE_PREWRITE_INTEGRITY_FAILED",
                {
                    "stage": stage,
                    "identity_ok": identity_ok,
                    "snapshot_ok": snapshot_ok,
                    "capability_ok": capability_ok,
                },
            )
            return None
        async with self._sessions() as session:
            run = await session.get(SyncRun, context.run_id, with_for_update=True)
            assert run is not None
            run.precommit_revision_id = current.revision_id
            run.failure_code = None
            run.failure_detail = None
            await session.commit()
        return current

    async def _create_backup(
        self,
        context: _Context,
        provider: Phase6GooglePort,
        source_name: str,
    ) -> object | None:
        async with self._sessions() as session:
            backup, effect, _ = await self._effect_state(
                session, context.run_id, context.plan_row_id, for_update=True
            )
            assert backup is not None and effect is not None
            if effect.outcome is not EffectOutcome.NOT_STARTED:
                return None
            require_effect_transition(effect.outcome, EffectOutcome.STARTED)
            effect.outcome = EffectOutcome.STARTED
            effect.attempt_count += 1
            effect.started_at = datetime.now(UTC)
            await session.commit()
            backup_id = backup.id
            effect_key = effect.effect_key
            effect_id = effect.id
        backup_name = _backup_name(source_name, context.plan.payload.source.baseline_revision_id)
        try:
            receipt = await provider.create_backup(
                file_id=context.provider_file_id,
                destination_parent_id=context.parent_id,
                backup_name=backup_name,
                operation_metadata={
                    "docrelayPlan": str(context.plan_row_id),
                    "docrelayEffect": str(effect_id),
                    "source_revision": context.plan.payload.source.baseline_revision_id,
                },
            )
        except GoogleEffectOutcomeUnknown:
            await self._mark_backup_unknown(context.run_id, backup_id, effect_key)
            return None
        except GoogleIntegrationError as exc:
            await self._fail_backup(
                context.run_id,
                backup_id,
                effect_key,
                "GOOGLE_BACKUP_COPY_FAILED",
                exc.code.value,
            )
            return None
        async with self._sessions() as session:
            backup = await session.get(Backup, backup_id, with_for_update=True)
            stored_effect = await session.scalar(
                select(ExternalEffect)
                .where(
                    ExternalEffect.sync_run_id == context.run_id,
                    ExternalEffect.effect_key == effect_key,
                )
                .with_for_update()
            )
            assert backup is not None and stored_effect is not None
            require_effect_transition(stored_effect.outcome, EffectOutcome.SUCCEEDED)
            stored_effect.outcome = EffectOutcome.SUCCEEDED
            stored_effect.provider_external_id = receipt.backup_file_id
            stored_effect.resolved_at = datetime.now(UTC)
            backup.status = BackupStatus.CREATED
            backup.provider_backup_file_id = receipt.backup_file_id
            backup.location_evidence = {
                "copy_receipt_parent_match": receipt.parent_ids == (context.parent_id,),
                "provider_metadata": receipt.provider_metadata,
            }
            await session.commit()
        return receipt

    async def _verify_backup(
        self,
        context: _Context,
        provider: Phase6GooglePort,
        backup: Backup,
    ) -> bool:
        backup_file_id = backup.provider_backup_file_id
        assert backup_file_id is not None
        try:
            verification = await provider.verify_backup(
                source_file_id=context.provider_file_id,
                backup_file_id=backup_file_id,
                expected_parent_id=context.parent_id,
                expected_baseline_sha256=context.plan.payload.source.native_canonical_sha256,
            )
        except GoogleIntegrationError as exc:
            await self._set_attention(
                context.run_id,
                "GOOGLE_BACKUP_VERIFICATION_UNAVAILABLE",
                {"provider_code": exc.code.value},
            )
            return False
        checks = (
            verification.independently_readable,
            verification.separate_file,
            verification.expected_mime_type,
            verification.expected_location,
            verification.content_matches_baseline,
            verification.acl_not_broader,
            verification.canonical_sha256 == context.plan.payload.source.native_canonical_sha256,
        )
        if not all(checks):
            await self._fail_verified_backup(
                context.run_id,
                backup.id,
                {
                    "independently_readable": verification.independently_readable,
                    "separate_file": verification.separate_file,
                    "expected_mime_type": verification.expected_mime_type,
                    "expected_location": verification.expected_location,
                    "content_matches_baseline": verification.content_matches_baseline,
                    "acl_not_broader": verification.acl_not_broader,
                    "canonical_hash_matches": verification.canonical_sha256
                    == context.plan.payload.source.native_canonical_sha256,
                },
            )
            return False
        async with self._sessions() as session:
            row = await session.get(Backup, backup.id, with_for_update=True)
            assert row is not None
            row.status = BackupStatus.VERIFIED
            row.canonical_sha256 = verification.canonical_sha256
            row.acl_evidence = verification.evidence
            row.verified_at = datetime.now(UTC)
            await session.commit()
        return True

    async def _commit(self, context: _Context, provider: Phase6GooglePort) -> WriteBackView:
        operation = context.plan.payload.provider_operations[0]
        async with self._sessions() as session:
            run = await session.get(SyncRun, context.run_id, with_for_update=True)
            assert run is not None
            existing = await session.scalar(
                select(ExternalEffect)
                .where(
                    ExternalEffect.sync_run_id == context.run_id,
                    ExternalEffect.effect_type == EffectType.GOOGLE_BATCH_UPDATE,
                )
                .with_for_update()
            )
            if existing is not None:
                return await self._view(session, context)
            effect = ExternalEffect(
                sync_run_id=context.run_id,
                effect_key=f"google-batch-update:{context.plan_row_id}",
                effect_type=EffectType.GOOGLE_BATCH_UPDATE,
                outcome=EffectOutcome.STARTED,
                request_fingerprint=_hash_json(operation.provider_payload()),
                request_metadata={
                    "write_plan_sha256": context.plan.integrity_sha256,
                    "required_revision_id": operation.required_revision_id,
                    "request_count": len(operation.requests),
                    "request_types": ["deleteContentRange", "insertText"],
                },
                attempt_count=1,
                started_at=datetime.now(UTC),
            )
            session.add(effect)
            await session.commit()
            effect_key = effect.effect_key
        try:
            result = await provider.commit_guarded(
                file_id=context.provider_file_id,
                operation=operation,
            )
        except GoogleEffectOutcomeUnknown:
            await self._mark_effect_unknown(
                context.run_id,
                effect_key=effect_key,
                attention_code="GOOGLE_BATCH_UPDATE_OUTCOME_UNKNOWN",
            )
            return await self._reconcile_unknown_write(context, provider)

        if result.classification is CommitClassification.CONFLICT:
            await self._resolve_effect_not_applied(
                context.run_id, effect_key, result.safe_provider_evidence
            )
            latest = await self._safe_latest_revision(context, provider)
            await self._record_conflict(
                context,
                latest_revision_id=latest,
                stage="ATOMIC_GUARD",
                evidence={"reason": "required_revision_mismatch"},
            )
            return await self.get_status(context.run_id)
        if result.classification is not CommitClassification.SUCCEEDED:
            await self._resolve_effect_not_applied(
                context.run_id, effect_key, result.safe_provider_evidence
            )
            await self._fail_run(
                context.run_id,
                "GOOGLE_BATCH_UPDATE_REJECTED",
                {"classification": result.classification.value},
            )
            return await self.get_status(context.run_id)

        async with self._sessions() as session:
            run = await session.get(SyncRun, context.run_id, with_for_update=True)
            stored_effect = await session.scalar(
                select(ExternalEffect)
                .where(
                    ExternalEffect.sync_run_id == context.run_id,
                    ExternalEffect.effect_key == effect_key,
                )
                .with_for_update()
            )
            assert run is not None and stored_effect is not None
            require_effect_transition(stored_effect.outcome, EffectOutcome.SUCCEEDED)
            stored_effect.outcome = EffectOutcome.SUCCEEDED
            stored_effect.provider_external_id = result.resulting_revision_id
            stored_effect.resolved_at = datetime.now(UTC)
            await self._transition(
                session, run, SyncRunState.VERIFYING, "guarded Google batch accepted"
            )
            await session.commit()
        return await self._verify_after_write(context, provider)

    async def _reconcile_unknown_write(
        self, context: _Context, provider: Phase6GooglePort
    ) -> WriteBackView:
        try:
            current = await provider.inspect_current(
                file_id=context.provider_file_id,
                destination_parent_id=context.parent_id,
            )
        except GoogleIntegrationError as exc:
            await self._set_attention(
                context.run_id,
                "GOOGLE_WRITE_RECONCILIATION_UNAVAILABLE",
                {"provider_code": exc.code.value},
            )
            return await self.get_status(context.run_id)

        expected = context.plan.payload.expected_postimage
        source = context.plan.payload.source
        expected_payload = await self._expected_payload(context)
        if (
            _canonical_equal(
                current,
                schema=_payload_schema(expected_payload),
                sha256=expected.canonical_sha256,
                payload=expected_payload,
            )
            and current.revision_id != source.baseline_revision_id
        ):
            async with self._sessions() as session:
                run = await session.get(SyncRun, context.run_id, with_for_update=True)
                effect = await session.scalar(
                    select(ExternalEffect)
                    .where(
                        ExternalEffect.sync_run_id == context.run_id,
                        ExternalEffect.effect_type == EffectType.GOOGLE_BATCH_UPDATE,
                    )
                    .with_for_update()
                )
                assert run is not None and effect is not None
                require_effect_transition(
                    effect.outcome,
                    EffectOutcome.SUCCEEDED,
                    reconciliation_evidence=True,
                )
                effect.outcome = EffectOutcome.SUCCEEDED
                effect.provider_external_id = current.revision_id
                effect.resolved_at = datetime.now(UTC)
                effect.reconciliation_evidence = {
                    "classification": "EXACT_EXPECTED_POSTIMAGE",
                    "canonical_sha256": current.canonical_sha256,
                    "revision_advanced": True,
                }
                run.resulting_revision_id = current.revision_id
                run.failure_code = None
                run.failure_detail = None
                if run.state is SyncRunState.COMMITTING:
                    await self._transition(
                        session,
                        run,
                        SyncRunState.VERIFYING,
                        "unknown Google write reconciled to exact postimage",
                    )
                await session.commit()
            return await self._verify_snapshot(context, current)

        baseline_payload = await self._baseline_payload(context.snapshot_id)
        if (
            current.revision_id == source.baseline_revision_id
            and current.canonical_sha256 == source.native_canonical_sha256
            and current.canonical_payload == baseline_payload
        ):
            await self._finish_unknown_without_retry(
                context.run_id, "GOOGLE_BATCH_UPDATE_NOT_VISIBLY_APPLIED"
            )
            return await self.get_status(context.run_id)

        await self._record_conflict(
            context,
            latest_revision_id=current.revision_id,
            stage="WRITE_RECONCILIATION",
            evidence={"reason": "provider_state_matches_neither_baseline_nor_postimage"},
        )
        return await self.get_status(context.run_id)

    async def _verify_after_write(
        self, context: _Context, provider: Phase6GooglePort
    ) -> WriteBackView:
        try:
            current = await provider.inspect_current(
                file_id=context.provider_file_id,
                destination_parent_id=context.parent_id,
            )
        except GoogleIntegrationError as exc:
            await self._set_attention(
                context.run_id,
                "GOOGLE_POSTWRITE_READ_UNAVAILABLE",
                {"provider_code": exc.code.value},
            )
            return await self.get_status(context.run_id)
        return await self._verify_snapshot(context, current)

    async def _verify_snapshot(
        self, context: _Context, current: CurrentGoogleDocument
    ) -> WriteBackView:
        expected = context.plan.payload.expected_postimage
        source = context.plan.payload.source
        replacement = context.plan.payload.expected_replacement
        operation = context.plan.payload.provider_operations[0]
        expected_payload = await self._expected_payload(context)
        intended_text = _text_at_operation_range(
            current.canonical_payload, operation, postimage=True
        )
        report: dict[str, JsonValue] = {
            "identity_matches": current.identity.file_id == context.provider_file_id,
            "revision_advanced": current.revision_id != source.baseline_revision_id,
            "schema_matches": current.canonical_schema_version == _payload_schema(expected_payload),
            "canonical_hash_matches": current.canonical_sha256 == expected.canonical_sha256,
            "complete_structure_matches": current.canonical_payload == expected_payload,
            "intended_range_has_new_text": intended_text == replacement.new_text,
            "intended_range_old_preimage_gone": intended_text != replacement.old_text,
            "unaffected_structure_matches": current.canonical_payload == expected_payload,
        }
        passed = all(bool(value) for value in report.values())
        async with self._sessions() as session:
            run = await session.get(SyncRun, context.run_id, with_for_update=True)
            assert run is not None
            existing = await session.scalar(
                select(VerificationResult)
                .where(VerificationResult.sync_run_id == context.run_id)
                .order_by(VerificationResult.created_at.desc())
            )
            if existing is None:
                session.add(
                    VerificationResult(
                        sync_run_id=context.run_id,
                        write_plan_id=context.plan_row_id,
                        status=(VerificationStatus.PASSED if passed else VerificationStatus.FAILED),
                        verifier_version=expected.verifier_version,
                        expected_canonical_sha256=expected.canonical_sha256,
                        actual_canonical_sha256=current.canonical_sha256,
                        actual_revision_id=current.revision_id,
                        report=report,
                    )
                )
            run.resulting_revision_id = current.revision_id
            run.failure_code = None if passed else "GOOGLE_POSTIMAGE_VERIFICATION_FAILED"
            run.failure_detail = None if passed else report
            run.finished_at = datetime.now(UTC)
            target = SyncRunState.SUCCEEDED if passed else SyncRunState.VERIFICATION_FAILED
            if run.state is SyncRunState.VERIFYING:
                await self._transition(
                    session,
                    run,
                    target,
                    "complete provider-native postimage structurally verified"
                    if passed
                    else "provider-native postimage did not match the immutable expectation",
                )
            await session.commit()
        return await self.get_status(context.run_id)

    async def _load_context(
        self, session: AsyncSession, run_id: UUID, *, for_update: bool
    ) -> _Context:
        statement = (
            select(SyncRun, CloudDocument, CloudConnection, WritePlan, SourceSnapshot)
            .join(CloudDocument, CloudDocument.id == SyncRun.cloud_document_id)
            .join(CloudConnection, CloudConnection.id == CloudDocument.connection_id)
            .join(WritePlan, WritePlan.sync_run_id == SyncRun.id)
            .join(SourceSnapshot, SourceSnapshot.id == WritePlan.source_snapshot_id)
            .where(
                SyncRun.id == run_id,
                CloudConnection.owner_subject == self._owner_subject,
                CloudConnection.provider == Provider.GOOGLE,
            )
        )
        if for_update:
            statement = statement.with_for_update()
        row = (await session.execute(statement)).one_or_none()
        if row is None:
            run_exists = await session.get(SyncRun, run_id)
            if run_exists is None:
                raise RunNotFound("run was not found")
            raise WriteBackNotEligible("run has no persisted immutable WritePlan")
        run, document, connection, plan_row, snapshot = row._tuple()
        try:
            plan = SealedWritePlan.model_validate(
                {
                    "payload": plan_row.payload,
                    "integrity_sha256": plan_row.integrity_sha256,
                }
            )
        except ValidationError as exc:
            raise WriteBackNotEligible("persisted WritePlan failed its integrity seal") from exc
        expected_operations = {
            "operations": [
                operation.model_dump(mode="json") for operation in plan.payload.provider_operations
            ]
        }
        row_mirrors_valid = (
            plan_row.id == write_plan_identity(plan)
            and plan_row.sync_run_id == run.id
            and plan_row.source_snapshot_id == snapshot.id
            and plan_row.mapping_proof_id == plan.payload.mapping.mapping_proof_id
            and plan_row.schema_version == plan.payload.schema_version
            and plan_row.provider_file_id == plan.payload.source.provider_file_id
            and plan_row.baseline_revision_id == plan.payload.source.baseline_revision_id
            and plan_row.mapper_version == plan.payload.mapping.mapper_version
            and plan_row.verifier_version == plan.payload.expected_postimage.verifier_version
            and plan_row.provider_operations == expected_operations
            and plan_row.expected_postimage_sha256
            == plan.payload.expected_postimage.canonical_sha256
            and _as_utc(plan_row.sealed_at) == _as_utc(plan.payload.created_at)
            and _as_utc(plan_row.expires_at) == _as_utc(plan.payload.expires_at)
        )
        source_mirrors_valid = (
            run.cloud_document_id == document.id
            and run.baseline_revision_id == snapshot.provider_revision_id
            and snapshot.sync_run_id == run.id
            and snapshot.cloud_document_id == document.id
            and snapshot.id == plan.payload.source.snapshot_id
            and snapshot.provider_revision_id == plan.payload.source.baseline_revision_id
            and snapshot.native_raw_sha256 == plan.payload.source.native_raw_sha256
            and snapshot.native_canonical_sha256 == plan.payload.source.native_canonical_sha256
            and snapshot.exported_artifact_sha256 == plan.payload.source.exported_docx_sha256
            and document.connection_id == connection.id
            and document.provider_file_id == plan.payload.source.provider_file_id
            and document.mime_type == GOOGLE_DOC_MIME
            and tuple(document.parent_ids) == plan.payload.source.parent_ids
            and connection.provider_account_subject
            == plan.payload.source.provider_principal_subject
        )
        if not row_mirrors_valid or not source_mirrors_valid:
            raise WriteBackNotEligible(
                "persisted WritePlan mirrors do not match immutable source lineage"
            )
        if len(plan.payload.source.parent_ids) != 1:
            raise WriteBackNotEligible("WritePlan does not have one proven backup destination")
        return _Context(
            run_id=run.id,
            connection_id=connection.id,
            document_id=document.id,
            provider_file_id=document.provider_file_id,
            parent_id=plan.payload.source.parent_ids[0],
            plan_row_id=plan_row.id,
            plan=plan,
            snapshot_id=snapshot.id,
            requires_exact_file_authorization=run.folder_rule_id is not None,
        )

    async def _require_exact_file_authorization(
        self,
        session: AsyncSession,
        run: SyncRun,
        context: _Context,
    ) -> None:
        if not context.requires_exact_file_authorization:
            return
        row = (
            await session.execute(
                select(WatchRunLink, WatchedItem)
                .join(WatchedItem, WatchedItem.id == WatchRunLink.watched_item_id)
                .where(WatchRunLink.sync_run_id == run.id)
                .with_for_update()
            )
        ).one_or_none()
        link: WatchRunLink | None = None
        if row is not None:
            link, watched_item = row._tuple()
            if not watched_item.current_in_scope:
                raise WatchedFileOutOfScope(
                    "The watched document is no longer inside its configured root"
                )
        if (
            link is None
            or link.write_authorization_state is not WriteAuthorizationState.AUTHORIZED
            or link.folder_rule_id != run.folder_rule_id
            or link.folder_rule_version != run.folder_rule_version
        ):
            raise ExactFileWriteAuthorizationRequired(
                "Authorize this exact Google document with Picker before write-back"
            )

    async def _mark_exact_file_authorization_required(self, run_id: UUID) -> None:
        async with self._sessions() as session:
            link = await session.scalar(
                select(WatchRunLink).where(WatchRunLink.sync_run_id == run_id).with_for_update()
            )
            if link is not None:
                link.write_authorization_state = WriteAuthorizationState.REQUIRED
                link.write_authorization_checked_at = datetime.now(UTC)
                link.write_authorization_evidence = {
                    "is_app_authorized": False,
                    "verified_via": "phase6.drive.files.get.isAppAuthorized",
                    "read_scope_is_not_write_authority": True,
                }
            run = await session.get(SyncRun, run_id, with_for_update=True)
            if run is not None:
                run.failure_code = ExactFileWriteAuthorizationRequired.code
                run.failure_detail = {"provider_is_app_authorized": False}
            await session.commit()

    def _validate_eligibility(
        self,
        *,
        session: AsyncSession,
        run: SyncRun,
        context: _Context,
        effects_started: bool,
    ) -> None:
        del session
        plan = context.plan.payload
        if not context.plan.verify_integrity():
            raise WriteBackNotEligible("WritePlan is not immutable and valid")
        if plan.sync_run_id != run.id or plan.source.snapshot_id != context.snapshot_id:
            raise WriteBackNotEligible("WritePlan does not belong to this run and source")
        if plan.source.provider_file_id != context.provider_file_id:
            raise WriteBackNotEligible("WritePlan cloud identity is not current")
        if plan.source.baseline_revision_id != run.baseline_revision_id:
            raise WriteBackNotEligible("WritePlan baseline does not match the run baseline")
        if not effects_started and _as_utc(plan.expires_at) <= datetime.now(UTC):
            raise WriteBackNotEligible("WritePlan has expired; create new mapping lineage")
        if (
            _hash_json(run.rule_snapshot) != plan.rule.configuration_sha256
            or str(run.rule_snapshot.get("instruction_sha256") or "")
            != plan.rule.instruction_sha256
        ):
            raise WriteBackNotEligible("WritePlan rule snapshot is no longer current")
        if (run.folder_rule_id is not None and run.folder_rule_id != plan.rule.rule_id) or (
            run.folder_rule_version is not None and run.folder_rule_version != plan.rule.version
        ):
            raise WriteBackNotEligible("WritePlan rule identity is no longer current")

    async def _validate_persisted_lineage(self, session: AsyncSession, context: _Context) -> None:
        plan = context.plan.payload
        proof = await session.get(MappingProof, plan.mapping.mapping_proof_id)
        if (
            proof is None
            or proof.sync_run_id != context.run_id
            or proof.source_snapshot_id != context.snapshot_id
            or proof.integrity_sha256 != plan.mapping.integrity_sha256
        ):
            raise WriteBackNotEligible("MappingProof lineage no longer matches the WritePlan")
        try:
            sealed_proof = SealedMappingProof.model_validate(
                {
                    "mapping_proof_id": proof.id,
                    "payload": proof.proof_payload,
                    "integrity_sha256": proof.integrity_sha256,
                }
            )
        except ValidationError as exc:
            raise WriteBackNotEligible("MappingProof failed its integrity seal") from exc
        proof_payload = sealed_proof.payload
        if (
            proof_payload.source_snapshot_id != context.snapshot_id
            or proof_payload.provider_file_id != plan.source.provider_file_id
            or proof_payload.baseline_revision_id != plan.source.baseline_revision_id
            or proof_payload.native_raw_sha256 != plan.source.native_raw_sha256
            or proof_payload.native_snapshot_sha256 != plan.source.native_canonical_sha256
            or proof_payload.old_text != plan.expected_replacement.old_text
            or proof_payload.new_text != plan.expected_replacement.new_text
        ):
            raise WriteBackNotEligible("MappingProof source lineage no longer matches the plan")
        lineages = tuple(
            await session.scalars(
                select(WritePlanLineage).where(
                    WritePlanLineage.write_plan_id == context.plan_row_id
                )
            )
        )
        if len(lineages) != len(plan.approval_lineage):
            raise WriteBackNotEligible("approved proposal lineage is incomplete")
        for ordinal, (stored, sealed) in enumerate(
            zip(
                sorted(lineages, key=lambda item: item.ordinal),
                plan.approval_lineage,
                strict=True,
            ),
            start=1,
        ):
            proposal = await session.get(ProposedChange, stored.proposed_change_id)
            decision = await session.get(ReviewDecision, stored.review_decision_id)
            export = await session.get(SuperDocsExport, sealed.superdocs_export_id)
            review_round = (
                await session.get(ReviewRound, proposal.review_round_id)
                if proposal is not None
                else None
            )
            job = (
                await session.get(SuperDocsJob, proposal.superdocs_job_id)
                if proposal is not None
                else None
            )
            superdocs_document = (
                await session.get(SuperDocsDocument, proposal.target_document_id)
                if proposal is not None
                else None
            )
            superdocs_session = (
                await session.get(SuperDocsSession, job.superdocs_session_id)
                if job is not None
                else None
            )
            superseding = await session.scalar(
                select(ProposedChange.id).where(
                    ProposedChange.replaces_proposal_id == stored.proposed_change_id
                )
            )
            if (
                proposal is None
                or decision is None
                or export is None
                or review_round is None
                or job is None
                or superdocs_document is None
                or superdocs_session is None
                or stored.ordinal != ordinal
                or stored.proposed_change_id != sealed.proposal_id
                or stored.review_decision_id != sealed.decision_id
                or proposal.sync_run_id != context.run_id
                or proposal.operation is not ProposalOperation.EDIT
                or proposal.superdocs_change_id != sealed.superdocs_change_id
                or proposal.chunk_id != sealed.chunk_id
                or _sha256_text(proposal.old_html or "") != sealed.old_html_sha256
                or _sha256_text(proposal.new_html or "") != sealed.new_html_sha256
                or decision.sync_run_id != context.run_id
                or decision.proposed_change_id != proposal.id
                or decision.decision is not ChangeDecision.APPROVE
                or review_round.sync_run_id != context.run_id
                or review_round.superdocs_job_id != job.id
                or review_round.ordinal != sealed.review_round
                or review_round.resolution is not ReviewRoundResolution.SUBMIT_CHANGES
                or job.sync_run_id != context.run_id
                or job.status is not SuperDocsJobStatus.COMPLETED
                or job.superdocs_session_id != superdocs_session.id
                or job.target_document_id != superdocs_document.id
                or job.provider_job_id != sealed.job_id
                or superdocs_session.sync_run_id != context.run_id
                or superdocs_session.session_id != sealed.session_id
                or superdocs_document.superdocs_session_id != superdocs_session.id
                or superdocs_document.source_snapshot_id != context.snapshot_id
                or superdocs_document.session_document_id != sealed.session_document_id
                or superdocs_document.durable_document_id != sealed.durable_document_id
                or export.sync_run_id != context.run_id
                or export.source_snapshot_id != context.snapshot_id
                or export.superdocs_session_id != superdocs_session.id
                or export.superdocs_document_id != superdocs_document.id
                or export.superdocs_job_id != job.id
                or export.sha256 != sealed.approved_export_sha256
                or export.final_version_id != sealed.final_version_id
                or bool(export.warnings)
                or proof_payload.lineage.proposal_id != proposal.id
                or proof_payload.lineage.decision_id != decision.id
                or proof_payload.lineage.decision_sha256 != decision.decision_sha256
                or proof_payload.lineage.superdocs_export_id != export.id
                or superseding is not None
            ):
                raise WriteBackNotEligible("reviewed proposal is no longer approved and current")
        baseline_payload = await self._baseline_payload_in_session(session, context.snapshot_id)
        expected_payload = _apply_provider_operation(
            baseline_payload, context.plan.payload.provider_operations[0]
        )
        if (
            _text_at_operation_range(baseline_payload, context.plan.payload.provider_operations[0])
            != context.plan.payload.expected_replacement.old_text
            or _text_at_operation_range(
                expected_payload,
                context.plan.payload.provider_operations[0],
                postimage=True,
            )
            != context.plan.payload.expected_replacement.new_text
            or sha256_json(expected_payload)
            != context.plan.payload.expected_postimage.canonical_sha256
        ):
            raise WriteBackNotEligible(
                "WritePlan expected postimage does not derive from the persisted baseline"
            )

    async def _effect_state(
        self,
        session: AsyncSession,
        run_id: UUID,
        plan_id: UUID,
        *,
        for_update: bool = False,
    ) -> tuple[Backup | None, ExternalEffect | None, ExternalEffect | None]:
        backup_statement = select(Backup).where(
            Backup.sync_run_id == run_id, Backup.write_plan_id == plan_id
        )
        effect_statement = select(ExternalEffect).where(ExternalEffect.sync_run_id == run_id)
        if for_update:
            backup_statement = backup_statement.with_for_update()
            effect_statement = effect_statement.with_for_update()
        backup = await session.scalar(backup_statement)
        effects = tuple(await session.scalars(effect_statement))
        backup_effect = next(
            (item for item in effects if item.effect_type is EffectType.GOOGLE_BACKUP_COPY),
            None,
        )
        write_effect = next(
            (item for item in effects if item.effect_type is EffectType.GOOGLE_BATCH_UPDATE),
            None,
        )
        return backup, backup_effect, write_effect

    async def _view(self, session: AsyncSession, context: _Context) -> WriteBackView:
        run = await session.get(SyncRun, context.run_id)
        assert run is not None
        backup, _, write_effect = await self._effect_state(
            session, context.run_id, context.plan_row_id
        )
        verification = await session.scalar(
            select(VerificationResult)
            .where(VerificationResult.sync_run_id == context.run_id)
            .order_by(VerificationResult.created_at.desc())
        )
        conflict = await session.scalar(
            select(WriteConflict).where(WriteConflict.sync_run_id == context.run_id)
        )
        if verification is not None and verification.status is VerificationStatus.PASSED:
            status = WriteBackStatus.WRITE_VERIFIED
        elif verification is not None:
            status = WriteBackStatus.VERIFICATION_FAILED
        elif conflict is not None and conflict.decision is ConflictChoice.CANCEL:
            status = WriteBackStatus.CANCELLED
        elif conflict is not None and conflict.decision is ConflictChoice.REVIEW_LATEST:
            status = WriteBackStatus.REVIEW_LATEST
        elif conflict is not None:
            status = WriteBackStatus.CONFLICT
        elif run.state is SyncRunState.COMMIT_OUTCOME_UNKNOWN:
            status = WriteBackStatus.ATTENTION
        elif run.state is SyncRunState.FAILED:
            status = WriteBackStatus.FAILED
        elif run.failure_code in {
            "GOOGLE_PREWRITE_CHECK_UNAVAILABLE",
            "GOOGLE_BACKUP_VERIFICATION_UNAVAILABLE",
            "GOOGLE_POSTWRITE_READ_UNAVAILABLE",
            "GOOGLE_WRITE_RECONCILIATION_UNAVAILABLE",
        }:
            status = WriteBackStatus.ATTENTION
        elif run.state in {SyncRunState.COMMITTING, SyncRunState.VERIFYING}:
            status = WriteBackStatus.IN_PROGRESS
        else:
            status = WriteBackStatus.READY
        backup_created = backup is not None and backup.status in {
            BackupStatus.CREATED,
            BackupStatus.VERIFIED,
        }
        backup_verified = backup is not None and backup.status is BackupStatus.VERIFIED
        write_applied = write_effect is not None and write_effect.outcome is EffectOutcome.SUCCEEDED
        return WriteBackView(
            run_id=context.run_id,
            status=status,
            write_plan_id=context.plan_row_id,
            write_plan_sha256=context.plan.integrity_sha256,
            backup_created=backup_created,
            backup_verified=backup_verified,
            source_revision_verified=write_effect is not None or write_applied,
            write_applied=write_applied,
            structurally_verified=(
                verification is not None and verification.status is VerificationStatus.PASSED
            ),
            baseline_revision_id=context.plan.payload.source.baseline_revision_id,
            resulting_revision_id=run.resulting_revision_id,
            attention_code=run.failure_code,
            conflict=(
                ConflictView(
                    baseline_revision_id=conflict.baseline_revision_id,
                    latest_revision_id=conflict.latest_revision_id,
                    detection_stage=conflict.detection_stage,
                    detected_at=conflict.detected_at,
                    backup_created=conflict.backup_id is not None,
                    decision=conflict.decision,
                )
                if conflict is not None
                else None
            ),
        )

    async def _record_conflict(
        self,
        context: _Context,
        *,
        latest_revision_id: str | None,
        stage: str,
        evidence: dict[str, JsonValue],
    ) -> None:
        async with self._sessions() as session:
            run = await session.get(SyncRun, context.run_id, with_for_update=True)
            assert run is not None
            existing = await session.scalar(
                select(WriteConflict)
                .where(WriteConflict.sync_run_id == context.run_id)
                .with_for_update()
            )
            backup = await session.scalar(
                select(Backup).where(Backup.sync_run_id == context.run_id)
            )
            if existing is None:
                session.add(
                    WriteConflict(
                        sync_run_id=context.run_id,
                        write_plan_id=context.plan_row_id,
                        backup_id=(
                            backup.id
                            if backup is not None
                            and backup.status in {BackupStatus.CREATED, BackupStatus.VERIFIED}
                            else None
                        ),
                        baseline_revision_id=context.plan.payload.source.baseline_revision_id,
                        latest_revision_id=latest_revision_id,
                        detection_stage=stage,
                        detected_at=datetime.now(UTC),
                        safe_evidence=evidence,
                    )
                )
            run.failure_code = "GOOGLE_SOURCE_REVISION_CONFLICT"
            run.failure_detail = {
                "detection_stage": stage,
                "baseline_revision_id": context.plan.payload.source.baseline_revision_id,
                "latest_revision_id": latest_revision_id,
            }
            if run.state is SyncRunState.COMMITTING:
                await self._transition(
                    session,
                    run,
                    SyncRunState.CONFLICT,
                    "Google source changed after WritePlan creation",
                )
            await session.commit()

    async def _safe_latest_revision(
        self, context: _Context, provider: Phase6GooglePort
    ) -> str | None:
        try:
            current = await provider.inspect_current(
                file_id=context.provider_file_id,
                destination_parent_id=context.parent_id,
            )
        except GoogleIntegrationError:
            return None
        return current.revision_id

    async def _mark_backup_unknown(self, run_id: UUID, backup_id: UUID, effect_key: str) -> None:
        async with self._sessions() as session:
            run = await session.get(SyncRun, run_id, with_for_update=True)
            backup = await session.get(Backup, backup_id, with_for_update=True)
            effect = await session.scalar(
                select(ExternalEffect)
                .where(
                    ExternalEffect.sync_run_id == run_id,
                    ExternalEffect.effect_key == effect_key,
                )
                .with_for_update()
            )
            assert run is not None and backup is not None and effect is not None
            if effect.outcome is EffectOutcome.STARTED:
                require_effect_transition(effect.outcome, EffectOutcome.UNKNOWN)
                effect.outcome = EffectOutcome.UNKNOWN
            backup.status = BackupStatus.UNKNOWN
            run.failure_code = "GOOGLE_BACKUP_COPY_OUTCOME_UNKNOWN"
            run.failure_detail = {"effect_key": effect_key, "automatic_retry": False}
            if run.state is SyncRunState.COMMITTING:
                await self._transition(
                    session,
                    run,
                    SyncRunState.COMMIT_OUTCOME_UNKNOWN,
                    "Google backup copy outcome is unknown; automatic retry forbidden",
                )
            await session.commit()

    async def _mark_effect_unknown(
        self, run_id: UUID, *, effect_key: str, attention_code: str
    ) -> None:
        async with self._sessions() as session:
            run = await session.get(SyncRun, run_id, with_for_update=True)
            effect = await session.scalar(
                select(ExternalEffect)
                .where(
                    ExternalEffect.sync_run_id == run_id,
                    ExternalEffect.effect_key == effect_key,
                )
                .with_for_update()
            )
            assert run is not None and effect is not None
            if effect.outcome is EffectOutcome.STARTED:
                require_effect_transition(effect.outcome, EffectOutcome.UNKNOWN)
                effect.outcome = EffectOutcome.UNKNOWN
            run.failure_code = attention_code
            run.failure_detail = {"effect_key": effect_key, "automatic_retry": False}
            await session.commit()

    async def _resolve_effect_not_applied(
        self, run_id: UUID, effect_key: str, evidence: dict[str, JsonValue]
    ) -> None:
        async with self._sessions() as session:
            effect = await session.scalar(
                select(ExternalEffect)
                .where(
                    ExternalEffect.sync_run_id == run_id,
                    ExternalEffect.effect_key == effect_key,
                )
                .with_for_update()
            )
            assert effect is not None
            require_effect_transition(
                effect.outcome,
                EffectOutcome.NOT_STARTED,
                definitive_non_occurrence=True,
            )
            effect.outcome = EffectOutcome.NOT_STARTED
            effect.resolved_at = datetime.now(UTC)
            effect.reconciliation_evidence = evidence
            await session.commit()

    async def _finish_unknown_without_retry(self, run_id: UUID, code: str) -> None:
        async with self._sessions() as session:
            run = await session.get(SyncRun, run_id, with_for_update=True)
            assert run is not None
            run.failure_code = code
            run.failure_detail = {"automatic_retry": False, "provider_state": "BASELINE"}
            if run.state is SyncRunState.COMMITTING:
                await self._transition(
                    session,
                    run,
                    SyncRunState.COMMIT_OUTCOME_UNKNOWN,
                    "unknown write matched baseline; controlled decision required",
                )
            await session.commit()

    async def _fail_backup(
        self,
        run_id: UUID,
        backup_id: UUID,
        effect_key: str,
        code: str,
        provider_code: str,
    ) -> None:
        async with self._sessions() as session:
            backup = await session.get(Backup, backup_id, with_for_update=True)
            effect = await session.scalar(
                select(ExternalEffect)
                .where(
                    ExternalEffect.sync_run_id == run_id,
                    ExternalEffect.effect_key == effect_key,
                )
                .with_for_update()
            )
            assert backup is not None and effect is not None
            require_effect_transition(
                effect.outcome,
                EffectOutcome.NOT_STARTED,
                definitive_non_occurrence=True,
            )
            effect.outcome = EffectOutcome.NOT_STARTED
            effect.last_error = {"provider_code": provider_code}
            effect.resolved_at = datetime.now(UTC)
            backup.status = BackupStatus.FAILED
            await session.commit()
        await self._fail_run(run_id, code, {"provider_code": provider_code})

    async def _fail_verified_backup(
        self, run_id: UUID, backup_id: UUID, details: dict[str, JsonValue]
    ) -> None:
        async with self._sessions() as session:
            backup = await session.get(Backup, backup_id, with_for_update=True)
            assert backup is not None
            backup.status = BackupStatus.FAILED
            backup.acl_evidence = details
            await session.commit()
        await self._fail_run(run_id, "GOOGLE_BACKUP_VERIFICATION_FAILED", details)

    async def _fail_run(self, run_id: UUID, code: str, details: dict[str, JsonValue]) -> None:
        async with self._sessions() as session:
            run = await session.get(SyncRun, run_id, with_for_update=True)
            assert run is not None
            run.failure_code = code
            run.failure_detail = details
            run.finished_at = datetime.now(UTC)
            if run.state is SyncRunState.COMMITTING:
                await self._transition(session, run, SyncRunState.FAILED, code)
            await session.commit()

    async def _set_attention(self, run_id: UUID, code: str, details: dict[str, JsonValue]) -> None:
        async with self._sessions() as session:
            run = await session.get(SyncRun, run_id, with_for_update=True)
            assert run is not None
            run.failure_code = code
            run.failure_detail = details
            await session.commit()

    async def _baseline_payload(self, snapshot_id: UUID) -> dict[str, JsonValue]:
        async with self._sessions() as session:
            return await self._baseline_payload_in_session(session, snapshot_id)

    async def _expected_payload(self, context: _Context) -> dict[str, JsonValue]:
        baseline = await self._baseline_payload(context.snapshot_id)
        return _apply_provider_operation(baseline, context.plan.payload.provider_operations[0])

    @staticmethod
    async def _baseline_payload_in_session(
        session: AsyncSession, snapshot_id: UUID
    ) -> dict[str, JsonValue]:
        snapshot = await session.get(SourceSnapshot, snapshot_id)
        assert snapshot is not None
        capture_id = UUID(str(snapshot.provider_evidence["selected_baseline_capture_id"]))
        from docrelay.persistence.models import GoogleBaselineCapture

        capture = await session.get(GoogleBaselineCapture, capture_id)
        if capture is None:
            raise WriteBackNotEligible("persisted native baseline is missing")
        return capture.canonical_payload

    async def _transition(
        self,
        session: AsyncSession,
        run: SyncRun,
        target: SyncRunState,
        reason: str,
    ) -> None:
        source = run.state
        require_transition(source, target)
        sequence = (
            int(
                await session.scalar(
                    select(func.coalesce(func.max(RunTransition.sequence), 0)).where(
                        RunTransition.sync_run_id == run.id
                    )
                )
            )
            + 1
        )
        session.add(
            RunTransition(
                sync_run_id=run.id,
                sequence=sequence,
                from_state=source,
                to_state=target,
                actor_subject=self._owner_subject,
                reason=reason,
                evidence={},
            )
        )
        run.state = target
        run.state_version += 1


def _canonical_equal(
    current: CurrentGoogleDocument,
    *,
    schema: str,
    sha256: str,
    payload: dict[str, Any],
) -> bool:
    return (
        current.canonical_schema_version == schema
        and current.canonical_sha256 == sha256
        and current.canonical_payload == payload
    )


def _payload_schema(payload: dict[str, Any]) -> str:
    schema = payload.get("schema")
    return str(schema) if isinstance(schema, str) and schema else ""


def _text_at_operation_range(
    canonical: dict[str, Any],
    operation: GoogleDocsBatchUpdate,
    *,
    postimage: bool = False,
) -> str | None:
    request = cast(dict[str, Any], operation.requests[0])
    try:
        range_value = request["deleteContentRange"]["range"]
        start = int(range_value["startIndex"])
        end = int(range_value["endIndex"])
        if postimage:
            insert_request = cast(dict[str, Any], operation.requests[1])
            inserted_text = insert_request["insertText"]["text"]
            if not isinstance(inserted_text, str):
                return None
            end = start + _utf16_length(inserted_text)
        tab_id = str(range_value["tabId"])
        tabs = canonical["tabs"]
        if not isinstance(tabs, list):
            return None
        tab = next(
            item
            for item in tabs
            if isinstance(item, dict)
            and isinstance(item.get("tabProperties"), dict)
            and item["tabProperties"].get("tabId") == tab_id
        )
        for block in tab.get("body") or []:
            if not isinstance(block, dict):
                continue
            for run in block.get("runs") or []:
                if not isinstance(run, dict) or run.get("kind") != "text":
                    continue
                run_start = run.get("startIndex")
                text = run.get("text")
                if not isinstance(run_start, int) or not isinstance(text, str):
                    continue
                encoded = text.encode("utf-16-le")
                offset_start = (start - run_start) * 2
                offset_end = (end - run_start) * 2
                if 0 <= offset_start <= offset_end <= len(encoded):
                    return encoded[offset_start:offset_end].decode("utf-16-le")
    except (KeyError, StopIteration, TypeError, ValueError, UnicodeDecodeError):
        return None
    return None


def _apply_provider_operation(
    baseline: dict[str, Any], operation: GoogleDocsBatchUpdate
) -> dict[str, Any]:
    if len(operation.requests) != 2:
        raise WriteBackNotEligible("WritePlan does not contain the exact two-operation subset")
    delete_request = cast(dict[str, Any], operation.requests[0])
    insert_request = cast(dict[str, Any], operation.requests[1])
    if set(delete_request) != {"deleteContentRange"} or set(insert_request) != {"insertText"}:
        raise WriteBackNotEligible("WritePlan operation shape is not the exact supported subset")
    try:
        range_value = delete_request["deleteContentRange"]["range"]
        location = insert_request["insertText"]["location"]
        inserted_text = insert_request["insertText"]["text"]
        start = int(range_value["startIndex"])
        end = int(range_value["endIndex"])
        tab_id = str(range_value["tabId"])
        segment_id = str(range_value["segmentId"])
        if (
            segment_id != ""
            or str(location["segmentId"]) != segment_id
            or str(location["tabId"]) != tab_id
            or int(location["index"]) != start
            or not isinstance(inserted_text, str)
            or end <= start
        ):
            raise WriteBackNotEligible("WritePlan operation indexes are not internally exact")
    except (KeyError, TypeError, ValueError) as exc:
        raise WriteBackNotEligible("WritePlan operation shape is invalid") from exc

    expected = deepcopy(baseline)
    tabs = expected.get("tabs")
    if not isinstance(tabs, list):
        raise WriteBackNotEligible("persisted baseline has no canonical tab list")
    try:
        tab = next(
            item
            for item in tabs
            if isinstance(item, dict)
            and isinstance(item.get("tabProperties"), dict)
            and item["tabProperties"].get("tabId") == tab_id
        )
    except StopIteration as exc:
        raise WriteBackNotEligible("WritePlan tab is absent from the baseline") from exc
    matches = 0
    for block in tab.get("body") or []:
        if not isinstance(block, dict):
            continue
        for run in block.get("runs") or []:
            if not isinstance(run, dict) or run.get("kind") != "text":
                continue
            run_start = run.get("startIndex")
            text = run.get("text")
            if not isinstance(run_start, int) or not isinstance(text, str):
                continue
            encoded = text.encode("utf-16-le")
            offset_start = (start - run_start) * 2
            offset_end = (end - run_start) * 2
            if 0 <= offset_start < offset_end <= len(encoded):
                replacement = inserted_text.encode("utf-16-le")
                run["text"] = (encoded[:offset_start] + replacement + encoded[offset_end:]).decode(
                    "utf-16-le"
                )
                matches += 1
    if matches != 1:
        raise WriteBackNotEligible("WritePlan range does not map to one baseline text run")
    _shift_body_indexes(
        tab.get("body"),
        replaced_start=start,
        replaced_end=end,
        delta=_utf16_length(inserted_text) - (end - start),
    )
    return expected


def _shift_body_indexes(
    value: Any,
    *,
    replaced_start: int,
    replaced_end: int,
    delta: int,
) -> None:
    if isinstance(value, list):
        for child in value:
            _shift_body_indexes(
                child,
                replaced_start=replaced_start,
                replaced_end=replaced_end,
                delta=delta,
            )
        return
    if not isinstance(value, dict):
        return
    for key, child in value.items():
        if key in {"startIndex", "endIndex"}:
            if not isinstance(child, int) or isinstance(child, bool):
                raise WriteBackNotEligible(f"provider {key} is malformed")
            if replaced_start < child < replaced_end:
                raise WriteBackNotEligible(
                    "provider index boundary intersects the replacement range"
                )
            if child >= replaced_end:
                value[key] = child + delta
            continue
        _shift_body_indexes(
            child,
            replaced_start=replaced_start,
            replaced_end=replaced_end,
            delta=delta,
        )


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _backup_name(source_name: str, revision: str) -> str:
    timestamp = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")
    suffix = f" — DocRelay backup — {timestamp} — {revision[:16]}"
    return f"{source_name[: max(1, 240 - len(suffix))]}{suffix}"


def _hash_json(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _lease_expired(value: datetime | None) -> bool:
    return value is None or _as_utc(value) + EFFECT_LEASE <= datetime.now(UTC)


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
