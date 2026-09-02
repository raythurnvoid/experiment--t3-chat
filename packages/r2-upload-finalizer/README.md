# R2 Upload Finalizer Worker

This Worker consumes Cloudflare Queue messages emitted by R2 Event Notifications and forwards upload-create events to Convex. Convex remains responsible for upload ownership and finalization. Modal conversion and generated sibling files are plugin work now, done through `/api/v1/files/write` and `/api/v1/files/touch`.

Use `pnpx wrangler` for all Cloudflare CLI work in this repo. Do not install Wrangler globally, and do not use `npx wrangler`.

## Runtime Contract

R2 sends a queue message for `object-create` events. The Worker accepts only events where:

- `event.bucket === R2_FILES_BUCKET`
- `event.object.key` starts with `R2_UPLOAD_PREFIX`

The Worker posts this body to Convex:

```json
{
	"cloudflareMessageId": "cloudflare-queue-message-id",
	"attempts": 1,
	"event": {
		"action": "object-create",
		"bucket": "bucket-name",
		"object": {
			"key": "organizations/<organizationId>/workspaces/<workspaceId>/upload-staging/<assetId>",
			"size": 123,
			"eTag": "etag"
		},
		"eventTime": "2026-05-11T00:00:00.000Z"
	}
}
```

The Worker forwards accepted events to Convex at `/api/r2/event`.

Convex returns:

- `204` when the event is acknowledged, including queued work, duplicate in-progress deliveries, and already-finalized uploads.
- `400` when the event body is invalid.
- `401` when the shared event secret is missing or wrong.
- `404` when no upload asset matches the forwarded bucket/key.
- `500` for unexpected route failures.
- `503` for retryable Convex-side failures.

The Worker retries only network errors and retryable HTTP statuses: `408`, `409`, `425`, `429`, and `>=500`. It acknowledges non-retryable statuses such as `400`, `401`, and `404`. Duplicate delivery is expected; Convex finalization is idempotent.

Convex owns asset lookup, upload-kind filtering, idempotency, conversion queueing, and finalization. The Worker should stay a narrow event forwarder.

Creating the file node, asset doc, and signed target accepts the upload. If the node or its folder
becomes read-only later, Convex still publishes the upload. It also finishes text conversion when
needed and starts upload-completed plugins. The finished node keeps its lock. New changes stay
blocked.

User-facing signed PUTs use `organizations/.../upload-staging/<assetId>`. Convex verifies the staging
event. It then copies the bytes once to the immutable live key at
`organizations/.../assets/<assetId>` and publishes the upload. The event for the new live key is
acknowledged without starting upload finalization again. Generated Markdown, Yjs snapshots, and
content snapshots also use `/assets/<assetId>`. Their events are acknowledged without upload work.

## Configuration

Convex environment:

- `CLOUDFLARE_EVENTS_SECRET`: shared secret used only by trusted Cloudflare event forwarders for this app.

Convex R2 upload/conversion environment:

- `R2_BUCKET_FILES`: bucket used for uploaded source files.
- `R2_ENDPOINT`: Cloudflare R2 S3-compatible endpoint.
- `R2_ACCESS_KEY_ID`: access key for signed upload/download URL generation.
- `R2_SECRET_ACCESS_KEY`: secret key for signed upload/download URL generation.

Worker vars in `wrangler.jsonc`:

- `R2_FILES_BUCKET`: `bonobo-senate-press-files`
- `R2_UPLOAD_PREFIX`: `organizations/`

Worker secrets:

- `CONVEX_HTTP_URL`: Convex site URL, for example `https://grand-finch-267.convex.site`
- `EVENTS_SECRET`: same value as Convex `CLOUDFLARE_EVENTS_SECRET`

`wrangler.jsonc` declares both secrets under `secrets.required`, so `wrangler deploy` fails if either binding is missing.

Queues:

- Main queue: `bonobo-senate-press-r2-upload-events`
- Dead-letter queue: `bonobo-senate-press-r2-upload-events-dlq`

## Setup

Log in:

```powershell
pnpx wrangler login
```

Create queues:

```powershell
pnpx wrangler queues create bonobo-senate-press-r2-upload-events
pnpx wrangler queues create bonobo-senate-press-r2-upload-events-dlq
```

Set the Worker secret:

```powershell
pnpx wrangler secret put CONVEX_HTTP_URL --config packages/r2-upload-finalizer/wrangler.jsonc
pnpx wrangler secret put EVENTS_SECRET --config packages/r2-upload-finalizer/wrangler.jsonc
```

Set the Convex secret:

```powershell
cd packages/app
pnpx convex env set CLOUDFLARE_EVENTS_SECRET replace-with-random-token
```

The files bucket is committed in `packages/r2-upload-finalizer/wrangler.jsonc` as `bonobo-senate-press-files`. Keep `CONVEX_HTTP_URL` out of `wrangler.jsonc`; set it with `wrangler secret put` so each Cloudflare deployment can point at the correct Convex site without committing environment-specific URLs.

Deploy the Worker:

```powershell
pnpx wrangler deploy --config packages/r2-upload-finalizer/wrangler.jsonc
```

Create the R2 notification after Convex and the Worker are deployed:

```powershell
pnpx wrangler r2 bucket notification create bonobo-senate-press-files --event-type object-create --queue bonobo-senate-press-r2-upload-events --prefix "organizations/"
```

The browser uploads (`PUT`) and reads (`GET`) files with signed R2 URLs, straight to the
bucket: the Files sidebar and the rich text media upload put files, and the Files page loads
Yjs snapshots and media. Convex `ALLOWED_ORIGINS` only covers Convex routes. The bucket has
its own CORS policy, and it must list the same app origins, or those `fetch()` calls fail with
a CORS error on `https://raythurnvoid.github.io`. Apply [r2-files-cors.json](r2-files-cors.json)
after changing origins. Do not drop localhost.

Nothing reads that file automatically. `wrangler.jsonc` does not reference it, `wrangler deploy`
ignores it, and no script or CI step applies it. Wrangler reads it only as the `--file` argument
of the command below, sends its `rules` array to the R2 API once, and forgets it. So if you edit
the file and do not re-run the command, the bucket keeps the old policy. The file must stay
strict JSON: wrangler parses it with comments disallowed.

```powershell
vp env exec pnpx wrangler r2 bucket cors set bonobo-senate-press-files --file packages/r2-upload-finalizer/r2-files-cors.json --force
vp env exec pnpx wrangler r2 bucket cors list bonobo-senate-press-files
```

List notifications:

```powershell
pnpx wrangler r2 bucket notification list bonobo-senate-press-files
```

Delete one notification rule:

```powershell
pnpx wrangler r2 bucket notification delete bonobo-senate-press-files --queue bonobo-senate-press-r2-upload-events --rule <RULE_ID>
```

Delete all notification rules for the queue:

```powershell
pnpx wrangler r2 bucket notification delete bonobo-senate-press-files --queue bonobo-senate-press-r2-upload-events
```

## Local Development

Run tests:

```powershell
pnpm --dir packages/r2-upload-finalizer test
```

Run type checking:

```powershell
pnpm --dir packages/r2-upload-finalizer typecheck
```

Run Wrangler dev:

```powershell
pnpx wrangler dev --config packages/r2-upload-finalizer/wrangler.jsonc
```

## Operations

Tail Worker logs:

```powershell
pnpx wrangler tail bonobo-senate-r2-upload-finalizer
```

Inspect queue metadata:

```powershell
pnpx wrangler queues info bonobo-senate-press-r2-upload-events
pnpx wrangler queues info bonobo-senate-press-r2-upload-events-dlq
```

Inspect DLQ message bodies in the Cloudflare dashboard under Queues. If command-line body inspection is needed, add a temporary HTTP pull consumer for the DLQ and use the Queues Pull API with a scoped Cloudflare API token.

Purge a queue only after confirming the messages are no longer needed:

```powershell
pnpx wrangler queues purge bonobo-senate-press-r2-upload-events-dlq
```

## Troubleshooting

- `401` from Convex means Convex `CLOUDFLARE_EVENTS_SECRET` differs from Worker `EVENTS_SECRET`.
- `400` from Convex means the forwarded event body did not match the expected schema.
- `404` from Convex means the R2 object key did not match any upload asset; the Worker treats this as non-retryable.
- `503` from Convex or network failures are retried and eventually sent to the DLQ after `max_retries`.
- Events with a wrong bucket or a key outside `organizations/` are acknowledged without calling Convex.
- R2 notifications must be created after the queue exists.
