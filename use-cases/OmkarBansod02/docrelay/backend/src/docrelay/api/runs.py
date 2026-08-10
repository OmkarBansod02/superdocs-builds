from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Body, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from docrelay.core.config import Settings
from docrelay.integrations.google.runtime import GoogleRuntime
from docrelay.integrations.google.services import GoogleConnectionService
from docrelay.integrations.superdocs.runtime import SuperDocsRuntime
from docrelay.persistence.database import Database
from docrelay.persistence.models import (
    CloudConnection,
    CloudDocument,
    GoogleBaselineCapture,
)
from docrelay.services.artifacts import ArtifactStore
from docrelay.services.phase3 import (
    DecisionInput,
    ExportNotReady,
    ExportView,
    Phase3Baseline,
    Phase3Orchestrator,
    ProposalView,
    RunView,
    SelectedBaselineChanged,
    SourceNotFound,
    SuperDocsNotConfigured,
)

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])


class RunAPIModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartRunRequest(RunAPIModel):
    source_id: UUID
    baseline_capture_id: UUID
    instruction: str = Field(min_length=1, max_length=20_000)
    model_tier: Literal["core", "turbo", "pro", "max"] | None = None
    thinking_depth: Literal["fast", "balanced", "deep"] | None = None


class DecisionRequest(RunAPIModel):
    proposal_id: UUID
    approve: bool
    feedback: str | None = Field(default=None, max_length=10_000)


class SubmitDecisionsRequest(RunAPIModel):
    decisions: tuple[DecisionRequest, ...] = Field(min_length=1)


class ContinueRequest(RunAPIModel):
    should_continue: bool


class ResumeRequest(RunAPIModel):
    allow_definitive_retry: bool = False


class ProposalsResponse(RunAPIModel):
    run_id: UUID
    proposals: tuple[ProposalView, ...]


def _orchestrator(request: Request) -> Phase3Orchestrator:
    runtime: SuperDocsRuntime | None = request.app.state.superdocs_runtime
    if runtime is None:
        raise SuperDocsNotConfigured("SuperDocs is not configured on this server")
    database: Database = request.app.state.database
    artifacts: ArtifactStore = request.app.state.artifact_store
    settings: Settings = request.app.state.settings
    return Phase3Orchestrator(
        sessions=database.sessions,
        superdocs=runtime.client,
        artifacts=artifacts,
        owner_subject=settings.docrelay_owner_subject,
    )


@router.post("", response_model=RunView, status_code=status.HTTP_201_CREATED)
async def start_run(
    request: Request,
    payload: Annotated[StartRunRequest, Body()],
) -> RunView:
    orchestrator = _orchestrator(request)
    google_runtime: GoogleRuntime | None = request.app.state.google_runtime
    if google_runtime is None:
        raise SuperDocsNotConfigured(
            "Google and SuperDocs must both be configured to start a production run"
        )
    database: Database = request.app.state.database
    settings: Settings = request.app.state.settings
    async with database.sessions() as session:
        selected = await session.scalar(
            select(GoogleBaselineCapture)
            .join(
                CloudDocument,
                CloudDocument.id == GoogleBaselineCapture.cloud_document_id,
            )
            .join(CloudConnection, CloudConnection.id == CloudDocument.connection_id)
            .where(
                GoogleBaselineCapture.id == payload.baseline_capture_id,
                GoogleBaselineCapture.cloud_document_id == payload.source_id,
                CloudConnection.owner_subject == settings.docrelay_owner_subject,
            )
        )
        if selected is None:
            raise SourceNotFound("selected immutable Google baseline was not found")
        google = GoogleConnectionService(
            session=session,
            runtime=google_runtime,
            owner_subject=settings.docrelay_owner_subject,
            state_ttl_seconds=settings.google_oauth_state_ttl_seconds,
            refresh_skew_seconds=settings.google_access_token_refresh_skew_seconds,
            baseline_max_attempts=settings.google_baseline_max_attempts,
        )
        recaptured = await google.recapture_registered_source(payload.source_id)

    result = recaptured.result
    if (
        result.revision_id != selected.provider_revision_id
        or result.native_raw_sha256 != selected.native_raw_sha256
        or result.native_canonical_sha256 != selected.native_canonical_sha256
    ):
        raise SelectedBaselineChanged(
            "the selected Google baseline is no longer the current immutable revision"
        )
    phase3_baseline = Phase3Baseline(
        cloud_document_id=recaptured.document.id,
        provider_revision_id=result.revision_id,
        source_format=recaptured.document.mime_type,
        captured_at=result.captured_at,
        native_raw_sha256=result.native_raw_sha256,
        native_canonical_sha256=result.native_canonical_sha256,
        exported_docx_sha256=result.exported_docx_sha256,
        canonical_schema_version=result.canonicalizer_version,
        capability_evidence=recaptured.capture.capability_evidence,
        provider_evidence=recaptured.capture.provider_evidence
        | {
            "selected_baseline_capture_id": str(selected.id),
            "selected_capture_docx_sha256": selected.exported_docx_sha256,
            "per_run_docx_sha256": result.exported_docx_sha256,
        },
        docx_bytes=result.docx_bytes,
        filename=f"docrelay-source-{recaptured.document.id}.docx",
    )
    return await orchestrator.start_run(
        baseline=phase3_baseline,
        instruction=payload.instruction,
        model_tier=payload.model_tier,
        thinking_depth=payload.thinking_depth,
    )


@router.get("/{run_id}", response_model=RunView)
async def get_run(run_id: UUID, request: Request) -> RunView:
    return await _orchestrator(request).get_run(run_id)


@router.post("/{run_id}/resume", response_model=RunView)
async def resume_run(
    run_id: UUID,
    request: Request,
    payload: Annotated[ResumeRequest | None, Body()] = None,
) -> RunView:
    return await _orchestrator(request).resume(
        run_id,
        allow_definitive_retry=(payload.allow_definitive_retry if payload else False),
    )


@router.get("/{run_id}/proposals", response_model=ProposalsResponse)
async def list_proposals(run_id: UUID, request: Request) -> ProposalsResponse:
    proposals = await _orchestrator(request).list_proposals(run_id)
    return ProposalsResponse(run_id=run_id, proposals=proposals)


@router.post("/{run_id}/decisions", response_model=RunView)
async def submit_decisions(
    run_id: UUID,
    request: Request,
    payload: Annotated[SubmitDecisionsRequest, Body()],
) -> RunView:
    settings: Settings = request.app.state.settings
    return await _orchestrator(request).submit_decisions(
        run_id,
        decisions=tuple(
            DecisionInput(
                proposal_id=item.proposal_id,
                approve=item.approve,
                feedback=item.feedback,
            )
            for item in payload.decisions
        ),
        reviewer_subject=settings.docrelay_owner_subject,
    )


@router.post("/{run_id}/continue", response_model=RunView)
async def submit_continue(
    run_id: UUID,
    request: Request,
    payload: Annotated[ContinueRequest, Body()],
) -> RunView:
    settings: Settings = request.app.state.settings
    return await _orchestrator(request).submit_continue(
        run_id,
        should_continue=payload.should_continue,
        reviewer_subject=settings.docrelay_owner_subject,
    )


@router.get("/{run_id}/export", response_model=ExportView)
async def get_export(run_id: UUID, request: Request) -> ExportView:
    view = await _orchestrator(request).get_run(run_id)
    if view.export is None:
        raise ExportNotReady("reviewed SuperDocs export metadata is not ready")
    return view.export
