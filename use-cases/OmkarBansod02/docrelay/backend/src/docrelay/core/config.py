from functools import lru_cache
from typing import Literal, Self

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    app_env: Literal["development", "test", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "INFO"
    database_url: str = Field(min_length=1)
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])
    readiness_timeout_seconds: float = Field(default=2.0, gt=0, le=30)

    superdocs_api_key: SecretStr | None = None
    google_oauth_client_id: str | None = None
    google_oauth_client_secret: SecretStr | None = None
    google_oauth_redirect_uri: str | None = None
    oauth_token_encryption_key: SecretStr | None = None

    @model_validator(mode="after")
    def validate_database_driver(self) -> Self:
        if self.database_url.startswith("postgresql+asyncpg://"):
            return self
        if self.app_env == "test" and self.database_url.startswith("sqlite+aiosqlite://"):
            return self
        raise ValueError("DATABASE_URL must use postgresql+asyncpg (SQLite is test-only)")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
