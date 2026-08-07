# AWS EC2 Deployment Runbook

This document covers deploying the PeakMe backend to AWS EC2 with HTTPS, and the frontend to Vercel.

## 1. Launch EC2 Instance

1. Go to AWS Console → EC2 → Launch Instance
2. **AMI:** Ubuntu Server 24.04 LTS (64-bit x86)
3. **Instance type:** `t3.small` (2 vCPU, 2 GB RAM, ~$15/month)
4. **Key pair:** Create or select an existing key pair (save the `.pem` file!)
5. **Security group — open these ports:**
   - SSH: TCP 22 (your IP only)
   - HTTP: TCP 80 (0.0.0.0/0)
   - HTTPS: TCP 443 (0.0.0.0/0)
6. **Storage:** 20 GB gp3 (sufficient; images go to S3, not EC2)
7. Launch and note the **Public IP**

## 2. Point Your Domain to EC2

In your DNS provider, add an **A record**:
```
api.yourdomain.com → <EC2 Public IP>
```

Wait 5–30 minutes for DNS propagation before proceeding.

## 3. Install Docker on EC2

SSH into the instance:
```bash
ssh -i your-key.pem ubuntu@<EC2-IP>
```

Install Docker:
```bash
# Update and install prerequisites
sudo apt-get update
sudo apt-get install -y ca-certificates curl

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list

# Install Docker
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Allow running docker without sudo
sudo usermod -aG docker ubuntu
newgrp docker  # or log out and back in
```

Verify:
```bash
docker --version
docker compose version
```

## 4. Deploy PeakMe

```bash
# Clone repository
git clone https://github.com/YOUR_USERNAME/PeakMe.git
cd PeakMe

# Configure environment
cp .env.example .env
nano .env  # fill in all values — see .env.example for descriptions of each variable
```

Update `nginx/nginx.conf` — replace `YOUR_DOMAIN` with your actual domain:
```bash
sed -i 's/YOUR_DOMAIN/api.yourdomain.com/g' nginx/nginx.conf
```

## 5. Set Up HTTPS (Let's Encrypt)

```bash
# Install certbot
sudo apt-get install -y certbot

# Get certificate (temporarily stop nginx if running)
sudo certbot certonly --standalone \
  --non-interactive \
  --agree-tos \
  --email your@email.com \
  -d api.yourdomain.com
```

Certificates are saved to `/etc/letsencrypt/live/api.yourdomain.com/`.

## 6. Run Database Migrations

```bash
# Run migrations against Supabase (DATABASE_URL must be set in .env)
docker compose run --rm api alembic upgrade head
```

## 7. Start Production Services

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Verify:
```bash
curl https://api.yourdomain.com/health
# Expected: {"status":"ok","version":"0.1.0"}
```

## 8. Deploy Frontend to Vercel

