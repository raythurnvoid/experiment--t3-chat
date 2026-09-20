// Vitest runtime alias for `cloudflare:workers`.
// Ambient typecheck support lives in cloudflare-runtime.d.ts.

type WorkerEntrypointContext<Props> = {
	readonly props: Props;
	readonly waitUntil: (promise: Promise<unknown>) => void;
};

// The Playwright client reads `env` for endpoint URLs. Tests pass the binding
// object directly, so this stays an empty record.
export const env: Record<string, unknown> = {};

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
	readonly env: Env;
	readonly ctx: WorkerEntrypointContext<Props>;

	constructor() {
		this.env = {} as Env;
		this.ctx = { props: {} as Props, waitUntil: () => {} };
	}
}
