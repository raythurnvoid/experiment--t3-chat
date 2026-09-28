# MCP Fixture Worker

This Worker serves the `modern-basic` MCP test server at a public HTTPS URL, for live QA of the chat agent's MCP tools. Convex dev runs in the cloud, so it cannot reach a test server on a laptop.

- URL: `https://bonobo-senate-mcp-fixture.ray-thurne-void.workers.dev/modern-basic`. Every other path answers 404.
- The server code is `mcp_fixtures_create_basic_handler` in [packages/app/server/mcp-fixtures/mcp-fixtures.ts](../app/server/mcp-fixtures/mcp-fixtures.ts), the same fixture the MCP client tests use. The Worker imports it, so its package imports resolve from `packages/app`.
- It speaks only the `2026-07-28` protocol (no legacy `initialize`), with the tools `echo` and `picture`. It has no sign-in and no secrets.
- The Data Probe plugin (`plugins/bonobo-plugin-data-probe`, version 0.3.0 and later) declares it as its `fixture` MCP server.

Use `pnpx wrangler` through Vite Plus. Do not install Wrangler globally.

```powershell
vp env exec pnpm --dir packages/mcp-fixture-worker run typecheck
vp env exec pnpx wrangler deploy --config packages/mcp-fixture-worker/wrangler.jsonc
```

Deploying changes a public test server. Ask before you deploy.
