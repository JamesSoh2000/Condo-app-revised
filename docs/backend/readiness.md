# Readiness, Database Checks, And Caddy Switching

The backend exposes two health-style endpoints:

- `/api/health` is a liveness check. It only means the FastAPI process is running.
- `/api/ready` is a readiness check. It means the app is ready to serve real traffic.

## Local Docker Compose

Local Compose starts Postgres first. The backend service has:

```yaml
depends_on:
  db:
    condition: service_healthy
```

That waits for the Postgres container healthcheck to pass before starting FastAPI.

The backend then reads local settings from `backend/.env.dev`:

```env
DATABASE_URL=postgresql+asyncpg://postgres:devpassword@db:5432/condo_dev
READINESS_CHECK_DATABASE=true
```

Inside the Compose network, `db` is the hostname of the Postgres container. When `/api/ready` is called, the backend runs a tiny database query:

```sql
SELECT 1
```

If the query succeeds, `/api/ready` returns `200` with `database: ok`. If it fails, `/api/ready` returns `503`.

## Docker Healthchecks

Docker healthchecks are useful for local visibility:

```bash
docker compose ps
```

They can show whether containers are `healthy` or `unhealthy`.

For this project, the important checks are:

- Postgres healthcheck: proves Postgres is accepting connections.
- Backend `/api/ready`: proves FastAPI can reach the configured database.

The app healthcheck is helpful, but it is not what switches production traffic by itself.

## Production With RDS

In prod, `DATABASE_URL` points to RDS and should come from AWS SSM Parameter Store or another secret store. Prod should also set:

```env
APP_ENV=prod
READINESS_CHECK_DATABASE=true
```

The app should not crash just because RDS is briefly unavailable. Instead, `/api/ready` should fail. That lets the deploy script, reverse proxy, or future load balancer avoid routing traffic to an app instance that is not ready.

## Blue/Green And Caddy

Caddy does not automatically switch based on Docker health. The deploy script should make that decision.

The safe production flow is:

```text
Blue is live -> start Green -> wait for Green /api/ready -> switch Caddy -> monitor -> stop Blue
```

Example deploy gate:

```bash
for i in {1..10}; do
  if curl -sf http://localhost:8002/api/ready; then
    echo "Green is ready"
    break
  fi
  echo "Attempt $i failed, waiting..."
  sleep 3
done

if ! curl -sf http://localhost:8002/api/ready; then
  echo "ERROR: Green failed readiness check. Aborting deploy."
  docker compose -f docker-compose.prod.yml stop app-green
  exit 1
fi
```

After Green is ready, switch Caddy from Blue:

```caddy
reverse_proxy localhost:8001
```

to Green:

```caddy
reverse_proxy localhost:8002
```

Then reload Caddy:

```bash
caddy reload --config /app/Caddyfile
```

Using `curl /api/ready` in the deploy script is preferred for the traffic switch because it tests the same HTTP path Caddy will use.
