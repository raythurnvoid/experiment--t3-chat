// Ambient types for the Cloudflare module in the package typecheck.

type ExecutionContext = {
	readonly waitUntil: (promise: Promise<unknown>) => void;
	readonly passThroughOnException?: () => void;
	readonly exports?: Record<string, unknown>;
};

declare module "cloudflare:workers" {
	export class WorkerEntrypoint<Env = unknown, Props = unknown> {
		readonly env: Env;
		readonly ctx: ExecutionContext & { readonly props: Props };
	}
}
