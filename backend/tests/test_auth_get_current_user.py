"""Tests for deps.get_current_user — the user resolution / account-merge logic.

The email-fallback path silently links accounts, so a regression could merge two
people or violate the unique-email constraint. _verify_token is stubbed; the DB is
real.
"""
import uuid

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import func, select

import app.deps as deps
from app.deps import get_current_user
from app.models.user import User
from tests.factories import make_user


def _creds():
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials="ignored")


def _patch_payload(monkeypatch, payload):
    async def fake_verify(_token):
        return payload

    monkeypatch.setattr(deps, "_verify_token", fake_verify)


async def _user_count(db):
    return await db.scalar(select(func.count()).select_from(User))


async def test_known_uuid_returns_existing_user(db, monkeypatch):
    user = await make_user(db, email="a@example.com")
    _patch_payload(monkeypatch, {"sub": str(user.id), "email": "a@example.com"})

    got = await get_current_user(credentials=_creds(), db=db)

    assert got.id == user.id
    assert await _user_count(db) == 1  # no new row


async def test_email_fallback_links_to_existing_user_without_creating_a_row(db, monkeypatch):
    existing = await make_user(db, email="same@example.com")
    # A different Supabase UUID (e.g. OTP-then-Google) but the same email.
    _patch_payload(monkeypatch, {"sub": str(uuid.uuid4()), "email": "same@example.com"})

    got = await get_current_user(credentials=_creds(), db=db)

    assert got.id == existing.id  # linked, not duplicated
    assert await _user_count(db) == 1


async def test_brand_new_user_is_auto_created_with_metadata_name(db, monkeypatch):
    _patch_payload(
        monkeypatch,
        {
            "sub": str(uuid.uuid4()),
            "email": "new@example.com",
            "user_metadata": {"full_name": "New Person"},
        },
    )

    got = await get_current_user(credentials=_creds(), db=db)

    assert got.email == "new@example.com"
    assert got.display_name == "New Person"
    assert await _user_count(db) == 1


async def test_new_user_without_metadata_falls_back_to_email_prefix(db, monkeypatch):
    _patch_payload(monkeypatch, {"sub": str(uuid.uuid4()), "email": "alice@example.com"})

    got = await get_current_user(credentials=_creds(), db=db)

    assert got.display_name == "alice"


async def test_display_name_synced_when_stored_name_is_email_prefix(db, monkeypatch):
    # Stored name still looks auto-generated (== email prefix); JWT carries a real name.
    user = await make_user(db, email="bob@example.com", display_name="bob")
    _patch_payload(
        monkeypatch,
        {
            "sub": str(uuid.uuid4()),
            "email": "bob@example.com",
            "user_metadata": {"full_name": "Bob Smith"},
        },
    )

    got = await get_current_user(credentials=_creds(), db=db)

    assert got.id == user.id
    assert got.display_name == "Bob Smith"


async def test_missing_sub_raises_401(db, monkeypatch):
    _patch_payload(monkeypatch, {"email": "x@example.com"})  # no "sub"

    with pytest.raises(HTTPException) as exc:
        await get_current_user(credentials=_creds(), db=db)

    assert exc.value.status_code == 401
