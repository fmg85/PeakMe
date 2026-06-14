"""
Dataset ingestion service.

Accepts a ZIP file (PNGs + metadata.csv), validates the contents,
uploads images to S3 in parallel, and creates Ion records in the database.
"""
import asyncio
import csv
import io
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dataset import Dataset
from app.models.ion import Ion
from app.services.storage import upload_image

# Max concurrent S3 uploads per ingestion job
_S3_WORKERS = 20


class IngestError(Exception):
    pass


async def ingest_zip(
    zip_bytes: bytes,
    dataset: Dataset,
    db: AsyncSession,
) -> int:
    """
    Process a ZIP upload, upload PNGs to S3 in parallel, create Ion rows.
    Returns the number of ions ingested.
    Raises IngestError on validation failures.
    """
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise IngestError("Uploaded file is not a valid ZIP archive.")

    names = zf.namelist()

    # Find metadata.csv — support both root-level and inside a single folder
    metadata_candidates = [n for n in names if Path(n).name == "metadata.csv"]
    if not metadata_candidates:
        raise IngestError(
            "metadata.csv not found in ZIP. "
            "See the Instructions page for the required format."
        )
    metadata_path = metadata_candidates[0]
    base_dir = str(Path(metadata_path).parent)

    # Parse metadata.csv
    csv_content = zf.read(metadata_path).decode("utf-8-sig")  # handle BOM
    reader = csv.DictReader(io.StringIO(csv_content))

    required_cols = {"filename", "mz_value"}
    if not required_cols.issubset(set(reader.fieldnames or [])):
        raise IngestError(
            f"metadata.csv must have columns: {required_cols}. "
            f"Found: {set(reader.fieldnames or [])}"
        )

    rows = list(reader)
    if not rows:
        raise IngestError("metadata.csv is empty — no ions to ingest.")

    # Validate all filenames exist in ZIP before starting any upload
    zip_files = set(names)
    parsed: list[tuple[str, float, str]] = []  # (fname, mz, zip_path)
    for i, row in enumerate(rows):
        fname = row["filename"].strip()
        try:
            mz = float(row["mz_value"])
        except (ValueError, KeyError):
            raise IngestError(f"Invalid mz_value in row {i + 2}: '{row.get('mz_value')}'")

        zip_path = fname
        candidate = f"{base_dir}/{fname}"
        if candidate in zip_files and base_dir != ".":
            zip_path = candidate
        elif fname not in zip_files:
            raise IngestError(f"File '{fname}' listed in metadata.csv not found in ZIP.")

        parsed.append((fname, mz, zip_path))

    # ── Pre-read all file bytes from the ZIP (single-threaded, thread-safe) ──────
    # ZipFile is not thread-safe; extract all data before spawning upload workers.
    upload_items: list[tuple[str, float, bytes, str | None, bytes | None]] = []
    for fname, mz, zip_path in parsed:
        img_bytes = zf.read(zip_path)
        tic_fname = fname.replace(".png", "_tic.png")
        candidate = f"{base_dir}/{tic_fname}"
        if candidate in zip_files and base_dir != ".":
            tic_bytes: bytes | None = zf.read(candidate)
        elif tic_fname in zip_files:
            tic_bytes = zf.read(tic_fname)
        else:
            tic_bytes = None
        upload_items.append((fname, mz, img_bytes, tic_fname if tic_bytes is not None else None, tic_bytes))

    # Publish the total up-front so the client can show a denominator and a
    # moving progress bar while the (slow) S3 uploads run.
    total = len(upload_items)
    dataset.total_ions = total
    dataset.processed_ions = 0
    await db.commit()

    # ── Parallel S3 uploads (no ZIP access in threads) ─────────────────────────
    loop = asyncio.get_running_loop()

    def _upload(idx: int, item: tuple[str, float, bytes, str | None, bytes | None]) -> tuple[int, str, float, str, str | None]:
        fname, mz, img_bytes, tic_fname, tic_bytes = item
        key = upload_image(img_bytes, dataset.id, fname)
        tic_key = upload_image(tic_bytes, dataset.id, tic_fname) if tic_bytes is not None and tic_fname else None
        return (idx, fname, mz, key, tic_key)

    # Persist progress in ~2% steps so the client sees movement without one DB
    # write per ion. as_completed lets us count finished uploads; results are
    # re-sorted by index afterwards to preserve metadata.csv order.
    commit_step = max(1, total // 50)
    results_by_idx: dict[int, tuple[str, float, str, str | None]] = {}
    done = 0

    with ThreadPoolExecutor(max_workers=_S3_WORKERS) as pool:
        futures = [loop.run_in_executor(pool, _upload, idx, item) for idx, item in enumerate(upload_items)]
        for coro in asyncio.as_completed(futures):
            idx, fname, mz, key, tic_key = await coro
            results_by_idx[idx] = (fname, mz, key, tic_key)
            done += 1
            if done % commit_step == 0 and done < total:
                dataset.processed_ions = done
                await db.commit()

    results = [results_by_idx[i] for i in range(total)]

    # ── Bulk DB insert ─────────────────────────────────────────────────────────
    ions = [
        Ion(
            dataset_id=dataset.id,
            mz_value=mz,
            image_key=key,
            tic_image_key=tic_key,
            sort_order=i,
        )
        for i, (fname, mz, key, tic_key) in enumerate(results)
    ]
    db.add_all(ions)
    dataset.total_ions = len(ions)
    dataset.processed_ions = len(ions)
    dataset.status = "ready"
    await db.commit()

    return len(ions)
