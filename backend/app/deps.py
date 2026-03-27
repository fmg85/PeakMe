"""
FastAPI dependencies.

get_current_user: verifies Supabase JWT and returns (or auto-creates) the local User.

Upgrade path: to swap auth providers, only this file needs to change.
The JWT is verified using the Supabase JWT secret (HS256). Supabase also supports
RS256 via JWKS — update the decode call if you switch to that.
"""
import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.user import User

security = HTTPBearer()


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
        payload = jwt.decode(
            credentials.credentials,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            options={"verify_aud": False},  # Supabase uses "authenticated" audience
        )
        user_id: str = payload.get("sub")
        email: str = payload.get("email", "")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    uid = uuid.UUID(user_id)
    result = await db.execute(select(User).where(User.id == uid))
    user = result.scalar_one_or_none()

    if user is None:
        # First-time login: auto-create user record from JWT claims
        # Full sync endpoint (POST /api/auth/sync) allows setting display_name
        display_name = payload.get("user_metadata", {}).get("display_name") or email.split("@")[0]
        user = User(id=uid, email=email, display_name=display_name)
        db.add(user)
        await db.commit()
        await db.refresh(user)

    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
