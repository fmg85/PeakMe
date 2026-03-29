import uuid
from datetime import datetime

from pydantic import BaseModel


class DatasetOut(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    description: str | None
    sample_type: str | None
    total_ions: int
    my_annotation_count: int = 0
    status: str
    error_msg: str | None
    created_at: datetime
    fluorescence_url: str | None = None
    fluorescence_outline_url: str | None = None

    model_config = {"from_attributes": True}
