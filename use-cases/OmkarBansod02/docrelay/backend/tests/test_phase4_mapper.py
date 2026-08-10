from copy import deepcopy
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from pydantic import ValidationError

from docrelay.domain.enums import ChangeDecision, ProposalOperation, Provider
from docrelay.domain.write_plan import SealedWritePlan
from docrelay.integrations.google.canonical import sha256_json
from docrelay.mapping.production import (
    BaselineSnapshot,
    MappingFailure,
    MappingFailureCode,
    ReviewedProposal,
    compile_write_plan,
    map_replacement,
    normalize_reviewed_change,
)

NOW = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)
ZERO_HASH = "0" * 64
ONE_HASH = "1" * 64
TWO_HASH = "2" * 64


def _paragraph(
    text: str = "Payment is due within 45 days.",
    *,
    start: int = 162,
    bullet: dict[str, str] | None = None,
    runs: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    content = f"{text}\n"
    end = start + len(content.encode("utf-16-le")) // 2
    return {
        "startIndex": start,
        "endIndex": end,
        "type": "paragraph",
        "paragraphStyle": {"namedStyleType": "NORMAL_TEXT"},
        "bullet": bullet,
        "positionedObjectIds": [],
        "runs": runs
        or [
            {
                "kind": "text",
                "startIndex": start,
                "endIndex": end,
                "text": content,
                "style": {},
            }
        ],
    }


def _canonical(body: list[dict[str, object]] | None = None) -> dict[str, object]:
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
                "body": body or [_paragraph()],
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


def _proposal(**changes: object) -> ReviewedProposal:
    values: dict[str, object] = {
        "proposal_id": UUID("00000000-0000-0000-0000-000000000101"),
        "decision_id": UUID("00000000-0000-0000-0000-000000000102"),
        "decision": ChangeDecision.APPROVE,
        "decision_sha256": ZERO_HASH,
        "superseded": False,
        "operation": ProposalOperation.EDIT,
        "review_round": 1,
        "session_id": "session-a",
        "session_document_id": "document-a",
        "durable_document_id": "durable-a",
        "job_id": "job-a",
        "superdocs_export_id": UUID("00000000-0000-0000-0000-000000000103"),
        "approved_export_sha256": ONE_HASH,
        "final_version_id": "final-a",
        "superdocs_change_id": "change-a",
        "chunk_id": "ephemeral-chunk-a",
        "old_html": '<p data-id="same">Payment is due within 45 days.</p>',
        "new_html": '<p data-id="same">Payment is due within 30 days.</p>',
        "lineage_current": True,
    }
    values.update(changes)
    return ReviewedProposal.model_validate(values)


def _baseline(payload: dict[str, object] | None = None, **changes: object) -> BaselineSnapshot:
    canonical = payload or _canonical()
    values: dict[str, object] = {
        "snapshot_id": UUID("00000000-0000-0000-0000-000000000201"),
        "provider": Provider.GOOGLE,
        "provider_principal_subject": "principal-a",
        "provider_file_id": "google-file-a",
        "parent_ids": ("parent-a",),
        "baseline_revision_id": "revision-A",
        "run_baseline_revision_id": "revision-A",
        "capture_revision_id": "revision-A",
        "native_raw_sha256": ONE_HASH,
        "native_canonical_sha256": sha256_json(canonical),
        "exported_docx_sha256": TWO_HASH,
        "canonical_payload": canonical,
    }
    values.update(changes)
    return BaselineSnapshot.model_validate(values)


def _supported_mapping():
    change = normalize_reviewed_change(_proposal())
    return change, _baseline(), map_replacement(change, _baseline(), created_at=NOW)


def test_approved_unique_supported_replacement_produces_exact_proof_and_plan() -> None:
    change, baseline, proof = _supported_mapping()
    plan = compile_write_plan(
        change=change,
        baseline=baseline,
        proof=proof,
        sync_run_id=UUID("00000000-0000-0000-0000-000000000301"),
        rule_identity=UUID("00000000-0000-0000-0000-000000000302"),
        rule_version=1,
        instruction_sha256=ZERO_HASH,
        configuration_sha256=ONE_HASH,
        created_at=NOW,
        expires_at=NOW + timedelta(hours=24),
    )

    assert proof.payload.candidate_count == 1
    assert proof.payload.location.edit_start_index == 184
    assert proof.payload.location.edit_end_index == 186
    assert proof.payload.lineage.chunk_id == "ephemeral-chunk-a"
    assert proof.payload.location.model_dump().get("chunk_id") is None
    assert plan.payload.expected_replacement.old_text == "45"
    assert plan.payload.expected_replacement.new_text == "30"
    operation = plan.payload.provider_operations[0]
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
                    "location": {"segmentId": "", "tabId": "t.0", "index": 184},
                    "text": "30",
                }
            },
        ],
        "writeControl": {"requiredRevisionId": "revision-A"},
    }


