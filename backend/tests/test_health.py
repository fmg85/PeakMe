"""Tests for the health/readiness probes.

/readiness is the post-deploy gate: it must 503 when the DB is unreachable or the
schema isn't at head, so a broken deploy can't report success.
"""
from sqlalchemy import text

from app.main import _expected_head_revision


async def _set_alembic_version(db, version_num):
    await db.execute(text("CREATE TABLE IF NOT EXISTS alembic_version (version_num varchar(32) NOT NULL)"))
    await db.execute(text("DELETE FROM alembic_version"))
    await db.execute(text("INSERT INTO alembic_version (version_num) VALUES (:v)"), {"v": version_num})
    await db.commit()


async def test_health_is_static_ok(client):
    r = await client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


async def test_readiness_ok_when_schema_at_head(client, db):
    head = _expected_head_revision()
    await _set_alembic_version(db, head)

    r = await client.get("/readiness")

    assert r.status_code == 200
    assert r.json() == {"ready": True, "revision": head}


async def test_readiness_503_when_schema_stale(client, db):
    await _set_alembic_version(db, "0001")  # behind head

    r = await client.get("/readiness")

    assert r.status_code == 503
