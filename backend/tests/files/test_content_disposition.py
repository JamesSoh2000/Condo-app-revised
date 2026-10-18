"""`content_disposition` (P3-04b criteria 17, 22): the header a download is served with."""

from urllib.parse import unquote

import pytest

from app.files.service import content_disposition


@pytest.mark.parametrize(
    ("content_type", "kind"),
    [
        ("image/jpeg", "inline"),
        ("image/png", "inline"),
        ("image/webp", "inline"),
        ("image/heic", "inline"),
        ("application/pdf", "attachment"),
    ],
)
def test_images_are_inline_and_everything_else_an_attachment(content_type, kind):
    assert content_disposition(content_type, "a.bin").startswith(f'{kind}; filename="a.bin"; ')


def test_plain_ascii_name_is_kept_in_both_forms():
    assert content_disposition("application/pdf", "Rules 2026.pdf") == (
        "attachment; filename=\"Rules 2026.pdf\"; filename*=UTF-8''Rules%202026.pdf"
    )


@pytest.mark.parametrize(
    ("name", "fallback"),
    [
        ('a"b.png', "a_b.png"),
        ("a\\b.png", "a_b.png"),
        ("café.png", "caf_.png"),
        ("文件.png", "__.png"),
        ("a;b=c.png", "a;b=c.png"),  # inside a quoted string, `;` and `=` are text
    ],
)
def test_fallback_replaces_quotes_backslashes_and_non_ascii(name, fallback):
    header = content_disposition("image/png", name)

    quoted, extended = header.removeprefix("inline; ").split("; filename*=UTF-8''")
    assert quoted == f'filename="{fallback}"'
    # The extended form is all attr-chars (RFC 5987): nothing a parser could split on.
    assert all(c.isascii() and (c.isalnum() or c in "%-._~") for c in extended)
    assert unquote(extended, encoding="utf-8") == name
