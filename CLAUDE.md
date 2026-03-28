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
- R script (`r-scripts/export_cardinal_pngs.R`) is auto-copied to `frontend/public/` at build time

## Branches

- Always develop on `main` unless told otherwise

## Documentation maintenance — MANDATORY

After every non-trivial change, ask yourself:

1. **CHANGELOG.md** — Add an entry under `## Unreleased` for every user-facing change.
   Format: `- TYPE: short description (#context if relevant)`
   Types: `feat`, `fix`, `perf`, `breaking`
   Do this as part of the same commit as the code change.

2. **`docs/r-export-workflow.md` + `frontend/src/pages/InstructionsPage.tsx`** — These two must stay
   in sync. If the R script interface, dependencies, or CLI flags change, update BOTH.

3. **`docs/setup.md`** — Update if auth flow, env vars, or local dev steps change.

4. **`docs/deployment.md`** — Update if deployment process, env vars, or infra changes.

5. **`docs/adr/`** — Create a new ADR (`ADR-00N-title.md`) when making a significant
   architectural decision. Copy the format from an existing ADR.

6. **`README.md`** (root, if it exists) — Keep the top-level overview current.

The rule: **if you changed it, document it in the same commit.**

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

## Key file locations

| What | Where |
|---|---|
| R export script (golden source) | `r-scripts/export_cardinal_pngs.R` |
| Instructions page (TSX) | `frontend/src/pages/InstructionsPage.tsx` |
| Instructions workflow doc | `docs/r-export-workflow.md` |
| API routes | `backend/app/routers/` |
| DB models | `backend/app/models/` |
| Alembic migrations | `backend/alembic/versions/` |
| Frontend types | `frontend/src/lib/types.ts` |
| Vercel config (proxy) | `frontend/vercel.json` |
| GitHub Actions deploy | `.github/workflows/deploy.yml` |
