import hashlib
import re
from copy import deepcopy
from datetime import datetime
from enum import StrEnum
from html.parser import HTMLParser
from typing import Any, Literal, NoReturn, Self
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from docrelay.domain.enums import ChangeDecision, ProposalOperation, Provider
from docrelay.domain.write_plan import (
    ApprovalLineageContract,
    ExpectedPostimageContract,
    ExpectedReplacementContract,
    GoogleDocsBatchUpdate,
    MappingProofContract,
    RuleContract,
    SealedWritePlan,
    Sha256,
    SourceSnapshotContract,
    WritePlanPayload,
    canonical_json_bytes,
)
from docrelay.integrations.google.canonical import sha256_json

MAPPER_VERSION = "docrelay.google-plain-token-mapper.v1"
COMPILER_VERSION = "docrelay.google-write-plan-compiler.v1"
MAPPING_SCHEMA_VERSION = "docrelay.mapping-proof.v1"
VERIFIER_VERSION = "docrelay.google-native-canonical.v1"
_ASCII_TOKEN = re.compile(r"[A-Za-z0-9]+")


class MappingFailureCode(StrEnum):
    NOT_APPROVED = "NOT_APPROVED"
    UNDECIDED = "UNDECIDED"
    SUPERSEDED = "SUPERSEDED"
    STALE_LINEAGE = "STALE_LINEAGE"
    UNSUPPORTED_OPERATION = "UNSUPPORTED_OPERATION"
    MALFORMED_REVIEW_HTML = "MALFORMED_REVIEW_HTML"
    FORMATTING_DELTA = "FORMATTING_DELTA"
    NON_CONTIGUOUS_REPLACEMENT = "NON_CONTIGUOUS_REPLACEMENT"
    NON_INTERNAL_REPLACEMENT = "NON_INTERNAL_REPLACEMENT"
    NON_ASCII_REPLACEMENT = "NON_ASCII_REPLACEMENT"
    UNEQUAL_UTF16_LENGTH = "UNEQUAL_UTF16_LENGTH"
    WRONG_REVISION = "WRONG_REVISION"
    STALE_SNAPSHOT = "STALE_SNAPSHOT"
    MALFORMED_SNAPSHOT = "MALFORMED_SNAPSHOT"
    PREIMAGE_MISSING = "PREIMAGE_MISSING"
    AMBIGUOUS_PREIMAGE = "AMBIGUOUS_PREIMAGE"
    UNSUPPORTED_TABLE_LOCATION = "UNSUPPORTED_TABLE_LOCATION"
    UNSUPPORTED_NON_BODY_LOCATION = "UNSUPPORTED_NON_BODY_LOCATION"
    UNSUPPORTED_LIST_PARAGRAPH = "UNSUPPORTED_LIST_PARAGRAPH"
    UNSUPPORTED_PARAGRAPH_STYLE = "UNSUPPORTED_PARAGRAPH_STYLE"
    UNSUPPORTED_MULTIPLE_RUNS = "UNSUPPORTED_MULTIPLE_RUNS"
    UNSUPPORTED_TEXT_STYLE = "UNSUPPORTED_TEXT_STYLE"
    UNSUPPORTED_STRUCTURAL_LOCATION = "UNSUPPORTED_STRUCTURAL_LOCATION"
    EXISTING_PLAN_LINEAGE_MISMATCH = "EXISTING_PLAN_LINEAGE_MISMATCH"


