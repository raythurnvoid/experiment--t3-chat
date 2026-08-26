/**
 * The one RealtimeKit adapter. Every provider detail stays behind this module so a provider
 * reversal replaces this file instead of leaking a second provider model through the service.
 *
 * The facts this module encodes were measured in the M0 live runs, not read from documentation:
 *
 * - Transcription runs only when the participant's preset carries
 *   `permissions.transcription_enabled: true`. Stock presets lack the field, so Council creates
 *   and verifies its own presets, reading the preset DETAIL endpoint — the list endpoint returns
 *   no permissions at all, so a list-level null means "not read", not "absent".
 * - `?meeting_id=` on GET /sessions does not filter. Sessions are matched client-side on
 *   `session.associated_id`, or a previous meeting's transcript would read as this meeting's.
 * - HTTP 200 never means ready: the transcript metadata route hands out a working presigned URL
 *   before the object has bytes, and that URL answers 200 with an empty body for minutes.
 *   Readiness is nonzero downloaded bytes that then parse into at least one non-empty sentence.
 * - Track filenames carry the Add Participant response `data.id`, not `custom_participant_id`.
 * - `format` is a strict UPPERCASE enum; the JSON shape nests the speaker under `peerData`.
 */

import { Result } from "./result.ts";
import type { Env } from "./env.ts";
import { council_read_stream_with_limit } from "./http.ts";

/** The only origin the provider bearer may ever be sent to. */
const PROVIDER_ORIGIN = "https://api.cloudflare.com";

function app_base(env: Env) {
	return `${PROVIDER_ORIGIN}/client/v4/accounts/${env.REALTIMEKIT_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}`;
}

type ProviderResponse = {
	status: number;
	ok: boolean;
	body: unknown;
};

/**
 * Call the provider and return the parsed envelope plus HTTP status. Never throws on a non-2xx —
 * a refusal is data the caller maps to its own error — but a thrown network error propagates,
 * because "the answer was lost" and "the provider said no" are different states in the meeting
 * machine and must not be collapsed.
 */
async function provider_fetch(
	env: Env,
	path: string,
	init?: { method?: string; body?: string },
): Promise<ProviderResponse> {
	const url = path.startsWith("http") ? path : `${app_base(env)}${path}`;
	// Check the origin before the request, not after: sending the Authorization header to a wrong
	// host is the damage, whatever the response says.
	if (new URL(url).origin !== PROVIDER_ORIGIN) {
		throw new Error("Refusing to send the provider token to a non-provider origin");
	}

	const response = await fetch(url, {
		method: init?.method ?? "GET",
		headers: {
			Authorization: `Bearer ${env.REALTIMEKIT_API_TOKEN}`,
			...(init?.body ? { "Content-Type": "application/json" } : {}),
		},
		body: init?.body,
	});
	const text = await response.text();
	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = null;
	}
	return { status: response.status, ok: response.ok, body };
}

