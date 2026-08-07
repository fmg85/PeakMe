"""Tests for dataset deletion authorization.

Deleting a dataset is the most destructive operation in the app: ON DELETE CASCADE
takes `datasets -> ions -> annotations` (migration 0001), so it destroys *every*
user's annotations for that dataset, and then the S3 prefix. Ownership is enforced
at the parent project, matching `delete_project`.

Read/annotate endpoints remain intentionally shared between authenticated users
(see tests/test_projects.py) — this is specifically about the unrecoverable path.
"""
import uuid

from app.models.annotation import Annotation
from app.models.ion import Ion
from sqlalchemy import func, select
from tests.factories import make_dataset, make_ion, make_project, make_user


async def test_owner_can_delete_own_dataset(client, db, login_as):
    owner = await make_user(db)
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    login_as(owner)

    r = await client.delete(f"/api/datasets/{dataset.id}")

    assert r.status_code == 204


async def test_non_owner_cannot_delete_dataset(client, db, login_as):
    owner = await make_user(db)
    other = await make_user(db)
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    login_as(other)

    r = await client.delete(f"/api/datasets/{dataset.id}")

    assert r.status_code == 403


async def test_admin_can_delete_any_dataset(client, db, login_as):
    owner = await make_user(db)
    admin = await make_user(db, is_admin=True)
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    login_as(admin)

    r = await client.delete(f"/api/datasets/{dataset.id}")

    assert r.status_code == 204


async def test_delete_missing_dataset_returns_404(client, db, login_as):
    user = await make_user(db)
    login_as(user)

    r = await client.delete(f"/api/datasets/{uuid.uuid4()}")

    assert r.status_code == 404


async def test_rejected_delete_leaves_every_annotation_intact(client, db, login_as):
    """The regression that matters: a 403 must not cost anyone their work."""
    owner = await make_user(db)
    annotator = await make_user(db)
    attacker = await make_user(db)
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    ion = await make_ion(db, dataset, sort_order=0)
    db.add(Annotation(ion_id=ion.id, user_id=annotator.id, label_name="Tumor"))
    await db.commit()

    login_as(attacker)
    r = await client.delete(f"/api/datasets/{dataset.id}")

    assert r.status_code == 403
    # The cascade must not have fired: ion and annotation both still present.
    assert (await db.execute(select(func.count(Ion.id)).where(Ion.dataset_id == dataset.id))).scalar() == 1
    assert (await db.execute(select(func.count(Annotation.id)).where(Annotation.ion_id == ion.id))).scalar() == 1


async def test_owner_delete_does_cascade_annotations(client, db, login_as):
    """Confirm the cascade this guard protects is real — an authorized delete still works."""
    owner = await make_user(db)
    annotator = await make_user(db)
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    ion = await make_ion(db, dataset, sort_order=0)
    db.add(Annotation(ion_id=ion.id, user_id=annotator.id, label_name="Tumor"))
    await db.commit()

    login_as(owner)
    r = await client.delete(f"/api/datasets/{dataset.id}")

    assert r.status_code == 204
    assert (await db.execute(select(func.count(Ion.id)).where(Ion.dataset_id == dataset.id))).scalar() == 0
    assert (await db.execute(select(func.count(Annotation.id)).where(Annotation.ion_id == ion.id))).scalar() == 0
