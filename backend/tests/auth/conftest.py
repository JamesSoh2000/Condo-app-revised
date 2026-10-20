"""Fixtures for the auth tests: the email tests' fake SMTP server and `email.send` handler, and the
worker's savepoint sessions, so a password reset test can run `Worker.run_once` and read the sent
message (as tests/invitations/conftest.py)."""

from tests.email.conftest import email_handler, smtp  # noqa: F401
from tests.jobs.conftest import sessions  # noqa: F401
