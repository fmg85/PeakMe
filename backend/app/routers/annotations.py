import csv
import io
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import joinedload

from app.database import get_db
from app.deps import CurrentUser
from app.models.annotation import Annotation
from app.models.dataset import Dataset
from app.models.ion import Ion
from app.models.project import Project
from app.models.star import IonStar
from app.models.user import User
from app.schemas.annotation import GlobalStatsOut, LabelCount, StatsOut, UserStats

router = APIRouter(prefix="/api/projects", tags=["annotations"])


@router.get("/{project_id}/annotations")
async def export_annotations(
    project_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    format: Literal["csv", "json"] = Query(default="csv"),
):
    """
    Export all annotations for a project as CSV or JSON.
    Streams the response to handle large datasets.
    """
    result = await db.execute(
        select(Annotation, Ion, User)
        .join(Ion, Annotation.ion_id == Ion.id)
        .join(Dataset, Ion.dataset_id == Dataset.id)
        .join(User, Annotation.user_id == User.id)
        .where(Dataset.project_id == project_id)
        .order_by(Ion.dataset_id, Ion.sort_order, User.display_name)
    )
    rows = result.all()

    # Batch-load all stars for this project
    star_result = await db.execute(
        select(IonStar.ion_id, IonStar.user_id)
        .join(Ion, IonStar.ion_id == Ion.id)
        .join(Dataset, Ion.dataset_id == Dataset.id)
        .where(Dataset.project_id == project_id)
    )
    starred_set = {(r.ion_id, r.user_id) for r in star_result}

    if format == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "ion_id", "dataset_id", "mz_value", "label_name",
            "label_option_id", "starred", "annotator", "annotator_id",
            "confidence", "time_spent_ms", "annotated_at", "updated_at",
        ])
        for annotation, ion, user in rows:
            writer.writerow([
                str(annotation.ion_id),
                str(ion.dataset_id),
                ion.mz_value,
                annotation.label_name,
                str(annotation.label_option_id) if annotation.label_option_id else "",
                (annotation.ion_id, user.id) in starred_set,
                user.display_name,
                str(user.id),
                annotation.confidence or "",
                annotation.time_spent_ms or "",
                annotation.created_at.isoformat(),
                annotation.updated_at.isoformat(),
            ])
        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=peakme_annotations_{project_id}.csv"},
        )
    else:
        import json
        data = [
            {
                "ion_id": str(a.ion_id),
                "dataset_id": str(ion.dataset_id),
                "mz_value": ion.mz_value,
                "label_name": a.label_name,
                "label_option_id": str(a.label_option_id) if a.label_option_id else None,
                "starred": (a.ion_id, u.id) in starred_set,
                "annotator": u.display_name,
                "annotator_id": str(u.id),
                "confidence": a.confidence,
                "time_spent_ms": a.time_spent_ms,
                "annotated_at": a.created_at.isoformat(),
                "updated_at": a.updated_at.isoformat(),
            }
            for a, ion, u in rows
        ]
        return StreamingResponse(
            iter([json.dumps(data, indent=2)]),
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename=peakme_annotations_{project_id}.json"},
        )


@router.get("/{project_id}/datasets/{dataset_id}/annotations")
async def export_dataset_annotations(
    project_id: uuid.UUID,
    dataset_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
    format: Literal["csv", "json"] = Query(default="csv"),
):
    """Export all annotations for a single dataset as CSV or JSON."""
    result = await db.execute(
        select(Annotation, Ion, User)
        .join(Ion, Annotation.ion_id == Ion.id)
        .join(User, Annotation.user_id == User.id)
        .where(Ion.dataset_id == dataset_id)
        .order_by(Ion.sort_order, User.display_name)
    )
    rows = result.all()

    # Batch-load stars for this dataset
    star_result = await db.execute(
        select(IonStar.ion_id, IonStar.user_id)
        .where(IonStar.ion_id.in_([ion.id for _, ion, _ in rows]))
    )
    starred_set = {(r.ion_id, r.user_id) for r in star_result}

    ds_result = await db.execute(select(Dataset).where(Dataset.id == dataset_id))
    dataset = ds_result.scalar_one_or_none()
    safe_name = (dataset.name if dataset else str(dataset_id)).replace(" ", "_")

    if format == "csv":
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow([
            "ion_id", "mz_value", "label_name", "label_option_id",
            "starred", "annotator", "annotator_id",
            "confidence", "time_spent_ms", "annotated_at", "updated_at",
        ])
        for annotation, ion, user in rows:
            writer.writerow([
                str(annotation.ion_id),
                ion.mz_value,
                annotation.label_name,
                str(annotation.label_option_id) if annotation.label_option_id else "",
                (annotation.ion_id, user.id) in starred_set,
                user.display_name,
                str(user.id),
                annotation.confidence or "",
                annotation.time_spent_ms or "",
                annotation.created_at.isoformat(),
                annotation.updated_at.isoformat(),
            ])
        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f"attachment; filename=peakme_{safe_name}_annotations.csv"},
        )
    else:
        import json
        data = [
            {
                "ion_id": str(a.ion_id),
                "mz_value": ion.mz_value,
                "label_name": a.label_name,
                "label_option_id": str(a.label_option_id) if a.label_option_id else None,
                "starred": (a.ion_id, u.id) in starred_set,
                "annotator": u.display_name,
                "annotator_id": str(u.id),
                "confidence": a.confidence,
                "time_spent_ms": a.time_spent_ms,
                "annotated_at": a.created_at.isoformat(),
                "updated_at": a.updated_at.isoformat(),
            }
            for a, ion, u in rows
        ]
        return StreamingResponse(
            iter([json.dumps(data, indent=2)]),
            media_type="application/json",
            headers={"Content-Disposition": f"attachment; filename=peakme_{safe_name}_annotations.json"},
        )


