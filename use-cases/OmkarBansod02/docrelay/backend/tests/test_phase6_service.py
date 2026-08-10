import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from docrelay.domain.enums import (
    BackupStatus,
    ChangeDecision,
    ConnectionStatus,
    EffectOutcome,
    EffectType,
    ProposalOperation,
    Provider,
    ReviewAwaitingKind,
    ReviewRoundResolution,
    SuperDocsDocumentRole,
    SuperDocsJobStatus,
    SyncMode,
    SyncRunState,
)
from docrelay.integrations.google.canonical import sha256_json
from docrelay.integrations.google.contracts import (
    BackupReceipt,
    BackupVerification,
    CommitClassification,
    CurrentGoogleDocument,
    GoogleCapabilities,
    GoogleFileIdentity,
    GuardedCommitResult,
)
from docrelay.integrations.google.errors import GoogleErrorCode, GoogleIntegrationError
from docrelay.integrations.google.write_back import GoogleEffectOutcomeUnknown
from docrelay.persistence.base import Base
from docrelay.persistence.models import (
    Backup,
    CloudConnection,
    CloudDocument,
    ExternalEffect,
    GoogleBaselineCapture,
    MappingProof,
    ProposedChange,
    ReviewDecision,
    ReviewRound,
    SourceSnapshot,
    SuperDocsDocument,
    SuperDocsExport,
    SuperDocsJob,
    SuperDocsSession,
    SyncRun,
    VerificationResult,
    WriteConflict,
    WritePlan,
)
from docrelay.services.phase4 import DryRunStatus, Phase4PlanningService
from docrelay.services.phase6 import (
    ConflictChoice,
    Phase6ExecutionService,
    WriteBackNotEligible,
    WriteBackStatus,
)

GOOGLE_DOC_MIME = "application/vnd.google-apps.document"


def _canonical(token: str, *, neighbor: str = "Unchanged neighbor.\n") -> dict[str, Any]:
    return {
        "schema": "docrelay.google-native-canonical.v1",
        "tabs": [
            {
                "tabProperties": {
                    "tabId": "t.0",
                    "title": "Tab 1",
                    "index": 0,
                    "nestingLevel": 0,
                    "parentTabId": None,
                },
                "body": [
                    {
                        "startIndex": 130,
                        "endIndex": 150,
                        "type": "paragraph",
                        "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
                        "bullet": None,
                        "positionedObjectIds": [],
                        "runs": [
                            {
                                "kind": "text",
                                "startIndex": 130,
                                "endIndex": 150,
                                "text": neighbor,
                                "style": {},
                            }
                        ],
                    },
                    {
                        "startIndex": 162,
                        "endIndex": 193,
                        "type": "paragraph",
                        "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
                        "bullet": None,
                        "positionedObjectIds": [],
                        "runs": [
                            {
                                "kind": "text",
                                "startIndex": 162,
                                "endIndex": 193,
                                "text": f"Payment is due within {token} days.\n",
                                "style": {},
                            }
                        ],
                    },
                ],
                "headers": {},
                "footers": {},
                "footnotes": {},
                "documentStyle": {},
                "namedStyles": {},
                "lists": {},
                "namedRanges": {},
                "inlineObjects": {},
                "positionedObjects": {},
                "childTabs": [],
            }
        ],
    }


