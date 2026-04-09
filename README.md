# PeakMe

A web app for annotating **mass spectrometry imaging (MSI) ion images**.

Researchers export ion images from R/Cardinal, upload a ZIP to PeakMe, and
annotate each ion image by swiping or pressing keyboard shortcuts.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Vite + Tailwind, deployed on Vercel |
| Backend | FastAPI + SQLAlchemy (async) + Alembic, deployed on AWS EC2 |
| Auth | Supabase (OTP email codes + Google OAuth) |
| Storage | AWS S3 (ion images) |
| Database | Supabase PostgreSQL |

Live: **peak-me.vercel.app** · API: **api.peakme.now**

## Documentation

| Doc | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Contributor instructions, conventions, key file map |
| [docs/setup.md](docs/setup.md) | Local development setup |
| [docs/deployment.md](docs/deployment.md) | EC2 + Vercel deployment |
| [docs/r-export-workflow.md](docs/r-export-workflow.md) | R workflow (Cardinal → PeakMe → R) |
| [docs/adr/](docs/adr/) | Architecture Decision Records |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Quick start

```bash
git clone <repo-url> && cd PeakMe
cp .env.example .env && cp frontend/.env.example frontend/.env.local
# fill in Supabase + AWS credentials
docker compose up -d
# backend: http://localhost:8000
# frontend: cd frontend && npm install && npm run dev → http://localhost:5173
```

See [docs/setup.md](docs/setup.md) for the full setup guide.

## R workflow

Scientists run `r-scripts/peakme_import.R` locally (Cardinal) to render ion images,
upload the ZIP to PeakMe, annotate, then run `r-scripts/peakme_export.R` to pull
annotations back into R. See [docs/r-export-workflow.md](docs/r-export-workflow.md).
