"""Tests for the project ownership 403 — the app's only privilege boundary.

Every other read/annotate endpoint is intentionally shared between authenticated
users; project mutation is the one place authorization matters.
"""
import uuid

from tests.factories import make_project, make_user


async def test_owner_can_update_own_project(client, db, login_as):
    owner = await make_user(db)
    project = await make_project(db, owner)
    login_as(owner)

    r = await client.patch(f"/api/projects/{project.id}", json={"name": "Renamed"})

    assert r.status_code == 200
    assert r.json()["name"] == "Renamed"


async def test_non_owner_cannot_update(client, db, login_as):
    owner = await make_user(db)
    other = await make_user(db)
    project = await make_project(db, owner)
    login_as(other)

    r = await client.patch(f"/api/projects/{project.id}", json={"name": "Hijacked"})

    assert r.status_code == 403


async def test_non_owner_cannot_delete(client, db, login_as):
    owner = await make_user(db)
    other = await make_user(db)
    project = await make_project(db, owner)
    login_as(other)

    r = await client.delete(f"/api/projects/{project.id}")

    assert r.status_code == 403


async def test_admin_can_update_any_project(client, db, login_as):
    owner = await make_user(db)
    admin = await make_user(db, is_admin=True)
    project = await make_project(db, owner)
    login_as(admin)

    r = await client.patch(f"/api/projects/{project.id}", json={"name": "By Admin"})

    assert r.status_code == 200


async def test_update_missing_project_returns_404(client, db, login_as):
    user = await make_user(db)
    login_as(user)

    r = await client.patch(f"/api/projects/{uuid.uuid4()}", json={"name": "x"})

    assert r.status_code == 404
