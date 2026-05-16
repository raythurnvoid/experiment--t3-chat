# R2 Upload Finalizer Worker

This Worker consumes Cloudflare Queue messages emitted by R2 Event Notifications and forwards upload-create events to Convex. Convex remains responsible for upload ownership, queueing Modal conversion, and linked `.shadow.md` creation.

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
			"key": "workspaces/<workspaceId>/projects/<projectId>/nodes/<sourceNodeId>/source",
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
- `404` when no upload doc matches the forwarded bucket/key.
- `500` for unexpected route failures.
- `503` for retryable Convex-side failures.

The Worker retries only network errors and retryable HTTP statuses: `408`, `409`, `425`, `429`, and `>=500`. It acknowledges non-retryable statuses such as `400`, `401`, and `404`. Duplicate delivery is expected; Convex finalization is idempotent.

Convex owns upload lookup, idempotency, conversion queueing, and finalization. The Worker should stay a narrow event forwarder.

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
- `R2_UPLOAD_PREFIX`: `workspaces/`

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
pnpx wrangler r2 bucket notification create bonobo-senate-press-files --event-type object-create --queue bonobo-senate-press-r2-upload-events --prefix "workspaces/"
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
- `404` from Convex means the R2 object key did not match any pending upload doc; the Worker treats this as non-retryable.
- `503` from Convex or network failures are retried and eventually sent to the DLQ after `max_retries`.
- Events with a wrong bucket or a key outside `workspaces/` are acknowledged without calling Convex.
- R2 notifications must be created after the queue exists.
