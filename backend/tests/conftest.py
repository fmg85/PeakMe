"""Shared fixtures for the PeakMe backend test suite.

Scope is intentionally narrow (CLAUDE.md "Testing"): auth, the annotate upsert,
the queue, and the ownership 403. Tests run against a real Postgres — locally an
ephemeral instance, in CI a `postgres:16` service — pointed at by DATABASE_URL.
See docs/adr/ADR-013-deploy-gated-ci.md.
"""
import asyncio
import os

# Settings() reads these at import time, so they must exist before importing app.*.
# Only DB-free placeholders here; DATABASE_URL is supplied by the runner (local
# ephemeral pg / CI service) so we never invent a database connection.
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-jwt-secret-do-not-use-in-prod")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_S3_BUCKET", "test-bucket")
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("ENVIRONMENT", "test")

if "DATABASE_URL" not in os.environ:
    raise RuntimeError(
        "DATABASE_URL must point at a throwaway test Postgres. "
        "Local: postgresql+psycopg://postgres@localhost:55432/peakme_test"
    )

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

import app.models  # noqa: F401  — registers every model on Base.metadata
from app.database import AsyncSessionLocal, Base
from app.deps import get_current_user
from app.main import app

# Truncate order is irrelevant with CASCADE, but list every table so a new one
# added without updating this is obvious.
_TABLES = "ion_stars, annotations, ions, datasets, label_options, projects, users"


def _create_schema() -> None:
    """Create all tables once, in a throwaway loop, before any test runs."""
    async def run() -> None:
        eng = create_async_engine(os.environ["DATABASE_URL"], poolclass=NullPool)
        async with eng.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await eng.dispose()

    asyncio.run(run())


_create_schema()


@pytest_asyncio.fixture(autouse=True)
async def _clean_tables():
    """Wipe all rows before each test for isolation (the schema persists)."""
    async with AsyncSessionLocal() as s:
        await s.execute(text(f"TRUNCATE {_TABLES} RESTART IDENTITY CASCADE"))
        await s.commit()
    yield


@pytest_asyncio.fixture
async def db():
    """A session for seeding fixtures and asserting DB state inside a test."""
    async with AsyncSessionLocal() as s:
        yield s


@pytest_asyncio.fixture
async def client():
    """An httpx client bound to the ASGI app (no network)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def login_as():
    """Override get_current_user to act as a given (already-seeded) user."""
    def _login(user):
        app.dependency_overrides[get_current_user] = lambda: user

    yield _login
    app.dependency_overrides.pop(get_current_user, None)
