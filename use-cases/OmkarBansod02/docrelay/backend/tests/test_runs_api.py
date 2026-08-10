from uuid import uuid4

from httpx import ASGITransport, AsyncClient

from docrelay.app import create_app
from docrelay.core.config import Settings


class StubDatabase:
    async def dispose(self) -> None:
        return None


def _settings() -> Settings:
    return Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL="sqlite+aiosqlite:///:memory:",
    )


async def test_phase3_machine_routes_exist_and_unconfigured_error_is_safe() -> None:
    app = create_app(settings=_settings(), database=StubDatabase())  # type: ignore[arg-type]
    run_id = uuid4()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        responses = [
            await client.get(f"/api/v1/runs/{run_id}"),
            await client.post(f"/api/v1/runs/{run_id}/resume"),
            await client.get(f"/api/v1/runs/{run_id}/proposals"),
            await client.get(f"/api/v1/runs/{run_id}/export"),
        ]
        openapi = (await client.get("/api/openapi.json")).json()

    assert all(response.status_code == 503 for response in responses)
    assert all(
        response.json()["error"]["code"] == "SUPERDOCS_NOT_CONFIGURED" for response in responses
    )
    serialized = "".join(response.text for response in responses).lower()
    for forbidden in ("api_key", "authorization", "access_token", "refresh_token"):
        assert forbidden not in serialized
    expected_paths = {
        "/api/v1/runs",
        "/api/v1/runs/{run_id}",
        "/api/v1/runs/{run_id}/resume",
        "/api/v1/runs/{run_id}/proposals",
        "/api/v1/runs/{run_id}/decisions",
        "/api/v1/runs/{run_id}/continue",
        "/api/v1/runs/{run_id}/export",
    }
    assert expected_paths.issubset(openapi["paths"])
