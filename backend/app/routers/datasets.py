import uuid

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import CurrentUser
from app.models.dataset import Dataset
from app.models.project import Project
from app.schemas.dataset import DatasetOut
from app.services.ingest import IngestError, ingest_zip
from app.services.storage import delete_dataset_images

router = APIRouter(tags=["datasets"])

MAX_ZIP_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB


@router.get("/api/projects/{project_id}/datasets", response_model=list[DatasetOut])
async def list_datasets(
    project_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Dataset)
        .where(Dataset.project_id == project_id)
        .order_by(Dataset.created_at.desc())
    )
    return result.scalars().all()


@router.post("/api/datasets/upload", response_model=DatasetOut, status_code=status.HTTP_201_CREATED)
async def upload_dataset(
    project_id: uuid.UUID = Form(...),
    name: str = Form(...),
    description: str | None = Form(default=None),
    sample_type: str | None = Form(default=None),
    file: UploadFile = ...,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")

    dataset = Dataset(
        project_id=project_id,
        name=name,
        description=description,
        sample_type=sample_type,
        status="pending",
    )
    db.add(dataset)
    await db.commit()
    await db.refresh(dataset)

    try:
        zip_bytes = await file.read()
        if len(zip_bytes) > MAX_ZIP_SIZE:
            raise IngestError("ZIP file exceeds 2 GB limit.")

        ion_count = await ingest_zip(zip_bytes, dataset, db)
    except IngestError as e:
        dataset.status = "error"
        dataset.error_msg = str(e)
        db.add(dataset)
        await db.commit()
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        dataset.status = "error"
        dataset.error_msg = "Unexpected error during ingestion."
        db.add(dataset)
        await db.commit()
        raise HTTPException(status_code=500, detail="Ingestion failed unexpectedly.")

    await db.refresh(dataset)
    return dataset


@router.get("/api/datasets/{dataset_id}", response_model=DatasetOut)
async def get_dataset(
    dataset_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    dataset = result.scalar_one_or_none()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return dataset


@router.delete("/api/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(
    dataset_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    dataset = result.scalar_one_or_none()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    # Delete S3 images (best effort — don't fail if S3 errors)
    try:
        delete_dataset_images(dataset_id)
    except Exception:
        pass

    await db.delete(dataset)
    await db.commit()
