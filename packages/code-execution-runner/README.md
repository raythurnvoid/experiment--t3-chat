# bonobo-senate-code-execution-runner

A trusted host Cloudflare Worker that runs an **untrusted JavaScript snippet** inside an
isolated **Dynamic Worker** (Worker Loader binding) and returns a compact JSON result plus
bounded logs. It backs the AI agent's `execute_code` tool.

The host Worker is trusted; the snippet is not. The snippet runs in a fresh Dynamic Worker
isolate with no access to platform bindings, platform secrets, or Worker `env`. By default it
also has no network egress. HTTPS egress is explicit and routes through the host gateway.
App file access is a real HTTP capability: the caller supplies a short-lived
public API grant token to the gateway, the snippet sees only
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
const headers = { "Content-Type": "application/json" };
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
	"app": { "origin": "https://example.convex.site", "token": "short-lived-grant-token" },
}
```

`code` is the **body of an `async` function**. Use `return` to produce a JSON-serializable
result. `input` is available as a variable. `console.log/info/debug/warn/error` are captured.
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
  "error": null           // { name, message } when errored/timed_out
}
```

Pre-flight failures (`disabled`, `unauthorized`, `invalid_json`, `invalid_request`, `misconfigured`,
`too_large`) return a non-2xx status with `{ ok: false, error: { code, message } }`.

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
  count, and time.
- **App file access is gateway-authenticated.** `app: { origin, token }` enables
  fetches to app public file API routes. The public API grant token stays in
  the gateway and is injected only for `/api/v1/files/*` requests at the configured
  app origin. The snippet can use `process.env.T3_APP_ORIGIN`; it cannot read the
  raw token. Use `/api/v1/files/list` for discovery, `/api/v1/files/read-many` for
  folder-scale reads, and `/api/v1/files/read` for one-off reads.
- **No platform bindings/secrets.** No Worker Loader `env` is passed to the Dynamic Worker.
  Synthetic `process.env` values are lexical harness variables, not platform bindings.
- **Time bound.** An in-sandbox `Promise.race` rejects after `LIMITS.sandboxTimeoutMs` (5s); a
  parent-side wall-clock backstop (`LIMITS.parentTimeoutMs`, 7s) cuts a snippet that hangs the
  RPC (e.g. a tight CPU loop). There is **no per-snippet `cpuMs`/`subRequests` cap** — those
  belong to the Workers-for-Platforms dispatch-namespace API, not the Worker Loader binding
  (`WorkerLoaderWorkerCode` has no `limits` field). CPU is bounded by the platform-default
  isolate limit plus the wall-clock cut.
- **Bounded output.** Captured logs are capped (100 lines / 16 KB) and the result is capped
  (16 KB); oversize sets `logsTruncated` / `resultTruncated`.
- **Privacy.** Operational logs carry only metadata (`executionId`, `codeHash`, byte sizes,
  status) — never raw code, input, result, captured logs, file contents, or app grant tokens.

## Configuration

| Name                              | Kind                   | Purpose                                                                |
| --------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `CODE_EXECUTION_RUNNER_SECRET`    | secret (required)      | Bearer token the caller must present.                                  |
| `CODE_EXECUTION_DISABLED`         | var (optional)         | Set to `"true"` to hard-disable execution (503 kill switch).           |
| `CODE_EXECUTION_NETWORK_DISABLED` | var (optional)         | Set to `"true"` to reject requests that need outbound access.          |
| `LOADER`                          | worker_loaders binding | The Worker Loader binding (declared in `wrangler.jsonc`).              |

## Develop / deploy

```sh
vp env exec pnpm --filter bonobo-senate-code-execution-runner test       # vitest (node env, mocked LOADER)
vp env exec pnpm --filter bonobo-senate-code-execution-runner typecheck
vp env exec pnpm --filter bonobo-senate-code-execution-runner dev        # wrangler dev --remote
vp env exec pnpm --filter bonobo-senate-code-execution-runner deploy     # wrangler deploy

# set the shared secret (non-prod)
vp env exec pnpx wrangler secret put CODE_EXECUTION_RUNNER_SECRET --config packages/code-execution-runner/wrangler.jsonc
```

The local test suite exercises the host Worker (auth, validation, size caps, capability
selection, gateway SSRF/header/redirect policy, response shaping, wall-clock backstop) with a
mocked Worker Loader. **Runtime isolation guarantees** (`globalOutbound: null` egress block,
real timeout, and real Worker Loader behavior) still require **remote smoke tests** against a
deployed instance.
