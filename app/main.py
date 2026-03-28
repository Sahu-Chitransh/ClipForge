from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.legacy import (
    legacy_router,
    register_exception_handlers,
    shutdown_legacy_runtime,
    startup_legacy_runtime,
)
from app.core.config import get_settings

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
LOGO_PATH = ROOT_DIR / "logo.png"


@asynccontextmanager
async def lifespan(_: FastAPI):
    await startup_legacy_runtime()
    try:
        yield
    finally:
        await shutdown_legacy_runtime()


def create_app() -> FastAPI:
    settings = get_settings()
    allow_origins = settings.allowed_origins or ["*"]

    app = FastAPI(
        title=settings.app_name,
        version="1.0.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_credentials="*" not in allow_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    app.include_router(legacy_router)

    if settings.is_development and FRONTEND_DIR.exists():
        app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

        @app.get("/", include_in_schema=False)
        async def serve_frontend() -> FileResponse:
            index_path = FRONTEND_DIR / "index.html"
            if not index_path.exists():
                raise HTTPException(status_code=404, detail="Frontend not found.")
            return FileResponse(index_path)

        @app.get("/logo.png", include_in_schema=False)
        async def serve_logo() -> FileResponse:
            if not LOGO_PATH.exists():
                raise HTTPException(status_code=404, detail="Logo not found.")
            return FileResponse(LOGO_PATH, media_type="image/png")

    return app


app = create_app()
