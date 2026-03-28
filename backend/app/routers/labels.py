import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import CurrentUser
from app.models.annotation import Annotation
from app.models.label import LabelOption
from app.models.project import Project
from app.schemas.label import LabelOptionCreate, LabelOptionOut, LabelOptionUpdate

router = APIRouter(tags=["labels"])


@router.get("/api/projects/{project_id}/labels", response_model=list[LabelOptionOut])
async def list_labels(
    project_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(LabelOption)
        .where(LabelOption.project_id == project_id)
        .order_by(LabelOption.sort_order)
    )
    return result.scalars().all()


@router.post(
    "/api/projects/{project_id}/labels",
    response_model=LabelOptionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_label(
    project_id: uuid.UUID,
    body: LabelOptionCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    label = LabelOption(
        project_id=project_id,
        name=body.name,
        color=body.color,
        keyboard_shortcut=body.keyboard_shortcut,
        swipe_direction=body.swipe_direction,
        sort_order=body.sort_order,
    )
    db.add(label)
    await db.commit()
    await db.refresh(label)
    return label


@router.patch("/api/labels/{label_id}", response_model=LabelOptionOut)
async def update_label(
    label_id: uuid.UUID,
    body: LabelOptionUpdate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(LabelOption).where(LabelOption.id == label_id))
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")
    if body.name is not None:
        label.name = body.name
    if body.color is not None:
        label.color = body.color
    if body.keyboard_shortcut is not None:
        label.keyboard_shortcut = body.keyboard_shortcut
    if "swipe_direction" in body.model_fields_set:
        label.swipe_direction = body.swipe_direction  # allows clearing with null
    if body.sort_order is not None:
        label.sort_order = body.sort_order
    db.add(label)
    await db.commit()
    await db.refresh(label)
    return label


@router.delete("/api/labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_label(
    label_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(LabelOption).where(LabelOption.id == label_id))
    label = result.scalar_one_or_none()
    if not label:
        raise HTTPException(status_code=404, detail="Label not found")

    # Prevent deletion if annotations reference this label
    count = await db.execute(
        select(func.count()).where(Annotation.label_option_id == label_id)
    )
    if count.scalar() > 0:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete label with existing annotations. Rename it instead.",
        )

    await db.delete(label)
    await db.commit()
