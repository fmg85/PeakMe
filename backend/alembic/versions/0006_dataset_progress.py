"""Add processed_ions to datasets for ingestion progress

Revision ID: 0006
Revises: 0005
Create Date: 2026-05-22
"""
from alembic import op
import sqlalchemy as sa

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "datasets",
        sa.Column("processed_ions", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("datasets", "processed_ions")
