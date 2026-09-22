# bonobo-senate-code-execution-runner

A trusted host Cloudflare Worker that runs an **untrusted JavaScript snippet** inside an
isolated **Dynamic Worker** (Worker Loader binding) and returns a compact JSON result,
bounded logs, and optional file bytes. It backs the AI agent's `execute_code` tool.

The host Worker is trusted; the snippet is not. The snippet runs in a fresh Dynamic Worker
isolate with no access to platform bindings, platform secrets, or Worker `env`. By default it
also has no network egress. HTTPS egress is explicit and routes through the host gateway.
App file access is a real HTTP capability: the caller supplies short-lived
public API grant tokens for the current and personal workspaces to the gateway. The snippet sees only
`process.env.T3_APP_ORIGIN`, and the gateway injects authorization only for
app public file API routes.

## Request contract

`POST /internal/execute-code` — `Authorization: Bearer <CODE_EXECUTION_RUNNER_SECRET>`

```jsonc
// request body
{
	"code": "return input.numbers.reduce((a, b) => a + b, 0);", // required, async-function body
	"input": { "numbers": [1, 2, 3] }, // optional, JSON value, in scope as `input`
	"executionId": "optional-correlation-id", // optional
}
```

Only `code`, `input`, `executionId`, `network`, and `app` are accepted as top-level
request fields.

Add capabilities when needed:

```jsonc
// internet mode
{
	"code": "return await fetch('https://example.com').then((r) => r.text());",
	"network": { "mode": "public_http" },
}
```

App file API mode sends the same request shape, with code like:

```js
const api = process.env.T3_APP_ORIGIN;
const headers = { "Content-Type": "application/json", "X-Bonobo-Workspace": "current" };
const listed = await fetch(api + "/api/v1/files/list", {
	method: "POST",
	headers,
	body: JSON.stringify({ path: "/payments", recursive: true, kind: "file", extension: "md" }),
}).then((response) => response.json());
const read = await fetch(api + "/api/v1/files/read-many", {
	method: "POST",
	headers,
	body: JSON.stringify({ paths: listed.items.map((item) => item.path) }),
}).then((response) => response.json());
if (read.truncated || read.errors.length) throw new Error("Some files were not read");
return { count: read.files.length };
```

```jsonc
{
	"code": "<the JavaScript body above>",
	"app": {
		"origin": "https://example.convex.site",
		"tokens": { "current": "current-grant-token", "personal": "personal-grant-token" },
	},
}
```

Both token fields are required and must be 1–512 characters. The old `app.token` shape is
rejected. The tokens may be equal when the current workspace is the user's personal home.
Every app file API request must include `X-Bonobo-Workspace: current` or
`X-Bonobo-Workspace: personal`. A missing or invalid selector returns 400 before fetching.
The trusted gateway chooses the token and removes the selector before forwarding.
A snippet can read both roots by changing this header between requests; it never sees either token.

`code` is the **body of an `async` function**. Use `return` to produce a JSON-serializable
result. `input` is available as a variable. `console.log/info/debug/warn/error` are captured.
Use `emitFile` to return a file without putting its bytes in the result or logs:

```js
emitFile({
	workspace: "personal",
	path: "/reports/output.bin",
	contentType: "application/octet-stream",
	bytes: new Uint8Array([0, 255, 128]),
});
```

`workspace` is required on every file and must be `current` or `personal`. It is not taken
from the most recent fetch. Both sandbox RPC and the host HTTP result preserve it.
The harness and trusted host each reject missing or invalid workspace values.
`bytes` accepts `Uint8Array` or `ArrayBuffer`. For a Blob, use `await blob.arrayBuffer()`.
The call copies the bytes at once, including only the selected range of a typed-array view.
Later changes to the source buffer do not change the file. Empty files are allowed.
`path` is 1–1024 characters; optional `contentType` is 1–255 characters. The runner checks
these transport bounds. The app checks canonical workspace paths and MIME syntax.
Missing content types use the file name's type hint or `application/octet-stream` in the app.

