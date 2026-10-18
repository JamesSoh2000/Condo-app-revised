"""`python -m app.worker` plus one test-only handler, run as a subprocess by
`test_worker.py::test_sigterm_finishes_current_job_releases_the_rest_and_exits_0`.

`test.marker` writes its job id to `payload["started"]`, then sleeps `payload["seconds"]`.
"""

import asyncio
from pathlib import Path
from typing import Any

from app.jobs.registry import JobContext, job_handler
from app.worker import run


@job_handler("test.marker")
async def marker(payload: dict[str, Any], ctx: JobContext) -> None:
    await asyncio.to_thread(Path(payload["started"]).write_text, str(ctx.job_id))
    await asyncio.sleep(payload["seconds"])


if __name__ == "__main__":
    run()
