from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from docrelay import __version__
from docrelay.api.health import router as health_router
from docrelay.api.middleware import RequestIdMiddleware
from docrelay.core.config import Settings, get_settings
from docrelay.core.logging import configure_logging
from docrelay.persistence.database import Database


def create_app(*, settings: Settings | None = None, database: Database | None = None) -> FastAPI:
    app_settings = settings or get_settings()
    app_database = database or Database(app_settings.database_url)
    configure_logging(app_settings.log_level)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await app_database.dispose()

    app = FastAPI(
        title="DocRelay API",
        summary="Safety-first control plane for cloud-document write-back",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs" if app_settings.app_env != "production" else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if app_settings.app_env != "production" else None,
    )
    app.state.settings = app_settings
    app.state.database = app_database
    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["X-Request-ID"],
    )
    app.add_middleware(RequestIdMiddleware)
    app.include_router(health_router)
    return app
