// Shared test environment: a real-SQLite D1, recording Queue and Workflow fakes, and a fetch
// router with sensible Convex/provider defaults each test can override per path.

import { test_d1 } from "./d1.ts";
import type { Env, council_QueueMessageBody } from "../src/env.ts";
import { council_encrypt, council_sha256_hex } from "../src/crypto.ts";

export const FUTURE = 4102444800000; // 2100-01-01, far past every test clock.

export function make_test_env(overrides?: Partial<Env>) {
	const queueSent: council_QueueMessageBody[] = [];
	const workflow = {
		instances: new Map<string, { status?: string }>(),
		failCreate: false,
		failGet: null as Error | null,
	};

	const env: Env = {
		CF_VERSION_METADATA: {
			id: "00000000-1111-2222-3333-444444444444",
			tag: "test",
			timestamp: "2026-08-15T00:00:00.000Z",
		},
		COUNCIL_DB: test_d1(),
		COUNCIL_EVENTS: {
			send: async (body) => {
				queueSent.push(body);
			},
		},
		COUNCIL_WORKFLOW: {
			create: async ({ id }) => {
				if (workflow.failCreate) {
					throw new Error("workflow service down");
				}
				workflow.instances.set(id, { status: "running" });
				return { id, status: async () => ({ status: "running" as const }) };
			},
			createBatch: async (batch) => {
				if (workflow.failCreate) {
					throw new Error("workflow service down");
				}
				for (const item of batch) {
					if (!workflow.instances.has(item.id)) {
						workflow.instances.set(item.id, { status: "running" });
					}
				}
				return batch.map((item) => ({ id: item.id, status: async () => ({ status: "running" as const }) }));
			},
			get: async (id) => {
				if (workflow.failGet) {
					throw workflow.failGet;
				}
				if (!workflow.instances.has(id)) {
					throw new Error("instance not found");
				}
				const stored = workflow.instances.get(id);
				const status = typeof stored?.status === "string" && stored.status !== "" ? stored.status : "running";
				return { id, status: async () => ({ status }) };
			},
		},
		AI: {
			run: async () => ({ text: "", segments: [] }),
		},
		COUNCIL_PLUGIN_ORIGIN: "https://plugin-origin.example",
		CONVEX_HTTP_URL: "https://convex.example",
		COUNCIL_TRACK_FILE_PREFIX: "council",
		COUNCIL_MEETING_MAX_MINUTES: "60",
		COUNCIL_MEETING_MAX_PARTICIPANTS: "25",
		COUNCIL_DESTINATION_PATH_PREFIX: "/meetings",
		COUNCIL_MAINTENANCE: "false",
		COUNCIL_ALLOW_MISSING_CLIENT_IP: "false",
		REALTIMEKIT_WEBHOOK_PUBLIC_KEY: "",
		COUNCIL_SERVICE_EXCHANGE_SECRET: "test-exchange-secret",
		REALTIMEKIT_API_TOKEN: "test-api-token",
		REALTIMEKIT_ACCOUNT_ID: "test-account-id",
		REALTIMEKIT_APP_ID: "test-app-id",
		COUNCIL_ROOM_COOKIE_SECRET: "test-cookie-secret",
		...overrides,
	};

	return { env, queueSent, workflow };
}

export type RecordedCall = {
	url: string;
	method: string;
	headers: Headers;
	bodyText: string | null;
	bodyJson: Record<string, unknown> | null;
};

type FetchHandler = (call: RecordedCall) => Response | Promise<Response>;

/**
 * Replace global fetch with a router. `overrides` match by URL substring and win over the
 * defaults; defaults answer the common Convex and provider shapes so a test only scripts what it
 * is about. Call `restore()` in afterEach.
 */
