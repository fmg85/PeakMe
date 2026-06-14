"""Small async factories for seeding test data."""
import uuid

from app.models.dataset import Dataset
from app.models.ion import Ion
from app.models.label import LabelOption
from app.models.project import Project
from app.models.user import User


async def make_user(db, *, email=None, display_name="Tester", is_admin=False, id=None):
    user = User(
        id=id or uuid.uuid4(),
        email=email or f"{uuid.uuid4().hex[:10]}@example.com",
        display_name=display_name,
        is_admin=is_admin,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def make_project(db, owner, *, name="Project"):
    project = Project(name=name, created_by=owner.id)
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


async def make_dataset(db, project, *, name="Dataset"):
    dataset = Dataset(project_id=project.id, name=name)
    db.add(dataset)
    await db.commit()
    await db.refresh(dataset)
    return dataset


async def make_label(db, project, *, name="Tumor"):
    label = LabelOption(project_id=project.id, name=name)
    db.add(label)
    await db.commit()
    await db.refresh(label)
    return label


async def make_ion(db, dataset, *, sort_order, mz=None):
    ion = Ion(
        dataset_id=dataset.id,
        mz_value=mz if mz is not None else 100.0 + sort_order,
        image_key=f"ions/{uuid.uuid4().hex}.png",
        sort_order=sort_order,
    )
    db.add(ion)
    await db.commit()
    await db.refresh(ion)
    return ion