class FakeGoogleWriteProvider:
    def __init__(self, baseline: dict[str, Any], expected: dict[str, Any]) -> None:
        self.baseline = baseline
        self.expected = expected
        self.current = baseline
        self.revision = "revision-A"
        self.backup_verification = BackupVerification(
            independently_readable=True,
            separate_file=True,
            expected_mime_type=True,
            expected_location=True,
            content_matches_baseline=True,
            acl_not_broader=True,
            canonical_sha256=sha256_json(baseline),
            evidence={"permission_comparison": "not_broader"},
        )
        self.commit_result = GuardedCommitResult(
            classification=CommitClassification.SUCCEEDED,
            resulting_revision_id="revision-B",
        )
        self.copy_unknown = False
        self.commit_unknown = False
        self.change_after_backup = False
        self.unknown_postimage: dict[str, Any] | None = None
        self.unknown_revision = "revision-B"
        self.block_copy: asyncio.Event | None = None
        self.copy_entered = asyncio.Event()
        self.events: list[str] = []
        self.copy_calls = 0
        self.verify_calls = 0
        self.verify_error: GoogleIntegrationError | None = None
        self.commit_calls = 0
        self.operations: list[object] = []

    async def inspect_current(
        self, *, file_id: str, destination_parent_id: str
    ) -> CurrentGoogleDocument:
        self.events.append("read")
        return CurrentGoogleDocument(
            identity=GoogleFileIdentity(
                file_id=file_id,
                parent_ids=(destination_parent_id,),
                mime_type=GOOGLE_DOC_MIME,
            ),
            name="Synthetic contract",
            revision_id=self.revision,
            native_raw_sha256="1" * 64,
            canonical_schema_version="docrelay.google-native-canonical.v1",
            canonical_sha256=sha256_json(self.current),
            canonical_payload=self.current,
            capabilities=GoogleCapabilities(
                can_edit=True,
                can_modify_content=True,
                can_download=True,
                can_copy=True,
                destination_can_add_children=True,
            ),
            safe_provider_metadata={"trashed": False},
        )

    async def create_backup(
        self,
        *,
        file_id: str,
        destination_parent_id: str,
        backup_name: str,
        operation_metadata: dict[str, str],
    ) -> BackupReceipt:
        self.events.append("copy")
        self.copy_calls += 1
        self.copy_entered.set()
        if self.block_copy is not None:
            await self.block_copy.wait()
        if self.copy_unknown:
            raise GoogleEffectOutcomeUnknown("backup response was not received")
        if self.change_after_backup:
            self.current = _canonical("45", neighbor="Human edit retained.\n")
            self.revision = "revision-human"
        assert "DocRelay backup" in backup_name
        assert operation_metadata["source_revision"] == "revision-A"
        return BackupReceipt(
            backup_file_id="backup-file-1",
            parent_ids=(destination_parent_id,),
            provider_metadata={"mime_type": GOOGLE_DOC_MIME},
        )

    async def verify_backup(
        self,
        *,
        source_file_id: str,
        backup_file_id: str,
        expected_parent_id: str,
        expected_baseline_sha256: str,
    ) -> BackupVerification:
        self.events.append("verify-backup")
        self.verify_calls += 1
        if self.verify_error is not None:
            raise self.verify_error
        assert source_file_id != backup_file_id
        assert expected_baseline_sha256 == sha256_json(self.baseline)
        return self.backup_verification

    async def commit_guarded(self, *, file_id: str, operation: object) -> GuardedCommitResult:
        self.events.append("batch-update")
        self.commit_calls += 1
        self.operations.append(operation)
        if self.commit_unknown:
            self.current = self.unknown_postimage or self.expected
            self.revision = self.unknown_revision
            raise GoogleEffectOutcomeUnknown("batchUpdate response was not received")
        if self.commit_result.classification is CommitClassification.SUCCEEDED:
            self.current = self.expected
            self.revision = self.commit_result.resulting_revision_id or "revision-B"
        return self.commit_result