export function install_fetch(overrides: Record<string, FetchHandler> = {}) {
	const calls: RecordedCall[] = [];
	const original = globalThis.fetch;

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		let bodyText: string | null = null;
		if (typeof init?.body === "string") {
			bodyText = init.body;
		} else if (init?.body instanceof Uint8Array) {
			bodyText = new TextDecoder().decode(init.body);
		}
		let bodyJson: Record<string, unknown> | null = null;
		if (bodyText) {
			try {
				bodyJson = JSON.parse(bodyText) as Record<string, unknown>;
			} catch {
				bodyJson = null;
			}
		}
		const call: RecordedCall = { url, method, headers: new Headers(init?.headers), bodyText, bodyJson };
		calls.push(call);

		for (const [needle, handler] of Object.entries(overrides)) {
			if (url.includes(needle)) {
				return await handler(call);
			}
		}
		const fallback = default_handler(call);
		if (fallback) {
			return fallback;
		}
		return Response.json({ message: `no test handler for ${url}` }, { status: 404 });
	}) as typeof fetch;

	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

let addParticipantCounter = 0;

function default_handler(call: RecordedCall): Response | null {
	const { url } = call;

	// Convex service-grant routes.
	if (url.includes("/api/internal/plugins/service-grants/exchange")) {
		return Response.json({
			token: "psg_interactive_test_token",
			expiresAt: FUTURE,
			scopes: ["plugin_data:read", "plugin_data:write"],
			principalKey: "principal-1",
			actorUserId: "user-1",
			organizationId: "org-1",
			workspaceId: "ws-1",
			installationId: "inst-1",
		});
	}
	if (url.includes("/api/internal/plugins/service-grants/verify-live")) {
		return Response.json({ live: true });
	}
	if (url.includes("/api/internal/plugins/service-grants/seal-processing")) {
		return Response.json({
			token: "psg_processing_test_token",
			expiresAt: FUTURE,
			scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
			principalKey: "principal-1",
			destinationPathPrefix: call.bodyJson?.destinationPathPrefix ?? "/meetings/unknown",
			actorUserId: "user-1",
			organizationId: "org-1",
			workspaceId: "ws-1",
			installationId: "inst-1",
		});
	}

	// Convex plugin-data routes.
	if (url.includes("/api/v1/plugin-data/reserve")) {
		// Mirror the host's ceiling: a reservation may not run longer than eight days
		// (plugins_data.ts MAX_RESERVATION_TTL_MS). The real host answers 400, not a refusal name.
		const expiresAt = Number(call.bodyJson?.expiresAt ?? 0);
		if (expiresAt - Date.now() > 8 * 24 * 60 * 60 * 1000) {
			return Response.json({ message: "expiresAt is too far in the future" }, { status: 400 });
		}
		return Response.json({ reservationId: "res-1", remainingBytes: 1, expiresAt });
	}
	if (url.includes("/api/v1/plugin-data/release-reservation")) {
		return Response.json({ releasedBytes: 0 });
	}
	if (url.includes("/api/v1/plugin-data/write-versioned")) {
		return Response.json({ revision: call.bodyJson?.revision ?? 1, byteSize: 1 });
	}
	if (url.includes("/api/v1/plugin-data/delete-versioned")) {
		return Response.json({ deleted: true, revision: call.bodyJson?.revision ?? 1 });
	}

	// Convex service upload routes. The host resolves an upload BY the request's idempotencyKey —
	// the key names one upload run (the meeting), never one call. Mirror that: any key outside the
	// meeting-key namespace answers the host's real 404, so a per-call key in the worker fails here
	// the same way it fails against real Convex.
	const uploadRunKey = (bodyJson: Record<string, unknown> | null) =>
		/^council-uploads-[\w-]+$/u.test(String(bodyJson?.idempotencyKey ?? ""));
	if (
		url.includes("/api/v1/files/service-uploads/create-target") ||
		url.includes("/api/v1/files/service-uploads/remint")
	) {
		if (!uploadRunKey(call.bodyJson)) {
			return Response.json({ message: "Not found" }, { status: 404 });
		}
		const targetKey = String(call.bodyJson?.targetKey ?? "unknown");
		return Response.json({
			state: "pending",
			path: String(call.bodyJson?.path ?? `/meetings/unknown/${targetKey}`),
			nodeId: `node-${targetKey}`,
			uploadUrl: `https://uploads.example/${encodeURIComponent(targetKey)}`,
			headers: { "Content-Type": String(call.bodyJson?.contentType ?? "application/octet-stream") },
			uploadUrlExpiresAt: FUTURE,
		});
	}
	if (url.includes("/api/v1/files/service-uploads/finalize")) {
		if (!uploadRunKey(call.bodyJson)) {
			return Response.json({ message: "Not found" }, { status: 404 });
		}
		const targetKey = String(call.bodyJson?.targetKey ?? "unknown");
		return Response.json({
			state: "committed",
			path: `/meetings/unknown/${targetKey}`,
			nodeId: `node-${targetKey}`,
			actualBytes: 1,
		});
	}
	if (url.includes("/api/v1/files/service-uploads/delete")) {
		return Response.json({ deleted: true });
	}
	// The host takes no path here: the grant's seal names the folder it archives.
	if (url.includes("/api/v1/files/service-uploads/archive-destination")) {
		return Response.json({ archivedNodes: 2 });
	}

	// Upload PUTs.
	if (url.startsWith("https://uploads.example/")) {
		return new Response(null, { status: 200 });
	}

	// Provider routes.
	if (url.includes("/realtime/kit/")) {
		if (url.endsWith("/meetings") && call.method === "POST") {
			return Response.json({ success: true, data: { meeting: { id: "pm-1" } } });
		}
		if (url.includes("/participants") && call.method === "POST") {
			addParticipantCounter += 1;
			return Response.json({
				success: true,
				data: { id: `prov-${addParticipantCounter}`, token: "tokenheader.tokenpayload.tokensig" },
			});
		}
		if (url.includes("/participants/") && call.method === "DELETE") {
			return Response.json({ success: true, data: { action: "delete" } });
		}
		if (url.includes("/recordings/track") && call.method === "POST") {
			return Response.json({ success: true, data: { recording: { id: "rec-1" } } });
		}
		if (url.includes("/active-session/kick-all")) {
			return Response.json({ success: true, data: { action: "kick-all" } });
		}
		if (url.includes("/active-session")) {
			return Response.json({ success: true, data: { id: "sess-1" } });
		}
		if (url.includes("/presets")) {
			// Council's own presets already exist and verify as enabled. The live list endpoint's
			// `data` IS the array (proven read-only against the real provider on 2026-08-16); do not
			// wrap it in an object, or the mock hides a parser that never matches production.
			if (url.endsWith("/presets")) {
				return Response.json({
					success: true,
					data: [
						{ id: "preset-host", name: "council_host_transcription" },
						{ id: "preset-guest", name: "council_guest_transcription" },
						{ id: "preset-stock-host", name: "group_call_host" },
						{ id: "preset-stock-guest", name: "group_call_participant" },
					],
				});
			}
			return Response.json({ success: true, data: { permissions: { transcription_enabled: true } } });
		}
	}

	return null;
}

