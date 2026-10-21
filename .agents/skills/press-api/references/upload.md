# Upload from a terminal

Upload files with plain HTTP calls: `curl` in bash, `Invoke-RestMethod` in PowerShell. You need no script. The examples use `jq` in bash and PowerShell 7 on Windows. Use whatever JSON tool your system has.

The steps:

1. Load the key into a variable.
2. Make every name valid.
3. Send text files with `write-many`. Send other files with `upload-urls`, then a PUT.
4. List the folder and check that every file is `ready`.

Each saved or uploaded file costs at least 1 cent. A batch with no credits left answers 402.

## 1. Load the key

The `login` command in [setup](references/setup.md) saves the key and API origin in `~/.config/bonobo-senate/credentials.json` as `{ "origin": "...", "key": "..." }`. Read them into variables inside the same command that uses them. Never print the key. Each shell call starts fresh, so load them again in every call. If `T3_API_KEY` and `T3_API_ORIGIN` are set, use those instead.

```bash
ORIGIN=$(jq -r .origin ~/.config/bonobo-senate/credentials.json)
KEY=$(jq -r .key ~/.config/bonobo-senate/credentials.json)
```

```powershell
$c = Get-Content "$HOME/.config/bonobo-senate/credentials.json" -Raw | ConvertFrom-Json
$h = @{ Authorization = "Bearer $($c.key)" }
```

## 2. Make every name valid

The API never renames a file. It refuses a path whose names are not already clean, with 400 and the refused `path`. The message names the bad name, says the rule, and gives the clean name to send, for example `File name "My Photo.PNG" is not allowed. ... Try "my-photo.png".`

A valid file or folder name uses only lowercase `a-z`, digits, and single `-`, `_`, or `.` between them. It cannot start or end with `-`, `_`, or `.`. Examples: `_notes.md` becomes `notes.md`, and `My CV (2).pdf` becomes `my-cv-2.pdf`. `README.md`, `AGENTS.md`, `SKILL.md`, and the `.agents` folder keep their usual spelling.

Clean each name before you send it. Clean the part before the extension, then add the extension back in lowercase:

```bash
f="My CV (2).pdf"
base=$(printf '%s' "${f%.*}" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9._-]+/-/g; s/[._-]{2,}/-/g; s/^[._-]+|[._-]+$//g')
name="$base.$(printf '%s' "${f##*.}" | tr 'A-Z' 'a-z')"
```

```powershell
$name = ($f.BaseName.ToLower() -replace '[^a-z0-9._-]+', '-' -replace '[._-]{2,}', '-').Trim('-', '_', '.') + $f.Extension.ToLower()
```

Two local files can clean to the same name. Check for that before you send them, or the second one replaces the first.

## 3a. Text files: `write-many`

Use this for editable text: `.md`, `.txt`, `.json`, `.yaml`, `.csv`, and similar. The request carries the content, so there is no second step, and the file is ready at once. Send up to 20 files and 8 MB per request. Missing folders are created. An existing file is replaced unless you send `"overwrite": "fail"`.

Body: `{ "files": [{ "path": "/notes/a.md", "content": "# A\n" }] }`. Answer: `{ "written": [{ path, nodeId, contentType }], "errors": [{ path, message, errorCode }] }`. Check `errors` even on HTTP 200. An empty file is refused; use `files/touch` for it. Text is saved with LF line ends, so a file with Windows CRLF line ends reads back with LF.

```bash
jq -n --rawfile c notes/a.md '{files: [{path: "/notes/a.md", content: $c}]}' |
  curl -sS --fail-with-body -X POST "$ORIGIN/api/v1/files/write-many" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" --data-binary @-
```

A whole folder in batches of 20, in PowerShell:

```powershell
$files = @(Get-ChildItem ./notes -File)
for ($i = 0; $i -lt $files.Count; $i += 20) {
  $batch = @($files[$i..([Math]::Min($i + 19, $files.Count - 1))] | ForEach-Object {
    # Clean the name as in step 2.
    $name = ($_.BaseName.ToLower() -replace '[^a-z0-9._-]+', '-' -replace '[._-]{2,}', '-').Trim('-', '_', '.') + $_.Extension.ToLower()
    @{ path = "/notes/$name"; content = Get-Content $_.FullName -Raw -Encoding UTF8 }
  })
  $json = @{ files = $batch } | ConvertTo-Json -Depth 5
  while ($true) {
    try {
      $r = Invoke-RestMethod -Method Post -Uri "$($c.origin)/api/v1/files/write-many" -Headers $h `
        -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($json))
      break
    } catch {
      # On 429, wait as long as the server asks, then send the same batch again.
      if ($_.Exception.Response.StatusCode -ne 429) { throw }
      $wait = ($_.ErrorDetails.Message | ConvertFrom-Json).retryAfterMs
      Start-Sleep -Milliseconds ([Math]::Max(1000, [int]$wait))
    }
  }
  "$($r.written.Count) written"; $r.errors
}
```

PowerShell gotchas:

- Wrap a list in `@(...)`. Otherwise a batch of one file becomes a single object, not a list, and the API refuses the body.
- Send the body as UTF-8 bytes, and read files with `-Encoding UTF8`. Otherwise letters such as `é` can arrive broken.
- `Invoke-RestMethod` throws on 4xx and 5xx. The JSON error is in `$_.ErrorDetails.Message`.

## 3b. Other files: `upload-urls`, then PUT

Use this for images, PDFs, videos, archives, and any other file. Ask for up to 20 signed upload URLs, then PUT each file's bytes to its URL.

Body: `{ "files": [{ "path": "/photos/a.png", "contentType": "image/png", "size": 1234 }] }`. `size` is the exact byte count. Answer: `{ "files": [{ path, nodeId, uploadUrl, headers }] }`, in the same order. Send the PUT with exactly the returned `headers` (`Content-Type` and `If-None-Match: *`). Do not send the API key to the upload URL, and do not print or keep the URL.

Common types: `.png` `image/png`, `.jpg` `image/jpeg`, `.pdf` `application/pdf`, `.mp4` `video/mp4`, `.zip` `application/zip`. Use `application/octet-stream` when you do not know the type. A text file sent this way still becomes an editable document, unless you send `"skipProcessing": true`.

```bash
SIZE=$(wc -c < a.png)
TARGET=$(jq -n --argjson s "$SIZE" '{files: [{path: "/photos/a.png", contentType: "image/png", size: $s}]}' |
  curl -sS --fail-with-body -X POST "$ORIGIN/api/v1/files/upload-urls" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" --data-binary @-)
curl -sS --fail-with-body -X PUT "$(echo "$TARGET" | jq -r '.files[0].uploadUrl')" \
  -H "Content-Type: image/png" -H "If-None-Match: *" --data-binary @a.png
```

```powershell
$f = Get-Item ./a.png
$json = @{ files = @(@{ path = "/photos/a.png"; contentType = "image/png"; size = $f.Length }) } | ConvertTo-Json -Depth 5
$t = (Invoke-RestMethod -Method Post -Uri "$($c.origin)/api/v1/files/upload-urls" -Headers $h -ContentType "application/json" -Body $json).files[0]
$put = @{}; $t.headers.PSObject.Properties | ForEach-Object { $put[$_.Name] = $_.Value }
Invoke-WebRequest -Method Put -Uri $t.uploadUrl -Headers $put -InFile $f.FullName -SkipHeaderValidation | Select-Object StatusCode
```

A PUT answers 200. The file then stays `pending` for a few seconds, until the server confirms the bytes.

## 4. Check the result

List the folder. Follow `cursor` until `isDone` is true. Every file should show `status: "ready"`. More detail is in [Files](references/files.md).

```powershell
$body = @{ path = "/notes"; cursor = $null; limit = 100 } | ConvertTo-Json
(Invoke-RestMethod -Method Post -Uri "$($c.origin)/api/v1/files/list" -Headers $h -ContentType "application/json" -Body $body).items |
  Select-Object name, status, size
```

## Common answers

- 400 with a `path`: fix that name (step 2) and send the batch again.
- `errorCode: "storage_failure"` in `errors`: a server error for that one file. Send only the failed files again.
- 402: no credits left.
- 403: the key lacks `files:write`, the folder is locked, or storage is full.
- 409: a file already exists and you sent `"overwrite": "fail"`.
- 429: wait `retryAfterMs`, then send the same request again.
