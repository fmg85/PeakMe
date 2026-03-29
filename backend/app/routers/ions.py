import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import CurrentUser
from app.models.annotation import Annotation
from app.models.dataset import Dataset
from app.models.ion import Ion
from app.models.label import LabelOption
from app.models.star import IonStar
from app.schemas.annotation import AnnotateRequest, AnnotationOut
from app.schemas.ion import AnnotationSummary, IonQueueItem
from app.services.storage import generate_presigned_url

router = APIRouter(tags=["ions"])

QueueStrategy = Literal["unannotated_first", "starred_first", "all"]


@router.get("/api/datasets/{dataset_id}/ions/queue", response_model=list[IonQueueItem])
async def get_ion_queue(
    dataset_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
    strategy: QueueStrategy = Query(default="unannotated_first"),
    after_sort_order: int = Query(default=-1),
    label_filter: str | None = Query(default=None),
):
    """
    Return an ordered list of ions for annotation.
    Uses cursor-based pagination via after_sort_order (sort_order of the last
    item in the previous batch) to avoid skipping ions as they get annotated.
    label_filter (optional): restrict to ions the current user annotated with
    that label_name, for targeted review sessions.
    Includes presigned image URLs, star status, and existing annotation for this user.
    """
    result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Dataset not found")

    # Base query: all ions for dataset after the cursor position
    query = select(Ion).where(
        Ion.dataset_id == dataset_id,
        Ion.sort_order > after_sort_order,
    )

    if label_filter is not None:
        # Restrict to ions the current user has annotated with this label
        label_subq = select(Annotation.ion_id).where(
            Annotation.user_id == current_user.id,
            Annotation.label_name == label_filter,
        )
        query = query.where(Ion.id.in_(label_subq))
    elif strategy == "unannotated_first":
        # Ions this user hasn't annotated yet, ordered by sort_order
        annotated_subq = select(Annotation.ion_id).where(
            Annotation.user_id == current_user.id
        )
        query = query.where(Ion.id.not_in(annotated_subq))
    elif strategy == "starred_first":
        starred_subq = select(IonStar.ion_id).where(
            IonStar.user_id == current_user.id
        )
        query = query.where(Ion.id.in_(starred_subq))

    query = query.order_by(Ion.sort_order).limit(limit)
    ions_result = await db.execute(query)
    ions = ions_result.scalars().all()

    if not ions:
        return []

    ion_ids = [i.id for i in ions]

    # Batch load annotations for current user
    ann_result = await db.execute(
        select(Annotation).where(
            Annotation.ion_id.in_(ion_ids),
            Annotation.user_id == current_user.id,
        )
    )
    annotations_by_ion = {a.ion_id: a for a in ann_result.scalars().all()}

    # Batch load stars for current user
    star_result = await db.execute(
        select(IonStar).where(
            IonStar.ion_id.in_(ion_ids),
            IonStar.user_id == current_user.id,
        )
    )
    starred_ions = {s.ion_id for s in star_result.scalars().all()}

    # Build response with presigned URLs
    items = []
    for ion in ions:
        ann = annotations_by_ion.get(ion.id)
        items.append(IonQueueItem(
            id=ion.id,
            mz_value=ion.mz_value,
            sort_order=ion.sort_order,
            image_url=generate_presigned_url(ion.image_key),
            tic_image_url=generate_presigned_url(ion.tic_image_key) if ion.tic_image_key else None,
            is_starred=ion.id in starred_ions,
            annotation=AnnotationSummary(
                label_option_id=ann.label_option_id,
                label_name=ann.label_name,
                confidence=ann.confidence,
            ) if ann else None,
        ))
    return items


@router.get("/api/ions/{ion_id}/image")
async def get_ion_image(
    ion_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Redirect to a presigned S3 URL for the ion image."""
    result = await db.execute(select(Ion).where(Ion.id == ion_id))
    ion = result.scalar_one_or_none()
    if not ion:
        raise HTTPException(status_code=404, detail="Ion not found")
    url = generate_presigned_url(ion.image_key, expires_in=3600)
    return RedirectResponse(url=url, status_code=302)


@router.post("/api/ions/{ion_id}/annotate", response_model=AnnotationOut)
async def annotate_ion(
    ion_id: uuid.UUID,
    body: AnnotateRequest,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Create or update annotation for current user on this ion (upsert)."""
    result = await db.execute(select(Ion).where(Ion.id == ion_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Ion not found")

    # Verify label option exists and get its current name
    label_result = await db.execute(
        select(LabelOption).where(LabelOption.id == body.label_option_id)
    )
    label = label_result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Label option not found")

    # Check for existing annotation (upsert)
    existing_result = await db.execute(
        select(Annotation).where(
            Annotation.ion_id == ion_id,
            Annotation.user_id == current_user.id,
        )
    )
    annotation = existing_result.scalar_one_or_none()

    if annotation:
        annotation.label_option_id = body.label_option_id
        annotation.label_name = label.name  # denormalized copy
        annotation.confidence = body.confidence
        annotation.time_spent_ms = body.time_spent_ms
    else:
        annotation = Annotation(
            ion_id=ion_id,
            user_id=current_user.id,
            label_option_id=body.label_option_id,
            label_name=label.name,
            confidence=body.confidence,
            time_spent_ms=body.time_spent_ms,
        )
        db.add(annotation)

    await db.commit()
    await db.refresh(annotation)
    return annotation


@router.delete("/api/ions/{ion_id}/annotate", status_code=status.HTTP_204_NO_CONTENT)
async def undo_annotation(
    ion_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Remove current user's annotation on this ion (undo)."""
    result = await db.execute(
        select(Annotation).where(
            Annotation.ion_id == ion_id,
            Annotation.user_id == current_user.id,
        )
    )
    annotation = result.scalar_one_or_none()
    if not annotation:
        raise HTTPException(status_code=404, detail="No annotation to undo")
    await db.delete(annotation)
    await db.commit()


@router.post("/api/ions/{ion_id}/star")
async def toggle_star(
    ion_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Toggle star on/off for current user. Returns {starred: bool}."""
    result = await db.execute(select(Ion).where(Ion.id == ion_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Ion not found")

    star_result = await db.execute(
        select(IonStar).where(
            IonStar.ion_id == ion_id,
            IonStar.user_id == current_user.id,
        )
    )
    star = star_result.scalar_one_or_none()

    if star:
        await db.delete(star)
        await db.commit()
        return {"starred": False}
    else:
        new_star = IonStar(ion_id=ion_id, user_id=current_user.id)
        db.add(new_star)
        await db.commit()
        return {"starred": True}
