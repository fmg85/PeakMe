from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
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