class MappingFailure(ValueError):
    def __init__(
        self,
        code: MappingFailureCode,
        message: str,
        *,
        candidate_count: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.candidate_count = candidate_count


class _FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ReviewedProposal(_FrozenModel):
    proposal_id: UUID
    decision_id: UUID | None
    decision: ChangeDecision | None
    decision_sha256: Sha256 | None
    superseded: bool
    operation: ProposalOperation
    review_round: int = Field(ge=1)
    session_id: str = Field(min_length=1)
    session_document_id: str = Field(min_length=1)
    durable_document_id: str | None = None
    job_id: str = Field(min_length=1)
    superdocs_export_id: UUID
    approved_export_sha256: Sha256
    final_version_id: str | None = None
    superdocs_change_id: str = Field(min_length=1)
    chunk_id: str | None
    old_html: str | None
    new_html: str | None
    lineage_current: bool


class SemanticReplacement(_FrozenModel):
    proposal_id: UUID
    decision_id: UUID
    decision_sha256: Sha256
    review_round: int
    session_id: str
    session_document_id: str
    durable_document_id: str | None
    job_id: str
    superdocs_export_id: UUID
    approved_export_sha256: Sha256
    final_version_id: str | None
    superdocs_change_id: str
    chunk_id: str
    old_html_sha256: Sha256
    new_html_sha256: Sha256
    old_paragraph: str
    new_paragraph: str
    old_text: str
    new_text: str
    prefix: str
    suffix: str


class BaselineSnapshot(_FrozenModel):
    snapshot_id: UUID
    provider: Literal[Provider.GOOGLE]
    provider_principal_subject: str = Field(min_length=1)
    provider_file_id: str = Field(min_length=1)
    parent_ids: tuple[str, ...] = Field(min_length=1)
    baseline_revision_id: str = Field(min_length=1)
    run_baseline_revision_id: str = Field(min_length=1)
    capture_revision_id: str = Field(min_length=1)
    native_raw_sha256: Sha256
    native_canonical_sha256: Sha256
    exported_docx_sha256: Sha256
    canonical_payload: dict[str, JsonValue]


class ProofLineage(_FrozenModel):
    proposal_id: UUID
    decision_id: UUID
    decision_sha256: Sha256
    review_round: int
    session_id: str
    session_document_id: str
    durable_document_id: str | None
    job_id: str
    superdocs_export_id: UUID
    approved_export_sha256: Sha256
    final_version_id: str | None
    superdocs_change_id: str
    chunk_id: str
    old_html_sha256: Sha256
    new_html_sha256: Sha256


class ProviderLocation(_FrozenModel):
    tab_id: str = Field(min_length=1)
    segment_id: Literal[""] = ""
    structural_element_index: int = Field(ge=0)
    paragraph_start_index: int = Field(ge=0)
    paragraph_end_index: int = Field(gt=0)
    text_run_index: Literal[0] = 0
    text_run_start_index: int = Field(ge=0)
    text_run_end_index: int = Field(gt=0)
    edit_start_index: int = Field(ge=0)
    edit_end_index: int = Field(gt=0)


class StructuralEligibility(_FrozenModel):
    one_root_tab: Literal[True] = True
    body_segment: Literal[True] = True
    top_level_paragraph: Literal[True] = True
    normal_text: Literal[True] = True
    non_list: Literal[True] = True
    one_plain_text_run: Literal[True] = True
    no_formatting_delta: Literal[True] = True
    internal_ascii_token: Literal[True] = True
    equal_utf16_length: Literal[True] = True
    exact_preimage: Literal[True] = True
    minimum_range: Literal[True] = True


class MappingProofPayload(_FrozenModel):
    schema_version: Literal["docrelay.mapping-proof.v1"] = "docrelay.mapping-proof.v1"
    mapper_version: Literal["docrelay.google-plain-token-mapper.v1"] = (
        "docrelay.google-plain-token-mapper.v1"
    )
    status: Literal["SUPPORTED"] = "SUPPORTED"
    status_reason: Literal["ALL_V1_CONSTRAINTS_PASSED"] = "ALL_V1_CONSTRAINTS_PASSED"
    created_at: datetime
    source_snapshot_id: UUID
    provider_file_id: str
    baseline_revision_id: str
    native_snapshot_sha256: Sha256
    native_raw_sha256: Sha256
    lineage: ProofLineage
    old_text: str
    new_text: str
    old_text_sha256: Sha256
    new_text_sha256: Sha256
    old_paragraph_sha256: Sha256
    new_paragraph_sha256: Sha256
    location: ProviderLocation
    candidate_count: Literal[1] = 1
    eligibility: StructuralEligibility


class SealedMappingProof(_FrozenModel):
    mapping_proof_id: UUID
    payload: MappingProofPayload
    integrity_sha256: Sha256

    @model_validator(mode="after")
    def verify_integrity(self) -> Self:
        calculated = _hash_model(self.payload)
        if calculated != self.integrity_sha256:
            raise ValueError("MappingProof integrity mismatch")
        if self.mapping_proof_id != _identity("mapping-proof", calculated):
            raise ValueError("MappingProof deterministic identity mismatch")
        return self

    @classmethod
    def seal(cls, payload: MappingProofPayload) -> "SealedMappingProof":
        integrity = _hash_model(payload)
        return cls(
            mapping_proof_id=_identity("mapping-proof", integrity),
            payload=payload,
            integrity_sha256=integrity,
        )


class _ParagraphParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.attrs: tuple[tuple[str, str | None], ...] | None = None
        self.parts: list[str] = []
        self.inside = False
        self.closed = False
        self.invalid = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "p" or self.inside or self.attrs is not None or self.closed:
            self.invalid = True
            return
        if len({name for name, _ in attrs}) != len(attrs):
            self.invalid = True
            return
        self.attrs = tuple(sorted(attrs))
        self.inside = True

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.invalid = True

    def handle_endtag(self, tag: str) -> None:
        if tag != "p" or not self.inside or self.closed:
            self.invalid = True
            return
        self.inside = False
        self.closed = True

    def handle_data(self, data: str) -> None:
        if not self.inside:
            if data:
                self.invalid = True
            return
        self.parts.append(data)

    def handle_comment(self, data: str) -> None:
        self.invalid = True

    def unknown_decl(self, data: str) -> None:
        self.invalid = True


def normalize_reviewed_change(proposal: ReviewedProposal) -> SemanticReplacement:
    if proposal.decision is None or proposal.decision_id is None:
        raise MappingFailure(MappingFailureCode.UNDECIDED, "proposal has no decision")
    if proposal.decision is not ChangeDecision.APPROVE:
        raise MappingFailure(MappingFailureCode.NOT_APPROVED, "proposal was not approved")
    if proposal.decision_sha256 is None:
        raise MappingFailure(MappingFailureCode.STALE_LINEAGE, "decision identity is incomplete")
    if proposal.superseded:
        raise MappingFailure(MappingFailureCode.SUPERSEDED, "proposal has been superseded")
    if not proposal.lineage_current:
        raise MappingFailure(MappingFailureCode.STALE_LINEAGE, "proposal lineage is stale")
    if proposal.operation is not ProposalOperation.EDIT:
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_OPERATION,
            "only reviewed edit proposals are supported",
        )
    if proposal.chunk_id is None or proposal.old_html is None or proposal.new_html is None:
        raise MappingFailure(
            MappingFailureCode.MALFORMED_REVIEW_HTML,
            "proposal lacks strict edit evidence",
        )

    old_attrs, old_paragraph = _parse_plain_paragraph(proposal.old_html)
    new_attrs, new_paragraph = _parse_plain_paragraph(proposal.new_html)
    if old_attrs != new_attrs:
        raise MappingFailure(
            MappingFailureCode.FORMATTING_DELTA,
            "paragraph attributes changed",
        )
    prefix_length = 0
    maximum_prefix = min(len(old_paragraph), len(new_paragraph))
    while (
        prefix_length < maximum_prefix
        and old_paragraph[prefix_length] == new_paragraph[prefix_length]
    ):
        prefix_length += 1
    suffix_length = 0
    maximum_suffix = min(
        len(old_paragraph) - prefix_length,
        len(new_paragraph) - prefix_length,
    )
    while (
        suffix_length < maximum_suffix
        and old_paragraph[len(old_paragraph) - suffix_length - 1]
        == new_paragraph[len(new_paragraph) - suffix_length - 1]
    ):
        suffix_length += 1
    old_end = len(old_paragraph) - suffix_length if suffix_length else len(old_paragraph)
    new_end = len(new_paragraph) - suffix_length if suffix_length else len(new_paragraph)
    old_text = old_paragraph[prefix_length:old_end]
    new_text = new_paragraph[prefix_length:new_end]
    prefix = old_paragraph[:prefix_length]
    suffix = old_paragraph[old_end:]
    if not old_text or not new_text:
        raise MappingFailure(
            MappingFailureCode.NON_CONTIGUOUS_REPLACEMENT,
            "create/delete deltas are unsupported",
        )
    if not prefix or not suffix:
        raise MappingFailure(
            MappingFailureCode.NON_INTERNAL_REPLACEMENT,
            "replacement must be internal to the paragraph",
        )
    if _ASCII_TOKEN.fullmatch(old_text) is None or _ASCII_TOKEN.fullmatch(new_text) is None:
        raise MappingFailure(
            MappingFailureCode.NON_ASCII_REPLACEMENT,
            "replacement must be one ordinary ASCII token",
        )
    if _utf16_length(old_text) != _utf16_length(new_text):
        raise MappingFailure(
            MappingFailureCode.UNEQUAL_UTF16_LENGTH,
            "replacement must preserve UTF-16 length",
        )
    return SemanticReplacement(
        proposal_id=proposal.proposal_id,
        decision_id=proposal.decision_id,
        decision_sha256=proposal.decision_sha256,
        review_round=proposal.review_round,
        session_id=proposal.session_id,
        session_document_id=proposal.session_document_id,
        durable_document_id=proposal.durable_document_id,
        job_id=proposal.job_id,
        superdocs_export_id=proposal.superdocs_export_id,
        approved_export_sha256=proposal.approved_export_sha256,
        final_version_id=proposal.final_version_id,
        superdocs_change_id=proposal.superdocs_change_id,
        chunk_id=proposal.chunk_id,
        old_html_sha256=_sha256_text(proposal.old_html),
        new_html_sha256=_sha256_text(proposal.new_html),
        old_paragraph=old_paragraph,
        new_paragraph=new_paragraph,
        old_text=old_text,
        new_text=new_text,
        prefix=prefix,
        suffix=suffix,
    )


