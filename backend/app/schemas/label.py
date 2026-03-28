import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

SwipeDirection = Literal["left", "right", "up", "down"] | None


class LabelOptionCreate(BaseModel):
    name: str
    color: str | None = None
    keyboard_shortcut: str | None = None
    swipe_direction: SwipeDirection = None
    sort_order: int = 0


class LabelOptionUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    keyboard_shortcut: str | None = None
    swipe_direction: SwipeDirection = None
    sort_order: int | None = None


class LabelOptionOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    color: str | None
    keyboard_shortcut: str | None
    swipe_direction: str | None
    sort_order: int
    created_at: datetime

    model_config = {"from_attributes": True}