For binary input, POST to `process.env.T3_APP_ORIGIN + "/api/v1/files/read-bytes"`
with `X-Bonobo-Workspace: current` or `personal` and
`{ path: "/reports/input.bin", offset: 0, length: 1048576, revision: null }`.
Check `response.ok`, then use `await response.arrayBuffer()`. The response is raw
bytes. `X-File-Content-Type`, `X-File-Revision`, `X-File-Size`, and `X-File-Offset`
describe the range. Pass the returned revision on later range reads.

Only this exact POST route gets a 1-MiB response cap. Other requests keep the
512,000-byte cap. Byte reads refuse redirects and use `Cache-Control: no-store`.
They count toward the existing 20-fetch limit. The app binds both grants to one
8-MiB total read budget, so switching workspaces or changing snippet code cannot reset it.

At most eight files and 8 MiB of raw file bytes may leave one successful execution,
combined across both workspaces.
Errors, timeouts, and invalid output drop the whole batch. The runner does not store files.
The app checks Agent mode and Files access, then creates ordinary pending files for review.
Ask mode keeps calculations and reads but cannot create files. Its public API grant stays
read-only. A public download may supply file bytes, but check `response.ok` before using
`arrayBuffer()`: the gateway returns 413 when the response exceeds 512,000 bytes.

Without `network` or `app`, `fetch()` and `connect()` throw. With `network.mode = "public_http"`,
public `fetch()` is available through the host gateway. With `app`, the gateway authorizes
requests only to `/api/v1/files/*` at the configured app origin and exposes only
`process.env.T3_APP_ORIGIN` to the snippet. The app chat tool supplies both capabilities,
so a snippet may combine app file reads with public HTTPS fetches in the same execution.
This is a powerful worker capability, not an exfiltration boundary; keep snippets
scoped to the user's request and rely on short-lived scoped grants, byte/time caps, and
route logs for containment.

```jsonc
// 200 response (the HTTP request succeeded; check `status` for the snippet outcome)
{
  "executionId": "…",
  "status": "succeeded" | "errored" | "timed_out",
  "codeHash": "sha256 of the wrapped code",
  "elapsedMs": 12,
  "result": 6,            // null when errored/timed_out or when resultTruncated
  "resultTruncated": false,
  "logs": ["…"],
  "logsTruncated": false,
  "files": [{ "workspace": "personal", "path": "/reports/output.bin", "contentType": "application/octet-stream", "dataBase64": "AP+A" }],
  "error": null           // { name, message } when errored/timed_out
}
```

Pre-flight failures (`disabled`, `unauthorized`, `invalid_json`, `invalid_request`, `misconfigured`,
`too_large`) return a non-2xx status with `{ ok: false, error: { code, message } }`.
Every 200 response includes `files`. It is `[]` after an error or timeout, and when no file
was emitted. File bytes cross sandbox RPC as typed arrays. Only the trusted host encodes
them as canonical base64 for HTTP. There is no caller-supplied size. The app reads at most
12 MiB before parsing this response, then checks the shape, base64, and decoded byte total.

`GET /health` → `{ "ok": true }`.

## Isolation posture

- **Sealed by default.** The Dynamic Worker is loaded with `globalOutbound: null`, so
  `fetch()` / `connect()` throw. This is a hard block, not a prompt policy.
- **Gatewayed public HTTPS only when requested.** `network: { mode: "public_http" }`
  loads `globalOutbound` with `ExecuteCodeHttpGateway` from `ctx.exports`. The gateway
  allows only HTTPS requests using common API methods; strips cookies and hop-by-hop /
  forwarded / host / proxy / Cloudflare-derived headers; blocks
  IP literals, single-label hostnames, localhost/internal-style hostnames, non-443 explicit
  ports, and redirects to blocked targets; caps request/response bytes, redirects, request
  count, and time. Each fetch keeps its five-second deadline through the complete response
  body read.
