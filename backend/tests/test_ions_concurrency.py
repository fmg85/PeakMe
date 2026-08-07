"""Concurrency + upsert-semantics tests for annotate and star.

Both endpoints were read-then-write: SELECT, then INSERT-or-UPDATE. Two concurrent
requests for the same (ion_id, user_id) both saw no row, both INSERTed, and the
second violated uq_annotation_ion_user (or the ion_stars PK) as an unhandled 500.

Reachable today via the offline reconciler replaying a queued mutation while the
user taps the same ion, and strictly more likely once more than one device or user
is in play — so this is also groundwork for multi-user.
"""
import asyncio

from app.models.annotation import Annotation
from app.models.star import IonStar
from sqlalchemy import func, select
from tests.factories import make_dataset, make_ion, make_label, make_project, make_user


async def _setup(db):
    user = await make_user(db)
    project = await make_project(db, user)
    label = await make_label(db, project, name="Tumor")
    dataset = await make_dataset(db, project)
    ion = await make_ion(db, dataset, sort_order=0)
    return user, label, ion


async def _count_annotations(db, ion_id):
    return (await db.execute(
        select(func.count(Annotation.id)).where(Annotation.ion_id == ion_id)
    )).scalar()


async def test_concurrent_annotate_of_same_ion_does_not_500(client, db, login_as):
    user, label, ion = await _setup(db)
    login_as(user)

    responses = await asyncio.gather(*[
        client.post(f"/api/ions/{ion.id}/annotate", json={"label_option_id": str(label.id)})
        for _ in range(5)
    ], return_exceptions=True)

    for r in responses:
        assert not isinstance(r, Exception), f"request raised: {r!r}"
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"
    assert await _count_annotations(db, ion.id) == 1, "upsert must converge to one row"


async def test_repeated_annotate_updates_in_place_and_last_write_wins(client, db, login_as):
    user, label, ion = await _setup(db)
    second = await make_label(db, await _project_of(db, ion), name="Necrosis")
    login_as(user)

    r1 = await client.post(f"/api/ions/{ion.id}/annotate", json={"label_option_id": str(label.id)})
    r2 = await client.post(f"/api/ions/{ion.id}/annotate", json={"label_option_id": str(second.id)})

    assert r1.status_code == 200 and r2.status_code == 200
    assert await _count_annotations(db, ion.id) == 1
    assert r2.json()["label_name"] == "Necrosis"


async def _project_of(db, ion):
    from app.models.dataset import Dataset
    from app.models.project import Project
    ds = (await db.execute(select(Dataset).where(Dataset.id == ion.dataset_id))).scalar_one()
    return (await db.execute(select(Project).where(Project.id == ds.project_id))).scalar_one()


async def test_reannotate_advances_updated_at(client, db, login_as):
    """Regression: ORM `onupdate` does not fire for a Core insert, so `updated_at`
    must be in the ON CONFLICT set_ dict or it silently freezes at creation time."""
    user, label, ion = await _setup(db)
    second = await make_label(db, await _project_of(db, ion), name="Necrosis")
    login_as(user)

    # Read raw columns (not the ORM object) so each read hits the DB rather than an
    # identity-map copy that would mask a frozen updated_at.
    async def _stamps():
        return (await db.execute(
            select(Annotation.created_at, Annotation.updated_at)
            .where(Annotation.ion_id == ion.id)
        )).one()

    await client.post(f"/api/ions/{ion.id}/annotate", json={"label_option_id": str(label.id)})
    created, first_updated = await _stamps()

    await asyncio.sleep(0.05)
    await client.post(f"/api/ions/{ion.id}/annotate", json={"label_option_id": str(second.id)})
    created_after, second_updated = await _stamps()

    assert second_updated > first_updated, "updated_at must advance on re-annotation"
    assert created_after == created, "created_at must be preserved by the upsert"


async def test_concurrent_star_toggles_do_not_500(client, db, login_as):
    user, _label, ion = await _setup(db)
    login_as(user)

    responses = await asyncio.gather(*[
        client.post(f"/api/ions/{ion.id}/star") for _ in range(5)
    ], return_exceptions=True)

    for r in responses:
        assert not isinstance(r, Exception), f"request raised: {r!r}"
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"

    # Whatever the interleaving, the table must hold 0 or 1 rows — never a duplicate,
    # never an integrity error. The reconciler re-reads and corrects the direction.
    count = (await db.execute(
        select(func.count()).select_from(IonStar).where(IonStar.ion_id == ion.id)
    )).scalar()
    assert count in (0, 1), f"star table diverged: {count} rows"


async def test_star_then_unstar_round_trips(client, db, login_as):
    user, _label, ion = await _setup(db)
    login_as(user)

    r1 = await client.post(f"/api/ions/{ion.id}/star")
    assert r1.json() == {"starred": True}
    r2 = await client.post(f"/api/ions/{ion.id}/star")
    assert r2.json() == {"starred": False}

    count = (await db.execute(
        select(func.count()).select_from(IonStar).where(IonStar.ion_id == ion.id)
    )).scalar()
    assert count == 0
