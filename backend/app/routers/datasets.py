import asyncio
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
from app.schemas.dataset import DatasetLabelSummary, DatasetOut, LabelCount
from app.services.ingest import IngestError, ingest_zip
from app.services.storage import delete_dataset_images, generate_presigned_url, upload_file

router = APIRouter(tags=["datasets"])

MAX_ZIP_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB
MAX_REF_IMAGE_SIZE = 50 * 1024 * 1024  # 50 MB


def _dataset_out(dataset: Dataset, my_annotation_count: int = 0) -> DatasetOut:
    """Build DatasetOut with presigned URLs for reference images."""
    out = DatasetOut.model_validate(dataset).model_copy(update={
        "my_annotation_count": my_annotation_count,
        "fluorescence_url": generate_presigned_url(dataset.fluorescence_key) if dataset.fluorescence_key else None,
        "fluorescence_outline_url": generate_presigned_url(dataset.fluorescence_outline_key) if dataset.fluorescence_outline_key else None,
    })
    return out


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

    return [_dataset_out(d, counts.get(d.id, 0)) for d in datasets]


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

    return _dataset_out(dataset, 0)


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
    return _dataset_out(dataset, my_count)


@router.get("/api/datasets/{dataset_id}/label-summary", response_model=DatasetLabelSummary)
async def get_dataset_label_summary(
    dataset_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Per-label annotation counts for the current user on this dataset."""
    result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    dataset = result.scalar_one_or_none()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    total = dataset.total_ions or 0

    # Count annotations per label_name for this user on this dataset
    label_result = await db.execute(
        select(Annotation.label_name, func.count(Annotation.id).label("cnt"))
        .join(Ion, Ion.id == Annotation.ion_id)
        .where(Ion.dataset_id == dataset_id, Annotation.user_id == current_user.id)
        .group_by(Annotation.label_name)
    )
    rows = label_result.all()

    annotated = sum(r.cnt for r in rows)
    unannotated = max(0, total - annotated)

    labels = [
        LabelCount(
            label_name=r.label_name,
            count=r.cnt,
            pct=round(r.cnt / total * 100, 1) if total > 0 else 0.0,
        )
        for r in sorted(rows, key=lambda r: r.cnt, reverse=True)
    ]

    return DatasetLabelSummary(
        total=total,
        annotated=annotated,
        unannotated=unannotated,
        labels=labels,
    )


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


@router.patch("/api/datasets/{dataset_id}/reference-images", response_model=DatasetOut)
async def upload_reference_images(
    dataset_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    fluorescence: UploadFile | None = File(default=None),
    outline: UploadFile | None = File(default=None),
):
    """
    Upload or replace the fluorescence image and/or fluorescence outline for a dataset.
    Both files are optional — send only the one(s) you want to update.
    """
    result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    dataset = result.scalar_one_or_none()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")

    loop = asyncio.get_running_loop()

    if fluorescence is not None:
        data = await fluorescence.read()
        if len(data) > MAX_REF_IMAGE_SIZE:
            raise HTTPException(status_code=422, detail="Fluorescence image exceeds 50 MB limit.")
        content_type = fluorescence.content_type or "image/jpeg"
        ext = fluorescence.filename.rsplit(".", 1)[-1].lower() if fluorescence.filename else "jpg"
        fname = f"fluorescence.{ext}"
        dataset.fluorescence_key = await loop.run_in_executor(
            None, upload_file, data, dataset_id, fname, content_type
        )

    if outline is not None:
        data = await outline.read()
        if len(data) > MAX_REF_IMAGE_SIZE:
            raise HTTPException(status_code=422, detail="Outline image exceeds 50 MB limit.")
        content_type = outline.content_type or "image/png"
        ext = outline.filename.rsplit(".", 1)[-1].lower() if outline.filename else "png"
        fname = f"fluorescence_outline.{ext}"
        dataset.fluorescence_outline_key = await loop.run_in_executor(
            None, upload_file, data, dataset_id, fname, content_type
        )

    if fluorescence is not None or outline is not None:
        db.add(dataset)
        await db.commit()
        await db.refresh(dataset)

    return _dataset_out(dataset)
