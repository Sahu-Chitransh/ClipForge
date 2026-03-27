import asyncio
import contextlib
import json
import mimetypes
import os
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.background import BackgroundTask
from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError


BASE_DIR = Path(__file__).resolve().parent
DOWNLOADS_DIR = BASE_DIR / "downloads"
FRONTEND_DIR = BASE_DIR / "frontend"
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

JOB_TTL_SECONDS = int(os.getenv("JOB_TTL_SECONDS", "3600"))
CLEANUP_INTERVAL_SECONDS = int(os.getenv("CLEANUP_INTERVAL_SECONDS", "300"))
DELETE_AFTER_SERVED_SECONDS = int(os.getenv("DELETE_AFTER_SERVED_SECONDS", "300"))
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "*").split(",")
    if origin.strip()
]


class DownloadItem(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    url: str
    format: Literal["video", "audio", "mp4", "mp3"] = "video"
    quality: Optional[str] = None
    start_time: Optional[str] = Field(default=None, alias="startTime")
    end_time: Optional[str] = Field(default=None, alias="endTime")
    filename: Optional[str] = None
    audio_bitrate: Optional[str] = Field(default=None, alias="audioBitrate")
    trim_segment: Optional[bool] = Field(default=None, alias="trimSegment")

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("URL is required.")
        return value


class DownloadJobResponse(BaseModel):
    job_id: str
    status: str
    progress: float
    status_url: str
    download_url: Optional[str] = None
    error: Optional[str] = None


@dataclass
class JobRecord:
    job_id: str
    source_url: str
    requested_format: str
    quality: Optional[str]
    start_time: Optional[str]
    end_time: Optional[str]
    status: str = "pending"
    progress: float = 0.0
    download_url: Optional[str] = None
    file_path: Optional[str] = None
    file_name: Optional[str] = None
    mime_type: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    served_at: Optional[float] = None


app = FastAPI(title="Clipforge API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

jobs: Dict[str, JobRecord] = {}
jobs_lock = asyncio.Lock()

if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def now_ts() -> float:
    return time.time()


def build_status_payload(job: JobRecord) -> Dict[str, Any]:
    return {
        "job_id": job.job_id,
        "status": job.status,
        "progress": round(job.progress, 2),
        "download_url": job.download_url,
        "error": job.error,
        "file_name": job.file_name,
        "source_url": job.source_url,
        "format": job.requested_format,
        "quality": job.quality,
        "startTime": job.start_time,
        "endTime": job.end_time,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    }


def normalize_format(value: Optional[str]) -> str:
    normalized = (value or "video").strip().lower()
    if normalized in {"mp3", "audio"}:
        return "audio"
    return "video"


def parse_timestamp(value: Optional[str]) -> Optional[float]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    parts = str(value).strip().split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        total = 0.0
        for part in parts:
            total = total * 60 + float(part)
        return total
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid timestamp: {value}") from exc


def format_seconds(value: float) -> str:
    hours = int(value // 3600)
    minutes = int((value % 3600) // 60)
    seconds = value % 60
    return f"{hours:02d}:{minutes:02d}:{seconds:06.3f}"


def sanitize_filename(value: str) -> str:
    keep = {" ", ".", "-", "_", "(", ")"}
    return "".join(ch for ch in value if ch.isalnum() or ch in keep).strip() or "download"


def format_duration(seconds: Optional[int]) -> Optional[str]:
    if seconds is None:
        return None
    total = int(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def resolve_video_format(quality: Optional[str]) -> str:
    value = (quality or "").strip().lower()
    if "4k" in value or "2160" in value:
        return "bestvideo[height<=2160]+bestaudio/best[height<=2160]/best"
    if "1440" in value or "2k" in value:
        return "bestvideo[height<=1440]+bestaudio/best[height<=1440]/best"
    if "1080" in value:
        return "bestvideo[height<=1080]+bestaudio/best[height<=1080]/best"
    if "720" in value:
        return "bestvideo[height<=720]+bestaudio/best[height<=720]/best"
    if "480" in value:
        return "bestvideo[height<=480]+bestaudio/best[height<=480]/best"
    if "360" in value:
        return "bestvideo[height<=360]+bestaudio/best[height<=360]/best"
    return "bestvideo+bestaudio/best"


def resolve_audio_quality(item: DownloadItem) -> str:
    value = (item.audio_bitrate or item.quality or "192").strip().lower().replace("kbps", "")
    digits = "".join(ch for ch in value if ch.isdigit())
    return digits or "192"


def should_trim(item: DownloadItem) -> bool:
    if item.trim_segment is False:
        return False
    return bool(item.start_time or item.end_time)


def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is not installed or not available on PATH.")


def run_ffmpeg_trim(input_path: Path, output_path: Path, target_format: str, item: DownloadItem) -> None:
    ensure_ffmpeg()

    start_seconds = parse_timestamp(item.start_time)
    end_seconds = parse_timestamp(item.end_time)
    if start_seconds is None and end_seconds is None:
        return
    if start_seconds is not None and end_seconds is not None and end_seconds <= start_seconds:
        raise RuntimeError("endTime must be greater than startTime.")

    cmd = ["ffmpeg", "-y"]
    if start_seconds is not None:
        cmd.extend(["-ss", format_seconds(start_seconds)])
    cmd.extend(["-i", str(input_path)])
    if end_seconds is not None:
        cmd.extend(["-to", format_seconds(end_seconds)])

    if target_format == "audio":
        audio_bitrate = resolve_audio_quality(item)
        cmd.extend(["-vn", "-c:a", "libmp3lame", "-b:a", f"{audio_bitrate}k", str(output_path)])
    else:
        cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                str(output_path),
            ]
        )

    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "ffmpeg trimming failed.")


def convert_for_frontend(input_path: Path, item: DownloadItem) -> Path:
    target_format = normalize_format(item.format)
    desired_suffix = ".mp3" if target_format == "audio" else ".mp4"
    if input_path.suffix.lower() == desired_suffix and not should_trim(item):
        return input_path

    converted_path = input_path.with_name(f"{input_path.stem}_final{desired_suffix}")
    if should_trim(item):
        run_ffmpeg_trim(input_path, converted_path, target_format, item)
    elif target_format == "audio":
        ensure_ffmpeg()
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-c:a",
            "libmp3lame",
            "-b:a",
            f"{resolve_audio_quality(item)}k",
            str(converted_path),
        ]
        completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or "Audio conversion failed.")
    else:
        ensure_ffmpeg()
        cmd = [
            "ffmpeg",
            "-y",
            "-i",
            str(input_path),
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            str(converted_path),
        ]
        completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or "Video conversion failed.")

    with contextlib.suppress(FileNotFoundError):
        if input_path != converted_path:
            input_path.unlink()
    return converted_path