@asynccontextmanager
async def _environment() -> AsyncIterator[
    tuple[
        async_sessionmaker[Any],
        Phase6ExecutionService,
        FakeGoogleWriteProvider,
        Any,
        dict[str, Any],
        dict[str, Any],
    ]
]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def enable_foreign_keys(dbapi_connection: object, _: object) -> None:
        cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(UTC)
    baseline = _canonical("45")
    baseline_hash = sha256_json(baseline)

    async with sessions() as session:
        connection = CloudConnection(
            owner_subject="owner-a",
            provider=Provider.GOOGLE,
            provider_account_subject="principal-a",
            status=ConnectionStatus.CONNECTED,
            granted_scopes={"scopes": ["drive.file"]},
        )
        session.add(connection)
        await session.flush()
        document = CloudDocument(
            connection_id=connection.id,
            provider_file_id="google-file-a",
            mime_type=GOOGLE_DOC_MIME,
            display_name="Synthetic contract",
            parent_ids=["parent-a"],
            last_seen_revision_id="revision-A",
        )
        session.add(document)
        await session.flush()
        capture = GoogleBaselineCapture(
            cloud_document_id=document.id,
            provider_revision_id="revision-A",
            native_raw_sha256="1" * 64,
            native_canonical_sha256=baseline_hash,
            exported_docx_sha256="2" * 64,
            exported_docx_size_bytes=9000,
            canonicalizer_version="docrelay.google-native-canonical.v1",
            canonical_payload=baseline,
            capability_evidence={"canModifyContent": True},
            parent_ids=["parent-a"],
            attempt_count=1,
            capture_started_at=now,
            captured_at=now,
            provider_evidence={"read_only": True},
        )
        session.add(capture)
        await session.flush()
        run = SyncRun(
            cloud_document_id=document.id,
            rule_snapshot={
                "instruction": "Change 45 days to 30 days.",
                "instruction_sha256": "3" * 64,
            },
            mode=SyncMode.PREVIEW,
            state=SyncRunState.REVIEWED_EXPORT_READY,
            state_version=7,
            intent_key="4" * 64,
            baseline_revision_id="revision-A",
            started_at=now,
        )
        session.add(run)
        await session.flush()
        snapshot = SourceSnapshot(
            sync_run_id=run.id,
            cloud_document_id=document.id,
            provider_revision_id="revision-A",
            source_format=GOOGLE_DOC_MIME,
            captured_at=now,
            native_raw_sha256="1" * 64,
            native_canonical_sha256=baseline_hash,
            exported_artifact_sha256="5" * 64,
            artifact_reference="baselines/run-a.docx",
            schema_version="docrelay.google-native-canonical.v1",
            capability_evidence={"canModifyContent": True},
            provider_evidence={"selected_baseline_capture_id": str(capture.id)},
        )
        session.add(snapshot)
        await session.flush()
        sd_session = SuperDocsSession(
            sync_run_id=run.id,
            session_id="session-a",
            raw_evidence={"fresh_ingestion": True},
        )
        session.add(sd_session)
        await session.flush()
        sd_document = SuperDocsDocument(
            superdocs_session_id=sd_session.id,
            source_snapshot_id=snapshot.id,
            role=SuperDocsDocumentRole.TARGET,
            session_document_id="document-a",
            durable_document_id="durable-a",
            upload_version_id="upload-a",
            final_version_id="final-a",
            baseline_html_sha256="6" * 64,
            baseline_evidence={"fresh": True},
        )
        session.add(sd_document)
        await session.flush()
        job = SuperDocsJob(
            sync_run_id=run.id,
            superdocs_session_id=sd_session.id,
            target_document_id=sd_document.id,
            provider_job_id="job-a",
            status=SuperDocsJobStatus.COMPLETED,
            start_request_sha256="7" * 64,
            raw_state={"status": "completed"},
            usage_evidence={"ops_charged": 1},
            started_at=now,
            completed_at=now,
        )
        session.add(job)
        await session.flush()
        review_round = ReviewRound(
            sync_run_id=run.id,
            superdocs_job_id=job.id,
            ordinal=1,
            awaiting_kind=ReviewAwaitingKind.CHANGE_BATCH,
            raw_pending_evidence={"change_ids": ["change-a"]},
            resolution=ReviewRoundResolution.SUBMIT_CHANGES,
            resolved_by_subject="owner-a",
            resolved_at=now,
        )
        session.add(review_round)
        await session.flush()
        proposal = ProposedChange(
            sync_run_id=run.id,
            superdocs_job_id=job.id,
            review_round_id=review_round.id,
            target_document_id=sd_document.id,
            superdocs_change_id="change-a",
            ordinal=1,
            operation=ProposalOperation.EDIT,
            chunk_id="ephemeral-chunk-a",
            old_html="<p>Payment is due within 45 days.</p>",
            new_html="<p>Payment is due within 30 days.</p>",
            payload_sha256="8" * 64,
            raw_payload={"operation": "edit"},
        )
        session.add(proposal)
        await session.flush()
        session.add(
            ReviewDecision(
                sync_run_id=run.id,
                proposed_change_id=proposal.id,
                decision=ChangeDecision.APPROVE,
                reviewer_subject="owner-a",
                decision_sha256="9" * 64,
            )
        )
        session.add(
            SuperDocsExport(
                sync_run_id=run.id,
                source_snapshot_id=snapshot.id,
                superdocs_session_id=sd_session.id,
                superdocs_document_id=sd_document.id,
                superdocs_job_id=job.id,
                artifact_reference="exports/run-a.docx",
                sha256="a" * 64,
                size_bytes=9000,
                content_type=(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                ),
                warnings=[],
                final_version_id="final-a",
                exported_at=now,
            )
        )
        await session.commit()
        run_id = run.id
        proposal_id = proposal.id

    dry_run = await Phase4PlanningService(sessions=sessions, owner_subject="owner-a").dry_run(
        run_id, proposal_id=proposal_id
    )
    assert dry_run.status is DryRunStatus.READY
    async with sessions() as session:
        from docrelay.persistence.models import WritePlan

        plan = await session.scalar(select(WritePlan).where(WritePlan.sync_run_id == run_id))
        assert plan is not None
        expected = _canonical("30")
        assert sha256_json(expected) == plan.expected_postimage_sha256

    provider = FakeGoogleWriteProvider(baseline, expected)
    service = Phase6ExecutionService(
        sessions=sessions,
        owner_subject="owner-a",
        provider_factory=lambda _session, _connection_id: provider,
    )
    try:
        yield sessions, service, provider, run_id, baseline, expected
    finally:
        await engine.dispose()


