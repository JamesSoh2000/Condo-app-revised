# Runbook — bootstrap a building

Provision a new building and invite its first property manager with one audited command
([P4-03](../tickets/P4-03-bootstrap-building-command.md)). It writes, in one transaction:

- the building, with a generated join code
- its features
- its units, if you give a CSV
- an invitation for the manager (role `property_management`), and its email
- one audit event, `building.bootstrapped`, with your name and reason

If anything fails, nothing is written. It works with `APP_ENV=prod` (unlike `seed`).

This page covers the local stack. D-06 adds the staging variant (the same command through SSM Session
Manager).

## Before you start

- The stack is up (`make up`, or `make prodlike`) and migrated (`make migrate`).
- Optional: a units CSV with the header `tower,label,floor` (any order), UTF-8, at most 1 MiB and
  5,000 rows. Every row must be valid; one bad row refuses the whole run. Check the file first with a dry
  run (below).
- Choose a slug: lower-case letters, digits and `-`, at most 63. It must be new.
- The command records who ran it from `OPERATOR` (else `USER`). Inside the container `USER` is usually
  unset, so pass `-e OPERATOR=<your name>` to `docker compose exec`. Without either, it refuses to run.

## 1. Dry run

Copy the CSV into the container first (the command reads a path inside it):

```bash
docker compose cp ./cedar-units.csv app:/tmp/cedar-units.csv

docker compose exec -e OPERATOR="$USER" app python -m app.cli bootstrap-building \
  --slug cedar --name "Cedar Court" --address "1 Cedar St, Toronto" \
  --timezone America/Toronto --locale en \
  --features packages,notices,maintenance \
  --units-csv /tmp/cedar-units.csv \
  --manager-email pat.manager@example.com --manager-name "Pat Manager" \
  --reason "Pilot onboarding, ticket OPS-12" \
  --dry-run
```

It prints the plan (`dry run: nothing was written`, then the slug, name, timezone, locale, features, unit
count and invitation target) and writes nothing. Any error (`slug already exists`, an unknown timezone,
an invalid CSV row by line number, a bad email) exits 1, and also before anything is written in a real run.

Options: `--locale` is `en` (default) or `fr`, the language of the emails. `--features` defaults to
`packages,notices,maintenance`; `--features ""` enables none. `--units-csv` is optional.

## 2. Real run

Run the same command without `--dry-run`. The output ends with:

```text
building id: <uuid>
join code: ABCDE-FGHJK
deliver this link to the manager only if the email does not arrive:
accept URL: https://<APP_BASE_URL>/invite/<token>
```

- **The accept URL is shown once and is a credential**: whoever opens it can accept the invitation for
  seven days. It is not logged and not stored (only its hash is). Don't paste it into tickets or chat;
  give it to the manager directly, and only if the email doesn't arrive. Clear your terminal scrollback
  after a production run.
- The worker sends the invitation email (locally: Mailpit, <http://localhost:8025>).

## 3. Check

```bash
make cli args="audit --building cedar --action building."
```

shows one `building.bootstrapped` event with your name and reason. When the manager accepts, they are an
active `property_management` member of the building and can invite staff.

## If something goes wrong

| Symptom | What to do |
|---|---|
| `slug already exists` | The building exists already (perhaps a previous run worked). Check with the audit command above; don't bootstrap it again |
| The email never arrives | `make cli args="jobs-status"`; a dead job can be retried (`jobs-retry <id>`). Or deliver the accept URL yourself |
| The URL was lost or leaked before it was used, or expired (7 days) | Revoke and resend are manager routes, and the building has no manager yet. There is no operator command for this (a follow-up of P4-03): raise it in the inbox. Don't bootstrap the slug again; it is refused |
