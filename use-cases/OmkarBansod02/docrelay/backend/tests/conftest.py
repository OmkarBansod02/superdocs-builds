from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from docrelay.domain.enums import Provider
from docrelay.domain.write_plan import (
    ApprovalLineageContract,
    ExpectedPostimageContract,
    GoogleDocsBatchUpdate,
    MappingProofContract,
    RuleContract,
    SealedWritePlan,
    SourceSnapshotContract,
    WritePlanPayload,
)

ZERO_HASH = "0" * 64
ONE_HASH = "1" * 64
TWO_HASH = "2" * 64
THREE_HASH = "3" * 64


@pytest.fixture
def write_plan_factory() -> Callable[..., SealedWritePlan]:
    def build(
        *,
        sync_run_id: UUID | None = None,
        snapshot_id: UUID | None = None,
        rule_id: UUID | None = None,
        mapping_proof_id: UUID | None = None,
        proposal_id: UUID | None = None,
        decision_id: UUID | None = None,
    ) -> SealedWritePlan:
        now = datetime(2026, 8, 7, 17, 0, tzinfo=UTC)
        baseline_revision = "revision-A"
        payload = WritePlanPayload(
            created_at=now,
            expires_at=now + timedelta(hours=12),
            sync_run_id=sync_run_id or uuid4(),
            source=SourceSnapshotContract(
                snapshot_id=snapshot_id or uuid4(),
                provider=Provider.GOOGLE,
                provider_principal_subject="google-principal-1",
                provider_file_id="immutable-google-file-id",
                parent_ids=("parent-folder-id",),
                baseline_revision_id=baseline_revision,
                native_raw_sha256=ZERO_HASH,
                native_canonical_sha256=ONE_HASH,
                exported_docx_sha256=TWO_HASH,
            ),
            rule=RuleContract(
                rule_id=rule_id or uuid4(),
                version=1,
                instruction_sha256=TWO_HASH,
                configuration_sha256=THREE_HASH,
            ),
            mapping=MappingProofContract(
                mapping_proof_id=mapping_proof_id or uuid4(),
                schema_version="docrelay.mapping-proof.v1",
                mapper_version="docrelay.google-plain-token-mapper.v1",
                integrity_sha256=THREE_HASH,
            ),
            approval_lineage=(
                ApprovalLineageContract(
                    proposal_id=proposal_id or uuid4(),
                    decision_id=decision_id or uuid4(),
                    review_round=2,
                    session_id="session-for-revision-A",
                    session_document_id="doc_primary",
                    durable_document_id="durable-audit-id",
                    job_id="superdocs-job-id",
                    superdocs_change_id="replacement-change-id",
                    chunk_id="fresh-ingestion-chunk-id",
                    approved=True,
                    old_html_sha256=ZERO_HASH,
                    new_html_sha256=ONE_HASH,
                ),
            ),
            provider_operations=(
                GoogleDocsBatchUpdate(
                    required_revision_id=baseline_revision,
                    requests=(
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
                                "location": {"segmentId": "", "tabId": "t.0", "index": 184},
                                "text": "30",
                            }
                        },
                    ),
                ),
            ),
            expected_postimage=ExpectedPostimageContract(
                schema_version="docrelay.google-canonical.v1",
                verifier_version="docrelay.google-native-canonical.v1",
                canonical_sha256=THREE_HASH,
                canonical_payload={"paragraph": "Payment is due within 30 days."},
            ),
        )
        return SealedWritePlan.seal(payload)

    return build
