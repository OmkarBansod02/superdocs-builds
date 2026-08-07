import pytest
from pydantic import ValidationError

from docrelay.core.config import Settings


def test_database_url_is_required(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(ValidationError, match="database_url"):
        Settings(_env_file=None)  # type: ignore[call-arg]


def test_non_test_runtime_requires_async_postgresql() -> None:
    with pytest.raises(ValidationError, match=r"postgresql\+asyncpg"):
        Settings(
            _env_file=None,
            APP_ENV="development",
            DATABASE_URL="sqlite+aiosqlite:///:memory:",
        )


def test_test_runtime_may_use_sqlite_without_weakening_production() -> None:
    settings = Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL="sqlite+aiosqlite:///:memory:",
    )
    assert settings.app_env == "test"


def test_secrets_are_typed_as_secret_values() -> None:
    settings = Settings(
        _env_file=None,
        APP_ENV="test",
        DATABASE_URL="sqlite+aiosqlite:///:memory:",
        SUPERDOCS_API_KEY="not-a-real-key",
        GOOGLE_OAUTH_CLIENT_SECRET="not-a-real-secret",
    )
    assert "not-a-real-key" not in repr(settings.superdocs_api_key)
    assert settings.superdocs_api_key is not None
    assert settings.superdocs_api_key.get_secret_value() == "not-a-real-key"
