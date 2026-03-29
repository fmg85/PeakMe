import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class Ion(Base):
    __tablename__ = "ions"
    __table_args__ = (
        Index("ix_ions_dataset_sort", "dataset_id", "sort_order"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    dataset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False
    )
    mz_value: Mapped[float] = mapped_column(Float, nullable=False)
    image_key: Mapped[str] = mapped_column(String(500), nullable=False)  # S3 object key
    tic_image_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    dataset = relationship("Dataset", back_populates="ions")
    annotations = relationship("Annotation", back_populates="ion", cascade="all, delete-orphan")
    stars = relationship("IonStar", back_populates="ion", cascade="all, delete-orphan")
