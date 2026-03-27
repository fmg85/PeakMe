import uuid
from datetime import datetime

from pydantic import BaseModel


class LabelOptionCreate(BaseModel):
    name: str
    color: str | None = None
    keyboard_shortcut: str | None = None
    sort_order: int = 0


class LabelOptionUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    keyboard_shortcut: str | None = None
    sort_order: int | None = None


class LabelOptionOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    color: str | None
    keyboard_shortcut: str | None
    sort_order: int
    created_at: datetime

    model_config = {"from_attributes": True}