async def test_stale_revision_before_backup_is_conflict_with_zero_mutations() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        provider.revision = "revision-human"
        provider.current = _canonical("45", neighbor="Human edit.\n")

        result = await service.execute(run_id)

        assert result.status is WriteBackStatus.CONFLICT
        assert result.conflict is not None
        assert result.conflict.detection_stage == "BEFORE_BACKUP"
        assert provider.copy_calls == provider.commit_calls == 0


async def test_non_ready_or_inconsistent_plan_never_reaches_provider() -> None:
    async with _environment() as (sessions, service, provider, run_id, _, _):
        async with sessions() as session:
            run = await session.get(SyncRun, run_id)
            assert run is not None
            run.state = SyncRunState.AWAITING_REVIEW
            await session.commit()

        with pytest.raises(WriteBackNotEligible):
            await service.execute(run_id)
        assert provider.events == []


@pytest.mark.parametrize("tamper", ["mapping", "operation_mirror", "approval"])
async def test_immutable_plan_and_mapping_mirrors_are_revalidated_before_effects(
    tamper: str,
) -> None:
    async with _environment() as (sessions, service, provider, run_id, _, _):
        async with sessions() as session:
            if tamper == "mapping":
                proof = await session.scalar(
                    select(MappingProof).where(MappingProof.sync_run_id == run_id)
                )
                assert proof is not None
                proof.integrity_sha256 = "0" * 64
            elif tamper == "operation_mirror":
                plan = await session.scalar(
                    select(WritePlan).where(WritePlan.sync_run_id == run_id)
                )
                assert plan is not None
                plan.provider_operations = {"operations": []}
            else:
                decision = await session.scalar(
                    select(ReviewDecision).where(ReviewDecision.sync_run_id == run_id)
                )
                assert decision is not None
                decision.decision = ChangeDecision.REJECT
            await session.commit()

        with pytest.raises(WriteBackNotEligible):
            await service.execute(run_id)
        assert provider.events == []


