export type R2EventNotification = {
	account?: string;
	action: string;
	bucket: string;
	object: {
		key: string;
		size?: number;
		eTag?: string;
	};
	eventTime: string;
};

export type Env = {
	CONVEX_HTTP_URL: string;
	EVENTS_SECRET: string;
	R2_FILES_BUCKET: string;
	R2_UPLOAD_PREFIX: string;
};

type QueueRetryOptions = {
	delaySeconds?: number;
};

export type QueueMessage<T> = {
	id: string;
	attempts: number;
	body: T;
	ack: () => void;
	retry: (options?: QueueRetryOptions) => void;
};

type MessageBatch<T> = {
	messages: QueueMessage<T>[];
};

export type HandleR2EventMessageResult =
	| {
			type: "ack";
			reason: string;
	  }
	| {
			type: "retry";
			reason: string;
			delaySeconds: number;
	  };

function is_record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function is_r2_event_notification(value: unknown): value is R2EventNotification {
	if (!is_record(value) || !is_record(value.object)) {
		return false;
	}

	return (
		(value.account === undefined || typeof value.account === "string") &&
		typeof value.action === "string" &&
		typeof value.bucket === "string" &&
		typeof value.object.key === "string" &&
		(value.object.size === undefined || typeof value.object.size === "number") &&
		(value.object.eTag === undefined || typeof value.object.eTag === "string") &&
		typeof value.eventTime === "string"
	);
}

function should_process_r2_event(event: R2EventNotification, env: Env) {
	return event.bucket === env.R2_FILES_BUCKET && event.object.key.startsWith(env.R2_UPLOAD_PREFIX);
}

function normalize_convex_http_url(value: string) {
	return value.replace(/\/+$/, "");
}

function is_retryable_convex_status(status: number) {
	return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retry_delay_seconds(attempts: number) {
	return Math.min(300, 2 ** Math.min(Math.max(attempts, 0), 8));
}

export async function handle_r2_event_message(
	message: QueueMessage<unknown>,
	env: Env,
): Promise<HandleR2EventMessageResult> {
	if (!is_r2_event_notification(message.body)) {
		return {
			type: "ack",
			reason: "Invalid R2 event notification payload",
		};
	}

	if (!should_process_r2_event(message.body, env)) {
		return {
			type: "ack",
			reason: "R2 event is outside this worker scope",
		};
	}

	let response: Response;
	try {
		response = await fetch(`${normalize_convex_http_url(env.CONVEX_HTTP_URL)}/api/r2/event`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: message.id,
				attempts: message.attempts,
				event: message.body,
			}),
		});
	} catch {
		return {
			type: "retry",
			reason: "Convex HTTP request failed",
			delaySeconds: retry_delay_seconds(message.attempts),
		};
	}

	if (response.ok) {
		return {
			type: "ack",
			reason: "Convex accepted the event",
		};
	}

	if (is_retryable_convex_status(response.status)) {
		return {
			type: "retry",
			reason: `Convex returned retryable status ${response.status}`,
			delaySeconds: retry_delay_seconds(message.attempts),
		};
	}

	return {
		type: "ack",
		reason: `Convex returned non-retryable status ${response.status}`,
	};
}

export default {
	async queue(batch: MessageBatch<unknown>, env: Env) {
		for (const message of batch.messages) {
			const result = await handle_r2_event_message(message, env);
			if (result.type === "retry") {
				message.retry({ delaySeconds: result.delaySeconds });
				continue;
			}

			message.ack();
		}
	},

	async fetch() {
		return new Response("ok");
	},
};
