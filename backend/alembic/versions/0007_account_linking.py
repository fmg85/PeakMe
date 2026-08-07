"""Link multiple auth identities to one person (identity_group_id)

One human can hold several accounts, because Supabase creates a distinct user per
auth method and per email (magic-link vs Google, work vs personal address). Since
ownership points at a single users.id, the same person signing in a different way
was a different owner — so whether a delete succeeded depended on which button
they used to sign in.

Accounts sharing a non-NULL identity_group_id are the same person. NULL means a
standalone identity, which is every existing row: purely additive, no backfill,
no behaviour change until a group is assigned.

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("identity_group_id", UUID(as_uuid=True), nullable=True),
    )
    # Ownership resolution looks accounts up by group on every guarded request.
    op.create_index(
        "ix_users_identity_group",
        "users",
        ["identity_group_id"],
        postgresql_where=sa.text("identity_group_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_users_identity_group", table_name="users")
    op.drop_column("users", "identity_group_id")