function body_data(response: ProviderResponse): Record<string, unknown> | null {
	const body = response.body;
	if (typeof body !== "object" || body === null) {
		return null;
	}
	const data = (body as Record<string, unknown>).data;
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

/**
 * Say whether a response field is a provider id, token, or URL this service may keep.
 *
 * `typeof value === "string"` also accepts `""`, and an empty string is none of those things. Three
 * concrete things go wrong if one is kept. An empty id lands in the next request path as
 * `/participants/` instead of naming one participant. An empty id stored in D1 reads back as
 * absent, because `discover_tracks` and `fetch_provider_transcript` in `pipeline.ts` both test
 * their column for truthiness — the meeting would then publish no tracks and no diagnostic while
 * the column says the id is set. An empty token is handed to a member as a working join credential,
 * and the row records that admission as finished, so no retry ever mints a real one.
 *
 * So treat an empty string exactly like a missing field. Each caller below already has its own
 * answer for a missing one — a provider refusal, a null session id, a preset it creates instead, or
 * a track file it skips — and that same answer is the right one for an empty field too.
 */
function nonempty_string(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function provider_nay(operation: string, response: ProviderResponse) {
	// Status and provider error code only. Provider bodies can carry tokens and presigned URLs, so
	// they never reach a message.
	return Result<never>({
		_nay: { name: "provider_refused", message: `${operation} returned HTTP ${response.status}` },
	});
}

// #region presets

const PRESET_SOURCES = {
	host: "group_call_host",
	guest: "group_call_participant",
} as const;

export const council_PRESET_NAMES = {
	host: "council_host_transcription",
	guest: "council_guest_transcription",
} as const;

/**
 * Make sure Council's own transcription-enabled preset exists for a role and really carries the
 * permission. Returns the preset name to use on Add Participant. Never trusts the list endpoint's
 * permissions and never assumes a stock preset works.
 */
export async function council_provider_ensure_preset(env: Env, role: "host" | "guest") {
	const targetName = council_PRESET_NAMES[role];

	const list = await provider_fetch(env, "/presets");
	if (!list.ok) {
		return provider_nay("List presets", list);
	}
	// The list envelope's `data` IS the presets array (proven read-only against the live provider
	// on 2026-08-16); object-shaped `data` belongs to detail and create answers only.
	const data = body_data(list);
	const presets = (Array.isArray(data) ? data : []) as {
		id?: unknown;
		name?: unknown;
	}[];
	const listed = (name: string) => presets.find((preset) => preset.name === name);

	const existing = listed(targetName);
	if (existing && nonempty_string(existing.id)) {
		// Verify through the DETAIL read. Require strict `=== true`.
		const detail = await provider_fetch(env, `/presets/${existing.id}`);
		const detailData = body_data(detail);
		const permissions = detailData?.permissions as Record<string, unknown> | undefined;
		if (detail.ok && permissions?.transcription_enabled === true) {
			return Result({ _yay: { presetName: targetName, presetId: existing.id } });
		}
		return Result<never>({
			_nay: {
				name: "preset_invalid",
				message: `Preset ${targetName} exists but does not carry transcription_enabled`,
			},
		});
	}

	const source = listed(PRESET_SOURCES[role]);
	if (!source || !nonempty_string(source.id)) {
		return Result<never>({
			_nay: { name: "preset_missing", message: `Stock preset ${PRESET_SOURCES[role]} was not found` },
		});
	}
	const sourceDetail = await provider_fetch(env, `/presets/${source.id}`);
	const sourceData = body_data(sourceDetail);
	if (!sourceDetail.ok || !sourceData) {
		return provider_nay("Read stock preset", sourceDetail);
	}

	// Clone config and ui verbatim and add only the one permission that switches transcription on.
	const created = await provider_fetch(env, "/presets", {
		method: "POST",
		body: JSON.stringify({
			name: targetName,
			config: sourceData.config,
			permissions: { ...(sourceData.permissions as Record<string, unknown>), transcription_enabled: true },
			ui: sourceData.ui,
		}),
	});
	const createdData = body_data(created);
	if (!created.ok || !createdData || !nonempty_string(createdData.id)) {
		return provider_nay("Create preset", created);
	}
	return Result({ _yay: { presetName: targetName, presetId: createdData.id } });
}

// #endregion presets

// #region meeting lifecycle

/**
 * Create the provider meeting. `transcribe_on_end: true` is required at create, and
 * `record_on_start: false` because the authenticated host decides when recording begins.
 */
export async function council_provider_create_meeting(env: Env, title: string) {
	const response = await provider_fetch(env, "/meetings", {
		method: "POST",
		body: JSON.stringify({
			title,
			transcribe_on_end: true,
			record_on_start: false,
			ai_config: { transcription: { language: "en-US" } },
		}),
	});
	const data = body_data(response);
	const meeting = (data?.meeting ?? data) as Record<string, unknown> | null;
	if (!response.ok || !meeting || !nonempty_string(meeting.id)) {
		return provider_nay("Create meeting", response);
	}
	return Result({ _yay: { providerMeetingId: meeting.id } });
}

/**
 * Add one participant. Returns both ids Council must keep: the durable `customParticipantId` it
 * sent, and the separate response `data.id` the provider writes into track filenames. The token
 * is the participant's join credential; the caller stores it encrypted or not at all.
 */
export async function council_provider_add_participant(
	env: Env,
	args: { providerMeetingId: string; name: string; presetName: string; customParticipantId: string },
) {
	const response = await provider_fetch(env, `/meetings/${args.providerMeetingId}/participants`, {
		method: "POST",
		body: JSON.stringify({
			name: args.name,
			preset_name: args.presetName,
			custom_participant_id: args.customParticipantId,
		}),
	});
	const data = body_data(response);
	if (!response.ok || !data || !nonempty_string(data.id) || !nonempty_string(data.token)) {
		return provider_nay("Add participant", response);
	}
	return Result({ _yay: { providerParticipantId: data.id, token: data.token } });
}

/** Delete a provider participant whose token must never become usable after a close race. */
export async function council_provider_delete_participant(
	env: Env,
	args: { providerMeetingId: string; providerParticipantId: string },
) {
	const response = await provider_fetch(
		env,
		`/meetings/${args.providerMeetingId}/participants/${args.providerParticipantId}`,
		{ method: "DELETE" },
	);
	if (!response.ok) {
		return provider_nay("Delete participant", response);
	}
	return Result({ _yay: true });
}

/**
 * Start TRACK recording: one audio file per participant, named with the Add Participant id, which
 * is the attribution the whole design rests on. `layers` is omitted on purpose — the live
 * validator rejects the documented string shape, and omitting it yields the per-participant
 * naming. `max_seconds` enforces the meeting cap provider-side whatever else happens.
 */
export async function council_provider_start_track_recording(
	env: Env,
	args: { providerMeetingId: string; maxSeconds: number },
) {
	const response = await provider_fetch(env, "/recordings/track", {
		method: "POST",
		body: JSON.stringify({ meeting_id: args.providerMeetingId, max_seconds: args.maxSeconds }),
	});
	const data = body_data(response);
	const recording = (data?.recording ?? data) as Record<string, unknown> | null;
	if (!response.ok || !recording || !nonempty_string(recording.id)) {
		return provider_nay("Start track recording", response);
	}
	return Result({ _yay: { providerRecordingId: recording.id } });
}

/**
 * Stop a running recording. The provider does NOT stop a track recording when the session ends —
 * proven live on 2026-08-16, where a recording stayed RECORDING for 25+ minutes after kick-all
 * emptied the room — it runs to its max_seconds cap instead, and the track files publish only
 * after the stop. So the close path and the processing pipeline both stop it explicitly.
 */
export async function council_provider_stop_recording(env: Env, recordingId: string) {
	const response = await provider_fetch(env, `/recordings/${recordingId}`, {
		method: "PUT",
		body: JSON.stringify({ action: "stop" }),
	});
	if (!response.ok) {
		return provider_nay("Stop recording", response);
	}
	return Result({ _yay: true });
}

/**
 * End the active session by removing everyone. Normal leave also ends a session, so this is a
 * cleanup guarantee for the host-close and deadline paths, not a transcription prerequisite.
 */
export async function council_provider_kick_all(env: Env, providerMeetingId: string) {
	const response = await provider_fetch(env, `/meetings/${providerMeetingId}/active-session/kick-all`, {
		method: "POST",
		body: JSON.stringify({}),
	});
	if (!response.ok) {
		return provider_nay("Kick all", response);
	}
	return Result({ _yay: true });
}

export async function council_provider_get_active_session(env: Env, providerMeetingId: string) {
	const response = await provider_fetch(env, `/meetings/${providerMeetingId}/active-session`);
	const data = body_data(response);
	if (!response.ok || !data || !nonempty_string(data.id)) {
		return Result({ _yay: { sessionId: null as string | null } });
	}
	return Result({ _yay: { sessionId: data.id as string | null } });
}

/**
 * Find this meeting's session. The list is fetched wide and matched on `associated_id` here,
 * because the provider's own `meeting_id` filter does not filter.
 */
export async function council_provider_find_session(env: Env, providerMeetingId: string) {
	const response = await provider_fetch(env, `/sessions?meeting_id=${providerMeetingId}`);
	const data = body_data(response);
	const sessions = (Array.isArray(data?.sessions) ? data.sessions : Array.isArray(data) ? data : []) as Record<
		string,
		unknown
	>[];
	if (!response.ok) {
		return provider_nay("List sessions", response);
	}

	const matched = sessions.filter((session) => session.associated_id === providerMeetingId);
	if (matched.length !== 1 || !nonempty_string(matched[0].id)) {
		// Zero and several are both refusals: picking one of several would read another run's data.
		return Result({
			_yay: { sessionId: null as string | null, matchCount: matched.length },
		});
	}
	return Result({ _yay: { sessionId: matched[0].id as string | null, matchCount: 1 } });
}

/**
 * Read the persisted session. Status and `settings.transcribe_on_end` come from here, never from
 * a remembered create response.
 */
export async function council_provider_get_session(env: Env, sessionId: string) {
	const response = await provider_fetch(env, `/sessions/${sessionId}`);
	const data = body_data(response);
	if (!response.ok || !data) {
		return provider_nay("Read session", response);
	}
	const settings = data.settings as Record<string, unknown> | undefined;
	return Result({
		_yay: {
			status: typeof data.status === "string" ? data.status : null,
			transcribeOnEnd: settings?.transcribe_on_end === true,
		},
	});
}

// #endregion meeting lifecycle

// #region artifacts

export type council_ProviderTrackFile = {
	fileName: string;
	downloadUrl: string;
};

/**
 * Read the recording and list its per-participant track files. The download URLs are presigned
 * capabilities that live for seven days; they are handed to the streaming download and never
 * stored or logged.
 */
export async function council_provider_get_recording(env: Env, recordingId: string) {
	const response = await provider_fetch(env, `/recordings/${recordingId}`);
	// The provider drops a recording after its seven-day expiry, so 404 is its own answer: the
	// recording is gone, not refused. `council_run_deletion` skips its recording stop on exactly
	// this name. Every other refusal keeps `provider_refused`, so a transient error can never read
	// like the recording being gone.
	if (response.status === 404) {
		return Result<never>({
			_nay: { name: "not_found", message: "Read recording returned HTTP 404" },
		});
	}
	const envelope = body_data(response);
	const recording = (envelope?.recording ?? envelope) as Record<string, unknown> | null;
	if (!response.ok || !recording) {
		return provider_nay("Read recording", response);
	}

	const downloadUrl = recording.download_url as Record<string, unknown> | undefined;
	const linkGroups = (Array.isArray(downloadUrl?.links) ? downloadUrl.links : []) as Record<string, unknown>[];
	const downloadUrls = (linkGroups[0]?.download_urls ?? {}) as Record<string, { download_url?: unknown }>;
	const trackFiles: council_ProviderTrackFile[] = [];
	for (const [fileName, entry] of Object.entries(downloadUrls)) {
		if (entry && nonempty_string(entry.download_url)) {
			trackFiles.push({ fileName, downloadUrl: entry.download_url });
		}
	}

	return Result({
		_yay: {
			status: typeof recording.status === "string" ? recording.status : null,
			// Duration 0 after stop, with no files, is the hang we measured live. The pipeline
			// reads this to tell that hang apart from a slow upload that is still writing bytes.
			recordingDuration: typeof recording.recording_duration === "number" ? recording.recording_duration : null,
			trackFiles,
		},
	});
}

/**
 * Open one track file as a stream. The body is never buffered here — the caller pipes it to the
 * upload and reads a bounded copy for transcription.
 */
export async function council_provider_download_track(downloadUrl: string) {
	const response = await fetch(downloadUrl);
	if (!response.ok || !response.body) {
		return Result<never>({
			_nay: { name: "provider_refused", message: `Track download returned HTTP ${response.status}` },
		});
	}
	const contentLength = Number(response.headers.get("Content-Length"));
	return Result({
		_yay: {
			stream: response.body,
			contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
		},
	});
}

/**
 * The provider transcript is a diagnostic file, and the people in the meeting decide how big it
 * gets. Read it with a cap so one very long meeting cannot buffer an unbounded string into the
 * Worker. A few megabytes is far more than a JSON transcript of a one-hour meeting needs.
 */
const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Fetch the provider's own transcript once. HTTP 200 is never readiness: the caller polls until
 * this returns nonzero bytes that parse into at least one non-empty sentence. The artifact is a
 * diagnostic only — its speaker identity is placeholder garbage today (rule 6 of the provider
 * correction) — so `null` after the polling budget is not a pipeline failure.
 */
export async function council_provider_fetch_transcript(env: Env, sessionId: string) {
	const metadata = await provider_fetch(env, `/sessions/${sessionId}/transcript?format=JSON`);
	const data = body_data(metadata);
	const url = data?.transcript_download_url;
	if (typeof url !== "string" || !url.startsWith("https://")) {
		return Result({ _yay: { ready: false as const } });
	}

	const download = await fetch(url);
	if (!download.ok || !download.body) {
		return Result({ _yay: { ready: false as const } });
	}
	const bytes = await council_read_stream_with_limit(download.body, TRANSCRIPT_MAX_BYTES);
	// Answer not-ready, the same as a transcript the provider has not finished writing. The caller
	// polls, gives up, and finishes the meeting without the diagnostic file. Losing a diagnostic
	// must never fail a run that already has its transcript and summary.
	if (bytes._nay) {
		console.warn("The provider transcript is larger than the diagnostic cap; continuing without it", {
			sessionId,
			maxBytes: TRANSCRIPT_MAX_BYTES,
		});
		return Result({ _yay: { ready: false as const } });
	}
	const text = new TextDecoder().decode(bytes._yay);
	if (text.length === 0) {
		return Result({ _yay: { ready: false as const } });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return Result({ _yay: { ready: false as const } });
	}
	// `[]` is valid JSON and 2 bytes, so a bare parse check passes on a transcript that is still
	// being generated. Require at least one line with a non-empty sentence.
	if (
		!Array.isArray(parsed) ||
		!parsed.some((line) => typeof line?.sentence === "string" && line.sentence.length > 0)
	) {
		return Result({ _yay: { ready: false as const } });
	}

	const speakerIds = parsed
		.map((line) => (line as { peerData?: { id?: unknown } }).peerData?.id)
		.filter((id): id is string => typeof id === "string");
	return Result({ _yay: { ready: true as const, rawJson: text, speakerIds } });
}

// #endregion artifacts
