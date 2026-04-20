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

## 9. Renew SSL Certificate (Automatic)

> This cron job references `/home/ubuntu/PeakMe/`. If your deploy user or repo path
> differs, update the path accordingly before running.

Create a cron job to auto-renew:
```bash
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && docker compose -f /home/ubuntu/PeakMe/docker-compose.yml -f /home/ubuntu/PeakMe/docker-compose.prod.yml restart nginx") | crontab -
```

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
`alembic upgrade head`, and verify with a health check. If the health check fails, the
workflow exits with an error — check the Actions log.

> **Note:** The `.env` file on EC2 is **not** managed by GitHub Actions. If you rotate
> secrets (AWS keys, Supabase JWT secret), SSH into EC2 and update `.env` manually,
> then run `docker compose restart api`.

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
