"""Print the API's OpenAPI document as JSON, without starting a server or touching the database.

`make gen-api` pipes it into openapi-typescript to regenerate `frontend/src/api/schema.d.ts`, and CI
fails when the committed file differs from what this produces.
"""

import json
import sys

from app.main import create_app


def main() -> None:
    document = create_app().openapi()
    # Fixed formatting so two runs on the same code give the same bytes.
    sys.stdout.write(json.dumps(document, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
