# Clipforge

Clipforge is a FastAPI + yt-dlp based YouTube media downloader SPA.

## Features

- Single video and playlist queues
- Video and audio downloads
- Metadata fetch for title, duration, thumbnail, and quality support
- Playlist bulk presets for format and quality/bitrate
- Live backend health indicator
- List and card queue views
- Audio downloads with embedded thumbnail artwork
- Floating help panel with quick FAQs

## Requirements

- Python 3.11+
- `ffmpeg` installed and available on `PATH`

## Setup

1. Create a virtual environment.
   ```powershell
   py -3.11 -m venv .venv
   ```

2. Activate it.
   ```powershell
   .\.venv\Scripts\Activate.ps1
   ```

3. Install dependencies.
   ```powershell
   python -m pip install --upgrade pip
   pip install -r requirements.txt
   ```

4. Install ffmpeg.
   - Windows with winget:
     ```powershell
     winget install Gyan.FFmpeg
     ```
   - Or with Chocolatey:
     ```powershell
     choco install ffmpeg
     ```

5. Run the server.
   ```powershell
   uvicorn main:app --reload --host 127.0.0.1 --port 8000
   ```

6. Open the app.
   - [http://127.0.0.1:8000](http://127.0.0.1:8000)

## API

- `POST /api/download`
- `POST /api/metadata`
- `POST /api/playlist`
- `GET /api/status/{job_id}`
- `GET /api/files/{job_id}`
- `GET /health`

## Notes

- Local backend mode uses `http://127.0.0.1:8000`.
- Audio files are saved as MP3 with embedded thumbnail artwork.
