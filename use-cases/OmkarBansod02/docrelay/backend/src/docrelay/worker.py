import asyncio
import logging

from docrelay.core.config import get_settings
from docrelay.core.logging import configure_logging
from docrelay.integrations.superdocs.runtime import SuperDocsRuntime
from docrelay.persistence.database import Database
from docrelay.services.artifacts import FilesystemArtifactStore
from docrelay.services.phase3 import Phase3Error, Phase3Orchestrator

logger = logging.getLogger(__name__)


async def run_once(orchestrator: Phase3Orchestrator) -> int:
    run_ids = await orchestrator.list_resumable_run_ids()
    for run_id in run_ids:
        try:
            await orchestrator.resume(run_id)
        except Phase3Error as exc:
            logger.warning(
                "phase3_worker_attention",
                extra={
                    "safe_metadata": {
                        "run_id": str(run_id),
                        "error_code": exc.code,
                    }
                },
            )
        except Exception:
            logger.exception(
                "phase3_worker_failure",
                extra={"safe_metadata": {"run_id": str(run_id)}},
            )
    return len(run_ids)


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    runtime = SuperDocsRuntime.from_settings(settings)
    if runtime is None:
        raise RuntimeError("SUPERDOCS_API_KEY is required for the Phase 3 worker")
    database = Database(settings.database_url)
    orchestrator = Phase3Orchestrator(
        sessions=database.sessions,
        superdocs=runtime.client,
        artifacts=FilesystemArtifactStore(settings.docrelay_artifact_dir),
        owner_subject=settings.docrelay_owner_subject,
    )
    idle_multiplier = 1.0
    try:
        while True:
            work_count = await run_once(orchestrator)
            idle_multiplier = 1.0 if work_count else min(idle_multiplier * 1.5, 5.0)
            await asyncio.sleep(settings.phase3_worker_poll_seconds * idle_multiplier)
    finally:
        await runtime.close()
        await database.dispose()


if __name__ == "__main__":
    asyncio.run(main())
