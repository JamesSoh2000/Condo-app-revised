"""`jobs-status` as text (P3-01b). Prints no payload, and only the start of each `last_error`."""

from datetime import datetime

from app.jobs.service import JobStatusReport

ERROR_SHOWN = 200


def _safe(text: str | None) -> str:
    # Stored text comes from exception messages: control and format characters (escape
    # sequences, bidi overrides) could drive the operator's terminal, so each becomes `?`.
    return "".join(ch if ch.isprintable() else "?" for ch in text or "")


def render_status(report: JobStatusReport, *, now: datetime) -> str:
    lines = [f"{status.value:<10} {count}" for status, count in report.counts.items()]
    if report.oldest_due_run_at is None:
        lines.append("oldest due: none")
    else:
        age = max(0, int((now - report.oldest_due_run_at).total_seconds()))
        lines.append(f"oldest due: {age} s ago")
    if not report.dead:
        lines.append("dead jobs: none")
        return "\n".join(lines)
    lines.append(f"dead jobs ({len(report.dead)} most recent, newest first):")
    for row in report.dead:
        finished = row.finished_at.isoformat() if row.finished_at is not None else "-"
        error = _safe((row.last_error or "")[:ERROR_SHOWN])
        lines.append(
            f"{row.id}  {_safe(row.kind)}  {row.attempts}/{row.max_attempts}  {finished}  {error}"
        )
    return "\n".join(lines)
