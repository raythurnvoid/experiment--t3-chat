// Vitest runtime alias for `cloudflare:workers`.
// Ambient typecheck support lives in cloudflare-runtime.d.ts.

type WorkerEntrypointContext<Props> = {
	readonly props: Props;
	readonly waitUntil: (promise: Promise<unknown>) => void;
};

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
	readonly env: Env;
	readonly ctx: WorkerEntrypointContext<Props>;

	constructor() {
		this.env = {} as Env;
		this.ctx = { props: {} as Props, waitUntil: () => {} };
	}
}
