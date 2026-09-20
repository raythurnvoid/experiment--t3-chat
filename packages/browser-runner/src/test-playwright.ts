// Vitest runtime alias for `@cloudflare/playwright`.
// Unit tests mock the provider at the object boundary; live deployed proofs
// cover the real client. These stubs throw if a test reaches them.

export async function acquire(): Promise<never> {
	throw new Error("test stub: acquire is unavailable in unit tests");
}

export async function connect(): Promise<never> {
	throw new Error("test stub: connect is unavailable in unit tests");
}

export async function sessions(): Promise<never> {
	throw new Error("test stub: sessions is unavailable in unit tests");
}
