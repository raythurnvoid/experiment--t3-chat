// Vitest runtime alias for `@cloudflare/playwright`.
// Unit tests mock the provider at the object boundary; live deployed proofs
// cover the real client. Provider calls throw if a test reaches them.

class TimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TimeoutError";
	}
}

export const errors = { TimeoutError };

export async function acquire(): Promise<never> {
	throw new Error("test stub: acquire is unavailable in unit tests");
}

export async function connect(): Promise<never> {
	throw new Error("test stub: connect is unavailable in unit tests");
}

export async function sessions(): Promise<never> {
	throw new Error("test stub: sessions is unavailable in unit tests");
}
