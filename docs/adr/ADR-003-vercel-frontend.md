# ADR-003: Vercel for frontend hosting

**Date:** 2026-03-27
**Status:** Accepted

## Context

The React frontend is a Vite-built static site (plain HTML/JS/CSS after `vite build`). It needs to be accessible globally and ideally auto-deploy on every `git push`.

## Decision

Host the React frontend on **Vercel**.

- Every push to `main` triggers an automatic production deploy
- Every pull request gets a unique preview URL (useful for reviewing UI changes before merging)
- Vercel serves assets from a global CDN

## Consequences

**Positive:**
- Zero-config deploys for Vite/React projects
- Preview URLs per branch make UI review painless
- Global CDN with no configuration
- Free tier sufficient for this use case
- Team already has a Vercel subscription

**Negative:**
- Additional service to configure (env vars must be set in Vercel dashboard)
- CORS must be explicitly configured on the FastAPI backend (`ALLOWED_ORIGINS` env var)
- Vendor dependency for frontend availability

## Migration Path (Docker-only)

If Vercel is no longer desired:
1. Run `npm run build` in `frontend/` (produces `frontend/dist/`)
2. Add to `docker-compose.yml`:
   ```yaml
   frontend:
     image: nginx:alpine
     volumes:
       - ./frontend/dist:/usr/share/nginx/html:ro
     ports: ["3000:80"]
   ```
3. Update nginx reverse proxy to serve `/` from this container
4. Remove Vercel project

**Zero code changes required.** The React app is frontend-only static files.