async def update_job(job_id: str, **changes: Any) -> None:
    async with jobs_lock:
        job = jobs[job_id]
        for key, value in changes.items():
            setattr(job, key, value)
        job.updated_at = now_ts()


def build_progress_hook(job_id: str):
    def hook(data: Dict[str, Any]) -> None:
        status = data.get("status")
        downloaded = data.get("downloaded_bytes") or 0
        total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
        loop = getattr(app.state, "main_loop", None)
        if loop is None:
            return

        if status == "downloading" and total:
            progress = max(0.0, min(99.0, downloaded / total * 100))
            asyncio.run_coroutine_threadsafe(
                update_job(job_id, status="processing", progress=progress),
                loop,
            )
        elif status == "finished":
            asyncio.run_coroutine_threadsafe(
                update_job(job_id, status="processing", progress=99.0),
                loop,
            )

    return hook


def normalize_items(payload: Dict[str, Any]) -> List[DownloadItem]:
    if "items" in payload and isinstance(payload["items"], list):
        return [DownloadItem.model_validate(item) for item in payload["items"]]

    if "downloads" in payload and isinstance(payload["downloads"], list):
        return [DownloadItem.model_validate(item) for item in payload["downloads"]]

    if "urls" in payload and isinstance(payload["urls"], list):
        items: List[DownloadItem] = []
        shared = {k: v for k, v in payload.items() if k not in {"urls", "items", "downloads"}}
        for url in payload["urls"]:
            item_payload = dict(shared)
            if isinstance(url, dict):
                item_payload.update(url)
            else:
                item_payload["url"] = url
            items.append(DownloadItem.model_validate(item_payload))
        return items

    if "url" in payload:
        return [DownloadItem.model_validate(payload)]

    raise HTTPException(
        status_code=400,
        detail="Payload must include `url`, `urls`, `items`, or `downloads`.",
    )


