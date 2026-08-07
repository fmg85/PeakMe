"""Regression tests for the ML score bulk UPDATE.

This shipped broken: `update(Ion).where(Ion.id == bindparam("ion_id"))` with
executemany params is rejected by SQLAlchemy 2.0 ("bulk synchronize of persistent
objects not supported when using bulk update with additional WHERE criteria"), and
`_ingest_background_from_s3` swallowed it with a bare `except Exception: pass` — so
scoring was a silent no-op on every dataset ever ingested and nothing said so.

These tests drive the real `score_dataset`, stubbing only S3 and ONNX, so the actual
UPDATE executes against Postgres. The interesting assertion is simply that rows
change at all — the original code never got that far.
"""
from app.models.ion import Ion
from app.services import ml_scoring
from sqlalchemy import select
from tests.factories import make_dataset, make_ion, make_project, make_user


async def _seed(db, n=4):
    owner = await make_user(db)
    project = await make_project(db, owner)
    dataset = await make_dataset(db, project)
    ions = [await make_ion(db, dataset, sort_order=i) for i in range(n)]
    return dataset.id, [i.id for i in ions]


def _stub(monkeypatch, scores):
    """Stub out S3 + ONNX so only the DB write path is exercised."""
    monkeypatch.setattr(ml_scoring.settings, "ml_model_s3_key", "model.onnx", raising=False)
    monkeypatch.setattr(ml_scoring, "_fetch_image", lambda key: b"")
    monkeypatch.setattr(ml_scoring, "_get_session", lambda: object())
    monkeypatch.setattr(ml_scoring, "_run_inference", lambda session, images: scores)


async def test_scoring_writes_ml_score_and_reranks(db, monkeypatch):
    dataset_id, ion_ids = await _seed(db, 4)
    # Ion 0 worst, ion 3 best → expected sort_order 3,2,1,0 respectively.
    _stub(monkeypatch, [0.1, 0.4, 0.6, 0.9])

    await ml_scoring.score_dataset(dataset_id, db)

    rows = (await db.execute(
        select(Ion.id, Ion.sort_order, Ion.ml_score).where(Ion.dataset_id == dataset_id)
    )).all()
    by_id = {r.id: (r.sort_order, r.ml_score) for r in rows}

    assert all(v[1] is not None for v in by_id.values()), "ml_score was never written"
    assert by_id[ion_ids[3]][0] == 0, "highest-scoring ion must rank first"
    assert by_id[ion_ids[0]][0] == 3, "lowest-scoring ion must rank last"
    assert sorted(v[0] for v in by_id.values()) == [0, 1, 2, 3], "ranks must be a dense 0..n-1"
    assert by_id[ion_ids[3]][1] == 0.9


async def test_scoring_is_a_noop_without_a_configured_model(db, monkeypatch):
    dataset_id, ion_ids = await _seed(db, 3)
    monkeypatch.setattr(ml_scoring.settings, "ml_model_s3_key", None, raising=False)

    await ml_scoring.score_dataset(dataset_id, db)

    rows = (await db.execute(
        select(Ion.sort_order, Ion.ml_score).where(Ion.dataset_id == dataset_id)
    )).all()
    assert all(r.ml_score is None for r in rows), "must not touch ions when disabled"
    assert sorted(r.sort_order for r in rows) == [0, 1, 2], "upload order preserved"


async def test_scoring_only_touches_its_own_dataset(db, monkeypatch):
    other_id, other_ions = await _seed(db, 2)
    dataset_id, _ = await _seed(db, 2)
    _stub(monkeypatch, [0.2, 0.8])

    await ml_scoring.score_dataset(dataset_id, db)

    rows = (await db.execute(
        select(Ion.ml_score).where(Ion.dataset_id == other_id)
    )).all()
    assert all(r.ml_score is None for r in rows), "scored the wrong dataset"
