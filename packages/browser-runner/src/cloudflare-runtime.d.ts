// Ambient types for the Cloudflare module in the package typecheck.

type ExecutionContext = {
	readonly waitUntil: (promise: Promise<unknown>) => void;
	readonly passThroughOnException?: () => void;
	readonly exports?: Record<string, unknown>;
};

declare class WebSocketPair {
	0: WebSocket;
	1: WebSocket;
}

interface ResponseInit {
	webSocket?: WebSocket | null;
}

interface Response {
	readonly webSocket?: WebSocket | null;
}

interface WebSocket {
	accept(): void;
}

declare module "cloudflare:workers" {
	export class WorkerEntrypoint<Env = unknown, Props = unknown> {
		readonly env: Env;
		readonly ctx: ExecutionContext & { readonly props: Props };
	}
}

// `nodejs_compat` gives the Worker `node:buffer`. Playwright `setFiles` needs a real `Buffer`.
declare module "node:buffer" {
	export type Buffer = Uint8Array;
	export const Buffer: {
		from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): Buffer;
	};
}
