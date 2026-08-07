from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from docrelay.domain.enums import ProposalOperation, SuperDocsJobStatus
from docrelay.domain.write_plan import Sha256


class SuperDocsContract(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class SessionDocumentIdentity(SuperDocsContract):
    session_id: str = Field(min_length=1)
    session_document_id: str = Field(min_length=1)
    durable_document_id: str | None = None


class IngestedDocument(SuperDocsContract):
    identity: SessionDocumentIdentity
    upload_version_id: str = Field(min_length=1)
    baseline_html_sha256: Sha256
    chunks_count: int = Field(ge=0)
    safe_evidence: dict[str, JsonValue]


class JobReference(SuperDocsContract):
    job_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    status: SuperDocsJobStatus


class PendingChange(SuperDocsContract):
    change_id: str = Field(min_length=1)
    operation: ProposalOperation
    document_id: str = Field(min_length=1)
    chunk_id: str | None = None
    old_html: str | None = None
    new_html: str | None = None
    ai_explanation: str | None = None
    insert_after_chunk_id: str | None = None
    raw_payload: dict[str, JsonValue]


class JobSnapshot(SuperDocsContract):
    reference: JobReference
    awaiting_kind: str | None = None
    pending_changes: tuple[PendingChange, ...] = ()
    pending_batch_decisions: dict[str, JsonValue] = Field(default_factory=dict)
    result: dict[str, JsonValue] | None = None
    error: dict[str, JsonValue] | None = None
    usage: dict[str, JsonValue] = Field(default_factory=dict)
    raw_payload: dict[str, JsonValue]


class ChangeReviewDecision(SuperDocsContract):
    change_id: str = Field(min_length=1)
    approved: bool
    feedback: str | None = None


class ReviewReceipt(SuperDocsContract):
    status: str = Field(min_length=1)
    batch_complete: bool
    raw_payload: dict[str, JsonValue]


class ContinueReceipt(SuperDocsContract):
    status: str = Field(min_length=1)
    raw_payload: dict[str, JsonValue]


class ExportArtifact(SuperDocsContract):
    artifact_reference: str = Field(min_length=1)
    sha256: Sha256
    size_bytes: int = Field(ge=0)
    content_disposition: str | None = None
    warnings_raw: str | None = None
    warnings: tuple[dict[str, JsonValue], ...] = ()


class DocumentIngestion(Protocol):
    async def ingest_docx(
        self,
        *,
        artifact_reference: str,
        session_id: str,
        open_mode: str = "replace",
    ) -> IngestedDocument: ...


class EditJobStart(Protocol):
    async def start_edit(
        self,
        *,
        target: SessionDocumentIdentity,
        instruction: str,
        approval_mode: str = "ask_every_time",
    ) -> JobReference: ...


class JobObservation(Protocol):
    async def get_job(self, job_id: str) -> JobSnapshot: ...

    async def recover_session_jobs(self, session_id: str) -> tuple[JobSnapshot, ...]: ...


class ReviewSubmission(Protocol):
    async def submit_decisions(
        self,
        *,
        session_id: str,
        job_id: str,
        decisions: tuple[ChangeReviewDecision, ...],
    ) -> ReviewReceipt: ...

    async def submit_continue(
        self,
        *,
        session_id: str,
        job_id: str,
        should_continue: bool,
    ) -> ContinueReceipt: ...


class DocumentExport(Protocol):
    async def export_docx(
        self,
        *,
        target: SessionDocumentIdentity,
        filename: str,
    ) -> ExportArtifact: ...
