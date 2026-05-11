import hmac
import os
import re
import tempfile
from pathlib import Path

import modal

app = modal.App("files-markitdown")

image = modal.Image.debian_slim(python_version="3.12").uv_pip_install(
    "fastapi",
    "markitdown[all]",
    "requests",
)


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("BONOBO_SENATE_PRESS")],
    timeout=15 * 60,
)
@modal.asgi_app()
def files_markitdown_asgi():
    import requests
    from fastapi import FastAPI, Header, HTTPException
    from markitdown import MarkItDown
    from pydantic import BaseModel, Field

    web_app = FastAPI()
    converter = MarkItDown(enable_plugins=False)

    class ConvertRequest(BaseModel):
        sourceUrl: str = Field(min_length=1)
        filename: str = Field(min_length=1, max_length=255)
        contentType: str | None = Field(default=None, max_length=255)
        maxBytes: int = Field(default=50 * 1024 * 1024, ge=1, le=200 * 1024 * 1024)
        maxMarkdownCharacters: int = Field(default=900_000, ge=1, le=950_000)

    class ConvertResponse(BaseModel):
        markdown: str
        converter: str
        originalFilename: str
        contentType: str | None
        warnings: list[str]

    def files_markitdown_authorize_request(authorization: str | None):
        expected_token = os.environ.get("BONOBO_SENATE_PRESS")
        if not expected_token:
            raise HTTPException(status_code=500, detail="Converter token is not configured")

        expected_header = f"Bearer {expected_token}"
        if not authorization or not hmac.compare_digest(authorization, expected_header):
            raise HTTPException(status_code=401, detail="Unauthorized")

    def files_markitdown_safe_filename(filename: str):
        name = Path(filename.replace("\\", "/")).name.strip()
        name = re.sub(r"[^A-Za-z0-9._ -]", "-", name)
        name = re.sub(r"\s+", " ", name).strip()
        return name[:160] or "upload"

    def files_markitdown_download_source(request: ConvertRequest, path: Path):
        bytes_written = 0
        try:
            with requests.get(request.sourceUrl, stream=True, timeout=(10, 120)) as response:
                response.raise_for_status()
                with path.open("wb") as file:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if not chunk:
                            continue

                        bytes_written += len(chunk)
                        if bytes_written > request.maxBytes:
                            raise HTTPException(status_code=413, detail="Source file is too large")

                        file.write(chunk)
        except requests.HTTPError as error:
            raise HTTPException(status_code=422, detail="Failed to download source file") from error
        except requests.RequestException as error:
            raise HTTPException(status_code=502, detail="Failed to fetch source file") from error

    @web_app.get("/health")
    def files_markitdown_health():
        return {"ok": True}

    @web_app.post("/markitdown", response_model=ConvertResponse)
    def files_markitdown_convert(request: ConvertRequest, authorization: str | None = Header(default=None)):
        files_markitdown_authorize_request(authorization)

        with tempfile.TemporaryDirectory() as temp_dir:
            local_path = Path(temp_dir) / files_markitdown_safe_filename(request.filename)
            files_markitdown_download_source(request, local_path)

            try:
                result = converter.convert_local(str(local_path))
            except Exception as error:
                raise HTTPException(status_code=422, detail="Failed to convert source file") from error

        markdown = result.text_content
        if len(markdown) > request.maxMarkdownCharacters:
            raise HTTPException(status_code=413, detail="Converted markdown is too large")

        return ConvertResponse(
            markdown=markdown,
            converter="markitdown",
            originalFilename=request.filename,
            contentType=request.contentType,
            warnings=[],
        )

    return web_app
