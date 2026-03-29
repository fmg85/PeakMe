import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal, get_db
from app.deps import CurrentUser
from app.models.annotation import Annotation
from app.models.dataset import Dataset
from app.models.ion import Ion
from app.models.project import Project
from app.schemas.dataset import DatasetOut
from app.services.ingest import IngestError, ingest_zip
from app.services.storage import delete_dataset_images

router = APIRouter(tags=["datasets"])

MAX_ZIP_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB


async def _ingest_background(zip_bytes: bytes, dataset_id: uuid.UUID) -> None:
    """Run ingestion in a fresh DB session after the HTTP response is sent."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
        dataset = result.scalar_one()
        try:
            await ingest_zip(zip_bytes, dataset, db)
        except IngestError as e:
            dataset.status = "error"
            dataset.error_msg = str(e)
            db.add(dataset)
            await db.commit()
        except Exception:
            dataset.status = "error"
            dataset.error_msg = "Unexpected error during ingestion."
            db.add(dataset)
            await db.commit()


@router.get("/api/projects/{project_id}/datasets", response_model=list[DatasetOut])
async def list_datasets(
    project_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    ds_result = await db.execute(
        select(Dataset)
        .where(Dataset.project_id == project_id)
        .order_by(Dataset.created_at.desc())
    )
    datasets = ds_result.scalars().all()
    if not datasets:
        return []

    # Annotation count per dataset for current user (single batch query)
    dataset_ids = [d.id for d in datasets]
    count_result = await db.execute(
        select(Ion.dataset_id, func.count(Annotation.id).label("cnt"))
        .join(Annotation, Annotation.ion_id == Ion.id)
        .where(Ion.dataset_id.in_(dataset_ids), Annotation.user_id == current_user.id)
        .group_by(Ion.dataset_id)
    )
    counts = {row.dataset_id: row.cnt for row in count_result}

    return [
        DatasetOut.model_validate(d).model_copy(update={"my_annotation_count": counts.get(d.id, 0)})
        for d in datasets
    ]


@router.post("/api/datasets/upload", response_model=DatasetOut, status_code=status.HTTP_202_ACCEPTED)
async def upload_dataset(
    background_tasks: BackgroundTasks,
    current_user: CurrentUser,
    project_id: uuid.UUID = Form(...),
    name: str = Form(...),
    description: str | None = Form(default=None),
    sample_type: str | None = Form(default=None),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")

    # Read and validate file size before creating the DB record
    zip_bytes = await file.read()
    if len(zip_bytes) > MAX_ZIP_SIZE:
        raise HTTPException(status_code=422, detail="ZIP file exceeds 2 GB limit.")

    # Create the dataset record immediately so the UI can show "processing"
    dataset = Dataset(
        project_id=project_id,
        name=name,
        description=description,
        sample_type=sample_type,
        status="processing",
    )
    db.add(dataset)
    await db.commit()
    await db.refresh(dataset)

    # Kick off ingestion after the response is sent
    background_tasks.add_task(_ingest_background, zip_bytes, dataset.id)

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

    count_result = await db.execute(
        select(func.count(Annotation.id))
        .join(Ion, Ion.id == Annotation.ion_id)
        .where(Ion.dataset_id == dataset_id, Annotation.user_id == current_user.id)
    )
    my_count = count_result.scalar() or 0
    return DatasetOut.model_validate(dataset).model_copy(update={"my_annotation_count": my_count})


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
