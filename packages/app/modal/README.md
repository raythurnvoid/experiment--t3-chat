# Modal File Converter

This directory contains the deployable Modal artifact for converting R2-hosted files into Markdown.

Local repository rules say not to install or run Python on this machine. Deploy this from a Python-enabled Modal environment or CI runner instead of bootstrapping Python inside this workspace.

## Runtime Contract

The PDF plugin's backend worker (`plugins/bonobo-plugin-pdf`) sends `POST /markitdown` with:

- `sourceUrl`: short-lived signed R2 download URL
- `filename`: original filename
- `contentType`: optional MIME type used as an additional conversion hint
- `maxBytes`: source download limit
- `maxMarkdownBytes`: response size guard for Convex storage

Modal returns:

- `markdown`
- `converter`
- `originalFilename`
- `contentType`
- `warnings`

`GET /health` returns a basic `{ "ok": true }` health response.

Conversion behavior:

- Uses MarkItDown with plugins disabled.
- Uses the sanitized filename, extension, and optional MIME type as conversion hints.
- The plugin may call this endpoint for uploaded source files without MIME allowlisting; a deterministic non-success response such as `413` or `422` fails that plugin run and leaves the upload as a stored file.
- Downloads from the signed R2 URL with a streamed request.
- Spools the source stream with an 8 MiB in-memory threshold before spilling to a temporary file.
- Enforces the source size through `maxBytes`; the PDF plugin currently passes 200 MiB. 50 MiB is only this service's default when the field is omitted.
- Enforces the Markdown response size through `maxMarkdownBytes`; the PDF plugin currently passes 900,000 bytes.

Error statuses:

- `401`: request authorization is missing or does not match the Modal secret.
- `413`: source file is too large or converted Markdown is too large.
- `422`: source download failed or MarkItDown could not convert the source.
- `502`: source fetch request failed before conversion.
- `500`: converter token is not configured.

## Configuration

Create a Modal Secret named `BONOBO_SENATE_PRESS` with:

- `BONOBO_SENATE_PRESS`

Set matching plugin-runner secrets (see `packages/plugin-runner/wrangler.jsonc`), which reach the PDF plugin as publisher secrets:

- `MODAL_FILE_CONVERTER_URL`: the deployed Modal `/markitdown` endpoint URL
- `MODAL_TOKEN`: the same token value as `BONOBO_SENATE_PRESS`

The plugin calls Modal with `Authorization: Bearer <MODAL_TOKEN>`. Modal compares that value against the `BONOBO_SENATE_PRESS` secret.

## Deploy

This repo uses a Docker-wrapped Modal CLI so Python is not installed on the Windows host.

```powershell
.\packages\app\scripts\modal-cli.ps1 token new
.\packages\app\scripts\modal-cli.ps1 secret create BONOBO_SENATE_PRESS BONOBO_SENATE_PRESS=replace-with-random-token
.\packages\app\scripts\modal-cli.ps1 deploy packages/app/modal/files_markitdown.py
```

Modal credentials are stored outside the repo at `%USERPROFILE%\.modal-cli\.modal.toml`.

## Tests

Run Modal converter unit tests through Docker:

```powershell
.\packages\app\scripts\modal-test.ps1
```

## Related Modal apps

The media audio extractor used by the video plugin lives in its own repository (plugins are self-contained): `plugins/bonobo-plugin-video/modal/media_audio_extractor.py`, with its own Docker-wrapped `scripts/modal-test.ps1` and `scripts/modal-cli.ps1`. It shares the `BONOBO_SENATE_PRESS` Modal secret and the `~/.modal-cli` auth config with this converter.