@pytest.mark.parametrize("failure", ["canonical", "acl"])
async def test_backup_must_be_content_and_permission_verified_before_write(
    failure: str,
) -> None:
    async with _environment() as (_, service, provider, run_id, baseline, _):
        update: dict[str, Any]
        if failure == "canonical":
            update = {
                "content_matches_baseline": False,
                "canonical_sha256": sha256_json(_canonical("99")),
            }
        else:
            update = {"acl_not_broader": False}
        provider.backup_verification = provider.backup_verification.model_copy(update=update)

        result = await service.execute(run_id)

        assert result.status is WriteBackStatus.FAILED
        assert result.attention_code == "GOOGLE_BACKUP_VERIFICATION_FAILED"
        assert provider.events[:3] == ["read", "copy", "verify-backup"]
        assert provider.commit_calls == 0
        assert provider.backup_verification.canonical_sha256 != sha256_json(baseline) or (
            not provider.backup_verification.acl_not_broader
        )


async def test_backup_unknown_is_never_retried_and_never_writes() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        provider.copy_unknown = True

        first = await service.execute(run_id)
        second = await service.execute(run_id)

        assert first.status is second.status is WriteBackStatus.ATTENTION
        assert first.attention_code == "GOOGLE_BACKUP_COPY_OUTCOME_UNKNOWN"
        assert provider.copy_calls == 1
        assert provider.commit_calls == 0


async def test_backup_verification_read_can_resume_without_a_second_copy() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        provider.verify_error = GoogleIntegrationError(
            GoogleErrorCode.UNAVAILABLE,
            "Google API unavailable",
            retryable=True,
        )

        stopped = await service.execute(run_id)
        assert stopped.status is WriteBackStatus.ATTENTION
        assert stopped.attention_code == "GOOGLE_BACKUP_VERIFICATION_UNAVAILABLE"
        assert stopped.backup_created
        assert provider.copy_calls == 1
        assert provider.commit_calls == 0

        provider.verify_error = None
        resumed = await service.execute(run_id)
        assert resumed.status is WriteBackStatus.WRITE_VERIFIED
        assert provider.copy_calls == 1
        assert provider.verify_calls == 2
        assert provider.commit_calls == 1


async def test_human_change_after_backup_is_conflict_without_batch_update() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        provider.change_after_backup = True

        result = await service.execute(run_id)

        assert result.status is WriteBackStatus.CONFLICT
        assert result.conflict is not None
        assert result.conflict.detection_stage == "AFTER_BACKUP"
        assert result.backup_verified
        assert provider.copy_calls == 1
        assert provider.commit_calls == 0


async def test_exact_persisted_plan_is_sent_once_with_required_revision() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        result = await service.execute(run_id)

        assert result.status is WriteBackStatus.WRITE_VERIFIED
        assert provider.events == [
            "read",
            "copy",
            "verify-backup",
            "read",
            "batch-update",
            "read",
        ]
        assert provider.commit_calls == 1
        operation = provider.operations[0]
        assert operation.required_revision_id == "revision-A"
        assert operation.provider_payload() == {
            "requests": [
                {
                    "deleteContentRange": {
                        "range": {
                            "segmentId": "",
                            "tabId": "t.0",
                            "startIndex": 184,
                            "endIndex": 186,
                        }
                    }
                },
                {
                    "insertText": {
                        "location": {
                            "segmentId": "",
                            "tabId": "t.0",
                            "index": 184,
                        },
                        "text": "30",
                    }
                },
            ],
            "writeControl": {"requiredRevisionId": "revision-A"},
        }


async def test_provider_revision_rejection_is_durable_conflict_without_force() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        provider.commit_result = GuardedCommitResult(
            classification=CommitClassification.CONFLICT,
            safe_provider_evidence={"reason": "required_revision_mismatch"},
        )

        result = await service.execute(run_id)

        assert result.status is WriteBackStatus.CONFLICT
        assert result.conflict is not None
        assert result.conflict.detection_stage == "ATOMIC_GUARD"
        assert provider.commit_calls == 1
        assert "overwrite" not in result.model_dump_json().lower()


