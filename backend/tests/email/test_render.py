"""Rendering templates (P3-02 criteria 5, 12, 13; 10 for the rendering errors)."""

from pathlib import Path

import pytest

from app.email import templates
from app.email.templates import EmailTemplateError, render_email
from tests.email.conftest import point_settings_at


@pytest.fixture(autouse=True)
def _email_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    point_settings_at(monkeypatch, 1025)


# A layout for temp roots: without it, rendering fails on the missing `base.*` before it reaches
# the case a test is about (review round 1).
LAYOUT = {
    "en/base.txt": "{% block body %}{% endblock %}",
    "en/base.html": "{% block body %}{% endblock %}",
}


def write(root: Path, files: dict[str, str]) -> Path:
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    return root


def test_test_template_renders_subject_text_and_html_with_layout() -> None:
    rendered = render_email("test", {}, "en")

    assert rendered.subject
    assert "\n" not in rendered.subject
    assert "Hello there" in rendered.text
    assert "Hello there" in rendered.html
    # The base layout: sender's name when there is no building, and the app link in the footer.
    assert "Maple Tower" in rendered.html
    assert "http://localhost:5173" in rendered.html
    assert "http://localhost:5173" in rendered.text
    assert rendered.html.lstrip().lower().startswith("<!doctype html>")


def test_layout_shows_the_building_name_when_given() -> None:
    rendered = render_email("test", {"building_name": "Oak Court"}, "en")

    assert "Oak Court" in rendered.html
    assert "Oak Court" in rendered.text


# Criterion 5


def test_html_part_escapes_context_text_part_does_not() -> None:
    rendered = render_email("test", {"name": "<script>"}, "en")

    assert "&lt;script&gt;" in rendered.html
    assert "<script>" not in rendered.html
    # Plain text is not HTML: escaping it would show the reader `&lt;`.
    assert "<script>" in rendered.text
    assert "&lt;" not in rendered.text


def test_layout_values_are_escaped_in_html_too() -> None:
    rendered = render_email("test", {"building_name": "<b>Oak</b>"}, "en")

    assert "&lt;b&gt;Oak&lt;/b&gt;" in rendered.html


# Criterion 13


def test_subject_is_one_line_whatever_the_context_holds() -> None:
    rendered = render_email("test", {"name": "Ann\r\nBcc: victim@example.test\n"}, "en")

    assert "\r" not in rendered.subject
    assert "\n" not in rendered.subject
    assert "Ann Bcc: victim@example.test" in rendered.subject


# Criterion 12


def test_fr_falls_back_to_en_when_fr_has_no_file() -> None:
    fr, en = render_email("test", {}, "fr"), render_email("test", {}, "en")

    assert (fr.subject, fr.text) == (en.subject, en.text)
    # The same English layout, tagged with the requested locale.
    assert fr.html == en.html.replace('<html lang="en">', '<html lang="fr">')


def test_fr_falls_back_to_en_per_part(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = write(
        tmp_path,
        {
            "en/base.txt": "{% block body %}{% endblock %}\n-- en footer",
            "en/base.html": "<p>{% block body %}{% endblock %}</p><p>en footer</p>",
            "en/hello.subject.txt": "Hello",
            "en/hello.txt": "{% extends base %}{% block body %}Hi {{ name }}{% endblock %}",
            "en/hello.html": "{% extends base %}{% block body %}Hi {{ name }}{% endblock %}",
            "fr/hello.subject.txt": "Bonjour",
            "fr/base.html": "<p>{% block body %}{% endblock %}</p><p>pied fr</p>",
            "fr/hello.html": "{% extends base %}{% block body %}Salut {{ name }}{% endblock %}",
        },
    )
    monkeypatch.setattr(templates, "TEMPLATES_DIR", root)

    rendered = render_email("hello", {"name": "Ann"}, "fr")

    assert rendered.subject == "Bonjour"
    assert rendered.text == "Hi Ann\n-- en footer"
    assert rendered.html == "<p>Salut Ann</p><p>pied fr</p>"


# Criterion 10 (the rendering half; queue_email's own checks are in test_queue.py)


def test_missing_variable_is_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = write(
        tmp_path,
        {
            **LAYOUT,
            "en/needs.subject.txt": "Hello",
            "en/needs.txt": "{% extends base %}{% block body %}For {{ name }}{% endblock %}",
            "en/needs.html": "x",
        },
    )
    monkeypatch.setattr(templates, "TEMPLATES_DIR", root)

    with pytest.raises(EmailTemplateError, match="'name' is undefined"):
        render_email("needs", {}, "en")
    # The same template renders once the variable is given.
    assert render_email("needs", {"name": "Ann"}, "en").text == "For Ann"


def test_missing_part_is_an_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = write(tmp_path, {**LAYOUT, "en/half.subject.txt": "x", "en/half.txt": "x"})
    monkeypatch.setattr(templates, "TEMPLATES_DIR", root)

    with pytest.raises(EmailTemplateError, match=r"half\.html"):
        render_email("half", {}, "en")


@pytest.mark.parametrize("name", ["nope", "../en/test", "Test", "test.html", "", "base/x", "1test"])
def test_unknown_or_malformed_template_name_is_an_error(name: str) -> None:
    with pytest.raises(EmailTemplateError):
        render_email(name, {}, "en")


@pytest.mark.parametrize("locale", ["de", "EN", "", "../en", "en/"])
def test_unsupported_locale_is_an_error(locale: str) -> None:
    with pytest.raises(EmailTemplateError):
        render_email("test", {}, locale)


def test_caller_cannot_override_the_layout_values() -> None:
    rendered = render_email(
        "test", {"base": "en/test.subject.txt", "app_base_url": "https://evil.example"}, "en"
    )

    assert "evil.example" not in rendered.html
    assert "http://localhost:5173" in rendered.html
