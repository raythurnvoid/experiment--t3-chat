// CORS origin used by server-utils headers helpers
if (!process.env.ALLOWED_ORIGINS) {
	process.env.ALLOWED_ORIGINS = "ALLOWED_ORIGINS";
}

// Liveblocks secrets referenced in ai_docs_temp.ts
if (!process.env.LIVEBLOCKS_WEBHOOK_SECRET) {
	process.env.LIVEBLOCKS_WEBHOOK_SECRET = "LIVEBLOCKS_WEBHOOK_SECRET";
}
