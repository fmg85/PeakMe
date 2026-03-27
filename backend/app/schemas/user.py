import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr


class UserSyncRequest(BaseModel):
    display_name: str


class UserOut(BaseModel):
    id: uuid.UUID
    display_name: str
    email: str
    is_admin: bool
    created_at: datetime

    model_config = {"from_attributes": True}
