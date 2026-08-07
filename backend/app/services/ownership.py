"""Who is allowed to mutate a project (and the datasets inside it).

Every ownership check in the app goes through `can_modify_project`. Keeping it in
one place matters for two reasons:

1. The rule is subtle. A person is not the same thing as an account — Supabase
   mints a distinct user row per auth method and per email address, so one human
   routinely holds several. Ownership stores a single `users.id`, so a naive
   `project.created_by == current_user.id` makes the answer depend on which button
   someone pressed to sign in. Linked accounts (`identity_group_id`) fix that.

2. It is where multi-user support lands. Adding project members later means
   extending this one function, not hunting down comparisons across routers.

Deliberately NOT applied to reads, uploads, or label editing: PeakMe intentionally
shares those between signed-in users (see tests/test_projects.py). This guards the
mutations that are unrecoverable.
"""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.project import Project
from app.models.user import User


async def identity_ids(db: AsyncSession, user: User) -> set[uuid.UUID]:
    """Every account id belonging to the same person as `user`.

    Just `{user.id}` for an unlinked account, which is the default. Linked accounts
    resolve to the whole group, so signing in via Google vs a magic link reaches the
    same projects.
    """
    if user.identity_group_id is None:
        return {user.id}
    rows = await db.execute(
        select(User.id).where(User.identity_group_id == user.identity_group_id)
    )
    # Include user.id defensively: a group of one, or a stale read, must never
    # lock someone out of their own project.
    return {user.id} | {r[0] for r in rows}


async def can_modify_project(db: AsyncSession, project: Project, user: User) -> bool:
    """True if `user` may mutate/delete `project` or anything inside it."""
    if user.is_admin:
        return True
    if project.created_by == user.id:  # fast path — no query for the common case
        return True
    return project.created_by in await identity_ids(db, user)
