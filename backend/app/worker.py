"""`python -m app.worker`: the background job worker (P3-01a). Exits 0 after SIGTERM or SIGINT."""

import asyncio

from app.jobs.worker import main
from app.logging_config import configure_logging


def run() -> None:
    configure_logging()
    asyncio.run(main())


if __name__ == "__main__":
    run()
