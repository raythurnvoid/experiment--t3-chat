# Modal File Converter

This directory contains the deployable Modal artifact for converting R2-hosted files into Markdown.

Local repository rules say not to install or run Python on this machine. Deploy this from a Python-enabled Modal environment or CI runner instead of bootstrapping Python inside this workspace.

## Runtime Contract

Convex sends:

- `sourceUrl`: short-lived signed R2 download URL
- `filename`: original filename
- `contentType`: optional MIME type used as an additional conversion hint
- `maxBytes`: source download limit
- `maxMarkdownCharacters`: response size guard for Convex storage

Modal returns:

- `markdown`
- `converter`
- `originalFilename`
- `contentType`
- `warnings`

## Configuration

Create a Modal Secret named `BONOBO_SENATE_PRESS` with:

- `BONOBO_SENATE_PRESS`

Set matching Convex environment variables:

- `MODAL_FILE_CONVERTER_URL`: the deployed Modal `/markitdown` endpoint URL
- `MODAL_TOKEN`: the same token value as `BONOBO_SENATE_PRESS`

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
