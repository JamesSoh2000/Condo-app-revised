"""The app, imported on its own as the server does, can configure every ORM mapper (P2-01b).

The test suite imports every models module through its fixtures, so a model the running app never
imports (and that a relationship needs) fails only in a real process: login answered 500 on the
stack with `NoReferencedTableError` for `buildings`. This runs a fresh interpreter, like the server.
"""

import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent


def test_importing_the_app_alone_configures_every_mapper():
    code = (
        "import app.main\n"
        "from sqlalchemy.orm import configure_mappers\n"
        "from app.models.base import Base\n"
        "configure_mappers()\n"
        "print(sorted(Base.metadata.tables))\n"
    )
    result = subprocess.run(  # noqa: S603 (fixed code, this interpreter)
        [sys.executable, "-c", code], cwd=BACKEND_DIR, capture_output=True, text=True, check=False
    )

    assert result.returncode == 0, result.stderr[-2000:]
    assert "'buildings'" in result.stdout
    assert "'sessions'" in result.stdout
