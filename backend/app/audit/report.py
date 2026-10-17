"""How `python -m app.cli audit` prints events: one line each, or a JSON array (`--json`)."""

import json
from collections.abc import Sequence

from app.audit.service import AuditEventRow


def render(rows: Sequence[AuditEventRow], *, as_json: bool) -> str:
    if as_json:
        return json.dumps([_as_dict(row) for row in rows], indent=2, ensure_ascii=False)
    if not rows:
        return "no audit events"
    return "\n".join(_as_line(row) for row in rows)


def _as_dict(row: AuditEventRow) -> dict[str, object]:
    return {
        field: str(value) if field.endswith("id") and value is not None else value
        for field, value in row._asdict().items()
    } | {"created_at": row.created_at.isoformat()}


def _as_line(row: AuditEventRow) -> str:
    entity = f"{row.entity_type}:{row.entity_id}" if row.entity_id else row.entity_type
    metadata = json.dumps(row.metadata, ensure_ascii=False, sort_keys=True)
    return "  ".join(
        [
            row.created_at.isoformat(timespec="seconds"),
            row.action,
            row.building_slug or "-",
            row.actor_email or "-",
            entity,
            f"request={row.request_id or '-'}",
            metadata,
        ]
    )
