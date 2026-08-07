# PeakMe — Claude Code Instructions

## Project overview

PeakMe is a web app for annotating mass spectrometry imaging (MSI) ion images.
Researchers export ion images from R/Cardinal, upload a ZIP to PeakMe, and
annotate each ion image by swiping or pressing keyboard shortcuts.

**Stack:**
- Frontend: React + TypeScript + Vite + Tailwind, deployed on Vercel (`peak-me.vercel.app`)
- Backend: FastAPI + SQLAlchemy (async) + Alembic, deployed on AWS EC2 (`api.peakme.now`)
- Auth: Supabase (OTP email codes + Google OAuth)
- Storage: AWS S3 (ion images)
- DB: Supabase Postgres

**Key architecture notes:**
- Vercel proxies `/api/*` → `https://api.peakme.now/api/*` (server-side, bypasses browser DNS filtering)
- `VITE_API_URL` is intentionally unset — frontend uses relative `/api/` paths via the proxy
- GitHub Actions auto-deploys to EC2 on push to `main` and runs `alembic upgrade head`
- R scripts (`r-scripts/peakme_import.R`, `r-scripts/peakme_export.R`) are auto-copied to `frontend/public/` at build time

## Branches

- Always develop on `main` unless told otherwise

## Self-correction rule

If you notice you have made the **same documentation or process mistake more than once**
(e.g. forgot to update `InstructionsPage.tsx` when the R script changed, forgot to add
a CHANGELOG entry, forgot to update `docs/setup.md` after an auth change), **add a
specific new rule to this file in the same commit** so it doesn't recur.

## Silent failure — the defect class that keeps happening here

On 2026-08-07 an audit found six independent bugs in this repo. Every one was the same
shape: **a check that could not observe the thing it claimed to verify.** None broke
loudly; all were invisible by construction.

| What was "protected" | Why nothing noticed |
|---|---|
| ML score ranking | `except Exception: pass` swallowed a bulk-UPDATE error — dead on all 291,371 ions for months |
| Prod schema matching the code | A failed migration latched, and the retry path skipped the migration and swallowed six 503s |
| Supabase not pausing | The keepalive lived in a scheduled workflow GitHub disables after 60 days of repo inactivity — it would die exactly when the repo went quiet, i.e. when it was needed |
| Offline undo reaching the server | A network error deleted the queued mutation anyway |
| HTTPS being up | Every check curled `localhost`, which cannot see TLS, nginx or DNS |
| Certificate renewal | The documented cron could never have run; it failed nightly for 90 days until the cert expired |

**The rule: when you add a safety mechanism, ask what would tell you it stopped
working. If the honest answer is "the thing it protects against, happening" — it is not
a safety mechanism yet, it is a hope.**

That single question would have caught all six before they mattered. Apply it whenever
you add a fallback, retry, health check, scheduled job, or `except`.

Three concrete rules follow. All three are enforced:

1. **Verify from outside the boundary.** A check that runs inside the system cannot see
   the system's edges. The `public-probe` CI job requests the real public HTTPS URL with
   certificate validation on; it caught a live outage the in-box readiness gate reported
   as green.
2. **Never let a failure be silent.** `ruff` rejects `except: pass` (S110/E722). Swallowing
   is still right sometimes — best-effort S3 cleanup — but it must be deliberate: log the
   exception, or add `# noqa: S110` saying why silence is correct.
3. **Prove the recovery path; do not just configure it.** Exercise the path that will
   actually run, not a convenient approximation of it. A `--dry-run` that passes extra
   flags proves those flags work, not that cron works. When you fix a bug, make the test
   fail against the old code before you trust it.

Corollary for expiring or scheduled things (certs, tokens, cron): add a warning that
fires *well before* the deadline, so a broken renewal surfaces as a warning rather than
an outage.

## R script authoring rules

- **Keep both scripts valid R.** CI (the `r-lint` job in `deploy.yml`) parses each script
  on every push — both as written and with every `\` rewritten to `/` — and fails on a
  syntax error, so a broken script can't reach researchers.
  - *Historical note:* a `\`→`/` rewrite when serving `.R` from `public/` was once
    suspected, hence an old "never use backslashes" rule. **Verified 2026-06-14** that the
    deployed scripts are byte-identical to source (e.g. `\n` and regex `\\.` are served
    verbatim and work), so backslash escapes are fine. The as-served parse in CI is a
    defensive guard if that ever changes.
  - Still avoid backslash-escaped **quotes** (`\"`) — those would break the as-served
    parse (and are easy to replace with single quotes: `'value'`).
- **Bump the version comment** on line 3 of each R script (`[version X.Y.Z · YYYY-MM-DD]`)
  and the matching version badge in `InstructionsPage.tsx` whenever the script changes.

## Documentation maintenance — MANDATORY

After every non-trivial change, ask yourself:

