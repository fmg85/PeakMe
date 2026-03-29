"""Add reference image keys for TIC spectra and fluorescence

Revision ID: 0003
Revises: 0002
Create Date: 2026-03-29
"""
from alembic import op
import sqlalchemy as sa

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ions", sa.Column("tic_image_key", sa.String(500), nullable=True))
    op.add_column("datasets", sa.Column("fluorescence_key", sa.String(500), nullable=True))
    op.add_column("datasets", sa.Column("fluorescence_outline_key", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("ions", "tic_image_key")
    op.drop_column("datasets", "fluorescence_key")
    op.drop_column("datasets", "fluorescence_outline_key")
