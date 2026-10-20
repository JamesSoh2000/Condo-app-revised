"""Fixtures for the invitation tests: the email tests' fake SMTP server and `email.send`
handler, and the worker's savepoint sessions, so a test can run `Worker.run_once` and read the
sent message."""

from tests.email.conftest import email_handler, smtp  # noqa: F401
from tests.jobs.conftest import sessions  # noqa: F401
