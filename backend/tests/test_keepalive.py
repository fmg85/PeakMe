"""Tests for the in-app database keepalive.

The keepalive exists so an idle Supabase free-tier project never pauses itself
(ADR-002 / ADR-015). It must survive transient DB failures — a loop that dies on
the first blip silently stops protecting the database, which is the exact failure
mode the GitHub-Actions-based keepalive already has.
"""
import asyncio

import pytest
from sqlalchemy import text

import app.main as main


async def test_keepalive_endpoint_pings_db(client):
    r = await client.get("/keepalive")
    assert r.status_code == 200
    assert r.json() == {"alive": True}


async def test_keepalive_loop_pings_db_each_interval(monkeypatch):
    """The loop should issue a real query once per interval."""
    pings = 0
    real_sleep = asyncio.sleep

    async def fake_sleep(_seconds):
        nonlocal pings
        pings += 1
        if pings > 3:
            raise asyncio.CancelledError
        await real_sleep(0)

    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)

    executed = []

    class _FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, stmt):
            executed.append(str(stmt))

    monkeypatch.setattr(main, "AsyncSessionLocal", lambda: _FakeSession())

    with pytest.raises(asyncio.CancelledError):
        await main._keepalive_loop()

    assert len(executed) == 3
    assert all("SELECT 1" in q for q in executed)


async def test_keepalive_loop_survives_db_errors(monkeypatch):
    """A transient DB failure must not kill the loop — it has to keep pinging."""
    calls = 0
    real_sleep = asyncio.sleep

    async def fake_sleep(_seconds):
        nonlocal calls
        calls += 1
        if calls > 3:
            raise asyncio.CancelledError
        await real_sleep(0)

    monkeypatch.setattr(main.asyncio, "sleep", fake_sleep)

    attempts = 0

    def _boom():
        nonlocal attempts
        attempts += 1
        raise OSError("connection refused")

    monkeypatch.setattr(main, "AsyncSessionLocal", _boom)

    with pytest.raises(asyncio.CancelledError):
        await main._keepalive_loop()

    # Failed on every attempt, but kept going rather than exiting after the first.
    assert attempts == 3


async def test_keepalive_loop_is_started_and_cancelled_by_lifespan(monkeypatch):
    """The loop must actually be wired into app startup, and stopped on shutdown."""
    started = asyncio.Event()

    async def fake_loop():
        started.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(main, "_keepalive_loop", fake_loop)

    async with main.lifespan(main.app):
        await asyncio.wait_for(started.wait(), timeout=1)
        running = [t for t in asyncio.all_tasks() if t.get_coro().__name__ == "fake_loop"]
        assert running, "keepalive task was not started"

    # After the context exits, the task must be gone (not leaked).
    leftover = [
        t for t in asyncio.all_tasks()
        if t.get_coro().__name__ == "fake_loop" and not t.done()
    ]
    assert not leftover, "keepalive task leaked past shutdown"


async def test_keepalive_interval_leaves_margin_under_supabase_pause():
    """Supabase free tier pauses after ~1 week idle; the ping must be far tighter."""
    one_week = 7 * 24 * 60 * 60
    assert main.KEEPALIVE_INTERVAL_SECONDS < one_week / 4


async def test_db_reachable(db):
    """Sanity: the fixture DB answers the same query the keepalive uses."""
    result = await db.execute(text("SELECT 1"))
    assert result.scalar_one() == 1
