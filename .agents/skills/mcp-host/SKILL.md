---
name: mcp-host
description: Press as an MCP host. Covers the Convex MCP client, the guarded fetch, plugin MCP servers and members' own servers, OAuth sign-in (discovery, the issuer pin, grants, refresh, revoke), the fixture servers, and the conformance runs. Use when changing `server/mcp-client.ts`, `server/mcp-guarded-fetch.ts`, `server/mcp-oauth.ts`, `convex/plugins_mcp.ts`, `convex/plugins_mcp_oauth.ts`, `convex/mcp_custom_servers.ts`, the MCP servers page, the Connect card, or `packages/mcp-fixture-worker`.
---

# What It Is

Press is an MCP host. The chat agent calls tools of remote MCP servers from Convex actions. There are two kinds of server:

- **Plugin servers.** A plugin declares them in its manifest (`mcpServers`, capability `agent.mcp.connect`). Review and install consent cover them. Details: `../plugin-system/SKILL.md`, "MCP servers and skills at install".
- **Members' own servers.** A member pastes a server on the workspace "MCP servers" page (`/w/<org>/<workspace>/mcp-servers`). Each member sees only their own. Details: `../ai-chat-agent/SKILL.md`, "Own servers".

The paste parser ignores unknown keys and a local wrapper's env values. It refuses `${file:...}` only in the URL or header values Press uses. Static OAuth client settings are still refused.

Only remote servers over Streamable HTTP. No stdio, no resources, no prompts, no approvals, and no elicitation in v1. The `TODO(approvals)` and `TODO(elicitation)` comments mark where those go.

Other specs own these parts:

- Chat turn setup, tool names, results, the sign-in notice, and history: `../ai-chat-agent/SKILL.md`, "MCP tools".
- `workspace.mcp.use` and `organization.integrations_policy.manage`: `../access-control/SKILL.md`.
- The organization policy for plugins and member servers: `../organizations-tenancy/SKILL.md`, "Plugins and MCP servers policy".
- Deletion on every path: `../data-deletion/SKILL.md`.
- MCP sign-in versus Press auth: `../auth-system/SKILL.md`, "MCP sign-in is not Press auth".

# Source Of Truth Files

- `../../../packages/app/server/mcp-guarded-fetch.ts`: the one fetch guard for every MCP and OAuth request.
- `../../../packages/app/server/mcp-client.ts`: list tools and call one tool, with the MCP SDK (`@modelcontextprotocol/client`).
- `../../../packages/app/server/mcp-oauth.ts`: discovery, the authorization URL, code exchange, refresh, and revoke. It stores nothing.
- `../../../packages/app/convex/plugins_mcp.ts`: server docs, turn servers, `recheck_call`, health, the call ledger, grant deletion, and the drains.
- `../../../packages/app/convex/plugins_mcp_oauth.ts`: `start`, `finish`, `disconnect`, `can_connect`, the refresh lease, and `revoke_one`.
- `../../../packages/app/convex/mcp_custom_servers.ts` and `../../../packages/app/shared/mcp-custom-config.ts`: members' own servers and the paste parser.
- `../../../packages/app/src/routes/w/$organizationName/$workspaceName/mcp-servers/index.tsx`: the MCP servers page.
- `../../../packages/app/src/components/mcp-connect.tsx`: the one Connect button.
- `../../../packages/app/src/routes/oauth/mcp/callback.tsx`: the OAuth callback page.
- `../../../packages/app/vite.config.ts`: builds `oauth/mcp/client.json`, Press's OAuth client document.

# Guarded Fetch

`mcp_guarded_fetch_create` is the only way Press reaches an MCP server or a sign-in server. Convex sends every `fetch` through its SSRF proxy, which checks where a name resolves. The guard adds the rules the proxy cannot know:

