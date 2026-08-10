from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from docrelay.domain.write_plan import GoogleDocsBatchUpdate
from docrelay.integrations.google.contracts import CommitClassification
from docrelay.integrations.google.write_back import (
    GoogleEffectOutcomeUnknown,
    GoogleWriteHTTPClient,
    compare_effective_permissions,
)


def _operation() -> GoogleDocsBatchUpdate:
    return GoogleDocsBatchUpdate(
        required_revision_id="revision-A",
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
                    "location": {
                        "segmentId": "",
                        "tabId": "t.0",
                        "index": 184,
                    },
                    "text": "30",
                }
            },
        ),
    )


async def test_files_copy_uses_private_same_parent_version_metadata_without_acl_mutation() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "id": "backup-1",
                "mimeType": "application/vnd.google-apps.document",
                "parents": ["parent-a"],
                "trashed": False,
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        client = GoogleWriteHTTPClient(http=http, access_token=SecretStr("secret-token"))
        receipt = await client.create_backup(
            file_id="source-a",
            destination_parent_id="parent-a",
            backup_name="Contract — DocRelay backup — timestamp — revision-A",
            operation_metadata={
                "docrelayPlan": "plan-a",
                "docrelayEffect": "effect-a",
                "source_revision": "revision-A",
            },
        )

    assert receipt.backup_file_id == "backup-1"
    assert len(requests) == 1
    request = requests[0]
    assert request.method == "POST"
    assert request.url.path == "/drive/v3/files/source-a/copy"
    assert request.url.params["ignoreDefaultVisibility"] == "true"
    payload: dict[str, Any] = __import__("json").loads(request.content)
    assert payload == {
        "name": "Contract — DocRelay backup — timestamp — revision-A",
        "parents": ["parent-a"],
        "appProperties": {
            "docrelayPlan": "plan-a",
            "docrelayEffect": "effect-a",
            "source_revision": "revision-A",
        },
    }
    assert "/permissions" not in request.url.path


async def test_guarded_batch_payload_is_exact_and_never_uses_target_revision() -> None:
    captured: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(__import__("json").loads(request.content))
        return httpx.Response(200, json={"writeControl": {"requiredRevisionId": "revision-B"}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        result = await GoogleWriteHTTPClient(
            http=http, access_token=SecretStr("secret-token")
        ).commit_guarded(file_id="source-a", operation=_operation())

    assert result.classification is CommitClassification.SUCCEEDED
    assert captured == [_operation().provider_payload()]
    assert "targetRevisionId" not in str(captured)
    assert "replaceAllText" not in str(captured)


async def test_required_revision_400_is_conflict_and_transport_loss_is_unknown() -> None:
    def conflict(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "error": {
                    "status": "INVALID_ARGUMENT",
                    "message": (
                        "The required revision ID 'revision-A' does not match the latest revision."
                    ),
                }
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(conflict)) as http:
        result = await GoogleWriteHTTPClient(
            http=http, access_token=SecretStr("secret-token")
        ).commit_guarded(file_id="source-a", operation=_operation())
    assert result.classification is CommitClassification.CONFLICT

    def lost(_: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("lost response")

    async with httpx.AsyncClient(transport=httpx.MockTransport(lost)) as http:
        client = GoogleWriteHTTPClient(http=http, access_token=SecretStr("secret-token"))
        with pytest.raises(GoogleEffectOutcomeUnknown):
            await client.commit_guarded(file_id="source-a", operation=_operation())

    def unusable_copy(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"not-json")

    async with httpx.AsyncClient(transport=httpx.MockTransport(unusable_copy)) as http:
        client = GoogleWriteHTTPClient(http=http, access_token=SecretStr("secret-token"))
        with pytest.raises(GoogleEffectOutcomeUnknown):
            await client.create_backup(
                file_id="source-a",
                destination_parent_id="parent-a",
                backup_name="Synthetic — DocRelay backup — time — revision",
                operation_metadata={"source_revision": "revision-A"},
            )


def test_effective_permission_comparison_fails_closed_on_new_or_elevated_access() -> None:
    source = (
        {"id": "opaque-owner", "type": "user", "role": "owner"},
        {
            "id": "opaque-reader",
            "type": "user",
            "role": "reader",
            "allowFileDiscovery": False,
        },
    )
    same = tuple(dict(item) for item in source)
    safe, evidence = compare_effective_permissions(source, same)
    assert safe
    assert evidence["backup_not_broader"] is True

    broader = (*same, {"id": "anyone", "type": "anyone", "role": "reader"})
    assert compare_effective_permissions(source, broader)[0] is False

    elevated = (source[0], source[1] | {"role": "writer"})
    assert compare_effective_permissions(source, elevated)[0] is False

    discoverable = (source[0], source[1] | {"allowFileDiscovery": True})
    assert compare_effective_permissions(source, discoverable)[0] is False

    unknown_role = (source[0], source[1] | {"role": "futureRole"})
    assert compare_effective_permissions(source, unknown_role)[0] is False

    missing_identity = (source[0], {"type": "user", "role": "reader"})
    assert compare_effective_permissions(source, missing_identity)[0] is False
