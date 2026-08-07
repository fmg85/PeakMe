import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import AsyncSessionLocal, get_db
from app.routers import auth, projects, labels, datasets, ions, annotations, instructions
from app.routers.annotations import global_router

logger = logging.getLogger(__name__)

# How often the app pings its own database to keep it from going idle.
# Supabase's free tier pauses a project after ~1 week of inactivity (ADR-002),
# and a paused project takes the app — and its annotation data — offline until
# someone restores it by hand. 6h leaves a wide margin.
KEEPALIVE_INTERVAL_SECONDS = 6 * 60 * 60


async def _keepalive_loop() -> None:
    """Periodically `SELECT 1` so an idle database never pauses itself.

    This deliberately does NOT depend on GitHub Actions. The nightly workflow
    also pings /keepalive, but GitHub disables *scheduled* workflows after 60
    days of repository inactivity — and a scheduled workflow cannot keep itself
    alive, so that mechanism fails exactly when the repo goes quiet, which is
    precisely when the database is most likely to be idle. The API process runs
    24/7 on EC2, so it is the reliable place for this. See ADR-015.
    """
    while True:
        await asyncio.sleep(KEEPALIVE_INTERVAL_SECONDS)
        try:
            async with AsyncSessionLocal() as db:
                await db.execute(text("SELECT 1"))
            logger.debug("Keepalive ping ok")
        except Exception as exc:
            # Never let a transient DB blip kill the loop — just try again later.
            logger.warning("Keepalive ping failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_keepalive_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(
    title="PeakMe API",
    description="MSI annotation platform — Tinder for ions",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(labels.router)
app.include_router(datasets.router)
app.include_router(ions.router)
app.include_router(annotations.router)
app.include_router(global_router)
app.include_router(instructions.router)


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok", "version": "0.1.0"}


@app.get("/keepalive", tags=["health"], include_in_schema=False)
async def keepalive(db: AsyncSession = Depends(get_db)):
    """Ping the DB with SELECT 1 to prevent a Supabase free-tier pause.

    Kept as an endpoint so the nightly workflow (and a human) can trigger a ping
    on demand, but the app no longer depends on anything external calling it —
    `_keepalive_loop` does the same thing from inside the process. See ADR-015.
    """
    await db.execute(text("SELECT 1"))
    return {"alive": True}


@lru_cache(maxsize=1)
def _expected_head_revision() -> str:
    """The Alembic head revision the running code expects the DB to be at."""
    from alembic.config import Config as AlembicConfig
    from alembic.script import ScriptDirectory

    ini = Path(__file__).resolve().parent.parent / "alembic.ini"
    cfg = AlembicConfig(str(ini))
    cfg.set_main_option("script_location", str(ini.parent / "alembic"))
    return ScriptDirectory.from_config(cfg).get_current_head()


@app.get("/readiness", tags=["health"], include_in_schema=False)
async def readiness(db: AsyncSession = Depends(get_db)):
    """Deep health check — the post-deploy gate.

    Unlike /health (which only proves the process booted), this verifies the DB is
    reachable AND the schema is migrated to the revision this code expects. A 503
    here means the deploy is NOT safe to serve traffic.
    """
    try:
        await db.execute(text("SELECT 1"))
        result = await db.execute(text("SELECT version_num FROM alembic_version"))
        db_rev = result.scalar_one_or_none()
    except Exception as exc:
        logging.getLogger(__name__).error("Readiness DB check failed: %s", exc)
        raise HTTPException(status_code=503, detail="Database unavailable")

    head = _expected_head_revision()
    if db_rev != head:
        raise HTTPException(
            status_code=503,
            detail=f"Schema not at head (db={db_rev}, expected={head})",
        )
    return {"ready": True, "revision": db_rev}
