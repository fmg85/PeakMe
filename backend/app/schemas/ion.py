import uuid
from datetime import datetime

from pydantic import BaseModel


class IonOut(BaseModel):
    id: uuid.UUID
    dataset_id: uuid.UUID
    mz_value: float
    sort_order: int
    created_at: datetime

    model_config = {"from_attributes": True}


class IonQueueItem(BaseModel):
    id: uuid.UUID
    mz_value: float
    sort_order: int
    image_url: str          # presigned S3 URL
    tic_image_url: str | None = None
    is_starred: bool = False
    annotation: "AnnotationSummary | None" = None

    model_config = {"from_attributes": False}


class AnnotationSummary(BaseModel):
    label_option_id: uuid.UUID | None
    label_name: str
    confidence: int | None

    model_config = {"from_attributes": True}


IonQueueItem.model_rebuild()