def map_replacement(
    change: SemanticReplacement,
    baseline: BaselineSnapshot,
    created_at: datetime,
) -> SealedMappingProof:
    if not (
        baseline.baseline_revision_id
        == baseline.run_baseline_revision_id
        == baseline.capture_revision_id
    ):
        raise MappingFailure(
            MappingFailureCode.WRONG_REVISION,
            "baseline revision lineage does not match",
        )
    if sha256_json(baseline.canonical_payload) != baseline.native_canonical_sha256:
        raise MappingFailure(
            MappingFailureCode.STALE_SNAPSHOT,
            "persisted native snapshot hash does not match",
        )

    tab, body, tab_id = _one_root_tab(baseline.canonical_payload)
    candidates: list[tuple[int, dict[str, Any]]] = []
    for index, element in enumerate(body):
        if not isinstance(element, dict):
            _malformed("body structural element is malformed")
        if element.get("type") == "paragraph":
            if _paragraph_text(element) == change.old_paragraph:
                candidates.append((index, element))
        elif element.get("type") not in {
            "sectionBreak",
            "table",
            "tableOfContents",
            "unknown",
        }:
            _malformed("unknown body structural type")

    if len(candidates) > 1:
        raise MappingFailure(
            MappingFailureCode.AMBIGUOUS_PREIMAGE,
            "approved paragraph preimage has multiple baseline candidates",
            candidate_count=len(candidates),
        )
    if not candidates:
        nested_kind = _find_unsupported_location(tab, change.old_paragraph)
        if nested_kind == "table":
            raise MappingFailure(
                MappingFailureCode.UNSUPPORTED_TABLE_LOCATION,
                "approved preimage is inside a table",
                candidate_count=0,
            )
        if nested_kind is not None:
            raise MappingFailure(
                MappingFailureCode.UNSUPPORTED_NON_BODY_LOCATION,
                "approved preimage is outside the document body",
                candidate_count=0,
            )
        raise MappingFailure(
            MappingFailureCode.PREIMAGE_MISSING,
            "approved paragraph preimage is absent from baseline",
            candidate_count=0,
        )

    structural_index, paragraph = candidates[0]
    if paragraph.get("bullet") is not None:
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_LIST_PARAGRAPH,
            "list paragraphs are outside the proven subset",
            candidate_count=1,
        )
    style = paragraph.get("paragraphStyle")
    if not isinstance(style, dict) or style.get("namedStyleType") != "NORMAL_TEXT":
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_PARAGRAPH_STYLE,
            "paragraph is not ordinary NORMAL_TEXT",
            candidate_count=1,
        )
    if paragraph.get("positionedObjectIds") not in (None, []):
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_STRUCTURAL_LOCATION,
            "paragraph contains positioned objects",
            candidate_count=1,
        )
    runs = paragraph.get("runs")
    if not isinstance(runs, list) or len(runs) != 1:
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_MULTIPLE_RUNS,
            "paragraph must contain exactly one text run",
            candidate_count=1,
        )
    run = runs[0]
    if not isinstance(run, dict) or run.get("kind") != "text":
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_STRUCTURAL_LOCATION,
            "paragraph run is not plain text",
            candidate_count=1,
        )
    if run.get("style") != {}:
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_TEXT_STYLE,
            "explicit text styles are outside the proven subset",
            candidate_count=1,
        )
    paragraph_start = _integer_index(paragraph, "startIndex")
    paragraph_end = _integer_index(paragraph, "endIndex")
    run_start = _integer_index(run, "startIndex")
    run_end = _integer_index(run, "endIndex")
    run_text = run.get("text")
    if (
        not isinstance(run_text, str)
        or run_text != f"{change.old_paragraph}\n"
        or paragraph_start != run_start
        or paragraph_end != run_end
        or run_end - run_start != _utf16_length(run_text)
    ):
        _malformed("paragraph indexes do not match the persisted UTF-16 text run")
    edit_start = run_start + _utf16_length(change.prefix)
    edit_end = edit_start + _utf16_length(change.old_text)
    if edit_start <= run_start or edit_end >= run_end - 1:
        raise MappingFailure(
            MappingFailureCode.NON_INTERNAL_REPLACEMENT,
            "replacement range is not internal to the text run",
            candidate_count=1,
        )

    payload = MappingProofPayload(
        created_at=created_at,
        source_snapshot_id=baseline.snapshot_id,
        provider_file_id=baseline.provider_file_id,
        baseline_revision_id=baseline.baseline_revision_id,
        native_snapshot_sha256=baseline.native_canonical_sha256,
        native_raw_sha256=baseline.native_raw_sha256,
        lineage=ProofLineage(
            proposal_id=change.proposal_id,
            decision_id=change.decision_id,
            decision_sha256=change.decision_sha256,
            review_round=change.review_round,
            session_id=change.session_id,
            session_document_id=change.session_document_id,
            durable_document_id=change.durable_document_id,
            job_id=change.job_id,
            superdocs_export_id=change.superdocs_export_id,
            approved_export_sha256=change.approved_export_sha256,
            final_version_id=change.final_version_id,
            superdocs_change_id=change.superdocs_change_id,
            chunk_id=change.chunk_id,
            old_html_sha256=change.old_html_sha256,
            new_html_sha256=change.new_html_sha256,
        ),
        old_text=change.old_text,
        new_text=change.new_text,
        old_text_sha256=_sha256_text(change.old_text),
        new_text_sha256=_sha256_text(change.new_text),
        old_paragraph_sha256=_sha256_text(change.old_paragraph),
        new_paragraph_sha256=_sha256_text(change.new_paragraph),
        location=ProviderLocation(
            tab_id=tab_id,
            structural_element_index=structural_index,
            paragraph_start_index=paragraph_start,
            paragraph_end_index=paragraph_end,
            text_run_start_index=run_start,
            text_run_end_index=run_end,
            edit_start_index=edit_start,
            edit_end_index=edit_end,
        ),
        eligibility=StructuralEligibility(),
    )
    return SealedMappingProof.seal(payload)