@pytest.mark.parametrize(
    ("postimage", "revision", "expected_status", "expected_code"),
    [
        ("expected", "revision-B", WriteBackStatus.WRITE_VERIFIED, None),
        (
            "baseline",
            "revision-A",
            WriteBackStatus.ATTENTION,
            "GOOGLE_BATCH_UPDATE_NOT_VISIBLY_APPLIED",
        ),
        (
            "unexpected",
            "revision-human",
            WriteBackStatus.CONFLICT,
            "GOOGLE_SOURCE_REVISION_CONFLICT",
        ),
    ],
)
async def test_unknown_write_reconciles_by_complete_canonical_state_without_retry(
    postimage: str,
    revision: str,
    expected_status: WriteBackStatus,
    expected_code: str | None,
) -> None:
    async with _environment() as (_, service, provider, run_id, baseline, expected):
        provider.commit_unknown = True
        provider.unknown_revision = revision
        provider.unknown_postimage = {
            "expected": expected,
            "baseline": baseline,
            "unexpected": _canonical("30", neighbor="Unexpected change.\n"),
        }[postimage]

        first = await service.execute(run_id)
        second = await service.execute(run_id)

        assert first.status is expected_status
        assert second.status is expected_status
        assert first.attention_code == expected_code
        assert provider.commit_calls == 1


async def test_unrelated_post_write_change_fails_structural_verification() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        provider.expected = _canonical("30", neighbor="Unrelated changed.\n")

        result = await service.execute(run_id)

        assert result.status is WriteBackStatus.VERIFICATION_FAILED
        assert not result.structurally_verified
        assert result.attention_code == "GOOGLE_POSTIMAGE_VERIFICATION_FAILED"


async def test_repeated_execute_after_verified_success_has_no_new_effects() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        first = await service.execute(run_id)
        second = await service.execute(run_id)

        assert first.status is second.status is WriteBackStatus.WRITE_VERIFIED
        assert provider.copy_calls == provider.commit_calls == 1


async def test_restart_after_verified_backup_reuses_it_without_second_copy() -> None:
    async with _environment() as (sessions, service, provider, run_id, baseline, _):
        await _seed_verified_backup(sessions, run_id, sha256_json(baseline))

        result = await service.execute(run_id)

        assert result.status is WriteBackStatus.WRITE_VERIFIED
        assert provider.copy_calls == 0
        assert provider.commit_calls == 1
        async with sessions() as session:
            assert await session.scalar(select(func.count()).select_from(Backup)) == 1


async def test_restart_after_started_write_reconciles_without_second_write() -> None:
    async with _environment() as (sessions, service, provider, run_id, _, expected):
        await _seed_verified_backup(sessions, run_id, sha256_json(_canonical("45")))
        await _seed_started_write(sessions, run_id)
        provider.current = expected
        provider.revision = "revision-B"

        result = await service.execute(run_id)

        assert result.status is WriteBackStatus.WRITE_VERIFIED
        assert provider.commit_calls == 0


async def test_two_concurrent_execute_calls_claim_only_one_external_workflow() -> None:
    async with _environment() as (_, service, provider, run_id, _, _):
        provider.block_copy = asyncio.Event()
        first_task = asyncio.create_task(service.execute(run_id))
        await provider.copy_entered.wait()

        second = await service.execute(run_id)
        provider.block_copy.set()
        first = await first_task

        assert second.status is WriteBackStatus.IN_PROGRESS
        assert first.status is WriteBackStatus.WRITE_VERIFIED
        assert provider.copy_calls == provider.commit_calls == 1