1. **CHANGELOG.md** — Add an entry under a `## YYYY-MM-DD` date section (today's date)
   for every user-facing change. Do NOT use `## Unreleased` — PeakMe ships continuously
   so every change belongs to the date it was made.
   Format: `- TYPE: short description (#context if relevant)`
   Types: `feat`, `fix`, `perf`, `breaking`
   Do this as part of the same commit as the code change.

2. **`docs/r-export-workflow.md` + `frontend/src/pages/InstructionsPage.tsx`** — These two must stay
   in sync. If the R script interface, dependencies, or CLI flags change, update BOTH.

3. **`docs/setup.md`** — Update if auth flow, env vars, or local dev steps change.

4. **`docs/deployment.md`** — Update if deployment process, env vars, or infra changes.

5. **`docs/adr/`** — Create a new ADR (`ADR-00N-title.md`) when making a significant
   architectural decision. Copy the format from an existing ADR. Decisions that need ADRs:
   auth/JWT changes, new API endpoint patterns, security mitigations, data model changes.

6. **`README.md`** (root, if it exists) — Keep the top-level overview current.

The rule: **if you changed it, document it in the same commit.**

These rules are enforced by CI (`.github/workflows/check-docs.yml`):
- Pushing source changes without a CHANGELOG entry fails the build.
- Pushing R script changes without updating both `docs/r-export-workflow.md` and `InstructionsPage.tsx` fails the build.

## Testing — MANDATORY (scoped, not exhaustive)

PeakMe deliberately does **not** chase coverage. The rule is narrow and risk-based:
test the seams where a silent regression corrupts data, loses annotations, bypasses
auth, or breaks the R round-trip — and nothing else. See `docs/adr/ADR-013-deploy-gated-ci.md`.

**You MUST add or update a test in the same commit when you change any of:**

| Boundary | Files | Why it's load-bearing |
|---|---|---|
| Auth / JWT | `backend/app/deps.py` | A regression = forged-token auth bypass or wrong-user data |
| Ingestion | `backend/app/services/ingest.py` | Untrusted-input boundary; bad parsing scrambles the ion queue |
| Offline sync | `frontend/src/lib/offline/**` | Hand-rolled IDB queue/reconciler; silent annotation data-loss |
| Migrations | `backend/alembic/versions/*.py` | Runs against prod; a bad one is unrecoverable |
| Export contract | `backend/app/routers/annotations.py` (CSV header/format) | ADR-010 — breaks every researcher's R import |
| Ownership | `backend/app/routers/projects.py` (the 403 guard) | The app's only privilege boundary |

**Everything else needs no test** — UI tweaks, copy, new pages, styling, refactors with
no behaviour change. Do not add speculative tests for them.

**The ratchet:** only write a test when (a) you touch a boundary above, or (b) a bug
reached prod (add the regression test on the way out). The suite grows exactly as fast
as real risk does — no faster.

**Enforcement is automated, not manual** (`.github/workflows/deploy.yml`): every push to
`main` runs `ruff` (bug-focused: `F`, `E9`), an app import smoke-test, and
`alembic upgrade head` against a throwaway Postgres **before** the EC2 deploy. A failing
check skips the deploy and leaves prod on the last good commit — direct push-to-main
still works (e.g. from a mobile session); only broken code is blocked from shipping.

Run locally:
```bash
# backend — pytest needs a throwaway Postgres (real Postgres features are used).
#   one-time: brew install python@3.11 postgresql@16
#   start an ephemeral DB on :55432:
#     initdb -D /tmp/pg -U postgres --auth=trust && pg_ctl -D /tmp/pg -o "-p 55432" -l /tmp/pg.log start && createdb -h localhost -p 55432 -U postgres peakme_test
cd backend && pip install -r requirements.txt -r requirements-dev.txt
ruff check app
DATABASE_URL=postgresql+psycopg://postgres@localhost:55432/peakme_test python -m pytest
# (CI uses a postgres:16 service container instead — see deploy.yml backend-tests.)

# frontend — no external deps; Node + npm only.
cd frontend && npx tsc -p tsconfig.json --noEmit && npm run lint && npm test
```

## Commit conventions

Use conventional commits — this feeds the CHANGELOG and makes git history readable:

```
feat: short description      # new user-facing feature
fix: short description       # bug fix
perf: short description      # performance improvement
docs: short description      # docs only
refactor: short description  # code change, no behaviour change
chore: short description     # tooling, deps, config
breaking: short description  # breaking change (rare)
```

## Research workstream — ML pre-classification

An **active research project** lives under `research/` on the `main` branch.
It is fully isolated from app code and has **separate commit conventions and CI rules**:

- Commits use prefix `research:` (not a conventional commit type — no CHANGELOG entry required)
- CI doc checks do **not** apply to `research/**` (the path patterns only cover `backend/`, `frontend/src/`, `r-scripts/`)
- **Do not** modify files under `research/` as part of normal feature/fix work
- **Do not** import or reference anything from `research/` in app code
- The `research/session-state.md` file tracks progress, findings, and AWS resources across sessions
- The `research/report.md` file is the living research report (updated incrementally)

Goal: train and evaluate an ML classifier to pre-rank ion images by biological relevance, so annotators see the most meaningful ions first. See `research/session-state.md` for current status.

## Key file locations

| What | Where |
|---|---|
| PeakMe Import script (Cardinal → PeakMe) | `r-scripts/peakme_import.R` |
| PeakMe Export script (PeakMe → R) | `r-scripts/peakme_export.R` |
| Instructions page (TSX) | `frontend/src/pages/InstructionsPage.tsx` |
| Instructions workflow doc | `docs/r-export-workflow.md` |
| API routes | `backend/app/routers/` |
| DB models | `backend/app/models/` |
| Alembic migrations | `backend/alembic/versions/` |
| Frontend types | `frontend/src/lib/types.ts` |
| Vercel config (proxy) | `frontend/vercel.json` |
| GitHub Actions deploy | `.github/workflows/deploy.yml` |
