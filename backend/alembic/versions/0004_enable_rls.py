"""Enable Row Level Security on all public tables

All data access goes through FastAPI/SQLAlchemy which uses a privileged
Postgres role that bypasses RLS.  Enabling RLS with no permissive policies
blocks direct PostgREST (Supabase REST API) access for the anon/authenticated
roles — closing the security gap flagged by Supabase's security linter.

Revision ID: 0004
Revises: 0003
Create Date: 2026-04-01
"""
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

TABLES = [
    "alembic_version",
    "users",
    "projects",
    "label_options",
    "datasets",
    "ions",
    "annotations",
    "ion_stars",
]


def upgrade() -> None:
    for table in TABLES:
        op.execute(f'ALTER TABLE public."{table}" ENABLE ROW LEVEL SECURITY')


def downgrade() -> None:
    for table in TABLES:
        op.execute(f'ALTER TABLE public."{table}" DISABLE ROW LEVEL SECURITY')
