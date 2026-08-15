// Node stand-in for the runtime-provided `cloudflare:workflows` module. Vitest aliases the
// specifier here so pipeline tests can throw NonRetryableError without a live Worker runtime.
export class NonRetryableError extends Error {
	constructor(message: string, name?: string) {
		super(message);
		this.name = name ?? "NonRetryableError";
	}
}
