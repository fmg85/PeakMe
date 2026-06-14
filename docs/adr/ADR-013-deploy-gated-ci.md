# ADR-013: Deploy-gated CI and a scoped, risk-based test strategy

**Date:** 2026-06-14
**Status:** Accepted

## Context

PeakMe shipped to production for months with **zero automated tests**, no test
framework installed, and CI that ran no code — only `check-docs.yml` (CHANGELOG +
R-doc hygiene) and `deploy.yml` (SSH to EC2, `docker compose up --build`,
`alembic upgrade head`, `curl /health`). The de-facto safety net was TypeScript's
compiler (via the Vercel build only), the author's discipline, and a `/health`
endpoint that returns a static dict and never touches the DB.

The two real risks of this setup:

1. **Migrations run `alembic upgrade head` directly against the production Supabase
   Postgres** on every push to `main` — no staging, no dry-run, no rollback, and the
   new app containers are already serving traffic before the migration runs. A bad
   migration has total, unrecoverable blast radius.
2. **Nothing runs the code before prod.** An import error, broken route signature, or
   dependency conflict is first discovered when the prod container fails to boot.

The author develops largely from mobile Claude Code sessions that push directly to
`main`, so any solution must not force a branch-and-PR flow.

## Decision

### 1. Gate the *deploy*, not the *merge*

`deploy.yml` is restructured so the `deploy` job `needs:` two check jobs. Push to
`main` still triggers everything; the EC2 deploy only runs if the checks pass. A red
check **skips the deploy** and leaves prod on the last good commit. Direct
push-to-main (incl. from mobile) is unchanged — only broken code is blocked from
shipping. We deliberately did **not** adopt branch protection / required PRs (too much
friction for a one-person, mobile-first workflow).

The gating jobs:

| Job | What it does | Blocks deploy? |
|---|---|---|
| `backend-checks` | `ruff` (F, E9) + `python -c 'import app.main'` smoke | Yes |
| `migration-check` | `alembic upgrade head` on a throwaway Postgres service; `alembic check` for drift (advisory) | Yes (upgrade); drift is advisory |
| `backend-tests` | `pytest` against a throwaway Postgres service — auth, annotate upsert, queue cursor, ownership 403 | Yes |
| `frontend-checks` | `tsc --noEmit` + `eslint .` + `vitest run` | No — frontend ships via Vercel; its real gate is the build (`tsc && eslint . && vitest run` before `vite build`). Coupling the backend deploy to frontend checks would be wrong |

### 2. Ruff is bug-focused, not style-focused

`select = ["F", "E9"]` only — undefined names, dead imports, f-string mistakes, syntax
errors. No `E`/`W` style rules, no `B904`-style opinion churn. A red ruff result always
means a genuine problem worth stopping a deploy for. Migrations are excluded from
linting.

### 3. Tests are scoped and ratcheted, never exhaustive

Best practice for an app this size (~6.5k LOC, one engineer) is **not** a large suite.
The mandatory-test boundaries are fixed and few (auth `deps.py`, ingestion, the offline
sync layer, migrations, the export CSV contract, the ownership 403). Everything else
needs no test. New tests are added only when (a) a boundary is touched, or (b) a bug
reached prod (regression test on the way out). See CLAUDE.md "Testing".

## Consequences

**Positive:**
- A broken migration is caught on an ephemeral Postgres before it can ever touch the
  production database — the single largest blast-radius reduction available.
- "Prod container won't boot" classes of failure are caught at push time, not by users.
- Enforcement is structural: the author no longer has to *remember* to be careful; the
  gate refuses bad deploys. Mobile push-to-main keeps working.

**Negative / trade-offs:**
- A ~2–3 min delay between push and prod (mostly the migration dry-run).
- `alembic check` (drift) is advisory only — model/migration divergence surfaces as a
  non-fatal warning, not a hard failure, until the baseline is known-clean.
- The post-deploy check is still the static `/health`; a fatal DB-touching readiness
  probe is a planned follow-up.

## What to check when adding features

| Change | Check |
|---|---|
| New Alembic migration | Will pass `migration-check`? Avoid prod-only assumptions |
| New backend module | Does `import app.main` still succeed with only env vars set? |
| Touching an auth / ingest / offline / export / ownership boundary | Add/update a test in the same commit (CLAUDE.md) |
| New lint failures | Fix them, or justify narrowing the ruff `select` (don't widen ignore lists silently) |
