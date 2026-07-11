// CORS / checkout allowlist: use a real URL so `generate_checkout_link` URL checks and server helpers stay consistent.
if (!process.env.ALLOWED_ORIGINS) {
	process.env.ALLOWED_ORIGINS = "https://app.test";
}

// Liveblocks secrets referenced in files_nodes.ts
if (!process.env.LIVEBLOCKS_WEBHOOK_SECRET) {
	process.env.LIVEBLOCKS_WEBHOOK_SECRET = "LIVEBLOCKS_WEBHOOK_SECRET";
}

if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
	process.env.CLERK_WEBHOOK_SIGNING_SECRET = "CLERK_WEBHOOK_SIGNING_SECRET";
}

if (!process.env.ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM) {
	process.env.ANONYMOUS_USERS_JWT_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgOBPgfMSJPZ6xHOFg
/U3CsR0fSj+nJ8nLQe/Jnx4+dBahRANCAASjcftsEHqyxB/LO0KCYAMugMx4u/UO
wPzU9+R+4tCPEByfkjBQ9HtEx7oXl4FZOeN0b1h2TuQUKS+/lC/A01mL
-----END PRIVATE KEY-----`;
}

if (!process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM) {
	process.env.ANONYMOUS_USERS_JWT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEo3H7bBB6ssQfyztCgmADLoDMeLv1
DsD81PfkfuLQjxAcn5IwUPR7RMe6F5eBWTnjdG9Ydk7kFCkvv5QvwNNZiw==
-----END PUBLIC KEY-----`;
}

if (!process.env.VITE_CONVEX_HTTP_URL) {
	process.env.VITE_CONVEX_HTTP_URL = "https://convex.test";
}

if (!process.env.CLERK_SECRET_KEY) {
	process.env.CLERK_SECRET_KEY = "CLERK_SECRET_KEY";
}

if (!process.env.POLAR_SERVER) {
	process.env.POLAR_SERVER = "sandbox";
}

if (!process.env.POLAR_ORGANIZATION_TOKEN) {
	process.env.POLAR_ORGANIZATION_TOKEN = "POLAR_ORGANIZATION_TOKEN_TEST";
}

if (!process.env.MODAL_FILE_CONVERTER_URL) {
	process.env.MODAL_FILE_CONVERTER_URL = "https://modal.test/convert";
}

if (!process.env.MODAL_TOKEN) {
	process.env.MODAL_TOKEN = "MODAL_TOKEN_TEST";
}

if (!process.env.CLOUDFLARE_MEDIA_TRANSFORMER_URL) {
	process.env.CLOUDFLARE_MEDIA_TRANSFORMER_URL = "https://media-transformer.test";
}

if (!process.env.CLOUDFLARE_MEDIA_TRANSFORMER_SECRET) {
	process.env.CLOUDFLARE_MEDIA_TRANSFORMER_SECRET = "CLOUDFLARE_MEDIA_TRANSFORMER_SECRET_TEST";
}

if (!process.env.OPENAI_API_KEY) {
	process.env.OPENAI_API_KEY = "OPENAI_API_KEY_TEST";
}

if (!process.env.CLOUDFLARE_EVENTS_SECRET) {
	process.env.CLOUDFLARE_EVENTS_SECRET = "CLOUDFLARE_EVENTS_SECRET_TEST";
}

if (!process.env.PLUGIN_RUNNER_URL) {
	process.env.PLUGIN_RUNNER_URL = "https://plugin-runner.test";
}

if (!process.env.PLUGIN_RUNNER_SECRET) {
	process.env.PLUGIN_RUNNER_SECRET = "PLUGIN_RUNNER_SECRET_TEST";
}

if (!process.env.PLUGIN_RUNNER_HOST_SECRET) {
	process.env.PLUGIN_RUNNER_HOST_SECRET = "PLUGIN_RUNNER_HOST_SECRET_TEST";
}

if (!process.env.PLUGIN_SECRETS_ENCRYPTION_KEY) {
	process.env.PLUGIN_SECRETS_ENCRYPTION_KEY = "PLUGIN_SECRETS_ENCRYPTION_KEY_TEST";
}

if (!process.env.GITHUB_TOKEN_IMPORT) {
	process.env.GITHUB_TOKEN_IMPORT = "GITHUB_TOKEN_IMPORT_TEST";
}

if (!process.env.R2_BUCKET_FILES) {
	process.env.R2_BUCKET_FILES = "test-files-bucket";
}

if (!process.env.R2_ENDPOINT) {
	process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
}

if (!process.env.R2_ACCESS_KEY_ID) {
	process.env.R2_ACCESS_KEY_ID = "R2_ACCESS_KEY_ID_TEST";
}

if (!process.env.R2_SECRET_ACCESS_KEY) {
	process.env.R2_SECRET_ACCESS_KEY = "R2_SECRET_ACCESS_KEY_TEST";
}
