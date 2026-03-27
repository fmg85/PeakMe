import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class AnnotateRequest(BaseModel):
    label_option_id: uuid.UUID
    confidence: int | None = Field(default=None, ge=1, le=3)
    time_spent_ms: int | None = None


class AnnotationOut(BaseModel):
    id: uuid.UUID
    ion_id: uuid.UUID
    user_id: uuid.UUID
    label_option_id: uuid.UUID | None
    label_name: str
    confidence: int | None
    time_spent_ms: int | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class LabelCount(BaseModel):
    label_name: str
    count: int


class UserStats(BaseModel):
    user_id: uuid.UUID
    display_name: str
    annotation_count: int
    label_breakdown: list[LabelCount]


class StatsOut(BaseModel):
    total_ions: int
    total_annotations: int
    unique_annotators: int
    per_user: list[UserStats]
