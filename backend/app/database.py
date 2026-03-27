from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool

from app.config import settings

# NullPool is required for Supabase transaction pooler (port 6543):
# the pooler manages connections itself; SQLAlchemy-side pooling is redundant
# and incompatible with transaction-level pooling semantics.
engine = create_async_engine(
    settings.database_url,
    echo=settings.environment == "development",
    poolclass=NullPool,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session
