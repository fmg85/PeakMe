"""Add ml_score to ions and matrix_type to datasets

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-20
"""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ions", sa.Column("ml_score", sa.Float(), nullable=True))
    op.add_column(
        "datasets",
        sa.Column("matrix_type", sa.String(50), nullable=True, server_default="DHAP"),
    )
    # DESC NULLS LAST can't be expressed cleanly via op.create_index, use raw DDL
    op.execute(
        "CREATE INDEX ix_ions_dataset_ml_score "
        "ON ions (dataset_id, ml_score DESC NULLS LAST)"
    )


def downgrade() -> None:
    op.drop_index("ix_ions_dataset_ml_score", table_name="ions")
    op.drop_column("ions", "ml_score")
    op.drop_column("datasets", "matrix_type")
