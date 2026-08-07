from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from docrelay import __version__
from docrelay.api.google import GoogleErrorBody, GoogleErrorResponse
from docrelay.api.google import router as google_router
from docrelay.api.health import router as health_router
from docrelay.api.middleware import RequestIdMiddleware
from docrelay.core.config import Settings, get_settings
from docrelay.core.logging import configure_logging
from docrelay.integrations.google.errors import GoogleErrorCode, GoogleIntegrationError
from docrelay.integrations.google.runtime import GoogleRuntime
from docrelay.integrations.google.services import OAUTH_BROWSER_COOKIE
from docrelay.persistence.database import Database


def create_app(
    *,
    settings: Settings | None = None,
    database: Database | None = None,
    google_runtime: GoogleRuntime | None = None,
) -> FastAPI:
    app_settings = settings or get_settings()
    app_database = database or Database(app_settings.database_url)
    app_google_runtime = google_runtime or GoogleRuntime.from_settings(app_settings)
    configure_logging(app_settings.log_level)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        if app_google_runtime is not None:
            await app_google_runtime.close()
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
    app.state.google_runtime = app_google_runtime
    app.add_middleware(
        CORSMiddleware,
        allow_origins=app_settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "X-Request-ID"],
    )
    app.add_middleware(RequestIdMiddleware)
    app.include_router(health_router)
    app.include_router(google_router)

    @app.exception_handler(GoogleIntegrationError)
    async def handle_google_error(request: Request, exc: GoogleIntegrationError) -> Response:
        status_by_code = {
            GoogleErrorCode.OAUTH_NOT_CONFIGURED: 503,
            GoogleErrorCode.INVALID_OAUTH_STATE: 400,
            GoogleErrorCode.OAUTH_ACCESS_DENIED: 403,
            GoogleErrorCode.REAUTH_REQUIRED: 401,
            GoogleErrorCode.PERMISSION_DENIED: 403,
            GoogleErrorCode.CONNECTION_NOT_FOUND: 404,
            GoogleErrorCode.FILE_NOT_FOUND: 404,
            GoogleErrorCode.UNSUPPORTED_SOURCE_TYPE: 422,
            GoogleErrorCode.SOURCE_TRASHED: 409,
            GoogleErrorCode.SOURCE_CHANGED_DURING_CAPTURE: 409,
            GoogleErrorCode.RATE_LIMITED: 429,
            GoogleErrorCode.UNAVAILABLE: 503,
            GoogleErrorCode.INVALID_RESPONSE: 502,
        }
        payload = GoogleErrorResponse(
            error=GoogleErrorBody(
                code=exc.code,
                message=exc.safe_message,
                retryable=exc.retryable,
                details=exc.safe_details,
            )
        )
        response = Response(
            content=payload.model_dump_json(),
            status_code=status_by_code[exc.code],
            media_type="application/json",
        )
        if request.url.path == "/api/v1/google/oauth/callback":
            response.delete_cookie(
                OAUTH_BROWSER_COOKIE,
                path="/api/v1/google/oauth/callback",
                httponly=True,
                secure=app_settings.app_env == "production",
                samesite="lax",
            )
        return response

    return app