- `https:` only, on port 443 only, no user or password in the URL, hostnames only. It refuses IP literals in every form, a name with an empty label (`localhost..`), `localhost`, `instance-data`, and `.localhost`, `.local`, `.internal` names.
- It refuses Press's own hosts: the hosts of the env values in `PRESS_HOST_ENV_NAMES` (Convex cloud and site, `APP_BASE_URL`, Clerk, the runners, the media transformer, the Modal services). The optional Convex env `MCP_DENIED_HOSTS` adds exact hosts and `*.` suffixes. Both are read at call time.
- `mcp` mode: the server's headers and its Bearer token go only to the server's own origin. Redirects are refused. Responses are capped in decoded bytes. Every fetch and response read shares the operation deadline and caller signal, including initialization and session cleanup.
- `oauth` mode: no server headers. Only a GET may follow redirects (at most 3, each checked again). Each request has 5 seconds and 64 KiB.
- It throws for the SDK and records why in `failure`. Callers read `failure`, then `wwwAuthenticate` after a 401 or 403, then `retryAfter` after a 429.
- MCP sign-in and retry headers come from the latest POST response. A background GET or cleanup DELETE cannot supply them. A POST with no header clears the old value.

The code runner Worker has its own copy of the Press host rule (`PRESS_DENIED_HOSTS` in `packages/code-execution-runner/wrangler.jsonc`, subdomains included). Keep the two host lists equal.

# Protocol Client

- `mcp_client_list_tools` and `mcp_client_call_tool` open a new SDK client each time and close it before they return. No session stays open.
- Version: the `2026-07-28` era first. A server found to be legacy (`2025-11-25`, `2025-06-18`, `2025-03-26`) is called on the legacy era; the `discover` value from the list is passed to the call.
- `tools/list` may retry a 429 or a 5xx inside its time budget. `tools/call` never retries, because the tool may have done its work.
- A legacy call cannot start after initialization uses up its deadline. Session DELETE is best effort within the same deadline; its failure does not discard a completed tool result. Stop also ends retry waits and cleanup.
- Caps: 2 MiB per list page, 4 MiB per list, 20 pages, 500 tools per server, 1 MiB per call result. Tool schemas: 64 KiB, depth 10, 500 subschemas, no network `$ref`, and no recursion (a ref chain that leads back into a schema it is expanding, also through several refs). Names, titles, and descriptions are cut. Turn setup then keeps at most 100 tools and 128 KiB of tool definitions per turn (`convex/ai_chat.ts`).
- Errors are a `Result` with a fixed code and fixed Press text. Server text never goes into `_nay` or into a log, because it can echo a token or a header value back.
- Schemas are checked with `CfWorkerJsonSchemaValidator`, which runs in the Convex runtime. Every MCP tool is `strict: false` for OpenAI.
- Model tools leave out input schemas with known secrets, token-shaped text, or half a character in a key or nested value. Strings and numbers are checked as text. Known numeric secrets are also compared as numbers, so exponent form cannot hide them. Replacing those values could change the server's input rules.
- A 401 or scoped 403 reads only the selected Bearer challenge. Parameters of another challenge do not count as duplicates or supply metadata or scope.

# OAuth Sign-In

One grant per member, per workspace, per server (`plugins_mcp_oauth_grants`, target `plugin` or `custom`). Every server and every workspace shares one Press client and one callback.

