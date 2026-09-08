# Plugin runner

This Cloudflare Worker loads reviewed plugin code from R2 and runs it in a Dynamic Worker. The plugin gets its run token and the host RPC binding. Host secrets stay in the outer runner. Outbound calls still use the accepted capability and origin list.

## Request and deadline

`POST /internal/plugin-runner/run` requires the runner bearer secret. Its strict JSON request includes the artifact identity, run ID, host connection, permissions, input, and optional plugin endpoint path. It also requires:

- `responseMode: "invoke" | "event"`.
- `timeoutMs`: a positive integer, at most 35,000 for invoke or 180,000 for event.

The host owns both fields. They are not part of the event sent to the plugin. Requests without them, unknown fields, and excessive budgets refuse before loading the plugin. The complete request still has a 64,000-byte cap.

One deadline covers artifact loading, execution, and response reading. Body reading does not restart the clock. The runner signals abort and cancels an unfinished reader without waiting on plugin cleanup. This does not guarantee that earlier remote work stops. The Dynamic Worker's CPU limit remains separate. A valid empty answer is `new Response(null, { status: 204 })`.

## Responses

A completed invoke returns outer HTTP 200 with the complete encoded public JSON:

```ts
{
	runId: string;
	pluginStatus: number;
	output: string;
}
```

`output` is text, may be empty, and has fetched secrets and the run token masked. Plugin non-2xx statuses retain their bodies. They do not become host HTTP refusals. The host finalizes the run before deciding whether to relay these bytes.

A completed event returns outer HTTP 200 with `{ _yay: { pluginRunId, pluginStatus, elapsedMs, outputBytes } }`. Its response body is consumed and discarded, including on non-2xx. Events do not store arbitrary results.

An execution error returns `{ _nay: { code, name, message, data? } }`. `data`, when present, carries `pluginRunId`, `elapsedMs`, raw `outputBytes`, and `pluginStatus` when a response arrived. Error codes are runner-owned:

| Code                 | Meaning                                             |
| -------------------- | --------------------------------------------------- |
| `response_too_large` | Raw body or complete encoded reply exceeds its cap. |
| `response_timeout`   | The runner deadline passed.                         |
| `execution_failed`   | Execution or the response stream failed.            |
| `runner_refused`     | The runner refused before plugin execution.         |

Execution errors use outer 200. Pre-execution refusals use 400, 401, 404, 413, or 503. Error names are capped at 64 characters and messages at 500, after masking. The `_nay.code` field uses a plain object because the common `Result()` constructor drops extra error fields.

## Wire headers and limits

All run responses carry `X-Bonobo-Runner-Kind` (`invoke`, `event`, or `error`) and `X-Bonobo-Runner-Body-Bytes`. Completed responses also carry:

- `X-Bonobo-Runner-Run-Id`
- `X-Bonobo-Runner-Plugin-Status`
- `X-Bonobo-Runner-Elapsed-Ms`
- `X-Bonobo-Runner-Output-Bytes`

Errors include those metrics when available; pre-validation refusals may omit them. The runner creates every header itself. It never copies plugin headers. Values are ASCII; numeric metrics are nonnegative integer counts. The host validates the run ID, kind, status, and actual encoded body length.

Raw plugin bodies have a 16 MiB cap. Complete encoded invoke JSON also has a 16 MiB cap, including JSON escaping and its envelope. Small event/error JSON stays within 8 KiB, and runner metadata within 2 KiB (header name, value, and four separator bytes per header). Bounded fields keep those small replies below their caps. `outputBytes` means raw bytes read before masking; it is not the encoded reply size. Older history keeps its earlier metric meaning.

Reads collect text in 64 KiB blocks, with streaming UTF-8 decoding. Encoding uses small JSON string pieces without splitting surrogate pairs, counts bytes before retaining them, and collects at most 256 full 64 KiB blocks. Each read removes its abort listener. One tiny input chunk cannot leave one retained block or deadline reaction. The UI receives one complete response, not a live stream. Near-limit success must also be checked through deployed Cloudflare and Convex; Node tests do not establish Convex memory capacity.

## Deployment and checks

The strict host and runner contracts must match. For an upgrade from the old wire, deploy a reviewed temporary runner bridge first, switch the host, then release/update affected plugins. Observe old requests draining before removing the bridge and deploying this strict runner. Test both mismatched pairs refusing before execution. Rollback must restore a matching pair. Preserve committed side effects and run history; never replay runs as part of rollback. The kill switch refuses execution and does not pause event delivery.

From the repository root:

```powershell
vp env exec pnpm --dir packages/plugin-runner run test
vp env exec pnpm --dir packages/plugin-runner run typecheck
```

After the coordinated review and rollout checks:

```powershell
vp env exec pnpx wrangler deploy --config packages/plugin-runner/wrangler.jsonc
```

The deployment configuration names `bonobo-senate-plugin-runner`. See the maintained plugin-system skill for the SDK/plugin release chain. [Cloudflare's reader API](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreamdefaultreader/) and [Dynamic Workers API](https://developers.cloudflare.com/dynamic-workers/api-reference/) describe the platform boundaries used here.
