import asyncio
import logging
import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status  # noqa: F401 — File/Form/UploadFile used by reference-images endpoint
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
from app.services.storage import (
    delete_dataset_images,
    delete_file,
    download_file,
    generate_presigned_upload_url,
    generate_presigned_url,
    upload_file,
)
from pydantic import BaseModel

router = APIRouter(tags=["datasets"])

MAX_ZIP_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB
MAX_REF_IMAGE_SIZE = 50 * 1024 * 1024  # 50 MB


class PrepareUploadIn(BaseModel):
    project_id: uuid.UUID
    name: str
    description: str | None = None
    sample_type: str | None = None


class PrepareUploadOut(BaseModel):
    dataset_id: uuid.UUID
    upload_url: str


def _dataset_out(dataset: Dataset, my_annotation_count: int = 0) -> DatasetOut:
    """Build DatasetOut with presigned URLs for reference images."""
    out = DatasetOut.model_validate(dataset).model_copy(update={
        "my_annotation_count": my_annotation_count,
        "fluorescence_url": generate_presigned_url(dataset.fluorescence_key) if dataset.fluorescence_key else None,
        "fluorescence_outline_url": generate_presigned_url(dataset.fluorescence_outline_key) if dataset.fluorescence_outline_key else None,
    })
    return out


async def _ingest_background_from_s3(s3_key: str, dataset_id: uuid.UUID) -> None:
    """Download ZIP from S3, ingest it, then delete the temporary upload object."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
        dataset = result.scalar_one()
        loop = asyncio.get_running_loop()
        try:
            zip_bytes = await loop.run_in_executor(None, download_file, s3_key)
            await ingest_zip(zip_bytes, dataset, db)
            await loop.run_in_executor(None, delete_file, s3_key)
        except IngestError as e:
            dataset.status = "error"
            dataset.error_msg = str(e)
            db.add(dataset)
            await db.commit()
            return
        except Exception:
            dataset.status = "error"
            dataset.error_msg = "Unexpected error during ingestion."
            db.add(dataset)
            await db.commit()
            return

        # ML scoring — best-effort, never blocks dataset availability. Still LOG the
        # failure: a bare `except: pass` here hid a bulk-UPDATE bug that made scoring a
        # silent no-op on every dataset ever ingested, with nothing in the logs to say so.
        try:
            from app.services.ml_scoring import score_dataset
            await score_dataset(dataset_id, db)
        except Exception:
            logging.getLogger(__name__).exception(
                "ML scoring failed for dataset %s — ions keep their upload order", dataset_id
            )


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


@router.post("/api/datasets/prepare-upload", response_model=PrepareUploadOut)
async def prepare_upload(
    body: PrepareUploadIn,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """
    Step 1 of 3: create dataset record and return a presigned S3 PUT URL.
    The client uploads the ZIP directly to S3, then calls POST /ingest.
    """
    result = await db.execute(select(Project).where(Project.id == body.project_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")

    dataset = Dataset(
        project_id=body.project_id,
        name=body.name,
        description=body.description,
        sample_type=body.sample_type,
        status="pending",
    )
    db.add(dataset)
    await db.commit()
    await db.refresh(dataset)

    s3_key = f"uploads/{dataset.id}/source.zip"
    loop = asyncio.get_running_loop()
    upload_url = await loop.run_in_executor(None, generate_presigned_upload_url, s3_key)

    return PrepareUploadOut(dataset_id=dataset.id, upload_url=upload_url)


@router.post("/api/datasets/{dataset_id}/ingest", response_model=DatasetOut, status_code=status.HTTP_202_ACCEPTED)
async def trigger_ingest(
    dataset_id: uuid.UUID,
    current_user: CurrentUser,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """
    Step 3 of 3: after the client has uploaded the ZIP to S3, trigger ingestion.
    Downloads from S3, runs ingest + ML scoring in the background.
    """
    result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    dataset = result.scalar_one_or_none()
    if not dataset:
        raise HTTPException(status_code=404, detail="Dataset not found")
    if dataset.status != "pending":
        raise HTTPException(status_code=409, detail=f"Dataset is '{dataset.status}', expected 'pending'")

    dataset.status = "processing"
    db.add(dataset)
    await db.commit()
    await db.refresh(dataset)

    s3_key = f"uploads/{dataset_id}/source.zip"
    background_tasks.add_task(_ingest_background_from_s3, s3_key, dataset_id)

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
    # Authorization matters here specifically because the delete is unrecoverable:
    # ON DELETE CASCADE takes ions -> annotations, so this destroys EVERY user's
    # annotations for the dataset, and then the S3 prefix. Ownership lives on the
    # parent project (datasets have no created_by), so mirror the rule enforced by
    # delete_project. Read endpoints stay intentionally shared — see tests/test_projects.py.
    result = await db.execute(
        select(Dataset, Project)
        .join(Project, Project.id == Dataset.project_id)
        .where(Dataset.id == dataset_id)
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    dataset, project = row
    if project.created_by != current_user.id and not current_user.is_admin:
        raise HTTPException(status_code=403, detail="Not authorized")

    await db.delete(dataset)
    await db.commit()

    # Clean up S3 after DB delete (best-effort, off the event loop)
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, delete_dataset_images, dataset_id)
    except Exception:
        pass


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
