"""
FastAPI dependencies.

get_current_user: verifies Supabase JWT and returns (or auto-creates) the local User.

JWT verification supports both:
- ES256 (ECC P-256): new Supabase default — public key fetched from JWKS endpoint
  and cached for 1 hour (avoids a round-trip per request).
- HS256 (legacy shared secret): fallback for tokens issued before the key rotation.

Upgrade path: to swap auth providers, only this file needs to change.
"""
import time
import uuid
from typing import Annotated

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwk, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.user import User

security = HTTPBearer()

# JWKS cache — refreshed at most once per hour
_jwks_cache: dict | None = None
_jwks_fetched_at: float = 0.0
_JWKS_TTL = 3600.0


async def _get_jwks() -> dict:
    global _jwks_cache, _jwks_fetched_at
    if _jwks_cache is None or (time.time() - _jwks_fetched_at) > _JWKS_TTL:
        url = f"{settings.supabase_url}/auth/v1/.well-known/jwks.json"
        async with httpx.AsyncClient() as client:
            r = await client.get(url, timeout=5.0)
            r.raise_for_status()
            _jwks_cache = r.json()
            _jwks_fetched_at = time.time()
    return _jwks_cache


async def _verify_token(token: str) -> dict:
    """Verify a Supabase JWT — handles both ES256 (new) and HS256 (legacy)."""
    header = jwt.get_unverified_header(token)
    alg = header.get("alg", "HS256")

    if alg == "ES256":
        kid = header.get("kid")
        jwks = await _get_jwks()
        key_data = next(
            (k for k in jwks.get("keys", []) if k.get("kid") == kid),
            None,
        )
        if key_data is None:
            raise JWTError(f"Key {kid!r} not found in JWKS")
        public_key = jwk.construct(key_data, algorithm="ES256")
        return jwt.decode(
            token, public_key, algorithms=["ES256"], options={"verify_aud": False}
        )

    # Legacy HS256
    return jwt.decode(
        token,
        settings.supabase_jwt_secret,
        algorithms=["HS256"],
        options={"verify_aud": False},
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    db: Annotated[AsyncSession, Depends(get_db)],
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = await _verify_token(credentials.credentials)
        user_id: str = payload.get("sub")
        email: str = payload.get("email", "")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    uid = uuid.UUID(user_id)
    result = await db.execute(select(User).where(User.id == uid))
    user = result.scalar_one_or_none()

    if user is None and email:
        # Fallback: look up by email to handle the case where the same person
        # has signed in before via a different auth method (e.g. email OTP then
        # Google OAuth).  Supabase may issue a different UUID for each method
        # unless account-linking is enabled, which would otherwise cause a
        # unique-email constraint violation on INSERT.
        result = await db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()

    if user is None:
        # Genuinely new user — auto-create record from JWT claims.
        # Full sync (POST /api/auth/sync) allows updating display_name later.
        display_name = (
            payload.get("user_metadata", {}).get("full_name")
            or payload.get("user_metadata", {}).get("display_name")
            or email.split("@")[0]
        )
        user = User(id=uid, email=email, display_name=display_name)
        db.add(user)
        await db.commit()
        await db.refresh(user)

    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
