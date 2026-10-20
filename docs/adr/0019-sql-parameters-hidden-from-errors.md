# ADR-0019: SQL parameters are hidden from database error messages

- Status: Accepted
- Date: 2026-10-20
- Deciders: agent (autonomous) in P4-04

## Context

CLAUDE.md rule 10: never log tokens, passwords or cookies. Emailed links carry a token (invitations, P4-02;
password reset, P4-04), and `queue_email` puts the link in the `email.send` job's payload, which is a bound
parameter of the job's INSERT.

SQLAlchemy writes a statement's parameters into the message of every error it raises from the database
(`[parameters: …]`). That message reaches several outputs: `RequestLoggingMiddleware` logs it as
`error_message` and again in the traceback, the worker keeps an error's text in `jobs.last_error`, and a CLI
traceback prints it to stderr. P4-02b and P4-03 each found a token leaking through one of these after the
others were covered ("a secret leaks through a second output path", AGENT_MISTAKES_LOG). P4-04's test showed
the reset link in the request log when the job's INSERT fails.

## Decision

The app's engine is built by `app.core.database.make_engine`, which sets `hide_parameters=True`. The tests'
engine (`tests/conftest.py::engine`) uses the same factory, so request tests fail the way production does.
`tests/auth/test_password_reset.py::test_failed_request_leaks_no_token` fails a request at the token insert,
the job insert, the audit insert and the commit, and asserts the token reaches no log line, stderr or
response.

## Consequences

- A database error's log line shows the SQL and the driver's message, not the values. Debugging a constraint
  failure means reproducing it, or reading the values from the message Postgres itself writes (the
  `DETAIL` of a unique violation still names the key).
- Redaction at each output (the CLI's SQLSTATE-only message from P4-03, the worker's `describe_error`) stays:
  those also cover text that isn't a bound parameter.
- Engines built directly with `create_async_engine` (scratch-database tests, migrations) don't get it; they
  run no request code that logs.

## Alternatives considered

- Redact in the request log middleware: the traceback, the worker and the CLI would each need the same
  redaction, the pattern this ADR ends.
- Drop `error_message` from the request log: the traceback still holds the message.