def compile_write_plan(
    *,
    change: SemanticReplacement,
    baseline: BaselineSnapshot,
    proof: SealedMappingProof,
    sync_run_id: UUID,
    rule_identity: UUID,
    rule_version: int,
    instruction_sha256: Sha256,
    configuration_sha256: Sha256,
    created_at: datetime,
    expires_at: datetime,
) -> SealedWritePlan:
    proof_payload = proof.payload
    if (
        proof_payload.source_snapshot_id != baseline.snapshot_id
        or proof_payload.baseline_revision_id != baseline.baseline_revision_id
        or proof_payload.native_snapshot_sha256 != baseline.native_canonical_sha256
        or proof_payload.lineage.proposal_id != change.proposal_id
        or proof_payload.lineage.decision_id != change.decision_id
        or proof_payload.old_text_sha256 != _sha256_text(change.old_text)
        or proof_payload.new_text_sha256 != _sha256_text(change.new_text)
    ):
        raise MappingFailure(
            MappingFailureCode.STALE_LINEAGE,
            "MappingProof does not bind to the requested immutable inputs",
        )
    location = proof_payload.location
    requests: tuple[dict[str, JsonValue], ...] = (
        {
            "deleteContentRange": {
                "range": {
                    "segmentId": location.segment_id,
                    "tabId": location.tab_id,
                    "startIndex": location.edit_start_index,
                    "endIndex": location.edit_end_index,
                }
            }
        },
        {
            "insertText": {
                "location": {
                    "segmentId": location.segment_id,
                    "tabId": location.tab_id,
                    "index": location.edit_start_index,
                },
                "text": change.new_text,
            }
        },
    )
    expected = deepcopy(baseline.canonical_payload)
    tabs = expected["tabs"]
    assert isinstance(tabs, list)
    tab = tabs[0]
    assert isinstance(tab, dict)
    body = tab["body"]
    assert isinstance(body, list)
    paragraph = body[location.structural_element_index]
    assert isinstance(paragraph, dict)
    runs = paragraph["runs"]
    assert isinstance(runs, list)
    run = runs[0]
    assert isinstance(run, dict)
    run["text"] = f"{change.new_paragraph}\n"
    expected_sha256 = sha256_json(expected)
    payload = WritePlanPayload(
        created_at=created_at,
        expires_at=expires_at,
        sync_run_id=sync_run_id,
        source=SourceSnapshotContract(
            snapshot_id=baseline.snapshot_id,
            provider=Provider.GOOGLE,
            provider_principal_subject=baseline.provider_principal_subject,
            provider_file_id=baseline.provider_file_id,
            parent_ids=baseline.parent_ids,
            baseline_revision_id=baseline.baseline_revision_id,
            native_raw_sha256=baseline.native_raw_sha256,
            native_canonical_sha256=baseline.native_canonical_sha256,
            exported_docx_sha256=baseline.exported_docx_sha256,
        ),
        rule=RuleContract(
            rule_id=rule_identity,
            version=rule_version,
            instruction_sha256=instruction_sha256,
            configuration_sha256=configuration_sha256,
        ),
        mapping=MappingProofContract(
            mapping_proof_id=proof.mapping_proof_id,
            schema_version=proof_payload.schema_version,
            mapper_version=proof_payload.mapper_version,
            integrity_sha256=proof.integrity_sha256,
        ),
        compiler_version=COMPILER_VERSION,
        approval_lineage=(
            ApprovalLineageContract(
                proposal_id=change.proposal_id,
                decision_id=change.decision_id,
                review_round=change.review_round,
                session_id=change.session_id,
                session_document_id=change.session_document_id,
                durable_document_id=change.durable_document_id,
                job_id=change.job_id,
                superdocs_export_id=change.superdocs_export_id,
                approved_export_sha256=change.approved_export_sha256,
                final_version_id=change.final_version_id,
                superdocs_change_id=change.superdocs_change_id,
                chunk_id=change.chunk_id,
                approved=True,
                old_html_sha256=change.old_html_sha256,
                new_html_sha256=change.new_html_sha256,
            ),
        ),
        expected_replacement=ExpectedReplacementContract(
            old_text=change.old_text,
            new_text=change.new_text,
            old_paragraph_sha256=_sha256_text(change.old_paragraph),
            new_paragraph_sha256=_sha256_text(change.new_paragraph),
        ),
        provider_operations=(
            GoogleDocsBatchUpdate(
                required_revision_id=baseline.baseline_revision_id,
                requests=requests,
            ),
        ),
        expected_postimage=ExpectedPostimageContract(
            schema_version="docrelay.google-canonical.v1",
            verifier_version=VERIFIER_VERSION,
            canonical_sha256=expected_sha256,
            canonical_payload={
                "tab_id": location.tab_id,
                "segment_id": location.segment_id,
                "structural_element_index": location.structural_element_index,
                "paragraph_start_index": location.paragraph_start_index,
                "paragraph_end_index": location.paragraph_end_index,
                "paragraph_sha256": _sha256_text(change.new_paragraph),
            },
        ),
    )
    return SealedWritePlan.seal(payload)