// #region seed helpers

export async function seed_grant(
	env: Env,
	args?: Partial<{
		id: string;
		installationId: string;
		actorUserId: string;
		phase: "interactive" | "processing";
		destinationPathPrefix: string | null;
		token: string;
		expiresAt: number;
		updatedAt: number;
	}>,
) {
	const id = args?.id ?? "grant-1";
	const token = args?.token ?? "psg_seeded_test_token";
	await env.COUNCIL_DB.prepare(
		`INSERT INTO service_grants (id, organization_id, workspace_id, installation_id, actor_user_id, principal_key, phase, destination_path_prefix, token_encrypted, scopes, expires_at, created_at, updated_at)
		VALUES (?, 'org-1', 'ws-1', ?, ?, 'principal-1', ?, ?, ?, '["plugin_data:read","plugin_data:write"]', ?, 0, ?)`,
	)
		.bind(
			id,
			args?.installationId ?? "inst-1",
			args?.actorUserId ?? "user-1",
			args?.phase ?? "interactive",
			args?.destinationPathPrefix ?? null,
			await council_encrypt(env.COUNCIL_ROOM_COOKIE_SECRET, token),
			args?.expiresAt ?? FUTURE,
			args?.updatedAt ?? 0,
		)
		.run();
	return { id, token };
}

