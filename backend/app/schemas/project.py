import uuid
from datetime import datetime

from pydantic import BaseModel

from app.schemas.label import LabelOptionOut


class ProjectCreate(BaseModel):
    name: str
    description: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None


class ProjectOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    created_by: uuid.UUID
    created_at: datetime
    label_options: list[LabelOptionOut] = []

    model_config = {"from_attributes": True}
