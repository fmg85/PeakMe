# ADR-002: Supabase for Auth + PostgreSQL database

**Date:** 2026-03-27
**Status:** Accepted

## Context

The application needs user authentication and a relational database. The team is small (5–20 scientists), operations should be minimal, and the user already has a Supabase subscription.

## Decision

Use **Supabase** as both the authentication provider and the managed PostgreSQL database.

- Auth: Supabase Auth handles email magic links / password sign-in, issues JWTs
- Database: Supabase provides a managed PostgreSQL 15 instance
- The FastAPI backend verifies Supabase JWTs via the JWKS endpoint; user records are synced to a local `users` table on first login

## Consequences

**Positive:**
- No auth security concerns to manage (Supabase handles token rotation, PKCE, etc.)
- No database backups/updates to manage
- Supabase dashboard provides a useful data browser for scientists/admins
- Free tier (500 MB DB, 50 MB storage) sufficient to start
- Auth upgrade path is easy: change `deps.py` only to add MFA, SSO, etc.

**Negative:**
- Vendor dependency: if Supabase is unavailable, the entire app is unavailable
- Supabase free tier has a 1-week inactivity pause — upgrade to Pro ($25/month) before production use
- Data lives in Supabase's cloud (EU/US region configurable); may require consideration for sensitive research data

## Alternatives Considered

- **Self-hosted PostgreSQL on EC2:** Adds backup and HA concerns for a small team. Rejected in favour of managed service.
- **AWS RDS + Cognito:** More configuration overhead. Rejected; team has existing Supabase familiarity.
- **Display-name-only auth (no passwords):** Was considered for MVP simplicity, but Supabase magic links are nearly as simple with proper security.

## Migration Path

To move off Supabase: export data via `pg_dump` (Supabase exposes a direct Postgres connection), point `DATABASE_URL` at a new Postgres instance, replace JWT verification in `deps.py` with a new provider.
