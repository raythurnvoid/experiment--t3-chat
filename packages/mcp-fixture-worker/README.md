# MCP Fixture Worker

This Worker serves MCP test servers at a public HTTPS URL, for live QA of the chat agent's MCP tools. Convex dev runs in the cloud, so it cannot reach a test server on a laptop.

Base URL: `https://bonobo-senate-mcp-fixture.ray-thurne-void.workers.dev`. Every path not listed below answers 404.

- `/modern-basic`: the `modern-basic` server, with no sign-in and no secrets. The Data Probe plugin (`plugins/bonobo-plugin-data-probe`, version 0.3.0 and later) declares it as its `fixture` MCP server.
- `/oauth-call-only/mcp`: lists its tools without a token and asks for sign-in only on `tools/call`. Saved as a member's own server, it saves with no sign-in, and the first Connect pins the sign-in server.
- `/oauth-list/mcp`: needs a token for every request, also for the tool list.
- `/oauth-as`: the test sign-in server for both OAuth servers. It has no accounts: its page has an Approve and a Deny button. It accepts only CIMD clients (a client id that is a client document URL) and checks that the document lists the redirect URI.

All three servers run `mcp_fixtures_create_basic_handler` from [packages/app/server/mcp-fixtures/mcp-fixtures.ts](../app/server/mcp-fixtures/mcp-fixtures.ts), the same fixture the MCP client tests use, with the tools `echo` and `picture`. They speak only the `2026-07-28` protocol. The OAuth part is [src/oauth-fixture.ts](src/oauth-fixture.ts).

A Worker keeps no memory between requests, so codes and tokens are signed JSON with an expiry. The key is the Worker secret `OAUTH_SIGNING_KEY`. Revoke answers 200 but cannot end a token early. An access token lasts 10 minutes.

Use `pnpx wrangler` through Vite Plus. Do not install Wrangler globally.

```powershell
vp env exec pnpm --dir packages/mcp-fixture-worker run typecheck
vp env exec pnpx wrangler deploy --config packages/mcp-fixture-worker/wrangler.jsonc
```

Set a new signing key without printing it (this ends every token the fixture gave out):

```powershell
[Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)) | vp env exec pnpx wrangler secret put OAUTH_SIGNING_KEY --config packages/mcp-fixture-worker/wrangler.jsonc
```

Deploying changes a public test server. Ask before you deploy.
