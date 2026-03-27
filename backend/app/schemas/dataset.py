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
    status: str
    error_msg: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