def extract_metadata(url: str) -> Dict[str, Any]:
    ydl_opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,
        "skip_download": True,
    }
    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info.get("entries"):
            info = next((entry for entry in info["entries"] if entry), info)

        formats = info.get("formats") or []
        video_heights = sorted(
            {
                int(fmt["height"])
                for fmt in formats
                if fmt.get("vcodec") not in (None, "none")
                and fmt.get("height")
            },
            reverse=True,
        )
        max_height = video_heights[0] if video_heights else None

        return {
            "url": info.get("webpage_url") or url,
            "title": info.get("title") or url,
            "duration": info.get("duration"),
            "duration_text": format_duration(info.get("duration")),
            "channel": info.get("channel") or info.get("uploader") or info.get("creator"),
            "uploader": info.get("uploader") or info.get("channel"),
            "thumbnail": info.get("thumbnail"),
            "description": info.get("description"),
            "view_count": info.get("view_count"),
            "upload_date": info.get("upload_date"),
            "extractor": info.get("extractor_key") or info.get("extractor"),
            "available_video_heights": video_heights,
            "max_video_height": max_height,
            "supports_4k": bool(max_height and max_height >= 2160),
            "supports_1440p": bool(max_height and max_height >= 1440),
            "supports_1080p": bool(max_height and max_height >= 1080),
            "supports_720p": bool(max_height and max_height >= 720),
            "supports_480p": bool(max_height and max_height >= 480),
        }


def extract_playlist_metadata(url: str) -> Dict[str, Any]:
    ydl_opts: Dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,
        "skip_download": True,
        "extract_flat": False,
    }
    with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        entries = []
        playlist_title = info.get("title") or "Playlist"
        playlist_url = info.get("webpage_url") or url

        for entry in info.get("entries") or []:
            if not entry:
                continue
            entry_url = entry.get("webpage_url") or entry.get("url")
            if entry_url and not str(entry_url).startswith("http"):
                entry_url = f"https://www.youtube.com/watch?v={entry_url}"
            entries.append(
                {
                    "url": entry_url or url,
                    "title": entry.get("title") or entry_url or "Untitled video",
                    "duration": entry.get("duration"),
                    "duration_text": format_duration(entry.get("duration")),
                    "channel": entry.get("channel") or entry.get("uploader") or entry.get("creator"),
                    "uploader": entry.get("uploader") or entry.get("channel"),
                    "thumbnail": entry.get("thumbnail"),
                    "description": entry.get("description"),
                    "view_count": entry.get("view_count"),
                    "upload_date": entry.get("upload_date"),
                    "extractor": entry.get("extractor_key") or entry.get("extractor"),
                }
            )

        return {
            "title": playlist_title,
            "url": playlist_url,
            "item_count": len(entries),
            "entries": entries,
        }


def cleanup_auxiliary_files(job_dir: Path, keep_path: Path) -> None:
    for path in job_dir.iterdir():
        if path.is_file() and path != keep_path:
            with contextlib.suppress(FileNotFoundError):
                path.unlink()


def make_output_template(job_id: str) -> str:
    return str(DOWNLOADS_DIR / job_id / "%(title).120s.%(ext)s")


async def process_download(job_id: str, item: DownloadItem) -> None:
    job_dir = DOWNLOADS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    target_format = normalize_format(item.format)
    ydl_opts: Dict[str, Any] = {
        "outtmpl": make_output_template(job_id),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [build_progress_hook(job_id)],
    }

    if target_format == "audio":
        ydl_opts.update(
            {
                "format": "bestaudio/best",
                "writethumbnail": True,
                "postprocessors": [
                    {
                        "key": "FFmpegExtractAudio",
                        "preferredcodec": "mp3",
                        "preferredquality": resolve_audio_quality(item),
                    },
                    {
                        "key": "FFmpegThumbnailsConvertor",
                        "format": "jpg",
                    },
                    {
                        "key": "EmbedThumbnail",
                    }
                ],
            }
        )
    else:
        ydl_opts.update(
            {
                "format": resolve_video_format(item.quality),
                "merge_output_format": "mp4",
            }
        )

    try:
        await update_job(job_id, status="processing", progress=1.0)

        def blocking_download() -> Path:
            with YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(item.url, download=True)
                if "entries" in info and info["entries"]:
                    info = info["entries"][0]
                downloaded_path = Path(ydl.prepare_filename(info))
                if target_format == "audio":
                    downloaded_path = downloaded_path.with_suffix(".mp3")

                final_path = convert_for_frontend(downloaded_path, item)
                cleanup_auxiliary_files(job_dir, final_path)
                return final_path

        final_path = await asyncio.to_thread(blocking_download)
        filename = item.filename or sanitize_filename(final_path.name)
        mime_type, _ = mimetypes.guess_type(filename)
        if not mime_type:
            mime_type = "audio/mpeg" if target_format == "audio" else "video/mp4"

        await update_job(
            job_id,
            status="completed",
            progress=100.0,
            file_path=str(final_path),
            file_name=filename,
            mime_type=mime_type,
            download_url=f"/api/files/{job_id}",
        )
    except DownloadError as exc:
        await update_job(job_id, status="failed", error=str(exc), progress=0.0)
    except Exception as exc:
        await update_job(job_id, status="failed", error=str(exc), progress=0.0)


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        stale_job_ids: List[str] = []
        async with jobs_lock:
            snapshot = list(jobs.items())

        current = now_ts()
        for job_id, job in snapshot:
            expired = current - job.created_at > JOB_TTL_SECONDS
            served_and_expired = job.served_at is not None and current - job.served_at > DELETE_AFTER_SERVED_SECONDS
            if expired or served_and_expired:
                if job.file_path:
                    with contextlib.suppress(FileNotFoundError):
                        Path(job.file_path).unlink()
                with contextlib.suppress(OSError):
                    shutil.rmtree(DOWNLOADS_DIR / job_id, ignore_errors=True)
                stale_job_ids.append(job_id)

        if stale_job_ids:
            async with jobs_lock:
                for job_id in stale_job_ids:
                    jobs.pop(job_id, None)


