from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import CurrentUser
from app.schemas.user import UserOut, UserSyncRequest

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/me", response_model=UserOut)
async def get_me(current_user: CurrentUser):
    """Return the currently authenticated user."""
    return current_user


@router.post("/sync", response_model=UserOut)
async def sync_user(
    body: UserSyncRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """
    Update the current user's display name.
    Called on first login to let the user set a friendly name.
    """
    current_user.display_name = body.display_name
    db.add(current_user)
    await db.commit()
    await db.refresh(current_user)
    return current_user
