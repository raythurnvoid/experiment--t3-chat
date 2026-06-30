from dataclasses import dataclass
from types import SimpleNamespace

from fastapi.testclient import TestClient

from files_markitdown import files_markitdown_create_app


class FakeHTTPError(Exception):
    pass


class FakeRequestException(Exception):
    pass


class FakeResponse:
    def __init__(self, chunks, http_error=False):
        self.chunks = chunks
        self.http_error = http_error

    def __enter__(self):
        return self

    def __exit__(self, _exception_type, _exception, _traceback):
        return False

    def raise_for_status(self):
        if self.http_error:
            raise FakeHTTPError("download failed")

    def iter_content(self, chunk_size):
        for chunk in self.chunks:
            yield chunk


class FakeRequests:
    HTTPError = FakeHTTPError
    RequestException = FakeRequestException

    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, source_url, stream, timeout):
        self.calls.append(
            {
                "source_url": source_url,
                "stream": stream,
                "timeout": timeout,
            }
        )
        return self.response


class FakeConverter:
    def __init__(self, markdown="# Converted"):
        self.markdown = markdown
        self.calls = []

    def convert_stream(self, source_file, stream_info):
        self.calls.append(
            {
                "content": source_file.read(),
                "seekable": source_file.seekable(),
                "stream_info": stream_info,
            }
        )
        return SimpleNamespace(text_content=self.markdown)


class FailingConverter:
    def convert_stream(self, _source_file, _stream_info):
        raise RuntimeError("conversion failed")


@dataclass(frozen=True)
class FakeStreamInfo:
    filename: str | None = None
    extension: str | None = None
    mimetype: str | None = None


def test_health_returns_ok():
    client = TestClient(
        files_markitdown_create_app(
            requests_module=FakeRequests(FakeResponse([])),
            converter=FakeConverter(),
            stream_info_class=FakeStreamInfo,
        )
    )

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_convert_stream_uses_filename_extension_and_content_type_hints(monkeypatch):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    fake_requests = FakeRequests(FakeResponse([b"hello", b" ", b"world"]))
    converter = FakeConverter(markdown="# Converted\n\nHello world")
    client = TestClient(
        files_markitdown_create_app(
            requests_module=fake_requests,
            converter=converter,
            stream_info_class=FakeStreamInfo,
        )
    )

    response = client.post(
        "/markitdown",
        headers={"Authorization": "Bearer secret"},
        json={
            "sourceUrl": "https://r2.test/workspaces/ws/projects/pr/nodes/node/source",
            "filename": "folder\\Annual Report.pdf",
            "contentType": " application/pdf ",
            "maxBytes": 100,
            "maxMarkdownBytes": 1000,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "markdown": "# Converted\n\nHello world",
        "converter": "markitdown",
        "originalFilename": "folder\\Annual Report.pdf",
        "contentType": " application/pdf ",
        "warnings": [],
    }
    assert fake_requests.calls == [
        {
            "source_url": "https://r2.test/workspaces/ws/projects/pr/nodes/node/source",
            "stream": True,
            "timeout": (10, 120),
        }
    ]
    assert converter.calls == [
        {
            "content": b"hello world",
            "seekable": True,
            "stream_info": FakeStreamInfo(
                filename="Annual Report.pdf",
                extension=".pdf",
                mimetype="application/pdf",
            ),
        }
    ]


def test_unauthorized_request_does_not_download(monkeypatch):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    fake_requests = FakeRequests(FakeResponse([b"hello"]))
    converter = FakeConverter()
    client = TestClient(
        files_markitdown_create_app(
            requests_module=fake_requests,
            converter=converter,
            stream_info_class=FakeStreamInfo,
        )
    )

    response = client.post(
        "/markitdown",
        json={
            "sourceUrl": "https://r2.test/source",
            "filename": "file.pdf",
        },
    )

    assert response.status_code == 401
    assert fake_requests.calls == []
    assert converter.calls == []


def test_source_byte_limit_stops_before_conversion(monkeypatch):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    fake_requests = FakeRequests(FakeResponse([b"too large"]))
    converter = FakeConverter()
    client = TestClient(
        files_markitdown_create_app(
            requests_module=fake_requests,
            converter=converter,
            stream_info_class=FakeStreamInfo,
        )
    )

    response = client.post(
        "/markitdown",
        headers={"Authorization": "Bearer secret"},
        json={
            "sourceUrl": "https://r2.test/source",
            "filename": "file.pdf",
            "maxBytes": 4,
        },
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Source file is too large"}
    assert converter.calls == []


def test_markdown_byte_limit_uses_utf8_size(monkeypatch):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    client = TestClient(
        files_markitdown_create_app(
            requests_module=FakeRequests(FakeResponse([b"hello"])),
            converter=FakeConverter(markdown="ééé"),
            stream_info_class=FakeStreamInfo,
        )
    )

    response = client.post(
        "/markitdown",
        headers={"Authorization": "Bearer secret"},
        json={
            "sourceUrl": "https://r2.test/source",
            "filename": "file.pdf",
            "maxMarkdownBytes": 5,
        },
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Converted markdown is too large"}


def test_converter_failure_returns_unprocessable_entity(monkeypatch):
    monkeypatch.setenv("BONOBO_SENATE_PRESS", "secret")
    client = TestClient(
        files_markitdown_create_app(
            requests_module=FakeRequests(FakeResponse([b"hello"])),
            converter=FailingConverter(),
            stream_info_class=FakeStreamInfo,
        )
    )

    response = client.post(
        "/markitdown",
        headers={"Authorization": "Bearer secret"},
        json={
            "sourceUrl": "https://r2.test/source",
            "filename": "file.pdf",
        },
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Failed to convert source file"}