1. **Start** (`plugins_mcp_oauth.start`, action). It checks the return path (an app path, never a full URL), the rate limit, `workspace.mcp.use`, the target, and the policy. It asks the server once with no token, so a server that names its metadata only in the 401 challenge still works. Then it runs discovery and builds the authorization URL with PKCE. `insert_pending` checks everything again and stores a `plugins_mcp_oauth_pending` doc: the state hash (never the state), the encrypted code verifier, and the endpoints. A pending sign-in lives 10 minutes.
2. **Discovery** (`mcp_oauth_discover`). Protected resource metadata (PRM) comes from the challenge URL, then the path-aware well-known URL, then the root one. Its `resource` must be the URL that answered, or the manifest's reviewed `resource` pin, and always on the server's origin. No PRM means no sign-in: Press never guesses the issuer. The issuer must be the pin exactly. Authorization server metadata must match the issuer string exactly and must offer PKCE with `S256`.
3. **Mix-up rule.** All servers share one client id. So Press uses a sign-in server only when it promises `iss` in the callback (RFC 9207), or when its exact issuer is listed in the Convex env `MCP_TRUSTED_ISSUERS`. `finish` checks `iss` before it reads anything else.
4. **Client.** CIMD first: the client id is `<APP_BASE_URL>/oauth/mcp/client.json`, for a server that accepts a public client. Otherwise dynamic registration (DCR); its client secret is stored encrypted in `plugins_mcp_oauth_clients`, keyed by issuer, and reused. `start` fetches `client.json` once and stops with a clear message when it drifted from what Convex expects.
5. **Finish** (`plugins_mcp_oauth.finish`, called by the callback page). `claim_pending` takes the pending doc only when its `userId` is the caller and it has not expired. It rotates the stored state hash to block replay and keeps the doc so Disconnect can cancel the exchange. It returns the original doc; its original hash decrypts the verifier. A failed claim leaves the doc unchanged. After exchange, `store_grant` checks access and the retained doc, then consumes it in the grant-write transaction. A cancelled or refused exchange revokes the new token. `finish` clears claimed docs on every exit. A reconnect replaces the tokens in place.
6. **Use.** `plugins_mcp_oauth_get_access_token` returns the token, refreshed 60 seconds before it expires. One refresh lease per grant (30 seconds) makes sure only one caller refreshes. Refresh uses only the values stored on the grant and never runs discovery again. A refused request carries the grant ID and version it used, so an old 401 cannot end a new connection. A refresh result writes only for its own lease. A caller whose failure lost that lease reads the current grant again. `invalid_grant`, a missing refresh token, or a token refused right after a refresh marks the grant `needs_reconnect` and revokes its token.
7. **Step-up.** A 403 `insufficient_scope` keeps the asked scope on the grant (`record_step_up`). A tool call cannot open a browser, so the member's next Connect asks for it.
8. **Disconnect and delete.** `disconnect` needs no permission and ends only the caller's own grant and pending sign-ins for the target, even when no grant exists yet. Every path that ends a grant copies the encrypted token into `plugins_mcp_oauth_revocations` and schedules `revoke_one`: one best-effort revoke, then the doc is deleted.

Pins and changes:

- A plugin server's issuer is a manifest pin. When the server names another sign-in server, `start` marks the grant `needs_reconnect` and says "Ask the plugin publisher." It uses the grant ID and version read before discovery, so an old response cannot end a newer connection. A new URL or issuer in a new version drains the grants connected before it.
- A member's own server pins its issuer at save when it asks for sign-in then. A server that asks only on a tool call saves with no sign-in and pins at its first Connect ("late pin", in `start`). The pin changes `destinationFingerprint`, so an organization policy entry for the old fingerprint stops matching until a manager allows the new one. A server that later names another sign-in server must be deleted and added again.
- Grants store tokens encrypted with `MCP_SECRETS_ENCRYPTION_KEY`, bound to the target, member, issuer, and resource. A token Press cannot decrypt (a changed key) counts as gone.

Env values:

- Convex: `APP_BASE_URL` (the app origin plus its base path), `MCP_SECRETS_ENCRYPTION_KEY`, optional `MCP_TRUSTED_ISSUERS` and `MCP_DENIED_HOSTS`.
- GitHub Pages build: the repository variable `VITE_APP_BASE_URL`, written into `client.json`. Keep it equal to `APP_BASE_URL`. When the app moves, change both.

# Fixtures And QA

- Unit fixtures: `packages/app/server/mcp-fixtures/` (`mcp-fixtures.ts` for servers, `mcp-oauth-fixtures.ts` for sign-in servers). Tests route a stubbed `fetch` to them by host, so no socket opens.
- Public fixture Worker: `packages/mcp-fixture-worker` (see its README). `/modern-basic` has no sign-in. `/oauth-call-only/mcp` lists tools with no token and asks for sign-in on a call. `/oauth-list/mcp` needs a token for everything. `/oauth-as` is the test sign-in server with Approve and Deny buttons. Ask before you deploy it.
- The Data Probe plugin (`plugins/bonobo-plugin-data-probe`, 0.3.0 and later) declares `/modern-basic` as its `fixture` server.
- Browser QA recipes (pasting a server, the late pin, Connect, the policy modal, cleanup): `../app-playwriter-harness/references/app-map.md`, the MCP bullets. Convex dev runs in the cloud, so only the public Worker works for live checks.

