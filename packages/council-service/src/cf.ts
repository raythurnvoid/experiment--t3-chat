/**
 * The Cloudflare platform surfaces this Worker uses, declared here rather than pulled from
 * `@cloudflare/workers-types`, matching `packages/r2-upload-finalizer`, so the package stays
 * dependency-free. Only the members the code really calls are declared; a new call site extends
 * these types instead of widening them to `any`.
 */

export type D1Result = {
	success: boolean;
	meta: { changes: number };
};

export type D1PreparedStatement = {
	bind: (...values: unknown[]) => D1PreparedStatement;
	first: <T = Record<string, unknown>>() => Promise<T | null>;
	run: () => Promise<D1Result>;
	all: <T = Record<string, unknown>>() => Promise<{ results: T[]; success: boolean }>;
};

export type D1Database = {
	prepare: (query: string) => D1PreparedStatement;
	/** Atomic: one failing statement rolls back every statement in the array. */
	batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>;
};

export type Queue<Body> = {
	send: (body: Body) => Promise<void>;
};

export type QueueMessage<Body> = {
	id: string;
	attempts: number;
	body: Body;
	ack: () => void;
	retry: (options?: { delaySeconds?: number }) => void;
};

export type MessageBatch<Body> = {
	queue: string;
	messages: QueueMessage<Body>[];
};

export type WorkflowInstanceStatus =
	| "queued"
	| "running"
	| "paused"
	| "errored"
	| "terminated"
	| "complete"
	| "waiting"
	| "waitingForPause"
	| "unknown";

export type WorkflowInstanceSnapshot = {
	status: WorkflowInstanceStatus;
};

export type WorkflowInstance = {
	id: string;
	status: () => Promise<WorkflowInstanceSnapshot>;
};

export type WorkflowBinding = {
	/** Throws when no instance has this id. */
	get: (id: string) => Promise<WorkflowInstance>;
	create: (options: { id: string; params: unknown }) => Promise<WorkflowInstance>;
	createBatch: (batch: { id: string; params: unknown }[]) => Promise<WorkflowInstance[]>;
};

export type AiBinding = {
	run: (model: string, inputs: Record<string, unknown>) => Promise<unknown>;
};

export type ScheduledController = {
	scheduledTime: number;
	cron: string;
};

export type ExecutionContext = {
	waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * The step API a Workflow's `run` receives. `do` retries its callback until it succeeds or the
 * retry budget runs out, and replays return the persisted result instead of re-running, so every
 * callback must be idempotent and must return a small serializable value, never file bytes.
 */
export type WorkflowStep = {
	do: <T>(
		name: string,
		configOrCallback: { retries?: { limit: number; delay: string | number; backoff?: string } } | (() => Promise<T>),
		callback?: () => Promise<T>,
	) => Promise<T>;
	sleep: (name: string, duration: string | number) => Promise<void>;
};

export type WorkflowEvent<Params> = {
	payload: Params;
	timestamp: Date;
	instanceId: string;
};