@router.get("/{project_id}/stats", response_model=StatsOut)
async def get_stats(
    project_id: uuid.UUID,
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Per-user annotation counts and label breakdowns for a project."""
    # Total ions in project
    ion_count_result = await db.execute(
        select(func.count(Ion.id))
        .join(Dataset, Ion.dataset_id == Dataset.id)
        .where(Dataset.project_id == project_id)
    )
    total_ions = ion_count_result.scalar() or 0

    # All annotations with user info
    result = await db.execute(
        select(Annotation, User)
        .join(Ion, Annotation.ion_id == Ion.id)
        .join(Dataset, Ion.dataset_id == Dataset.id)
        .join(User, Annotation.user_id == User.id)
        .where(Dataset.project_id == project_id)
    )
    rows = result.all()

    total_annotations = len(rows)
    user_map: dict[uuid.UUID, dict] = {}
    global_labels: dict[str, int] = {}
    annotated_ions: set[uuid.UUID] = set()

    for annotation, user in rows:
        annotated_ions.add(annotation.ion_id)
        if user.id not in user_map:
            user_map[user.id] = {
                "user_id": user.id,
                "display_name": user.display_name,
                "count": 0,
                "labels": {},
            }
        user_map[user.id]["count"] += 1
        label = annotation.label_name
        user_map[user.id]["labels"][label] = user_map[user.id]["labels"].get(label, 0) + 1
        global_labels[label] = global_labels.get(label, 0) + 1

    per_user = sorted(
        [
            UserStats(
                user_id=v["user_id"],
                display_name=v["display_name"],
                annotation_count=v["count"],
                label_breakdown=[
                    LabelCount(label_name=k, count=c) for k, c in sorted(v["labels"].items())
                ],
            )
            for v in user_map.values()
        ],
        key=lambda u: u.annotation_count,
        reverse=True,
    )

    return StatsOut(
        total_ions=total_ions,
        total_annotated_ions=len(annotated_ions),
        total_annotations=total_annotations,
        unique_annotators=len(user_map),
        label_distribution=[
            LabelCount(label_name=k, count=c) for k, c in sorted(global_labels.items())
        ],
        per_user=per_user,
    )


# ---------------------------------------------------------------------------
# Global stats — cross-project, all users
# ---------------------------------------------------------------------------

global_router = APIRouter(prefix="/api/stats", tags=["stats"])


@global_router.get("", response_model=GlobalStatsOut)
async def get_global_stats(
    current_user: CurrentUser,
    db: AsyncSession = Depends(get_db),
):
    """Aggregate stats across all projects and all users."""
    total_ions_result = await db.execute(select(func.count(Ion.id)))
    total_ions = total_ions_result.scalar() or 0

    rows = await db.execute(
        select(Annotation.label_name, func.count(Annotation.id), func.count(func.distinct(Annotation.user_id)))
        .group_by(Annotation.label_name)
    )
    label_rows = rows.all()

    label_distribution = [
        LabelCount(label_name=label, count=count)
        for label, count, _ in sorted(label_rows, key=lambda r: r[0])
    ]
    total_annotations = sum(r[1] for r in label_rows)

    annotator_result = await db.execute(
        select(func.count(func.distinct(Annotation.user_id)))
    )
    unique_annotators = annotator_result.scalar() or 0

    return GlobalStatsOut(
        total_ions=total_ions,
        total_annotations=total_annotations,
        unique_annotators=unique_annotators,
        label_distribution=label_distribution,
    )
