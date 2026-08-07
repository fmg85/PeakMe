import asyncio
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.deps import CurrentUser
from app.models.dataset import Dataset
from app.models.project import Project
from app.schemas.project import ProjectCreate, ProjectOut, ProjectUpdate
from app.services.ownership import can_modify_project
from app.services.storage import delete_dataset_images

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
async def list_projects(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.label_options))
        .order_by(Project.created_at.desc())
    )
    return result.scalars().all()


@router.post("", response_model=ProjectOut, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    project = Project(
        name=body.name,
        description=body.description,
        created_by=current_user.id,
    )
    db.add(project)
    await db.commit()
    await db.refresh(project, ["label_options"])
    return project


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(
    project_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.label_options))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: uuid.UUID,
    body: ProjectUpdate,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not await can_modify_project(db, project, current_user):
        raise HTTPException(status_code=403, detail="Not authorized")
    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        project.description = body.description
    db.add(project)
    await db.commit()
    await db.refresh(project, ["label_options"])
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(
    project_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not await can_modify_project(db, project, current_user):
        raise HTTPException(status_code=403, detail="Not authorized")

    # Collect dataset IDs for S3 cleanup before deletion
    ds_result = await db.execute(select(Dataset.id).where(Dataset.project_id == project_id))
    dataset_ids = [row[0] for row in ds_result.all()]

    await db.delete(project)
    await db.commit()

    # Clean up S3 images for all datasets (best-effort, off the event loop)
    loop = asyncio.get_running_loop()
    for ds_id in dataset_ids:
        try:
            await loop.run_in_executor(None, delete_dataset_images, ds_id)
        except Exception:
            pass
