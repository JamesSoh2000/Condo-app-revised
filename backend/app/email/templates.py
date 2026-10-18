"""Email templates (P3-02): `templates/<locale>/<name>.subject.txt`, `.txt` and `.html`.

Each part falls back to `en/` when its locale has no file. The body templates extend `base`, the
locale's layout (building name and footer), also with the `en` fallback. HTML is autoescaped; the
subject and the text part are plain text, and the subject is collapsed to one line, so a context
value can't add a header.
"""

import re
from dataclasses import dataclass
from email.utils import parseaddr
from functools import cache
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined, TemplateError, select_autoescape

from app.core.config import settings

TEMPLATES_DIR = Path(__file__).parent / "templates"
SUPPORTED_LOCALES = ("en", "fr")
DEFAULT_LOCALE = "en"
_NAME = re.compile(r"[a-z][a-z0-9_]*")


class EmailTemplateError(ValueError):
    """The template, locale or context can't produce an email (the message names the template)."""


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    text: str
    html: str


@cache
def _environment(root: Path) -> Environment:
    return Environment(
        loader=FileSystemLoader(root),
        autoescape=select_autoescape(enabled_extensions=("html",), default_for_string=False),
        undefined=StrictUndefined,
        keep_trailing_newline=False,
    )


def render_email(template: str, context: dict[str, Any], locale: str) -> RenderedEmail:
    """Render the three parts of `template` in `locale`; raise `EmailTemplateError` if one can't."""
    if _NAME.fullmatch(template) is None:
        raise EmailTemplateError(f"email template names are [a-z][a-z0-9_]*, not {template!r}")
    if locale not in SUPPORTED_LOCALES:
        raise EmailTemplateError(f"email locale must be one of {SUPPORTED_LOCALES}, not {locale!r}")
    env = _environment(TEMPLATES_DIR)
    sender_name, sender_address = parseaddr(settings.email_from)

    def render(part: str) -> str:
        extension = part.rsplit(".", 1)[-1]
        # Set last, so a context key can't replace the layout or the app's own link.
        values = context | {
            "base": env.select_template(_candidates(locale, f"base.{extension}")),
            "locale": locale,
            "app_base_url": settings.app_base_url,
            "sender_name": sender_name or sender_address,
        }
        return env.select_template(_candidates(locale, f"{template}.{part}")).render(values)

    try:
        return RenderedEmail(
            subject=" ".join(render("subject.txt").split()),
            text=render("txt"),
            html=render("html"),
        )
    except TemplateError as exc:
        raise EmailTemplateError(f"email template {template!r} ({locale}): {exc}") from exc


def _candidates(locale: str, filename: str) -> list[str]:
    return [f"{locale}/{filename}", f"{DEFAULT_LOCALE}/{filename}"]
