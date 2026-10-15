# Backend & Infrastructure Master Guide

This document covers everything needed to understand, develop, and deploy the condo management app backend. It is the single source of truth for how the system is architected, why each piece exists, how to work with it locally, and how to deploy it to production safely.

This is the target backend and infrastructure guide. The current repo intentionally starts with a minimal `backend/` FastAPI skeleton and the Base44-exported frontend in `frontend/`. Docker, Alembic, PostgreSQL, Redis, production deployment files, and feature modules should be added through the milestone tickets instead of being kept as half-built starter scaffolding.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Repository Structure](#2-repository-structure)
3. [Local Development Setup](#3-local-development-setup)
4. [Backend — FastAPI](#4-backend--fastapi)
5. [Database — PostgreSQL + Alembic](#5-database--postgresql--alembic)
6. [Future Live Chat — Redis + WebSockets](#6-future-live-chat--redis--websockets)
7. [Notifications — AWS SES + SNS](#7-notifications--aws-ses--sns)
8. [File Storage — AWS S3](#8-file-storage--aws-s3)
9. [CI/CD Pipeline — GitHub Actions + ECR](#9-cicd-pipeline--github-actions--ecr)
10. [Production Infrastructure — AWS](#10-production-infrastructure--aws)
11. [Deployment — Blue/Green with Caddy](#11-deployment--bluegreen-with-caddy)
12. [Logging & Monitoring — CloudWatch](#12-logging--monitoring--cloudwatch)
13. [Security Checklist](#13-security-checklist)
14. [Gotchas & Things to Avoid](#14-gotchas--things-to-avoid)

---

## 1. Architecture Overview

### What We're Building

A multi-tenant condo management platform. One backend serves multiple buildings (clients). Each building has its own residents, units, amenities, and operational data, all isolated within a single shared database using row-level multi-tenancy.

### High-Level Diagram

```
                         Internet
                             │
                        [Caddy]          ← reverse proxy, SSL, blue/green switch
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
        [App Blue :8001]            [App Green :8002]
        FastAPI + Gunicorn           FastAPI + Gunicorn
              │                             │
              └──────────────┬──────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         [PostgreSQL]     [Redis]         [S3]
           (RDS)        (EC2 container)  (file storage)
                             │
                    [SES / SNS]          ← email / SMS via AWS APIs
```

### Tech Stack

| Layer | Technology | Why |
|---|---|---|
| API framework | FastAPI + Gunicorn + Uvicorn workers | Async-native, fast, automatic OpenAPI docs |
| Database | PostgreSQL 16 (RDS on prod) | Relational, strong consistency, supports RLS |
| Migrations | Alembic | Versioned schema changes, pairs with SQLAlchemy |
| ORM | SQLAlchemy 2.0 (async) | Async support, pairs with asyncpg |
| DB driver | asyncpg | Async PostgreSQL driver, required for FastAPI concurrency |
| Future live chat | WebSockets (native FastAPI) + Redis Pub/Sub | Two-way chat later; not required for MVP notifications |
| Email | AWS SES | Cheap, reliable, simple API |
| SMS | AWS SNS | Same SDK as SES, ~$0.01/text |
| File storage | AWS S3 | Standard, cheap, durable |
| Reverse proxy | Caddy | Automatic SSL, simple config, easy blue/green reload |
| Container runtime | Docker + Docker Compose | Same environment local and prod |
| Container registry | AWS ECR | Keeps images close to EC2, IAM auth |
| CI | GitHub Actions | Builds and pushes image on merge to main |
| Monitoring | AWS CloudWatch | Zero extra infrastructure, sufficient for one client |

---

## 2. Repository Structure

```
building-website/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app entrypoint, middleware registration
│   │   ├── middleware/          # Current request logging middleware
│   │   └── routers/             # Current health/version routes
│   ├── tests/
│   ├── pyproject.toml
│   ├── uv.lock
│   └── .env.example
├── frontend/                    # Current Base44-exported Vite app
├── docs/                        # Requirements, infra guide, tickets, AI workflow
├── README.md
└── .gitignore
```

As backend tickets are completed, `backend/` should grow toward this target structure:

```
backend/
├── app/
│   ├── main.py
│   ├── core/
│   │   ├── config.py            # Settings loaded from environment variables
│   │   ├── database.py          # SQLAlchemy async engine + session factory
│   │   ├── redis.py             # Redis client + pub/sub helpers for future chat
│   │   ├── security.py          # JWT creation and validation
│   │   └── dependencies.py      # Shared FastAPI dependencies (get_current_user, etc.)
│   ├── buildings/               # Building and feature flag management
│   ├── residents/               # Resident profiles, approval flow
│   ├── units/                   # Unit management
│   ├── packages/                # Package logging and pickup
│   ├── maintenance/             # Maintenance tickets and notes
│   ├── moves/                   # Move-in/out requests and inspections
│   ├── amenities/               # Amenity definitions and bookings
│   ├── reports/                 # Security shift and incident reports
│   ├── notifications/           # Durable in-app notifications, SES/SNS dispatching
│   ├── chat/                    # Future WebSocket chat, conversations, messages
│   ├── financials/              # Charges, expenses, budgets
│   └── auth/                    # Login, token refresh, registration
├── migrations/
│   ├── env.py                   # Alembic environment config
│   ├── script.py.mako           # Migration file template
│   └── versions/                # One file per migration, committed to git
├── scripts/
│   ├── seed.py                  # Populate local DB with fake data for development
│   └── deploy.sh                # Production deploy script (run on EC2)
├── tests/
├── Dockerfile
├── alembic.ini
├── pyproject.toml
├── uv.lock
├── .env.example                 # Backend template; never commit .env
```

Root-level `docker-compose.yml`, `docker-compose.prod.yml`, and `Caddyfile` are added later by the infrastructure tickets.

Each domain folder (residents, packages, etc.) follows this internal structure:

```
residents/
├── router.py      # FastAPI route definitions
├── models.py      # SQLAlchemy ORM models (maps to DB tables)
├── schemas.py     # Pydantic request/response schemas
├── service.py     # Business logic (called by router, calls models)
└── dependencies.py  # Domain-specific FastAPI dependencies
```

---

## 3. Local Development Setup

### Prerequisites

- Docker Desktop
- WSL2 Ubuntu 24.04 LTS for local development
- Python 3.12.13 (pinned in `.python-version` and `.tool-versions`)
- Node.js 24.16.0 with npm 11.x for frontend work (pinned in `.nvmrc`, `.node-version`, and `.tool-versions`)
- AWS CLI (configured with your IAM credentials, for ECR pulls and S3 access in dev)
- Git

### Current Starter Setup

The current starter repo does not include Docker, Postgres, Redis, Alembic, or production deploy files yet. Use the root `README.md` for the minimal frontend and backend commands until the corresponding infrastructure tickets add those files.

The flow below is the target local setup after M1/M2 infrastructure and database tickets are complete.

### First-Time Setup

**1. Clone the repo**

```bash
git clone git@github.com:your-org/building-website.git
cd building-website
```

The tracked `backend/.env.dev` contains safe local defaults. Create `backend/.env` only when you need personal overrides.

**2. Start all services**

```bash
docker compose up --build
```

This starts three containers:
- `app` — FastAPI on port 8000
- `db` — PostgreSQL on port 5432
- `redis` — Redis on port 6379, included for future live chat

**3. Run migrations**

```bash
docker compose exec app alembic upgrade head
```

This applies all migration scripts in order, creating every table in your local database.

**4. Seed fake data**

```bash
docker compose exec app python scripts/seed.py
```

This creates one fake building, fake units, fake residents, packages, tickets etc. so you have something to work with. Safe to run multiple times (it checks before inserting).

**5. Verify**

Open `http://localhost:8000/api/docs` — you should see the FastAPI Swagger UI with all endpoints listed.

---

### Local `docker-compose.yml`

```yaml
services:
  app:
    build:
      context: ./backend
    ports:
      - "8000:8000"
    volumes:
      - ./backend:/app                # mount backend source code for hot reload
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
    depends_on:
      - db
    env_file:
      - backend/.env

  db:
    image: postgres:16
    ports:
      - "5432:5432"                   # expose so you can connect with TablePlus/DBeaver
    environment:
      POSTGRES_DB: condo_dev
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: devpassword
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"                   # future live chat; expose so you can inspect with redis-cli

volumes:
  postgres_data:
```

### `.env.example`

```bash
# App
APP_ENV=dev                           # dev | prod
SECRET_KEY=change-me-to-a-long-random-string
ALLOWED_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]

# Database
DATABASE_URL=postgresql+asyncpg://postgres:devpassword@db:5432/condo_dev
READINESS_CHECK_DATABASE=true

# Redis (future live chat; not required by MVP workflows)
REDIS_URL=redis://redis:6379

# AWS (even locally, real credentials needed for S3/SES/SNS)
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
AWS_REGION=ca-central-1
S3_BUCKET_NAME=condo-app-dev-files

# Email / SMS
SES_FROM_EMAIL=noreply@yourcondoapp.com
```

**Never commit `.env` to git.** `.env` is in `.gitignore`. Only `.env.example` (with no real values) is committed.

### Day-to-Day Local Workflow

```bash
# Start everything
docker compose up

# Stop everything
docker compose down

# Wipe database and start fresh (useful when you've made a mess)
docker compose down -v
docker compose up
docker compose exec app alembic upgrade head
docker compose exec app python scripts/seed.py

# View logs
docker compose logs -f app

# Open a shell inside the container
docker compose exec app bash

# Run tests
docker compose exec app pytest
```

---

## 4. Backend — FastAPI

### Why FastAPI

- Async-native: handles many concurrent connections efficiently, useful for the future WebSocket chat feature
- Automatic OpenAPI docs at `/api/docs` — your frontend developer can test endpoints directly
- Pydantic validation built in — malformed requests are rejected automatically
- Gunicorn manages multiple worker processes in production, Uvicorn workers handle async

### Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .

# Production command — Gunicorn manages workers, Uvicorn handles async
CMD [".venv/bin/gunicorn", "app.main:app", \
     "-k", "uvicorn.workers.UvicornWorker", \
     "--workers", "4", \
     "--bind", "0.0.0.0:8000", \
     "--access-logfile", "-", \
     "--error-logfile", "-"]
```

Note: locally we override this command in `docker-compose.yml` to use `--reload` for hot reloading. In production, the Dockerfile CMD runs as-is.

### `backend/app/core/config.py`

```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    app_env: str = "dev"
    secret_key: str
    allowed_origins: list[str] = ["http://localhost:3000"]
    database_url: str
    redis_url: str
    aws_region: str = "ca-central-1"
    s3_bucket_name: str
    ses_from_email: str

    class Config:
        env_file = ".env"

settings = Settings()
```

### `backend/app/main.py`

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
from app.auth.router import router as auth_router
from app.packages.router import router as packages_router
# ... import all routers

app = FastAPI(
    title="Condo App API",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(packages_router, prefix="/api/packages", tags=["packages"])
# ... include all routers

@app.get("/api/health")
async def health():
    return {"status": "ok"}
```

### Authentication

Use JWT (JSON Web Tokens). On login, issue a short-lived access token (15 min) and a longer-lived refresh token (7 days). The access token is sent in the `Authorization: Bearer <token>` header on every request.

```python
# app/core/security.py
from datetime import datetime, timedelta
from jose import jwt

def create_access_token(user_id: str, building_id: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "building_id": building_id,
        "role": role,
        "exp": datetime.utcnow() + timedelta(minutes=15)
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")
```

```python
# app/core/dependencies.py
from fastapi import Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

async def get_current_user(token: str = Depends(oauth2_scheme)):
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
        return payload
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

# Role guards
async def require_management(user = Depends(get_current_user)):
    if user["role"] not in ["management", "council"]:
        raise HTTPException(status_code=403, detail="Insufficient permissions")
    return user
```

---

## 5. Database — PostgreSQL + Alembic

### Why This Setup

PostgreSQL is the right choice here because your data is highly relational (users belong to units, units belong to buildings, tickets belong to residents, etc.). A relational database enforces that structure. PostgreSQL specifically adds Row-Level Security (RLS) which gives you a safety net for tenant isolation.

### Multi-Tenancy Design

Single database, single schema, `building_id` on every tenant-specific table. No separate schemas per building.

**Why not separate schemas?**
- Running migrations means running them N times (once per building)
- Connection pooling becomes complicated
- Cross-building queries for your own admin dashboard require dynamic schema switching
- Doesn't pay off until you have hundreds of buildings or strict regulatory requirements

### Core Schema

```sql
-- Buildings (one row per client)
buildings (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    address TEXT,
    timezone VARCHAR DEFAULT 'America/Toronto',
    subscription_tier VARCHAR DEFAULT 'standard',  -- basic | standard | premium
    created_at TIMESTAMPTZ DEFAULT now()
)

-- Feature flags — what each building has paid for
building_features (
    building_id UUID REFERENCES buildings(id),
    feature_slug VARCHAR,      -- 'gameroom' | 'speakeasy' | 'pool' | 'ai_concierge' | 'financials'
    enabled BOOLEAN DEFAULT true,
    config JSONB DEFAULT '{}', -- per-feature config e.g. {"max_booking_hours": 3}
    PRIMARY KEY (building_id, feature_slug)
)

-- Physical structure
units (
    id UUID PRIMARY KEY,
    building_id UUID REFERENCES buildings(id),
    unit_number VARCHAR NOT NULL,
    floor INTEGER,
    tower VARCHAR
)

-- User accounts (global — one account could manage multiple buildings)
users (
    id UUID PRIMARY KEY,
    email VARCHAR UNIQUE NOT NULL,
    hashed_password VARCHAR NOT NULL,
    app_role VARCHAR NOT NULL,        -- resident | security | management | council
    created_at TIMESTAMPTZ DEFAULT now()
)

-- Ties a user to a specific building and unit
resident_profiles (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    building_id UUID REFERENCES buildings(id),
    unit_id UUID REFERENCES units(id),
    full_name VARCHAR NOT NULL,
    phone VARCHAR,
    status VARCHAR DEFAULT 'pending_approval'  -- pending_approval | approved
)

-- Amenities are dynamic per building
amenities (
    id UUID PRIMARY KEY,
    building_id UUID REFERENCES buildings(id),
    name VARCHAR NOT NULL,
    amenity_type VARCHAR,              -- 'gameroom' | 'speakeasy' | 'pool' | 'gym' | 'custom'
    is_active BOOLEAN DEFAULT true,
    booking_rules JSONB DEFAULT '{}'   -- {"max_duration_hours": 2, "opens": "08:00", "closes": "23:00"}
)

amenity_bookings (
    id UUID PRIMARY KEY,
    amenity_id UUID REFERENCES amenities(id),
    resident_id UUID REFERENCES resident_profiles(id),
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    status VARCHAR DEFAULT 'requested'  -- requested | accepted | active | completed | cancelled
)

-- All other entities follow the same pattern: always include building_id
packages (id, building_id, unit_id, recipient_profile_id, status, created_at, ...)
maintenance_tickets (id, building_id, resident_user_id, status, priority, category, description, ...)
maintenance_notes (id, ticket_id, author_id, content, ...)
move_requests (id, building_id, resident_user_id, requested_date, status, ...)
reports (id, building_id, author_id, report_type, content, is_deleted, ...)
report_reads (report_id, user_id)
notifications (id, building_id, recipient_id, event_type, data JSONB, read BOOLEAN, ...)
notification_preferences (resident_id, event_type, via_in_app, via_email, via_sms)
resident_charges (id, building_id, resident_id, amount, charge_type, created_at, ...)
building_expenses (id, building_id, amount, category, expense_date, ...)
budget_items (id, building_id, month, category, amount, ...)
```

### Feature Flag System

When a building subscribes to an add-on feature, you insert or update a row in `building_features`. Your middleware checks this on every relevant request:

```python
# app/buildings/dependencies.py
async def require_feature(feature_slug: str):
    async def checker(
        current_user = Depends(get_current_user),
        db: AsyncSession = Depends(get_db)
    ):
        result = await db.execute(
            select(BuildingFeature).where(
                BuildingFeature.building_id == current_user["building_id"],
                BuildingFeature.feature_slug == feature_slug,
                BuildingFeature.enabled == True
            )
        )
        if not result.scalar_one_or_none():
            raise HTTPException(status_code=403, detail=f"Feature '{feature_slug}' not enabled for this building")
    return checker

# Usage in a router
@router.get("/financials")
async def get_financials(
    _=Depends(require_feature("financials")),
    user=Depends(require_management)
):
    ...
```

The frontend calls `GET /buildings/me/features` on load and shows/hides nav items accordingly.

### `backend/app/core/database.py`

```python
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from app.core.config import settings

engine = create_async_engine(settings.database_url, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)

async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session
```

### Alembic — How Migrations Work

Alembic tracks which migration scripts have been run in a table called `alembic_version` inside your database. Each database (local, prod) tracks its own version independently.

**Generating a migration after changing a model:**

```bash
# Make your model change in app/models.py, then:
docker compose exec app alembic revision --autogenerate -m "add_priority_to_maintenance_tickets"
# Alembic compares your models to the current schema and writes the migration file
# Review the generated file in migrations/versions/ before committing
```

**Applying migrations:**

```bash
# Locally
docker compose exec app alembic upgrade head

# On prod (run this as the first step of your deploy script)
alembic upgrade head
```

**Rolling back one migration:**

```bash
alembic downgrade -1
```

**The golden rules of migrations:**

1. Migration files live in git alongside the code that needs them. They are always committed together in the same PR.
2. Never edit a migration file after it has been applied to production. Write a new one to correct it.
3. Every migration must be backward compatible — the old running version of the app must not crash when it hits the new schema. This matters during blue/green when both versions are briefly running.
4. Safe to do in one deploy: `ADD COLUMN` (nullable or with default), `CREATE TABLE`, `CREATE INDEX`.
5. Requires two deploys: renaming a column, changing a column type, making a nullable column NOT NULL, dropping a column.
6. The two-deploy pattern for a rename: Deploy 1 adds the new column and copies data. Deploy 2 drops the old column (by which point no running code references it).

---

## 6. Future Live Chat — Redis + WebSockets

### Priority

Live chat is a low-priority add-on. The MVP should not depend on WebSockets for packages, resident approval, notices, reports, badge counts, or operational notifications.

For MVP:
- In-app notifications are stored in PostgreSQL.
- The frontend loads notifications and badges through normal API calls.
- React Query refetch/invalidation and limited polling are enough for package counts, approvals, reports, notices, and emergency alerts.
- Email/SMS delivery is handled by SES/SNS as a best-effort background side effect.

WebSockets are planned for live chat later, where two-way communication matters.

### Why Still Plan For Redis

When FastAPI runs multiple Gunicorn workers, each WebSocket connection belongs to one worker process. If User A sends a chat message through Worker 1 and User B's socket is connected to Worker 2, Worker 1 needs a shared bus to tell Worker 2 about the message. Redis Pub/Sub is that bus.

Redis can be included in local and production compose early because it is lightweight, but the core app should still start and work without chat enabled.

### Chat Persistence Rule

Chat messages must be saved to PostgreSQL before being published over Redis. Redis is only the live delivery path.

This makes blue/green deploys and reconnects simple:
1. Client socket drops when the old app color is stopped.
2. Client reconnects to the new app color.
3. Client re-joins the conversation.
4. Client sends `last_seen_message_id` or a timestamp.
5. Backend returns missed messages from PostgreSQL.

The result is a brief disconnect, not lost messages.

### Future Chat Tables

```sql
chat_conversations (
    id UUID PRIMARY KEY,
    building_id UUID REFERENCES buildings(id),
    subject VARCHAR,
    status VARCHAR DEFAULT 'open',        -- open | closed
    created_by_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT now()
)

chat_participants (
    conversation_id UUID REFERENCES chat_conversations(id),
    user_id UUID REFERENCES users(id),
    last_read_message_id UUID,
    joined_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (conversation_id, user_id)
)

chat_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID REFERENCES chat_conversations(id),
    building_id UUID REFERENCES buildings(id),
    sender_user_id UUID REFERENCES users(id),
    body TEXT NOT NULL,
    attachment_s3_key VARCHAR,
    created_at TIMESTAMPTZ DEFAULT now()
)
```

### Future `backend/app/core/redis.py`

```python
import json
import redis.asyncio as aioredis
from app.core.config import settings

redis_client = aioredis.from_url(settings.redis_url, decode_responses=True)

async def publish_chat_event(building_id: str, conversation_id: str, event: dict):
    await redis_client.publish(
        f"building:{building_id}:chat:{conversation_id}",
        json.dumps(event),
    )
```

### Future WebSocket Endpoint

```python
# app/chat/router.py
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
import json

router = APIRouter()

@router.websocket("/chat/ws")
async def chat_websocket(websocket: WebSocket, token: str, conversation_id: str):
    user = validate_token(token)
    building_id = user["building_id"]
    user_id = user["sub"]

    await ensure_chat_participant(user_id, conversation_id, building_id)
    await websocket.accept()

    pubsub = redis_client.pubsub()
    channel = f"building:{building_id}:chat:{conversation_id}"
    await pubsub.subscribe(channel)

    async def redis_listener():
        async for message in pubsub.listen():
            if message["type"] == "message":
                await websocket.send_json(json.loads(message["data"]))

    listener_task = asyncio.create_task(redis_listener())

    try:
        while True:
            payload = await websocket.receive_json()
            message = await save_chat_message(
                conversation_id=conversation_id,
                sender_user_id=user_id,
                body=payload["body"],
            )
            await publish_chat_event(building_id, conversation_id, {
                "type": "chat_message.created",
                "message": message.to_dict(),
            })
    except WebSocketDisconnect:
        listener_task.cancel()
        await pubsub.unsubscribe(channel)
```

### Frontend Reconnect Contract

The chat client should:
- Connect only when the user opens chat.
- Reconnect with exponential backoff, for example 1s, 2s, 5s, 10s, 30s.
- Send the current conversation ID and token on connect.
- After reconnect, call `GET /chat/conversations/{id}/messages?after=<last_seen_message_id>`.
- Show a small "reconnecting" state rather than failing the whole app.

### On Prod

Redis runs as a container on the same EC2 instance, not exposed publicly. Both Blue and Green containers can connect to it. No ElastiCache is needed at the first-building scale.

**What to watch out for with shared Redis in blue/green:**
- Pub/Sub is safe for live chat delivery because PostgreSQL is the durable source of truth.
- Existing WebSocket connections on Blue will disconnect when Blue is stopped.
- That disconnect is acceptable if clients auto-reconnect and load missed messages from PostgreSQL.
- If Redis is ever used for caches or job queues, version key formats and keep queue handlers backward compatible during deploys.

---

## 7. Notifications — AWS SES + SNS

### Why AWS SES and SNS

In-app notification records live in PostgreSQL and are fetched by the frontend. Users also need to be notified when they're not actively using the app. SES handles email, SNS handles SMS. Both use the same `boto3` SDK, cost almost nothing at your scale, and require zero infrastructure to set up.

**Costs at one building (~500 residents):**
- SES: $0.10 per 1,000 emails
- SNS SMS: ~$0.01 per text message

### Setup

**SES requires domain verification.** In the AWS console:
1. Go to SES → Verified Identities → Create identity
2. Verify your sending domain (e.g., `yourcondoapp.com`) by adding DNS records
3. Request production access (SES starts in sandbox mode where you can only send to verified emails)

**SNS SMS** works immediately with no setup — just call the API.

### Notification Service

```python
# app/notifications/service.py
import boto3
from app.core.config import settings

ses = boto3.client("ses", region_name=settings.aws_region)
sns = boto3.client("sns", region_name=settings.aws_region)

EVENT_TEMPLATES = {
    "new_package": {
        "subject": "You have a new package",
        "email_body": "A package has arrived for your unit. Please pick it up at the concierge desk.",
        "sms_body": "Condo App: A package has arrived for your unit. Please pick it up at the concierge desk.",
    },
    "maintenance_update": {
        "subject": "Your maintenance request has been updated",
        "email_body": "Your maintenance ticket status has been updated. Log in to check the details.",
        "sms_body": "Condo App: Your maintenance request status has been updated.",
    },
    # add more event types as needed
}

async def dispatch(event_type: str, building_id: str, recipient, data: dict = {}):
    """
    recipient: resident_profile object with .email, .phone, .notification_preferences
    """
    template = EVENT_TEMPLATES.get(event_type, {})
    prefs = recipient.notification_preferences.get(event_type, {})

    # 1. In-app durable notification. Frontend fetches/polls these in MVP.
    if prefs.get("via_in_app", True):
        try:
            await create_notification_record(
                building_id=building_id,
                recipient_id=recipient.user_id,
                event_type=event_type,
                data=data,
            )
        except Exception as e:
            logger.error(f"In-app notification failed: {e}")

    # 2. Email
    if prefs.get("via_email", True) and recipient.email and template:
        try:
            ses.send_email(
                Source=settings.ses_from_email,
                Destination={"ToAddresses": [recipient.email]},
                Message={
                    "Subject": {"Data": template["subject"]},
                    "Body": {"Text": {"Data": template["email_body"]}}
                }
            )
        except Exception as e:
            logger.error(f"SES email failed: {e}")

    # 3. SMS
    if prefs.get("via_sms", False) and recipient.phone and template:
        try:
            sns.publish(
                PhoneNumber=recipient.phone,
                Message=template["sms_body"]
            )
        except Exception as e:
            logger.error(f"SNS SMS failed: {e}")
```

Notifications are durable in the database and should be created as part of the main workflow where appropriate. SES/SNS delivery is always **best-effort** — a failure in email or SMS must never roll back a database transaction or fail an API request. Always wrap outbound network calls in try/except and log the error.

For MVP, notification center and badge freshness should use normal API reads, React Query invalidation after local mutations, and small polling intervals for critical counters. Do not make core workflows depend on WebSockets.

### Notification Preferences Table

Residents control which channels they want per event type:

```sql
notification_preferences (
    resident_id UUID REFERENCES resident_profiles(id),
    event_type VARCHAR,
    via_in_app BOOLEAN DEFAULT true,
    via_email BOOLEAN DEFAULT true,
    via_sms BOOLEAN DEFAULT false,
    PRIMARY KEY (resident_id, event_type)
)
```

---

## 8. File Storage — AWS S3

### What Gets Stored

- Profile pictures
- Move inspection photos (pre/post damage)
- Maintenance ticket attachments
- Bank statement uploads

### Never Store Files in the Database

Do not store file contents in PostgreSQL (as bytea or similar). Store only the S3 key (the file path) in the database. S3 holds the actual bytes.

```sql
-- In maintenance_tickets:
attachment_s3_key VARCHAR    -- e.g. "buildings/abc123/tickets/xyz789/photo.jpg"
-- NOT: attachment_data BYTEA
```

### Upload Flow

Use **presigned URLs** — the frontend uploads directly to S3 without the file passing through your backend server. This keeps your EC2 load low and your uploads fast.

```
1. Frontend asks backend: POST /files/presigned-url
   { "file_type": "image/jpeg", "context": "maintenance_ticket", "ticket_id": "xyz" }

2. Backend generates a presigned URL (valid for 5 minutes):
   s3.generate_presigned_url("put_object", Params={...})
   Returns: { "upload_url": "https://s3.amazonaws.com/...", "s3_key": "buildings/..." }

3. Frontend uploads the file directly to S3 using the presigned URL (PUT request)

4. Frontend tells backend the upload is done:
   PATCH /maintenance-tickets/xyz { "attachment_s3_key": "buildings/..." }

5. Backend saves the s3_key to the database
```

```python
# app/files/router.py
import boto3
from app.core.config import settings

s3 = boto3.client("s3", region_name=settings.aws_region)

@router.post("/files/presigned-url")
async def get_presigned_url(
    file_type: str,
    context: str,
    current_user = Depends(get_current_user)
):
    building_id = current_user["building_id"]
    s3_key = f"buildings/{building_id}/{context}/{uuid4()}"

    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket_name,
            "Key": s3_key,
            "ContentType": file_type
        },
        ExpiresIn=300  # 5 minutes
    )
    return {"upload_url": upload_url, "s3_key": s3_key}
```

For downloads, generate presigned GET URLs so files are never publicly accessible:

```python
download_url = s3.generate_presigned_url(
    "get_object",
    Params={"Bucket": settings.s3_bucket_name, "Key": s3_key},
    ExpiresIn=3600  # 1 hour
)
```

### S3 Bucket Configuration

- Block all public access (files are only accessible via presigned URLs)
- Enable server-side encryption (SSE-S3)
- Set a lifecycle rule to transition old inspection photos to S3 Infrequent Access after 90 days to reduce cost
- Separate buckets for dev and prod: `condo-app-dev-files`, `condo-app-prod-files`

---

## 9. CI/CD Pipeline — GitHub Actions + ECR

### What Happens Automatically (CI)

On every merge to `main`:
1. GitHub Actions builds the Docker image
2. Pushes it to ECR with two tags: the git SHA (`abc1234`) and `latest`
3. The image is ready to pull and deploy — but nothing deploys automatically

Deployment to production is always a **manual step** (you SSH in and run the deploy script). This is intentional at your scale — full auto-deploy carries risk without comprehensive integration tests.

### GitHub Actions Workflow

```yaml
# .github/workflows/build.yml
name: Build and Push to ECR

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ca-central-1

      - name: Log in to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image
        env:
          ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
          ECR_REPOSITORY: condo-management-api
          IMAGE_TAG: ${{ github.sha }}
        run: |
          # IMPORTANT: build for linux/amd64 regardless of developer machine architecture
          # This is critical if any developer is on Apple Silicon (M1/M2/M3)
          docker buildx build \
            --platform linux/amd64 \
            -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG \
            -t $ECR_REGISTRY/$ECR_REPOSITORY:latest \
            --push .
```

**Critical: `--platform linux/amd64`** — If anyone on the team uses Apple Silicon, their local builds produce ARM images. An ARM image deployed to an x86 EC2 will fail silently or crash. Always force amd64 in CI.

### ECR Lifecycle Policy

Keep only the 10 most recent images (enough for rollbacks without accumulating cost):

```json
{
  "rules": [{
    "rulePriority": 1,
    "description": "Keep last 10 images",
    "selection": {
      "tagStatus": "any",
      "countType": "imageCountMoreThan",
      "countNumber": 10
    },
    "action": { "type": "expire" }
  }]
}
```

Set this in the AWS ECR console under your repository → Lifecycle policy.

### GitHub Secrets Required

Set these in your repo → Settings → Secrets and variables → Actions:

```
AWS_ACCESS_KEY_ID         ← IAM user with ECR push permissions
AWS_SECRET_ACCESS_KEY
```

---

## 10. Production Infrastructure — AWS

### What You're Running

| Resource | Type | Cost (approx) |
|---|---|---|
| EC2 instance | t3.small (2 vCPU, 2GB RAM) | ~$15/month |
| RDS PostgreSQL | db.t3.small | ~$25/month |
| S3 | Standard storage | ~$1-3/month |
| ECR | Image storage | ~$1-2/month |
| CloudWatch | Logs + basic metrics | ~$5-10/month |
| SES | Email | ~$1/month |
| SNS | SMS | ~$1-5/month |
| **Total** | | **~$50-60/month** |

Healthy margin on $500-2000/month revenue. No ElastiCache is needed at first — Redis can run as a container on EC2 when live chat is enabled.

### Initial EC2 Setup (One-Time)

```bash
# SSH in as ubuntu
ssh -i your-key.pem ubuntu@your-ec2-ip

# Install Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
# Log out and back in

# Install Docker Compose plugin
sudo apt-get install docker-compose-plugin

# Install AWS CLI
sudo apt install awscli

# Configure ECR access
aws configure  # enter your IAM credentials

# Create app directory
mkdir -p /app
cd /app

# Copy your prod docker-compose and Caddyfile here
# (either git clone the repo or scp the files)
```

### IAM Permissions for EC2

The EC2 instance needs an IAM role (not hardcoded credentials) with these permissions:
- `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` — to pull images
- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on your bucket — for file storage
- `ses:SendEmail` — for email notifications
- `sns:Publish` — for SMS notifications
- `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` — for CloudWatch

Attach the IAM role to the EC2 instance in the AWS console (EC2 → Actions → Security → Modify IAM role). No credentials in environment variables.

### RDS Setup

- Engine: PostgreSQL 16
- Instance: db.t3.small
- Storage: 20GB gp3 (auto-scaling disabled — you'll know when you need more)
- Multi-AZ: No (not needed for one client, adds ~$25/month)
- Publicly accessible: No — only accessible from within the VPC
- Security group: allow port 5432 only from your EC2's security group

Store the RDS connection string in AWS Systems Manager Parameter Store (not in your docker-compose file):

```bash
aws ssm put-parameter \
  --name "/condo-app/prod/DATABASE_URL" \
  --value "postgresql+asyncpg://user:pass@your-rds-endpoint:5432/condo" \
  --type SecureString
```

Your deploy script fetches it at deploy time.

### Production `docker-compose.prod.yml`

```yaml
services:
  app-blue:
    image: ${ECR_REGISTRY}/condo-management-api:${IMAGE_TAG}
    ports:
      - "8001:8000"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://redis:6379
      - SECRET_KEY=${SECRET_KEY}
      - APP_ENV=prod
      - ALLOWED_ORIGINS=["https://app.yourcondoapp.com"]
      - READINESS_CHECK_DATABASE=true
      - AWS_REGION=ca-central-1
      - S3_BUCKET_NAME=condo-app-prod-files
      - SES_FROM_EMAIL=noreply@yourcondoapp.com
    logging:
      driver: awslogs
      options:
        awslogs-region: ca-central-1
        awslogs-group: /condo-app/prod
        awslogs-stream: app-blue
    restart: unless-stopped

  app-green:
    image: ${ECR_REGISTRY}/condo-management-api:${IMAGE_TAG}
    ports:
      - "8002:8000"
    environment:
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=redis://redis:6379
      - SECRET_KEY=${SECRET_KEY}
      - APP_ENV=prod
      - ALLOWED_ORIGINS=["https://app.yourcondoapp.com"]
      - READINESS_CHECK_DATABASE=true
      - AWS_REGION=ca-central-1
      - S3_BUCKET_NAME=condo-app-prod-files
      - SES_FROM_EMAIL=noreply@yourcondoapp.com
    logging:
      driver: awslogs
      options:
        awslogs-region: ca-central-1
        awslogs-group: /condo-app/prod
        awslogs-stream: app-green
    restart: unless-stopped
    profiles:
      - green    # only starts when explicitly requested

  redis:
    image: redis:7-alpine
    restart: always
    # no ports exposed — only accessible within Docker network
    volumes:
      - redis_data:/data

volumes:
  redis_data:
```

Note the `profiles: [green]` on `app-green` — this means Green doesn't start automatically with `docker compose up`. You start it explicitly during a deploy.

---

## 11. Deployment — Blue/Green with Caddy

### Caddyfile

```caddyfile
yourcondoapp.com {
    reverse_proxy localhost:8001    # points to Blue by default
}
```

Caddy automatically handles SSL certificate provisioning and renewal via Let's Encrypt. No configuration needed.

**To switch from Blue to Green**, edit the port and reload:
```caddyfile
yourcondoapp.com {
    reverse_proxy localhost:8002    # now pointing to Green
}
```

```bash
caddy reload --config /app/Caddyfile
```

`caddy reload` is zero-downtime — existing connections finish on Blue while new ones go to Green.

For MVP, this is enough because the app does not rely on WebSockets. When live chat is added later, existing chat sockets connected to Blue will disconnect when Blue is stopped. That is acceptable as long as the chat client auto-reconnects to Green and reloads missed messages from PostgreSQL. Production deploys should still happen during low-traffic windows, such as midnight or after.

### `scripts/deploy.sh`

This is the script you run on EC2 for every production deploy:

```bash
#!/bin/bash
set -e  # exit immediately if any command fails

ECR_REGISTRY="your-account-id.dkr.ecr.ca-central-1.amazonaws.com"
ECR_REPO="condo-management-api"
IMAGE_TAG="${1:-latest}"   # pass the git SHA as argument, defaults to latest
APP_DIR="/app"

echo "=== Starting deploy: $IMAGE_TAG ==="

# 1. Fetch secrets from SSM Parameter Store
export DATABASE_URL=$(aws ssm get-parameter --name "/condo-app/prod/DATABASE_URL" --with-decryption --query Parameter.Value --output text)
export SECRET_KEY=$(aws ssm get-parameter --name "/condo-app/prod/SECRET_KEY" --with-decryption --query Parameter.Value --output text)
export ECR_REGISTRY=$ECR_REGISTRY
export IMAGE_TAG=$IMAGE_TAG

# 2. Authenticate with ECR and pull new image
aws ecr get-login-password --region ca-central-1 | docker login --username AWS --password-stdin $ECR_REGISTRY
docker pull $ECR_REGISTRY/$ECR_REPO:$IMAGE_TAG

# 3. Run database migrations BEFORE starting new container
echo "=== Running migrations ==="
docker run --rm \
  -e DATABASE_URL=$DATABASE_URL \
  $ECR_REGISTRY/$ECR_REPO:$IMAGE_TAG \
  alembic upgrade head

# 4. Start Green container
echo "=== Starting Green ==="
cd $APP_DIR
docker compose -f docker-compose.prod.yml --profile green up -d app-green

# 5. Wait for Green to be healthy
echo "=== Waiting for Green health check ==="
for i in {1..10}; do
  if curl -sf http://localhost:8002/api/ready; then
    echo "Green is healthy"
    break
  fi
  echo "Attempt $i failed, waiting..."
  sleep 3
done

if ! curl -sf http://localhost:8002/api/ready; then
  echo "ERROR: Green failed health check. Aborting deploy."
  docker compose -f docker-compose.prod.yml stop app-green
  exit 1
fi

# 6. Switch Caddy to Green
echo "=== Switching Caddy to Green (port 8002) ==="
sed -i 's/localhost:8001/localhost:8002/' $APP_DIR/Caddyfile
caddy reload --config $APP_DIR/Caddyfile

echo "=== Deploy complete. Green is live on port 8002. ==="
echo "=== Monitor logs, then run: docker compose -f docker-compose.prod.yml stop app-blue ==="
echo "=== Once confirmed stable, update Caddyfile Blue/Green labels for next deploy ==="
```

### Full Deploy Procedure

```bash
# On your machine — get the SHA of the commit you want to deploy
git log --oneline -5

# SSH into EC2
ssh -i your-key.pem ubuntu@your-ec2-ip

# Run the deploy script with the specific image SHA
cd /app
bash scripts/deploy.sh abc1234

# Watch Green logs
docker compose -f docker-compose.prod.yml logs -f app-green

# If everything looks good after a few minutes, shut down Blue
docker compose -f docker-compose.prod.yml stop app-blue

# --- ONLY IF SOMETHING IS WRONG ---
# Roll back to Blue immediately:
sed -i 's/localhost:8002/localhost:8001/' /app/Caddyfile
caddy reload --config /app/Caddyfile
docker compose -f docker-compose.prod.yml stop app-green
```

### Blue/Green Naming Convention

After each deploy, rename what was Green to Blue for the next cycle. The simplest way: maintain a file `/app/.current` that records which port is active (`8001` or `8002`), and have the deploy script read it to know which is old and which is new.

---

## 12. Logging & Monitoring — CloudWatch

### Why CloudWatch (Not Grafana/Prometheus)

At one client generating $500-2000/month, the cost and setup time of Grafana + Prometheus is not justified. CloudWatch gives you enough visibility for essentially nothing:

- EC2 basic metrics (CPU, network, disk) are **free**
- Logs cost ~$0.50/GB ingested — you're looking at a few dollars a month
- Alarms via SNS email are free

When you grow to 5-10 clients, you can run CloudWatch and a Prometheus exporter in parallel during a transition. It's not a painful migration.

### Log Driver Setup

The `awslogs` Docker log driver sends container logs straight to CloudWatch with zero agent or SDK code:

```yaml
# Already included in docker-compose.prod.yml
logging:
  driver: awslogs
  options:
    awslogs-region: ca-central-1
    awslogs-group: /condo-app/prod
    awslogs-stream: app-blue   # or app-green
```

Create the log group once:
```bash
aws logs create-log-group --log-group-name /condo-app/prod --region ca-central-1
```

### Structured JSON Logging

Use JSON logging from day one. This makes logs queryable in CloudWatch Insights without reformatting later.

```python
# app/core/logging.py
import logging
import json

class JSONFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "message": record.getMessage(),
            "module": record.module,
            **getattr(record, "extra", {})
        })

# Usage in route handlers
logger.info("Package logged", extra={
    "building_id": building_id,
    "unit": unit_number,
    "event": "package_logged"
})
```

Now in CloudWatch Insights you can query:
```
fields @timestamp, message, building_id, event
| filter level = "ERROR"
| sort @timestamp desc
```

### CloudWatch Alarms

Set up two alarms in the AWS console (or CLI):

**1. High CPU:**
```bash
aws cloudwatch put-metric-alarm \
  --alarm-name "condo-app-high-cpu" \
  --metric-name CPUUtilization \
  --namespace AWS/EC2 \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions arn:aws:sns:ca-central-1:YOUR_ACCOUNT:condo-app-alerts \
  --dimensions Name=InstanceId,Value=YOUR_INSTANCE_ID
```

**2. 5xx Error Rate** — add a metric filter on your logs:
```bash
aws logs put-metric-filter \
  --log-group-name /condo-app/prod \
  --filter-name "5xx-errors" \
  --filter-pattern '{ $.level = "ERROR" }' \
  --metric-transformations metricName=ErrorCount,metricNamespace=CondoApp,metricValue=1
```

Then create an alarm on that custom metric.

Both alarms notify an SNS topic that emails you. Free.

---

## 13. Security Checklist

### Network

- [ ] RDS is not publicly accessible — only reachable from EC2's security group
- [ ] Redis container has no public port in prod (`docker-compose.prod.yml`)
- [ ] EC2 security group: only ports 80, 443 (Caddy) and 22 (SSH) open to the internet
- [ ] SSH access restricted to your IP, or use AWS Session Manager instead of open port 22

### Application

- [ ] JWT secret key is long (32+ chars), random, stored in SSM Parameter Store
- [ ] All API endpoints check `building_id` from the JWT token — never trust `building_id` from request body
- [ ] File uploads validate MIME type and file size before issuing presigned URLs
- [ ] Rate limiting on auth endpoints (login, registration) to prevent brute force
- [ ] CORS `allow_origins` is restricted to your actual frontend domain in prod

### Data

- [ ] `.env` is in `.gitignore` — never committed
- [ ] No real credentials in `docker-compose.yml` — all from environment variables or SSM
- [ ] S3 bucket blocks all public access
- [ ] Database password is not the same as your local dev password

### Operational

- [ ] `--platform linux/amd64` in GitHub Actions build
- [ ] Migrations reviewed before merging
- [ ] New migration tested locally before pushing
- [ ] Health check passes before Caddy switches in deploy script

---

## 14. Gotchas & Things to Avoid

**Never develop against the production database.**
Local has its own Postgres container. Prod has RDS. They are separate. If you connect TablePlus to the wrong endpoint and run a migration manually, you'll corrupt the prod schema history.

**Never manually edit the prod schema.**
Only Alembic runs DDL on the database. Never `ALTER TABLE` or `CREATE TABLE` in a psql session on prod. It will fall out of sync with Alembic's version tracking and cause chaos on the next deploy.

**Never edit a migration file after it's been applied to prod.**
If you made a mistake, write a new migration that corrects it. Editing an existing one confuses Alembic's hash tracking.

**Never trust `building_id` from the request body.**
Always read `building_id` from the JWT token payload. A malicious request could send a different `building_id` in the body and read another building's data if you don't enforce this.

**Never store secrets in `docker-compose.prod.yml` or in the git repo.**
Use SSM Parameter Store for prod secrets. Use `.env` locally (git-ignored).

**Always build with `--platform linux/amd64` in CI.**
Apple Silicon developers produce ARM images locally. An ARM image on an x86 EC2 will run but perform badly or crash in subtle ways. Force amd64 in GitHub Actions regardless of what the developer's machine is.

**Notifications must never fail the main operation.**
SES and SNS calls go over the network and can fail. Always wrap them in try/except. A failed SMS must never roll back a package save.

**Future chat WebSocket connections drop — design for reconnection.**
When live chat is implemented, clients should automatically reconnect with exponential backoff. Chat messages must already be stored in PostgreSQL, so reconnecting clients can ask for missed messages by `last_seen_message_id` or timestamp.

**Blue/Green: run migrations before starting Green, not after.**
If Green starts and hits an old schema, it may crash or corrupt data. Migration → start Green → health check → switch Caddy. Always in that order.

**Blue/Green: keep migrations backward compatible.**
During the switch window, both Blue and Green are running against the same database. The new schema must not break the old code. Add columns nullable. Never rename in one step. Never drop a column in the same deploy that removes it from the code.

**Redis data format changes are like DB migrations.**
If you change the structure of something cached in Redis, version the key (`features:v2`) or keep old formats readable until Blue is shut down. Otherwise Blue reads a key Green wrote in a new format and crashes.
