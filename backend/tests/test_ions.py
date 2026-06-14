"""Integration tests for the annotate upsert, the queue, and starring.

The annotate endpoint is the replay target for offline sync; the queue cursor is
the swipe-session order. Both fail silently if they regress.
"""
import uuid

from sqlalchemy import func, select

from app.models.annotation import Annotation
from tests.factories import make_dataset, make_ion, make_label, make_project, make_user


async def _setup(db):
    user = await make_user(db)
    project = await make_project(db, user)
    dataset = await make_dataset(db, project)
    return user, project, dataset


async def test_annotate_is_an_upsert_second_label_wins(client, db, login_as):
    user, project, dataset = await _setup(db)
    ion = await make_ion(db, dataset, sort_order=0)
    tumor = await make_label(db, project, name="Tumor")
    necrosis = await make_label(db, project, name="Necrosis")
    login_as(user)

    r1 = await client.post(f"/api/ions/{ion.id}/annotate", json={"label_option_id": str(tumor.id)})
    r2 = await client.post(f"/api/ions/{ion.id}/annotate", json={"label_option_id": str(necrosis.id)})

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert r2.json()["label_name"] == "Necrosis"

    count = await db.scalar(
        select(func.count())
        .select_from(Annotation)
        .where(Annotation.ion_id == ion.id, Annotation.user_id == user.id)
    )
    assert count == 1  # upsert, not a second row


async def test_annotate_nonexistent_ion_returns_404(client, db, login_as):
    user, project, _ = await _setup(db)
    label = await make_label(db, project)
    login_as(user)

    r = await client.post(
        f"/api/ions/{uuid.uuid4()}/annotate", json={"label_option_id": str(label.id)}
    )
    assert r.status_code == 404


async def test_annotate_nonexistent_label_returns_404(client, db, login_as):
    user, _, dataset = await _setup(db)
    ion = await make_ion(db, dataset, sort_order=0)
    login_as(user)

    r = await client.post(
        f"/api/ions/{ion.id}/annotate", json={"label_option_id": str(uuid.uuid4())}
    )
    assert r.status_code == 404


async def test_annotate_confidence_out_of_range_is_422(client, db, login_as):
    user, project, dataset = await _setup(db)
    ion = await make_ion(db, dataset, sort_order=0)
    label = await make_label(db, project)
    login_as(user)

    r = await client.post(
        f"/api/ions/{ion.id}/annotate",
        json={"label_option_id": str(label.id), "confidence": 5},  # schema allows 1..3
    )
    assert r.status_code == 422


async def test_queue_cursor_pagination_has_no_gap_or_overlap(client, db, login_as):
    user, _, dataset = await _setup(db)
    for i in range(5):
        await make_ion(db, dataset, sort_order=i)
    login_as(user)
    base = f"/api/datasets/{dataset.id}/ions/queue"

    p1 = (await client.get(base, params={"strategy": "all", "limit": 2, "after_sort_order": -1})).json()
    assert [x["sort_order"] for x in p1] == [0, 1]

    p2 = (await client.get(base, params={"strategy": "all", "limit": 2, "after_sort_order": p1[-1]["sort_order"]})).json()
    assert [x["sort_order"] for x in p2] == [2, 3]

    p3 = (await client.get(base, params={"strategy": "all", "limit": 2, "after_sort_order": p2[-1]["sort_order"]})).json()
    assert [x["sort_order"] for x in p3] == [4]  # short final page


async def test_queue_unannotated_first_excludes_own_annotations(client, db, login_as):
    user, project, dataset = await _setup(db)
    ion0 = await make_ion(db, dataset, sort_order=0)
    await make_ion(db, dataset, sort_order=1)
    label = await make_label(db, project)
    login_as(user)
    await client.post(f"/api/ions/{ion0.id}/annotate", json={"label_option_id": str(label.id)})

    batch = (await client.get(f"/api/datasets/{dataset.id}/ions/queue", params={"strategy": "unannotated_first"})).json()

    assert [x["sort_order"] for x in batch] == [1]  # the annotated ion0 is gone


async def test_star_toggles_on_then_off(client, db, login_as):
    user, _, dataset = await _setup(db)
    ion = await make_ion(db, dataset, sort_order=0)
    login_as(user)

    on = await client.post(f"/api/ions/{ion.id}/star")
    off = await client.post(f"/api/ions/{ion.id}/star")

    assert on.json() == {"starred": True}
    assert off.json() == {"starred": False}
