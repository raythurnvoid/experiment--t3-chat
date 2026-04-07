// CORS / checkout allowlist: use a real URL so `generate_checkout_link` URL checks and server helpers stay consistent.
if (!process.env.ALLOWED_ORIGINS) {
	process.env.ALLOWED_ORIGINS = "https://app.test";
}

// Liveblocks secrets referenced in ai_docs_temp.ts
if (!process.env.LIVEBLOCKS_WEBHOOK_SECRET) {
	process.env.LIVEBLOCKS_WEBHOOK_SECRET = "LIVEBLOCKS_WEBHOOK_SECRET";
}

if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
	process.env.CLERK_WEBHOOK_SIGNING_SECRET = "CLERK_WEBHOOK_SIGNING_SECRET";
}

if (!process.env.ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM) {
	process.env.ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM = "ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM";
}

if (!process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM) {
	process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM = "ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM";
}

if (!process.env.VITE_CONVEX_HTTP_URL) {
	process.env.VITE_CONVEX_HTTP_URL = "https://convex.test";
}

if (!process.env.CLERK_SECRET_KEY) {
	process.env.CLERK_SECRET_KEY = "CLERK_SECRET_KEY";
}

if (!process.env.POLAR_PRODUCTS_PREFIX) {
	process.env.POLAR_PRODUCTS_PREFIX = "test";
}

// convex-test runs `ctx.scheduler.runAfter` via setTimeout; draining Polar from that path can throw
// on `_scheduled_functions` writes. Keep scheduled drain disabled by default in Vitest and call
// `drain_outbox` explicitly in dedicated drain tests via `t.action`.
if (!process.env.BILLING_SKIP_SCHEDULED_DRAIN) {
	process.env.BILLING_SKIP_SCHEDULED_DRAIN = "1";
}
