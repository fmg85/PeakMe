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

## R script authoring rules

- **Never use backslash escapes (`\"`, `\n`, `\t`) inside R string literals** in the R scripts.
  Vercel/Vite converts every `\` to `/` when serving `.R` files from `public/`, causing parse errors.
  Use single-quoted alternatives or restructure the string:
  - Instead of `\"value\"` → use `'value'`
  - Instead of `"\n"` for a newline in an error → just use `. ` (a space) or split into multiple `message()` calls
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