export async function seed_meeting(
	env: Env,
	args?: Partial<{
		id: string;
		code: string;
		installationId: string;
		status: string;
		title: string;
		serviceGrantId: string | null;
		processingGrantId: string | null;
		providerMeetingId: string | null;
		providerSessionId: string | null;
		providerRecordingId: string | null;
		deadlineAt: number | null;
		openedAt: number | null;
		closedAt: number | null;
		recordingStartedAt: number | null;
		participantCount: number;
		processingGeneration: number;
		createdAt: number;
	}>,
) {
	const id = args?.id ?? "meeting-1";
	const code = args?.code ?? "a".repeat(64);
	await env.COUNCIL_DB.prepare(
		`INSERT INTO meetings (id, code_hash, organization_id, workspace_id, installation_id, plugin_name, title, created_by_user_id, service_grant_id, processing_grant_id, destination_path, provider_meeting_id, provider_session_id, provider_recording_id, status, deadline_at, opened_at, closed_at, recording_started_at, participant_count, processing_generation, created_at, updated_at)
		VALUES (?, ?, 'org-1', 'ws-1', ?, 'council', ?, 'user-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			id,
			await council_sha256_hex(code),
			args?.installationId ?? "inst-1",
			args?.title ?? "Test meeting",
			args?.serviceGrantId === undefined ? "grant-1" : args.serviceGrantId,
			args?.processingGrantId ?? null,
			`/meetings/${id}`,
			args?.providerMeetingId === undefined ? "pm-1" : args.providerMeetingId,
			args?.providerSessionId ?? null,
			args?.providerRecordingId ?? null,
			args?.status ?? "created",
			args?.deadlineAt ?? null,
			args?.openedAt ?? null,
			args?.closedAt ?? null,
			args?.recordingStartedAt ?? null,
			args?.participantCount ?? 0,
			args?.processingGeneration ?? 0,
			args?.createdAt ?? 0,
			args?.createdAt ?? 0,
		)
		.run();
	return { id, code };
}

export async function seed_participant(
	env: Env,
	args: Partial<{
		id: string;
		meetingId: string;
		displayName: string;
		role: "host" | "guest";
		joinAttemptId: string;
		providerParticipantId: string | null;
		providerTokenEncrypted: string | null;
		acceptedAt: number | null;
	}>,
) {
	const id = args.id ?? crypto.randomUUID();
	await env.COUNCIL_DB.prepare(
		`INSERT INTO meeting_participants (id, meeting_id, display_name, role, join_attempt_id, provider_participant_id, provider_token_encrypted, accepted_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
	)
		.bind(
			id,
			args.meetingId ?? "meeting-1",
			args.displayName ?? "Guest",
			args.role ?? "guest",
			args.joinAttemptId ?? (args.role === "host" ? "host-user-1" : crypto.randomUUID()),
			args.providerParticipantId ?? null,
			args.providerTokenEncrypted ?? null,
			args.acceptedAt ?? null,
		)
		.run();
	return { id };
}

/** Insert a live room session and return the raw cookie and CSRF values a request would send. */
export async function seed_room_session(
	env: Env,
	args: {
		meetingId: string;
		participantId: string;
		role: "host" | "guest";
		actorServiceGrantId?: string | null;
	},
) {
	const sessionToken = "b".repeat(64);
	const csrfToken = "c".repeat(64);
	const actorServiceGrantId = args.role === "host" ? (args.actorServiceGrantId ?? "grant-1") : null;
	await env.COUNCIL_DB.prepare(
		`INSERT INTO room_sessions (token_hash, meeting_id, participant_id, role, actor_service_grant_id, csrf_token_hash, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
	)
		.bind(
			await council_sha256_hex(sessionToken),
			args.meetingId,
			args.participantId,
			args.role,
			actorServiceGrantId,
			await council_sha256_hex(csrfToken),
			FUTURE,
		)
		.run();
	return { sessionToken, csrfToken };
}

// #endregion seed helpers
