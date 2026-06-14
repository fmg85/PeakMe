import logging
from functools import lru_cache
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.routers import auth, projects, labels, datasets, ions, annotations, instructions
from app.routers.annotations import global_router

app = FastAPI(
    title="PeakMe API",
    description="MSI annotation platform — Tinder for ions",
    version="0.1.0",
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
    """Ping the DB with SELECT 1 — called nightly to prevent Supabase free-tier pause."""
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