@pytest.mark.parametrize("choice", [ConflictChoice.CANCEL, ConflictChoice.REVIEW_LATEST])
async def test_conflict_decisions_are_explicit_and_never_execute_stale_plan(
    choice: ConflictChoice,
) -> None:
    async with _environment() as (sessions, service, provider, run_id, _, _):
        provider.revision = "revision-human"
        provider.current = _canonical("45", neighbor="Human edit.\n")
        conflict = await service.execute(run_id)
        assert conflict.status is WriteBackStatus.CONFLICT

        decided = await service.decide_conflict(run_id, choice)

        expected = (
            WriteBackStatus.CANCELLED
            if choice is ConflictChoice.CANCEL
            else WriteBackStatus.REVIEW_LATEST
        )
        assert decided.status is expected
        assert provider.copy_calls == provider.commit_calls == 0
        async with sessions() as session:
            row = await session.scalar(
                select(WriteConflict).where(WriteConflict.sync_run_id == run_id)
            )
            assert row is not None and row.decision is choice
            assert await session.scalar(select(func.count()).select_from(VerificationResult)) == 0


async def test_execution_evidence_and_response_do_not_expose_secrets_or_raw_bodies() -> None:
    async with _environment() as (sessions, service, _provider, run_id, _, _):
        result = await service.execute(run_id)
        serialized = result.model_dump_json().lower()
        for forbidden in (
            "authorization",
            "access_token",
            "refresh_token",
            "superdocs_api_key",
            "payment is due",
        ):
            assert forbidden not in serialized

        async with sessions() as session:
            effects = tuple(await session.scalars(select(ExternalEffect)))
            assert {effect.effect_type for effect in effects} == {
                EffectType.GOOGLE_BACKUP_COPY,
                EffectType.GOOGLE_BATCH_UPDATE,
            }
            assert all("Authorization" not in str(effect.request_metadata) for effect in effects)
            assert all(effect.outcome is EffectOutcome.SUCCEEDED for effect in effects)
            backup = await session.scalar(select(Backup))
            assert backup is not None and backup.status is BackupStatus.VERIFIED


async def _seed_verified_backup(
    sessions: async_sessionmaker[Any], run_id: Any, canonical_sha256: str
) -> None:
    async with sessions() as session:
        plan = await session.scalar(select(WritePlan).where(WritePlan.sync_run_id == run_id))
        run = await session.get(SyncRun, run_id)
        assert plan is not None and run is not None
        effect = ExternalEffect(
            sync_run_id=run_id,
            effect_key=f"google-backup:{plan.id}",
            effect_type=EffectType.GOOGLE_BACKUP_COPY,
            outcome=EffectOutcome.SUCCEEDED,
            request_fingerprint="b" * 64,
            request_metadata={"write_plan_sha256": plan.integrity_sha256},
            provider_external_id="backup-file-1",
            attempt_count=1,
            started_at=datetime.now(UTC),
            resolved_at=datetime.now(UTC),
        )
        session.add(effect)
        await session.flush()
        session.add(
            Backup(
                sync_run_id=run_id,
                write_plan_id=plan.id,
                external_effect_id=effect.id,
                status=BackupStatus.VERIFIED,
                provider_backup_file_id="backup-file-1",
                baseline_revision_id="revision-A",
                canonical_sha256=canonical_sha256,
                location_evidence={"expected_parent": "parent-a"},
                acl_evidence={"acl_not_broader": True},
                verified_at=datetime.now(UTC),
            )
        )
        run.state = SyncRunState.COMMITTING
        await session.commit()


async def _seed_started_write(sessions: async_sessionmaker[Any], run_id: Any) -> None:
    async with sessions() as session:
        plan = await session.scalar(select(WritePlan).where(WritePlan.sync_run_id == run_id))
        assert plan is not None
        session.add(
            ExternalEffect(
                sync_run_id=run_id,
                effect_key=f"google-batch-update:{plan.id}",
                effect_type=EffectType.GOOGLE_BATCH_UPDATE,
                outcome=EffectOutcome.STARTED,
                request_fingerprint=plan.integrity_sha256,
                request_metadata={"write_plan_sha256": plan.integrity_sha256},
                attempt_count=1,
                started_at=datetime.now(UTC) - timedelta(hours=1),
            )
        )
        await session.commit()
