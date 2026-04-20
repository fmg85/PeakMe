"""ML scoring service — runs MobileNet-V3-Small inference on ion images.

After a dataset finishes ingesting, score_dataset() fetches all ion images from S3,
runs ONNX inference in batches, and atomically rewrites ions.sort_order (ML rank,
0 = highest P(on_tissue)) and ions.ml_score. The queue endpoint sorts by sort_order,
so no query changes are needed — ions arrive in ML-ranked order automatically.

Set ML_MODEL_S3_KEY in the environment to enable scoring. If unset, score_dataset()
returns immediately and the original sort_order is preserved.
"""

import asyncio
import io
import os
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from sqlalchemy import bindparam, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.ion import Ion
from app.services.storage import get_s3_client

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
BATCH_SIZE = 64
_S3_WORKERS = 20

_model_lock = threading.Lock()
_ort_session = None


def _load_model():
    import onnxruntime as ort

    client = get_s3_client()
    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as f:
        client.download_fileobj(settings.aws_s3_bucket, settings.ml_model_s3_key, f)
        tmp_path = f.name
    try:
        return ort.InferenceSession(tmp_path, providers=["CPUExecutionProvider"])
    finally:
        os.unlink(tmp_path)


def _get_session():
    global _ort_session
    if _ort_session is not None:
        return _ort_session
    with _model_lock:
        if _ort_session is None:
            _ort_session = _load_model()
    return _ort_session


def _preprocess(img_bytes: bytes) -> np.ndarray:
    from PIL import Image

    img = Image.open(io.BytesIO(img_bytes)).convert("RGB").resize((224, 224))
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - IMAGENET_MEAN) / IMAGENET_STD
    return arr.transpose(2, 0, 1)  # HWC → CHW float32


def _run_inference(session, images: list) -> list:
    scores = []
    for i in range(0, len(images), BATCH_SIZE):
        batch = np.stack([_preprocess(b) for b in images[i : i + BATCH_SIZE]])
        probs = session.run(["probabilities"], {"input": batch})[0]
        scores.extend(probs[:, 1].tolist())  # P(on_tissue) is class index 1
    return scores


def _fetch_image(key: str) -> bytes:
    return get_s3_client().get_object(Bucket=settings.aws_s3_bucket, Key=key)[
        "Body"
    ].read()


async def score_dataset(dataset_id, db: AsyncSession) -> None:
    """Score all ions in a dataset and rewrite sort_order by ML rank.

    Silently returns if ML_MODEL_S3_KEY is not configured. Errors propagate to
    the caller, which wraps this in a best-effort try/except.
    """
    if not settings.ml_model_s3_key:
        return

    rows = (
        await db.execute(
            select(Ion.id, Ion.image_key)
            .where(Ion.dataset_id == dataset_id)
            .order_by(Ion.sort_order)
        )
    ).all()
    if not rows:
        return

    ion_ids = [r.id for r in rows]
    image_keys = [r.image_key for r in rows]

    loop = asyncio.get_running_loop()

    # Fetch all ion images from S3 in parallel
    with ThreadPoolExecutor(max_workers=_S3_WORKERS) as pool:
        images = list(
            await asyncio.gather(
                *[loop.run_in_executor(pool, _fetch_image, k) for k in image_keys]
            )
        )

    # Load ONNX session (lazy, thread-safe) and run batch inference
    session = await loop.run_in_executor(None, _get_session)
    scores = await loop.run_in_executor(None, _run_inference, session, images)

    # Rank: highest P(on_tissue) → sort_order=0
    ranked = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    updates = [
        {
            "ion_id": ion_ids[orig_idx],
            "new_sort": new_rank,
            "ml_score": float(scores[orig_idx]),
        }
        for new_rank, orig_idx in enumerate(ranked)
    ]

    # Atomic bulk update — rewrites sort_order and ml_score in a single commit
    await db.execute(
        update(Ion)
        .where(Ion.id == bindparam("ion_id"))
        .values(sort_order=bindparam("new_sort"), ml_score=bindparam("ml_score")),
        updates,
    )
    await db.commit()