@app.on_event("startup")
async def startup_event() -> None:
    app.state.main_loop = asyncio.get_running_loop()
    app.state.cleanup_task = asyncio.create_task(cleanup_loop())


@app.on_event("shutdown")
async def shutdown_event() -> None:
    task = getattr(app.state, "cleanup_task", None)
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/")
async def serve_frontend() -> FileResponse:
    index_path = FRONTEND_DIR / "index.html"
    if not index_path.exists():
        raise HTTPException(status_code=404, detail="Frontend not found.")
    return FileResponse(index_path)


@app.get("/logo.png")
async def serve_logo() -> FileResponse:
    logo_path = BASE_DIR / "logo.png"
    if not logo_path.exists():
        raise HTTPException(status_code=404, detail="Logo not found.")
    return FileResponse(logo_path, media_type="image/png")


@app.post("/api/download")
async def create_download(request: Request) -> JSONResponse:
    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.") from exc

    items = normalize_items(payload)
    created_jobs: List[DownloadJobResponse] = []

    async with jobs_lock:
        for item in items:
            job_id = str(uuid.uuid4())
            jobs[job_id] = JobRecord(
                job_id=job_id,
                source_url=item.url,
                requested_format=normalize_format(item.format),
                quality=item.quality or item.audio_bitrate,
                start_time=item.start_time,
                end_time=item.end_time,
            )
            created_jobs.append(
                DownloadJobResponse(
                    job_id=job_id,
                    status="pending",
                    progress=0,
                    status_url=f"/api/status/{job_id}",
                )
            )
            asyncio.create_task(process_download(job_id, item))

    response = {
        "success": True,
        "jobs": [job.model_dump() for job in created_jobs],
    }
    if len(created_jobs) == 1:
        response.update(created_jobs[0].model_dump())

    return JSONResponse(status_code=202, content=response)


@app.post("/api/metadata")
async def get_metadata(request: Request) -> Dict[str, Any]:
    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.") from exc

    if isinstance(payload, dict):
        urls = payload.get("urls")
        if isinstance(urls, list):
            items = []
            for url in urls:
                if not isinstance(url, str) or not url.strip():
                    continue
                items.append(extract_metadata(url.strip()))
            return {"success": True, "items": items}

        url = payload.get("url")
        if isinstance(url, str) and url.strip():
            return {"success": True, "item": extract_metadata(url.strip())}

    raise HTTPException(status_code=400, detail="Payload must include `url` or `urls`.")


@app.post("/api/playlist")
async def get_playlist(request: Request) -> Dict[str, Any]:
    try:
        payload = await request.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.") from exc

    url = payload.get("url") if isinstance(payload, dict) else None
    if not isinstance(url, str) or not url.strip():
        raise HTTPException(status_code=400, detail="Payload must include `url`.")

    return {"success": True, "playlist": extract_playlist_metadata(url.strip())}


@app.get("/api/status/{job_id}")
async def get_status(job_id: str) -> Dict[str, Any]:
    async with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found.")
        return build_status_payload(job)


@app.get("/api/files/{job_id}")
async def download_file(job_id: str) -> FileResponse:
    async with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Job not found.")
        if job.status != "completed" or not job.file_path:
            raise HTTPException(status_code=409, detail="File is not ready yet.")

        file_path = Path(job.file_path)
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="Generated file is no longer available.")

        filename = job.file_name or file_path.name
        media_type = job.mime_type or "application/octet-stream"

    return FileResponse(
        path=file_path,
        filename=filename,
        media_type=media_type,
        background=BackgroundTask(lambda: asyncio.run(update_job(job_id, served_at=now_ts()))),
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": exc.detail},
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"success": False, "error": str(exc) or "Internal server error."},
    )
