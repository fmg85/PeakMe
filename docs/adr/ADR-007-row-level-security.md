# ADR-007: Enable Row Level Security on all public tables

**Date:** 2026-04-01
**Status:** Accepted

## Context

Supabase exposes every table in the `public` schema via a PostgREST REST API at
`https://<project>.supabase.co/rest/v1/`. Any client that knows the project URL
and the public `anon` key (which is embedded in the frontend bundle) can issue
arbitrary `GET`, `POST`, `PATCH`, and `DELETE` requests against these tables —
completely bypassing the FastAPI authentication and authorisation layer.

Supabase's built-in security linter flagged all eight tables as `rls_disabled_in_public`
at ERROR severity. Left unaddressed, a malicious actor could:
- Read all user emails, annotations, and project data
- Delete or corrupt annotations
- Enumerate project structure

## Decision

Enable Row Level Security (RLS) on every table in `public`:

```sql
ALTER TABLE public."<table>" ENABLE ROW LEVEL SECURITY;
```

No permissive policies are added. This means:
- The `anon` and `authenticated` Supabase roles are **denied all access** via PostgREST by default.
- The FastAPI/SQLAlchemy backend connects using the `postgres` superuser (or a role with `BYPASSRLS`), which bypasses RLS unconditionally — the backend is **unaffected**.
- Alembic migrations run under the same privileged connection and are also unaffected.

`FORCE ROW LEVEL SECURITY` is intentionally **not** used. That flag would apply
RLS to the table owner role too; if the backend ever ran as the table owner (non-superuser),
all queries would fail. `ENABLE` alone is sufficient to block PostgREST callers.

Migration: `backend/alembic/versions/0004_enable_rls.py`

## Consequences

**Positive:**
- Supabase security linter ERRORs cleared for all 8 tables.
- Direct PostgREST access is fully blocked; all data access must go through FastAPI.
- No application code changes required — the backend's privileged connection bypasses RLS.

**Negative:**
- If a future feature ever needs direct PostgREST access (e.g. Supabase Realtime
  subscriptions, or a mobile client using `supabase-js`), explicit policies will need
  to be written first.
- Supabase Table Editor in the dashboard still works (it uses the `postgres` role).

## Alternatives Considered

- **Leave RLS disabled, rely on network-level protection:** The Supabase project URL and
  anon key are already public (embedded in the frontend). No network-level control is
  feasible. Rejected.
- **Add permissive policies for `service_role` only:** Equivalent in effect but more
  verbose. The `service_role` already bypasses RLS; no policy needed.
