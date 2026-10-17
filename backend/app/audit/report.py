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


_UUID_FIELDS = ("id", "building_id", "actor_user_id", "entity_id")


def _as_dict(row: AuditEventRow) -> dict[str, object]:
    fields = row._asdict()
    for field in _UUID_FIELDS:
        if fields[field] is not None:
            fields[field] = str(fields[field])
    return fields | {"created_at": row.created_at.isoformat()}


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
