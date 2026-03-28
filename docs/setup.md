# Local Development Setup

## Prerequisites

- Python 3.11+
- Node.js 20+
- Docker + Docker Compose
- A Supabase account (free tier works)
- An AWS account with S3 access

## 1. Clone and configure

```bash
git clone <repo-url> && cd PeakMe
cp .env.example .env
cp frontend/.env.example frontend/.env.local
```

Edit `.env` with your Supabase and AWS credentials (see comments in the file).
Edit `frontend/.env.local` with your Supabase URL/anon key.

> **Note:** Do not set `VITE_API_URL` — the frontend uses relative `/api/` paths.
> In production, Vercel proxies these to the EC2 backend server-side.

## 2. Supabase setup

1. Go to [supabase.com](https://supabase.com) → create a new project
2. From **Settings → API**, copy:
   - Project URL → `SUPABASE_URL` and `VITE_SUPABASE_URL`
   - `anon` key → `VITE_SUPABASE_ANON_KEY`
   - JWT Secret → `SUPABASE_JWT_SECRET`
3. From **Settings → Database**, copy the connection string (Session mode, port 5432) → `DATABASE_URL`
   - Replace `postgresql://` with `postgresql+asyncpg://`
4. In **Authentication → Providers**, enable:
   - **Email** — set to OTP mode (6-digit codes, not magic links)
   - **Google** — add OAuth credentials from Google Cloud Console
5. In **Authentication → URL Configuration**, add `http://localhost:5173` to allowed redirect URLs

## 3. AWS S3 setup

1. Create an S3 bucket (e.g. `peakme-ions-dev`)
2. Create an IAM user with programmatic access and these permissions:
   ```json
   {
     "Effect": "Allow",
     "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
     "Resource": ["arn:aws:s3:::peakme-ions-dev", "arn:aws:s3:::peakme-ions-dev/*"]
   }
   ```
3. Copy access key/secret → `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` in `.env`

## 4. Run database migrations

```bash
cd backend
pip install -r requirements.txt
alembic upgrade head
cd ..
```

## 5. Start the backend

```bash
docker compose up
```

Or without Docker:
```bash
cd backend
uvicorn app.main:app --reload --port 8000
```

API is now at `http://localhost:8000`. Interactive docs at `http://localhost:8000/docs`.

## 6. Start the frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend is now at `http://localhost:5173`.

## 7. Verify

- Open `http://localhost:5173` → login page
- Sign in with your email → check inbox for a **6-digit OTP code**, or use **Sign in with Google**
- Create a project, add labels, upload a test ZIP

### Creating a test ZIP

For quick testing without Cardinal, create a minimal ZIP manually:

```python
# create_test_zip.py
import csv, io, os, struct, zipfile
from PIL import Image  # pip install Pillow

with zipfile.ZipFile('test_dataset.zip', 'w') as zf:
    metadata_rows = []
    for i, mz in enumerate([100.0, 200.5, 300.1, 400.7, 500.3]):
        fname = f'{mz:.4f}.png'
        # Create a simple gradient image
        img = Image.new('RGB', (50, 50), color=(i * 40, 100, 200 - i * 30))
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        zf.writestr(fname, buf.getvalue())
        metadata_rows.append({'filename': fname, 'mz_value': mz})

    meta_buf = io.StringIO()
    writer = csv.DictWriter(meta_buf, fieldnames=['filename', 'mz_value'])
    writer.writeheader()
    writer.writerows(metadata_rows)
    zf.writestr('metadata.csv', meta_buf.getvalue())

print('Created test_dataset.zip with 5 ions')
```
