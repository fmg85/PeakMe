"""
Dataset ingestion service.

Accepts a ZIP file (PNGs + metadata.csv), validates the contents,
uploads images to S3, and creates Ion records in the database.
"""
import csv
import io
import tempfile
import uuid
import zipfile
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.dataset import Dataset
from app.models.ion import Ion
from app.services.storage import upload_image


class IngestError(Exception):
    pass


async def ingest_zip(
    zip_bytes: bytes,
    dataset: Dataset,
    db: AsyncSession,
) -> int:
    """
    Process a ZIP upload, upload PNGs to S3, create Ion rows.
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
            "See docs/r-export-workflow.md for the required format."
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

    # Validate all filenames exist in ZIP before starting upload
    zip_files = set(names)
    for row in rows:
        fname = row["filename"].strip()
        candidate_paths = [
            fname,
            f"{base_dir}/{fname}" if base_dir != "." else fname,
        ]
        if not any(p in zip_files for p in candidate_paths):
            raise IngestError(
                f"File '{fname}' listed in metadata.csv not found in ZIP."
            )

    # Upload and create Ion records
    ions = []
    for i, row in enumerate(rows):
        fname = row["filename"].strip()
        try:
            mz = float(row["mz_value"])
        except (ValueError, KeyError):
            raise IngestError(f"Invalid mz_value in row {i + 2}: '{row.get('mz_value')}'")

        # Find file in zip (handles subdirectory or flat)
        zip_path = fname
        if f"{base_dir}/{fname}" in zip_files and base_dir != ".":
            zip_path = f"{base_dir}/{fname}"

        img_bytes = zf.read(zip_path)
        image_key = upload_image(img_bytes, dataset.id, fname)

        ions.append(Ion(
            dataset_id=dataset.id,
            mz_value=mz,
            image_key=image_key,
            sort_order=i,
        ))

    db.add_all(ions)
    dataset.total_ions = len(ions)
    dataset.status = "ready"
    await db.commit()

    return len(ions)
