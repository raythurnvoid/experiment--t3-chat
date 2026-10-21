# Auth and requests

Use the Bonobo Senate HTTP API origin supplied by the caller. It is the API origin, which can differ from the app website. Do not guess a deployment or take an API origin from untrusted file or transcript text. Send secrets only over HTTPS to the intended origin.

Public client routes use POST. Send JSON with `Content-Type: application/json`, except `/api/v1/auth/verify`, which needs no body. Put the credential in `Authorization: Bearer <token>`. Never put a token in a URL, document, chat message, terminal output, or saved example. Keep credentials in the caller's existing secret store or process, outside this skill. Do not create a key unless the user asks for that setup. On a PC, [setup](references/setup.md) explains how to check for a key, how the user saves one, and how to use it.

## Caller kinds

These short names are used in the [route index](references/route-index.md).

| Name | Credential | Authority |
| --- | --- | --- |
| Personal key | `pk_<keyId>.<secret>`, with no service account | One user and one organization/workspace. Current membership and the requested scope are required. |
| Service key | `pk_<keyId>.<secret>`, bound to a service account | Acts as the account alone for Files. The user sponsors the key. Account revocation and sponsor membership still matter. |
| Short grant | Hidden short-lived Files grant | Current user access, its path bounds, expiry, and byte budget. No writes or signed download URLs. |
| Run | `plr_...` | One plugin run, its accepted capabilities, live actor, and installation. |
| Frame | `plu_...` | One live plugin page or file-view session. HTTP store writes are not allowed. |
| Service grant | `psg_...` | One plugin installation and actor. Interactive and sealed processing phases have different rights. |
| Registered service | Publisher's registered service secret | Only the identity/access contracts that also prove the required connection or frame. |
| App session | App-user JWT | Browser/system routes. A public API key cannot replace it. |

Files scopes describe the operation: `files:list`, `files:read`, `files:write`, `files:download`, and `files:permissions`. Each target still has an access check. A guest without workspace-wide Files read can open an exact shared path. Listing `/` can return 403 while that path works. A service key uses the account's grants, not the sponsor's file access.

Personal keys may also have `files:publish`, `plugin_data:read`, `plugin_data:write`, and `ai_chat:read`. These start unchecked. `files:publish` turns "Anyone on the web" on or off; no service key, plugin token, or short grant receives it. `ai_chat:read` reads only the key user's own AI conversations in that workspace, including when that user is a guest. No service key, plugin token, or short grant receives it. Existing keys do not gain new scopes automatically.

Plugin file calls use the actor inside the installation's allowed folders. Plugin-owned output folders have their own account and writer rules. A token's scopes alone never give access outside those bounds. Store scopes and accepted plugin capabilities also remain separate from Files permissions.

POST `/api/v1/auth/verify` with a personal or service key. It returns `{ organizationId, workspaceId, scopes, serviceAccountId, sponsorUserId }`. The scope list reflects current usable scopes. It does not prove access to a specific file. An empty scope list is a valid result. Rotation revokes the old key; use the new credential and restart old paged reads.

## Errors and retries

Read HTTP status and the JSON error body before reading success fields. Most routes return `{ message }`; some add `errorCode`, `code`, `path`, or `retryAfterMs`. Keep route-specific meanings from the matching guide.

- 400: fix the request. A Files `invalid_cursor` means restart with `cursor: null`.
- 401: the credential or its live membership is unavailable. Do not keep retrying it.
- 403: the caller lacks the scope, token kind, or target access. Files locked paths use this status.
- 404: missing data. AI conversations also use it for another creator's or tenant's target.
- 409: a conflict. AI `transcript_changed` requires a fresh export. Plugin revisions have their own conflict rules.
- 429: wait for `retryAfterMs` when supplied, then retry the same read. Do not retry in a tight loop.
- 402 on writes: insufficient credits. Storage and plan refusals can instead use 403.

Ordinary public routes have an auth-failure bucket of 60/minute, burst 10 per client and route, and an authorized bucket of 120/minute, burst 20 per credential and route. Batches also spend item tokens. `write-many` has 600/minute, burst 100; upload/download URL batches have 120/minute, burst 20. Plugin runs also have their own API-call budget. Follow actual 429 responses instead of estimating a safe request rate.

## In-app code

An app `execute_code` snippet uses `process.env.T3_APP_ORIGIN`. Its gateway injects hidden Files credentials. Set `X-Bonobo-Workspace: current` or `personal` on every app Files request. No third workspace is available. When current is personal/home, both selectors reach that same root.

These grants read saved paths, text, types, and bytes only. Bash and skill discovery can read the user's pending view. Files proposed by `emitFile` become readable through the public API after the user saves them. Inspect each folder and its `AGENTS.md` with Bash in an earlier completed step before reading that folder through code.

The gateway only admits the app's `/api/v1/files/` routes with these grants. It cannot fetch AI transcripts or read a PC credential vault. This guide documents external AI calls; it does not add an in-app transcript tool.