def write_plan_identity(plan: SealedWritePlan) -> UUID:
    return _identity("write-plan", plan.integrity_sha256)


def _parse_plain_paragraph(html: str) -> tuple[tuple[tuple[str, str | None], ...], str]:
    parser = _ParagraphParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception as exc:
        raise MappingFailure(
            MappingFailureCode.MALFORMED_REVIEW_HTML,
            "proposal HTML is malformed",
        ) from exc
    if parser.invalid or parser.inside or not parser.closed or parser.attrs is None:
        code = (
            MappingFailureCode.FORMATTING_DELTA
            if "<" in html and html.lstrip().startswith("<p")
            else MappingFailureCode.MALFORMED_REVIEW_HTML
        )
        raise MappingFailure(code, "proposal must contain one plain paragraph")
    return parser.attrs, "".join(parser.parts)


def _one_root_tab(
    payload: dict[str, JsonValue],
) -> tuple[dict[str, Any], list[Any], str]:
    tabs = payload.get("tabs")
    if not isinstance(tabs, list):
        _malformed("native snapshot tabs are malformed")
    if len(tabs) != 1:
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_STRUCTURAL_LOCATION,
            "exactly one root tab is required",
        )
    if not isinstance(tabs[0], dict):
        _malformed("native snapshot root tab is malformed")
    tab = tabs[0]
    if tab.get("childTabs") not in (None, []):
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_STRUCTURAL_LOCATION,
            "child tabs are outside the proven subset",
        )
    properties = tab.get("tabProperties")
    body = tab.get("body")
    if not isinstance(properties, dict) or not isinstance(body, list):
        _malformed("native tab is missing properties or body")
    if properties.get("parentTabId") is not None or properties.get("nestingLevel") not in (0, None):
        raise MappingFailure(
            MappingFailureCode.UNSUPPORTED_STRUCTURAL_LOCATION,
            "mapped tab is not a root tab",
        )
    tab_id = properties.get("tabId")
    if not isinstance(tab_id, str) or not tab_id:
        _malformed("native root tab has no tabId")
    return tab, body, tab_id