1. Go to [vercel.com](https://vercel.com) → Add New Project
2. Import the `PeakMe` GitHub repository
3. Set **Root Directory** to `frontend`
4. Set **Framework Preset** to Vite
5. Add environment variables:
   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | Your Supabase project URL |
   | `VITE_SUPABASE_ANON_KEY` | Your Supabase anon key |

   > **Do not set `VITE_API_URL`.** The frontend uses relative `/api/` paths proxied
   > by Vercel to EC2 via `vercel.json`. Setting this env var bakes a direct URL into
   > the bundle and bypasses the proxy.
6. Deploy

After deployment, copy your Vercel URL (e.g. `https://your-project.vercel.app`) and:
- Add it to `ALLOWED_ORIGINS` in EC2's `.env`, then restart: `docker compose restart api`
- Add it to Supabase → Authentication → URL Configuration → Redirect URLs

> **ALLOWED_ORIGINS chicken-and-egg:** During initial EC2 setup (step 4) you don't have
> a Vercel URL yet. Set `ALLOWED_ORIGINS=http://localhost:5173` as a placeholder, then
> update it after Vercel deploys. Until updated, the deployed frontend will get CORS
> errors — but the API and health check will work for testing.

### S3 bucket CORS — offline image caching (PWA)

The offline PWA (ADR-012) caches ion images on the device by fetching them with the
browser `fetch()` API, which requires the `peakme-ions` bucket to allow **GET** from the
app origins via CORS. (The bucket already allows `PUT` for direct ZIP uploads.) Apply
both rules — `put-bucket-cors` replaces the entire config, so include the existing `PUT`
rule:

```bash
aws s3api put-bucket-cors --bucket peakme-ions --cors-configuration '{
  "CORSRules": [
    { "AllowedMethods": ["PUT"], "AllowedOrigins": ["https://peak-me.vercel.app","https://www.peakme.now"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3000 },
    { "AllowedMethods": ["GET"], "AllowedOrigins": ["https://peak-me.vercel.app","https://www.peakme.now","http://localhost:5173"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3000 }
  ]
}'
```

Without the `GET` rule, online annotation still works (images load via `<img>`), but the
"Download for offline" action cannot cache image bytes.

## 9. Renew SSL Certificate (Automatic)

> This cron job references `/home/ubuntu/PeakMe/`. If your deploy user or repo path
> differs, update the path accordingly before running.

The certificate was issued in **`--standalone`** mode (step 5), which binds port 80 to
prove domain ownership. In production nginx holds port 80, so renewal **must stop nginx
first and start it again afterwards** — and it must run as **root**, because
`/etc/letsencrypt` is root-only.

**Put the hooks in `/etc/letsencrypt/renewal-hooks/`, not in the cron line.** Scripts
there run for *every* renewal path — your cron, certbot's own systemd timer, and any
manual `certbot renew`. Defining them only in the cron means the systemd timer still
runs an unhooked `certbot renew`, which cannot bind port 80 and fails.

```bash
sudo mkdir -p /etc/letsencrypt/renewal-hooks/{pre,post}
printf '#!/bin/sh\ndocker compose -f /home/ubuntu/PeakMe/docker-compose.yml -f /home/ubuntu/PeakMe/docker-compose.prod.yml stop nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
printf '#!/bin/sh\ndocker compose -f /home/ubuntu/PeakMe/docker-compose.yml -f /home/ubuntu/PeakMe/docker-compose.prod.yml start nginx\n' | sudo tee /etc/letsencrypt/renewal-hooks/post/start-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/{pre,post}/*.sh
```

Then the cron entry is trivial — install it in **root's** crontab (`sudo crontab -e`,
not `crontab -e`; certbot needs root to read `/etc/letsencrypt`). One line: cron has no
line-continuation syntax, and a trailing `\` is a parse error, not a continuation.

```bash
sudo crontab -l 2>/dev/null | grep -v certbot > /tmp/rootcron || true
echo "0 3 * * * certbot renew --quiet --standalone" >> /tmp/rootcron
sudo crontab /tmp/rootcron && rm /tmp/rootcron
sudo crontab -l          # confirm: exactly one certbot line, unwrapped
```

Also remove the old broken entry from the **`ubuntu`** user's crontab, if present:

```bash
crontab -l 2>/dev/null | grep -v certbot | crontab -
```

> Do not define the hooks in *both* places. Certbot runs directory hooks **and**
> `--pre-hook`/`--post-hook`, so nginx would be stopped and started twice per renewal.
> Harmless (Docker stop/start are idempotent) but confusing.

The hooks only fire when a renewal is actually due, so nginx is not restarted nightly
for nothing.

> **This step previously documented a command that could never work**, and the
> certificate duly expired in production on 2026-08-07, taking the API down for every
> user (and for Vercel's `/api/*` proxy). The old version was
> `(crontab -l; echo "0 3 * * * certbot renew --quiet && … restart nginx") | crontab -`,
> which fails twice over: it installs into the **`ubuntu` user's** crontab, where
> `certbot` cannot read `/etc/letsencrypt`, and even as root `--standalone` cannot bind
> port 80 while the nginx container holds it. It only *restarted* nginx afterwards,
> never stopping it first. Both failures were silent.
>
> If you set up this box before 2026-08-07, remove the old entry from the `ubuntu`
> crontab (`crontab -e`) and add the root one above.

Verify renewal actually works — do not assume it:

```bash
sudo certbot certificates          # check the expiry date is in the future
# No inline hooks — this proves the /etc/letsencrypt/renewal-hooks/ scripts fire,
# which is what cron and the systemd timer will actually rely on.
sudo certbot renew --dry-run
```

To renew immediately (e.g. the certificate has already expired):

```bash
cd ~/PeakMe
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop nginx
sudo certbot renew --force-renewal
docker compose -f docker-compose.yml -f docker-compose.prod.yml start nginx
curl -sS -w '\nHTTP %{http_code}\n' https://api.peakme.now/health
```

You should not have to rely on noticing this yourself: the `public-probe` CI job
(step 10) fails the run if the public HTTPS endpoint is unreachable, and warns for
14 days before the certificate expires.

## 10. Configure GitHub Actions (Automated Deploy)

Deployments are automated via GitHub Actions on every push to `main`.
You must add three secrets to the GitHub repository before this works:

1. Go to your GitHub repository → **Settings → Secrets and variables → Actions → New repository secret**
2. Add each secret:

| Secret name | Value |
|---|---|
| `EC2_HOST` | Your EC2 public IP or domain (e.g. `api.yourdomain.com`) |
| `EC2_USER` | `ubuntu` (the default SSH user for Ubuntu AMIs) |
| `EC2_SSH_KEY` | The full contents of your `.pem` private key file |

To copy your `.pem` key contents:
```bash
cat your-key.pem
# Paste everything including -----BEGIN RSA PRIVATE KEY----- and -----END-----
```

Once set, every push to `main` will SSH into EC2, rebuild the Docker containers, run
`alembic upgrade head`, and verify with a **readiness check** (`/readiness` — DB
reachable + schema migrated to the expected Alembic head, replacing the old static
`/health`). If readiness fails after retries, the workflow exits with an error — check
the Actions log.

### Deploy is gated on CI checks (ADR-013)

The `deploy` job does not run until the check jobs in the same workflow pass:

| Job | What it does |
|---|---|
| `backend-checks` | `ruff` (bug-focused) + `python -c 'import app.main'` import smoke-test |
| `migration-check` | runs `alembic upgrade head` against a throwaway Postgres so a broken migration is caught **before** it touches the production DB; `alembic check` reports model/migration drift (advisory) |
| `backend-tests` | runs `pytest` against a throwaway `postgres:16` service — auth (JWT + account-merge), the annotate upsert, the queue cursor, and the ownership 403 |
| `frontend-checks` | `tsc --noEmit` + `eslint .` + `vitest run` (does not gate the backend deploy — the frontend ships via Vercel, whose build runs `tsc && eslint . && vitest run` and refuses to ship type errors, lint errors, or failing tests) |
| `r-lint` | parses both R scripts (as-is and with `\`→`/`) so a syntax error can't ship to researchers; reporting-only (R scripts ship via Vercel) |

A red `backend-checks`, `migration-check`, or `backend-tests` **skips the deploy** and leaves prod on the
last good commit — push-to-main still works, only broken code is blocked from shipping.
Fix the failure and push again. The check jobs use throwaway env values and **no
repository secrets**, so they also run safely on pull requests.

> **Note:** The `.env` file on EC2 is **not** managed by GitHub Actions. If you rotate
> secrets (AWS keys, Supabase JWT secret), SSH into EC2 and update `.env` manually,
> then run `docker compose restart api`.

### CI checks the public endpoint, not just localhost (`public-probe`)

Every other gate inspects the box **from inside the box** — the post-deploy readiness
probe curls `http://localhost:8000/readiness`, which bypasses nginx, TLS and DNS. That
is structurally blind to the entire public path: on 2026-08-07 the certificate expired,
every user and the Vercel `/api/*` proxy got a TLS failure, and the deploy still
reported green because localhost was perfectly healthy.

The `public-probe` job is the only check that sees what a user sees. It runs **after**
the deploy — the code should still ship — but turns the run red so a broken public
endpoint is never reported as success. It:

- requests `https://api.peakme.now/health` **with certificate validation on** (no
  `curl -k` anywhere in that job — validating the chain *is* the test), retrying for
  ~60s so a restarting nginx doesn't cause a false alarm;
- fails the run on an expired or otherwise invalid certificate;
- warns for `CERT_WARN_DAYS` (14) before expiry, so renewal breaking is visible long
  before it becomes an outage.

The hostname lives in the job's `PUBLIC_API_HOST` env var (a public DNS name, not a
secret). Change it there if the domain changes.

### Enabling ML scoring (optional)

After deploying, add the following to `.env` on EC2 to enable automatic ion ranking
after each dataset upload:

```
ML_MODEL_S3_KEY=research/results/model_mobilenet_v3_small.onnx
```

Then restart: `docker compose restart api`

When set, MobileNet-V3-Small runs inference on all ion images after ingestion and
rewrites `ions.sort_order` so annotators see biologically relevant ions first (~68%
annotation savings vs. random order). If unset, ions appear in original upload order.
The EC2 instance IAM role needs `s3:GetObject` on the `peakme-ions` bucket (already
required for ion image access).

The workflow also runs on a **nightly schedule (03:00 UTC)** as a catch-up mechanism:
if a push-triggered deploy failed (e.g. during an EC2 reboot), the server will
self-heal within 24 hours. It skips the rebuild if EC2 is already on the latest commit.

> **GitHub disables scheduled workflows after 60 days of repository inactivity.**
> (`push:` and `workflow_dispatch:` triggers are never disabled — only `schedule:`.)
> GitHub emails a warning shortly before it happens; re-enable from
> **Actions → Deploy to EC2**, and note that *any* push resets the 60-day counter.
>
> If it does lapse, the only thing lost is the catch-up redeploy. Keeping the
> database awake does **not** depend on it: the API pings its own DB every 6h from
> a background task, so a dormant repo can no longer cause a Supabase pause
> (see ADR-015). Adding another *scheduled* workflow to prevent this would not
> work — it would be disabled by the same rule.

To trigger a deploy immediately without pushing a commit, go to:
**GitHub → Actions → Deploy to EC2 → Run workflow**.

## 12. Update PeakMe

Once GitHub Actions is configured (step 10), deployments are fully automated:
- **EC2:** SSH deploy, Docker rebuild, `alembic upgrade head`
- **Vercel:** auto-deploys frontend on every push to `main` (Vercel webhook is set up
  automatically when you import the GitHub repo in step 8)

To deploy manually:
```bash
cd PeakMe
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api alembic upgrade head
```

## 13. Monitoring

```bash
# View API logs
docker compose logs -f api

# Check container status
docker compose ps

# View resource usage
docker stats
```

### Database keepalive

The Supabase free tier pauses a project after ~1 week of inactivity, which would take
the API and all annotation data offline until manually restored. The API prevents this
itself: a background task pings the DB (`SELECT 1`) every 6h for as long as the
container is running (ADR-015). No external scheduler is involved.

```bash
# Confirm the keepalive is alive (logs at DEBUG; failures log at WARNING)
docker compose logs api | grep -i keepalive

# Ping on demand
curl -sf http://localhost:8000/keepalive
```

A `Keepalive ping failed` warning is only a concern if it repeats for more than a day —
the 6h interval leaves a ~28× margin under the ~1 week pause threshold.

## 14. Backup

The database lives on Supabase — they handle backups (Point-in-Time Recovery on Pro plan).
Ion images live on S3 — enable S3 Versioning for protection against accidental deletion.

There is no data on the EC2 instance itself that needs backing up.

## 15. Migrating from Vercel to Docker-only (if needed)

If you ever want to stop using Vercel and serve the frontend from EC2:

1. `cd frontend && npm run build` — produces `frontend/dist/`
2. Add to `docker-compose.yml`:
   ```yaml
   frontend:
     image: nginx:alpine
     volumes:
       - ./frontend/dist:/usr/share/nginx/html:ro
     expose:
       - "3000"
   ```
3. Update `nginx/nginx.conf` to proxy `/` to `frontend:3000`
4. Delete the Vercel project

**Zero code changes required.** The React app is static files.