@pytest.mark.parametrize(
    ("proposal", "code"),
    [
        (_proposal(decision=ChangeDecision.REJECT), MappingFailureCode.NOT_APPROVED),
        (_proposal(decision=None, decision_id=None), MappingFailureCode.UNDECIDED),
        (_proposal(superseded=True), MappingFailureCode.SUPERSEDED),
        (_proposal(lineage_current=False), MappingFailureCode.STALE_LINEAGE),
    ],
)
def test_non_current_or_non_approved_proposal_fails_closed(
    proposal: ReviewedProposal, code: MappingFailureCode
) -> None:
    with pytest.raises(MappingFailure) as error:
        normalize_reviewed_change(proposal)
    assert error.value.code is code


@pytest.mark.parametrize(
    ("changes", "code"),
    [
        ({"operation": ProposalOperation.CREATE}, MappingFailureCode.UNSUPPORTED_OPERATION),
        (
            {"new_html": '<p data-id="changed">Payment is due within 30 days.</p>'},
            MappingFailureCode.FORMATTING_DELTA,
        ),
        (
            {
                "old_html": "<p>Payment is due within café days.</p>",
                "new_html": "<p>Payment is due within bistro days.</p>",
            },
            MappingFailureCode.NON_ASCII_REPLACEMENT,
        ),
        (
            {
                "old_html": "<p>Payment is due within 45 days.</p>",
                "new_html": "<p>Payment is due within 120 days.</p>",
            },
            MappingFailureCode.UNEQUAL_UTF16_LENGTH,
        ),
    ],
)
def test_normalization_rejects_changes_outside_proven_subset(
    changes: dict[str, object], code: MappingFailureCode
) -> None:
    with pytest.raises(MappingFailure) as error:
        normalize_reviewed_change(_proposal(**changes))
    assert error.value.code is code


def test_old_preimage_missing_fails_closed() -> None:
    change = normalize_reviewed_change(_proposal())
    with pytest.raises(MappingFailure) as error:
        map_replacement(change, _baseline(_canonical([_paragraph("Unrelated text.")])), NOW)
    assert error.value.code is MappingFailureCode.PREIMAGE_MISSING


def test_duplicate_old_preimage_is_ambiguous() -> None:
    change = normalize_reviewed_change(_proposal())
    payload = _canonical([_paragraph(start=10), _paragraph(start=100)])
    with pytest.raises(MappingFailure) as error:
        map_replacement(change, _baseline(payload), NOW)
    assert error.value.code is MappingFailureCode.AMBIGUOUS_PREIMAGE
    assert error.value.candidate_count == 2