def _paragraph_text(paragraph: dict[str, Any]) -> str | None:
    runs = paragraph.get("runs")
    if not isinstance(runs, list):
        _malformed("paragraph runs are malformed")
    parts: list[str] = []
    for run in runs:
        if not isinstance(run, dict):
            _malformed("paragraph run is malformed")
        if run.get("kind") != "text":
            return None
        text = run.get("text")
        if not isinstance(text, str):
            _malformed("text run content is malformed")
        parts.append(text)
    full = "".join(parts)
    if not full.endswith("\n") or full.endswith("\n\n"):
        _malformed("paragraph lacks one provider newline")
    return full[:-1]


def _find_unsupported_location(tab: dict[str, Any], old_paragraph: str) -> str | None:
    body = tab.get("body")
    assert isinstance(body, list)
    for element in body:
        if isinstance(element, dict) and element.get("type") == "table":
            if _contains_paragraph(element, old_paragraph):
                return "table"
    for segment_name in ("headers", "footers", "footnotes"):
        segments = tab.get(segment_name)
        if not isinstance(segments, dict):
            _malformed(f"{segment_name} map is malformed")
        for segment in segments.values():
            if _contains_paragraph(segment, old_paragraph):
                return segment_name
    return None


def _contains_paragraph(value: Any, old_paragraph: str) -> bool:
    if isinstance(value, dict):
        if value.get("type") == "paragraph" and _paragraph_text(value) == old_paragraph:
            return True
        return any(_contains_paragraph(child, old_paragraph) for child in value.values())
    if isinstance(value, list):
        return any(_contains_paragraph(child, old_paragraph) for child in value)
    return False


def _integer_index(value: dict[str, Any], key: str) -> int:
    result = value.get(key)
    if not isinstance(result, int) or isinstance(result, bool) or result < 0:
        _malformed(f"provider {key} is malformed")
    return result


def _malformed(message: str) -> NoReturn:
    raise MappingFailure(MappingFailureCode.MALFORMED_SNAPSHOT, message)


def _utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _hash_model(value: BaseModel) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _identity(kind: str, integrity: str) -> UUID:
    return uuid5(NAMESPACE_URL, f"docrelay:{kind}:{integrity}")