- **App file access is gateway-authenticated.** `app: { origin, tokens: { current, personal } }` enables
  fetches to app public file API routes. Both tokens stay in the gateway.
  It sends only the selected token for `/api/v1/files/*` requests at the configured
  app origin. The snippet can use `process.env.T3_APP_ORIGIN`; it cannot read the
  raw tokens. The workspace selector is stripped on all outbound requests, including public
  requests and redirects. App tokens are never forwarded outside the app file API. Redirects
  within that API keep the selected grant; public redirects cannot gain app access, and a
  redirect that leaves the API loses app access for the rest of that redirect chain.
  Byte reads still refuse all redirects. Use `/api/v1/files/list` for discovery, `/api/v1/files/read-many` for
  folder-scale text reads, `/api/v1/files/read` for one-off text reads, and
  `/api/v1/files/read-bytes` for bounded binary ranges. The gateway only
  injects the grant; tenant isolation is enforced by the app public file API. The
  grant does not authorize reserved `GLOBAL`/`GITHUB` mount docs.
- **No platform bindings/secrets.** No Worker Loader `env` is passed to the Dynamic Worker.
  Synthetic `process.env` values are lexical harness variables, not platform bindings.
- **Time bound.** An in-sandbox `Promise.race` rejects after `LIMITS.sandboxTimeoutMs` (5s); a
  parent-side wall-clock backstop (`LIMITS.parentTimeoutMs`, 7s) cuts a snippet that hangs the
  RPC (e.g. a tight CPU loop). This runner sets **no per-snippet `cpuMs`/`subRequests` cap**.
  CPU is bounded by the platform-default isolate limit plus the wall-clock cut.
- **Bounded output.** Captured logs are capped (100 lines / 16 KB) and the result is capped
  (16 KB); oversize sets `logsTruncated` / `resultTruncated`.
  Files have a separate eight-file / 8-MiB budget shared across both workspaces. The trusted host treats the RPC reply as
  unknown and checks every consumed field, logs, typed arrays, and byte totals. The snippet
  can change its own harness, so its local checks are not the security boundary.
- **Privacy.** Operational logs carry only metadata (`executionId`, `codeHash`, byte sizes,
  status) — never raw code, input, result, captured logs, file contents, or app grant tokens.

## Configuration

| Name                              | Kind                   | Purpose                                                       |
| --------------------------------- | ---------------------- | ------------------------------------------------------------- |
| `CODE_EXECUTION_RUNNER_SECRET`    | secret (required)      | Bearer token the caller must present.                         |
| `CODE_EXECUTION_DISABLED`         | var (optional)         | Set to `"true"` to hard-disable execution (503 kill switch).  |
| `CODE_EXECUTION_NETWORK_DISABLED` | var (optional)         | Set to `"true"` to reject requests that need outbound access. |
| `LOADER`                          | worker_loaders binding | The Worker Loader binding (declared in `wrangler.jsonc`).     |

## Develop / deploy

```sh
vp env exec pnpm --filter bonobo-senate-code-execution-runner test       # vitest (node env, mocked LOADER)
vp env exec pnpm --filter bonobo-senate-code-execution-runner typecheck
vp env exec pnpm --filter bonobo-senate-code-execution-runner dev        # wrangler dev --remote
vp env exec pnpm --filter bonobo-senate-code-execution-runner deploy     # base worker; no named env

# set the shared secret (non-prod)
vp env exec pnpx wrangler secret put CODE_EXECUTION_RUNNER_SECRET --config packages/code-execution-runner/wrangler.jsonc
```

The local test suite exercises the host Worker (auth, validation, size caps, capability
selection, gateway SSRF/header/redirect policy, response shaping, wall-clock backstop) with a
mocked Worker Loader. It also runs the generated file harness, checks exact bytes and limits,
and supplies forged RPC replies to test the trusted host. It covers strict token-pair inputs,
workspace selectors, token routing, redirect boundaries, both roots in one snippet, and
workspace validation at both file output boundaries. **Runtime isolation guarantees** (`globalOutbound: null` egress block,
real timeout, and real Worker Loader behavior) still require **remote smoke tests** against a
deployed instance. Before calling a release verified, test real typed RPC with a sliced array,
an empty file, an exact 8-MiB batch, an over-limit batch, and emit-then-throw. Confirm that the
target URL names this base worker; the package has no separate `dev` environment.
