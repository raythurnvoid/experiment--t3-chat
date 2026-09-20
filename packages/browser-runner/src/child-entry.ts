// Entry for the snippet child bundle. Export ONLY what untrusted snippets may
// use: `connect` reaches the one-session gate binding, and `expect` asserts.
// `launch`, `acquire`, `sessions`, `history`, and `limits` stay unreachable by
// import. Built by `pnpm run build:child` into `src/child-bundle.gen.ts`.
//
// The build keeps class and function names. Playwright's expect matchers check
// `receiver.constructor.name`, so a fully minified bundle breaks every
// locator assertion with "can be only used with Locator object".
// Identifier names also stay intact: Playwright's page scripts expect the
// injected name helper to be called `__name`.

export { connect, expect } from "@cloudflare/playwright/test";
