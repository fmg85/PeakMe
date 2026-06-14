"""Unit tests for deps._verify_token — the JWT verification at the auth boundary.

A regression here (accepting a forged/unsigned token, mishandling a missing kid)
is a full auth bypass, so each accept/reject path is pinned. No DB needed.
"""
import base64
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from jose import JWTError, jwk, jwt

import app.deps as deps
from app.config import settings

KID = "test-kid"


def _es256_keypair():
    key = ec.generate_private_key(ec.SECP256R1())
    priv_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    pub_pem = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    pub_jwk = jwk.construct(pub_pem, "ES256").to_dict()
    pub_jwk["kid"] = KID
    return priv_pem, pub_jwk


def _patch_jwks(monkeypatch, pub_jwk):
    async def fake_get_jwks():
        return {"keys": [pub_jwk]}

    monkeypatch.setattr(deps, "_get_jwks", fake_get_jwks)


async def test_valid_es256_token_is_accepted(monkeypatch):
    priv_pem, pub_jwk = _es256_keypair()
    _patch_jwks(monkeypatch, pub_jwk)
    token = jwt.encode({"sub": "u1"}, priv_pem, algorithm="ES256", headers={"kid": KID})

    claims = await deps._verify_token(token)

    assert claims["sub"] == "u1"


async def test_es256_unknown_kid_is_rejected(monkeypatch):
    priv_pem, pub_jwk = _es256_keypair()
    _patch_jwks(monkeypatch, pub_jwk)
    token = jwt.encode({"sub": "u1"}, priv_pem, algorithm="ES256", headers={"kid": "other"})

    with pytest.raises(JWTError):
        await deps._verify_token(token)


async def test_es256_tampered_signature_is_rejected(monkeypatch):
    priv_pem, pub_jwk = _es256_keypair()
    _patch_jwks(monkeypatch, pub_jwk)
    token = jwt.encode({"sub": "u1"}, priv_pem, algorithm="ES256", headers={"kid": KID})
    tampered = token[:-3] + ("aaa" if token[-3:] != "aaa" else "bbb")

    with pytest.raises(JWTError):
        await deps._verify_token(tampered)


async def test_valid_hs256_token_is_accepted():
    token = jwt.encode({"sub": "u1"}, settings.supabase_jwt_secret, algorithm="HS256")

    claims = await deps._verify_token(token)

    assert claims["sub"] == "u1"


async def test_hs256_wrong_secret_is_rejected():
    token = jwt.encode({"sub": "u1"}, "a-totally-different-secret", algorithm="HS256")

    with pytest.raises(JWTError):
        await deps._verify_token(token)


async def test_unsigned_alg_none_token_is_rejected():
    # Hand-craft an `alg: none` token (no library will happily sign one).
    def b64(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    token = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({'sub': 'u1'})}."

    with pytest.raises(JWTError):
        await deps._verify_token(token)
