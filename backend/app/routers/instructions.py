from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/api/instructions", tags=["instructions"])

# Mounted as a volume in docker-compose so it always reflects the latest git state
_R_SCRIPT_PATH = Path("/app/r-scripts/export_cardinal_pngs.R")


@router.get("/r-script")
async def download_r_script():
    """Download the Cardinal → PeakMe export R script."""
    if not _R_SCRIPT_PATH.exists():
        raise HTTPException(status_code=404, detail="R script not found on server")
    return FileResponse(
        path=_R_SCRIPT_PATH,
        filename="export_cardinal_pngs.R",
        media_type="text/plain",
    )
