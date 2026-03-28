from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Integer, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.database import Base

if TYPE_CHECKING:
    from app.models.job import DownloadJob


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    tier: Mapped[str] = mapped_column(String(32), nullable=False, default="free", server_default="free")
    usage_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    download_jobs: Mapped[list["DownloadJob"]] = relationship(back_populates="user")