def test_table_location_is_unsupported() -> None:
    change = normalize_reviewed_change(_proposal())
    table = {
        "startIndex": 10,
        "endIndex": 100,
        "type": "table",
        "rows": 1,
        "columns": 1,
        "tableRows": [
            {
                "cells": [{"content": [_paragraph(start=12)], "tableCellStyle": {}}],
                "tableRowStyle": {},
            }
        ],
        "tableStyle": {},
    }
    with pytest.raises(MappingFailure) as error:
        map_replacement(change, _baseline(_canonical([table])), NOW)
    assert error.value.code is MappingFailureCode.UNSUPPORTED_TABLE_LOCATION


def test_list_paragraph_is_unsupported() -> None:
    change = normalize_reviewed_change(_proposal())
    payload = _canonical([_paragraph(bullet={"listId": "list-a"})])
    with pytest.raises(MappingFailure) as error:
        map_replacement(change, _baseline(payload), NOW)
    assert error.value.code is MappingFailureCode.UNSUPPORTED_LIST_PARAGRAPH


def test_multiple_runs_or_formatting_boundary_is_unsupported() -> None:
    change = normalize_reviewed_change(_proposal())
    runs = [
        {
            "kind": "text",
            "startIndex": 162,
            "endIndex": 184,
            "text": "Payment is due within ",
            "style": {},
        },
        {
            "kind": "text",
            "startIndex": 184,
            "endIndex": 192,
            "text": "45 days.\n",
            "style": {"bold": True},
        },
    ]
    payload = _canonical([_paragraph(runs=runs)])
    with pytest.raises(MappingFailure) as error:
        map_replacement(change, _baseline(payload), NOW)
    assert error.value.code is MappingFailureCode.UNSUPPORTED_MULTIPLE_RUNS


@pytest.mark.parametrize(
    "baseline",
    [
        _baseline(run_baseline_revision_id="revision-B"),
        _baseline(capture_revision_id="revision-B"),
    ],
)
def test_wrong_google_revision_fails_closed(baseline: BaselineSnapshot) -> None:
    with pytest.raises(MappingFailure) as error:
        map_replacement(normalize_reviewed_change(_proposal()), baseline, NOW)
    assert error.value.code is MappingFailureCode.WRONG_REVISION


def test_malformed_provider_snapshot_fails_closed() -> None:
    canonical = _canonical()
    canonical["tabs"] = "not-a-list"
    with pytest.raises(MappingFailure) as error:
        map_replacement(
            normalize_reviewed_change(_proposal()),
            _baseline(canonical),
            NOW,
        )
    assert error.value.code is MappingFailureCode.MALFORMED_SNAPSHOT


def test_mapping_rejects_snapshot_hash_mismatch() -> None:
    with pytest.raises(MappingFailure) as error:
        map_replacement(
            normalize_reviewed_change(_proposal()),
            _baseline(native_canonical_sha256=ZERO_HASH),
            NOW,
        )
    assert error.value.code is MappingFailureCode.STALE_SNAPSHOT


def test_plan_is_frozen_and_deterministic_and_changed_input_changes_identity() -> None:
    change, baseline, proof = _supported_mapping()
    kwargs = {
        "change": change,
        "baseline": baseline,
        "proof": proof,
        "sync_run_id": UUID("00000000-0000-0000-0000-000000000301"),
        "rule_identity": UUID("00000000-0000-0000-0000-000000000302"),
        "rule_version": 1,
        "instruction_sha256": ZERO_HASH,
        "configuration_sha256": ONE_HASH,
        "created_at": NOW,
        "expires_at": NOW + timedelta(hours=24),
    }
    first = compile_write_plan(**kwargs)
    second = compile_write_plan(**kwargs)
    assert first == second
    assert first.integrity_sha256 == second.integrity_sha256

    changed = compile_write_plan(**(kwargs | {"configuration_sha256": TWO_HASH}))
    assert changed.integrity_sha256 != first.integrity_sha256

    tampered = deepcopy(first.model_dump(mode="json"))
    tampered["payload"]["expected_replacement"]["old_text"] = "XX"
    with pytest.raises(ValidationError, match="integrity mismatch"):
        SealedWritePlan.model_validate(tampered)