# Tests And Conformance

- `server/mcp-guarded-fetch.test.ts`, `server/mcp-client.test.ts`, `server/mcp-oauth.test.ts`
- `convex/plugins_mcp_oauth.test.ts`, `convex/mcp_custom_servers.test.ts`, `convex/ai_chat_mcp_route.test.ts`
- `shared/mcp-custom-config.test.ts`, `src/components/ai-chat/ai-chat-message.test.tsx`, `src/routes/w/$organizationName/$workspaceName/mcp-servers/index.test.tsx`

The conformance runs use `@modelcontextprotocol/conformance` `0.2.0-alpha.11` (pinned; the list changes between alphas) and the adapter `scripts/mcp-conformance-client.ts`, which runs the real client and OAuth code. Write results outside the repo:

```powershell
vp env exec -- pnpm --dir packages/app exec conformance client --command "vp env exec node --import tsx scripts/mcp-conformance-client.ts" --requirements 2026-07-28 --expected-failures scripts/mcp-conformance-baseline.yml -o <personal +ai folder>/conformance-2026-07-28
vp env exec -- pnpm --dir packages/app exec conformance client --command "vp env exec node --import tsx scripts/mcp-conformance-client.ts" --requirements 2025-11-25 --expected-failures scripts/mcp-conformance-baseline-2025-11-25.yml -o <personal +ai folder>/conformance-2025-11-25
```

- Use `node --import tsx`, not `pnpm exec tsx`: the runner starts every scenario at once, and three Node processes per scenario ran the machine out of memory.
- A passing scenario that is still in a baseline fails the run, so the baselines only shrink. Each entry says why it is there.
- The adapter's test-only switches (local `http`, the fixed conformance client id, the first-seen issuer pin) live only in the adapter. Convex functions never pass them.

# Gotchas

- Keep server text out of errors, logs, and notes. Mask tokens and header values in tool results (`mcp_clean_text`).
- Every write after a network wait checks the member, the target, and the policy again, in its own transaction. Member removal can finish while `start` or `finish` waits.
- Never put a token in scheduler args: Convex shows those in the dashboard. `revoke_one` takes only the revocation doc id.
- Do not revoke the old refresh token on a reconnect or a lost refresh lease. Some sign-in servers end every token of a sign-in on one revoke.
- The organization policy does not stop `save` or `test_connection` of a member's own server. It only keeps the server out of chat turns and sign-ins.
- A tool call checks access and the chat run lease right before each request, also after it waited for a token refresh. After the lease another run may own the thread.
- A plugin server's health counts only failures that do not depend on one member: never a sign-in error and never a list sent with the member's token. A member's own server counts its failures also with their token, because only that member uses it. `end_pause` clears a pause when it ends, so pages do not show a stale "Paused".
- List outcomes update health only when the saved destination fingerprint still matches the one used by the request. An old success cannot reset a new destination's failures.

# Accepted Risks And Later Phases

- No approval step: any MCP tool call runs with no card, and text from a result can steer the model. Approvals are a later phase.
- One shared client id means a sign-in server's consent screen shows only "Press".
- A plugin MCP header value is a plugin secret, so it needs `plugin.secrets.read`, and the plugin's backend runs can read it too. The user chose this on purpose: the backend and the MCP server belong to the same publisher.
- A member's server edit that changes only the path on the same origin keeps its saved secrets. The user chose this on purpose: the member picks the new path for their own secret.
- Only port 443 is allowed, in `plugins_validate_mcp_server_url` (manifest and pasted config), in the manifest `issuer` check, and in the fetch guard for every MCP and OAuth request, redirects included. The user chose this over any port.
- Servers that support neither CIMD nor DCR (GitHub, Slack, Asana today) cannot connect. Pre-registered OAuth apps are a later phase, and must be a general feature.
- Later: stdio servers in a container, resources and prompts, `list_changed` and caching, an admin "disconnect all", and owner switches for the agent's other outbound paths.
