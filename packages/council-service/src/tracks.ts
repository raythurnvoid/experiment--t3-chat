/**
 * Speaker attribution for a Council meeting.
 *
 * The provider's own transcript cannot say who spoke. Every segment it returns carries the literals
 * `TEST`, `unique_id`, `user_id`, and `custom_participant_id` in `peerData`, while the session
 * participant endpoint reports the real names for the same session. So Council never reads identity
 * out of the transcript. It reads identity out of the *file*: track recording writes one audio file
 * per participant and puts the provider's Add Participant response id into the file name.
 *
 * Council keeps its own `custom_participant_id` as the durable participant id. It also records the
 * separate `data.id` returned by Add Participant and matches that provider id from the track name
 * back to the durable participant. Nothing in the chain depends on a name the provider filled in.
 */

/** One participant of a meeting, as Council recorded it when the participant was created. */
export type council_Participant = {
	/** The durable `custom_participant_id` Council generated. */
	participantId: string;
	/** The separate Add Participant response `data.id` that the provider writes into track names. */
	providerParticipantId: string;
	displayName: string;
};

/** One line of speech from a single participant's own audio track. */
export type council_TrackSegment = {
	startMs: number;
	endMs: number;
	text: string;
};

/**
 * One downloaded track file and the speech found in it.
 *
 * `startOffsetMs` moves this track onto the meeting clock. Each track starts when its participant
 * joined, not when the recording started, so two tracks with the same segment times are not
 * simultaneous. The caller reads every track's start from the timestamp in its file name, takes the
 * earliest of those as the meeting clock zero, and passes this track's timestamp minus that zero.
 * So the zero is the first track that was recorded, not the moment the meeting or the recording
 * began. A participant who joined before that track still gets offset 0, never a negative one. File
 * names need no extra provider call, so the same files always replay to the same offsets.
 */
export type council_Track = {
	fileName: string;
	startOffsetMs: number;
	segments: council_TrackSegment[];
};

/** One attributed line of the finished transcript, on the meeting clock. */
export type council_AttributedSegment = {
	startMs: number;
	endMs: number;
	text: string;
	participantId: string;
	displayName: string;
};

/**
 * The parts of a track file name. The provider builds it as
 * `{prefix}_{userId}_{peerId}_{streamKind}_{mediaKind}_{unixMs}.webm`.
 */
export type council_TrackFileName = {
	prefix: string;
	providerParticipantId: string;
	peerId: string;
	streamKind: string;
	mediaKind: string;
	recordedAtMs: number;
};

/** The last five underscore-separated fields are fixed, so read the name from its end. */
const TRACK_FILE_NAME_TRAILING_FIELDS = 5;

/**
 * Read a track file name.
 *
 * Parse from the end, never from the start. The leading field is a caller-chosen prefix that may
 * itself contain underscores, so counting forward would read part of the prefix as the participant
 * id. The last five fields are fixed by the provider, so counting backward is stable.
 */
export function council_parse_track_file_name(fileName: string): council_TrackFileName | null {
	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex <= 0) {
		return null;
	}

	const parts = fileName.slice(0, dotIndex).split("_");
	if (parts.length < TRACK_FILE_NAME_TRAILING_FIELDS + 1) {
		return null;
	}

	const [providerParticipantId, peerId, streamKind, mediaKind, recordedAt] = parts.slice(
		-TRACK_FILE_NAME_TRAILING_FIELDS,
	);
	const prefix = parts.slice(0, -TRACK_FILE_NAME_TRAILING_FIELDS).join("_");
	// A non-numeric timestamp means the name is not the shape we think it is. Refuse rather than
	// attribute speech to whichever field happened to land in the id position.
	if (!/^\d+$/u.test(recordedAt) || providerParticipantId.length === 0 || peerId.length === 0) {
		return null;
	}

	return {
		prefix,
		providerParticipantId,
		peerId,
		streamKind,
		mediaKind,
		recordedAtMs: Number(recordedAt),
	};
}

/** Why a track could not be attributed. Every reason drops the whole track rather than guessing. */
export type council_TrackRejection = {
	fileName: string;
	reason: "unreadable_file_name" | "unknown_participant" | "not_an_audio_peer_track";
};

export type council_AttributionResult = {
	segments: council_AttributedSegment[];
	rejected: council_TrackRejection[];
};

/**
 * Bind every track's speech to the participant whose provider id appears in the file name.
 *
 * A track whose provider id is not in the participant list is dropped, not guessed at. Attributing
 * it to the nearest participant would put one person's words under another person's name, which is
 * the exact failure this whole design exists to prevent.
 *
 * One participant can produce several tracks, because reconnecting starts a new peer. Those tracks
 * share a participant id and different peer ids, so they merge naturally.
 */
export function council_attribute_tracks(args: {
	tracks: council_Track[];
	participants: council_Participant[];
}): council_AttributionResult {
	const participantsByProviderId = new Map(
		args.participants.map((participant) => [participant.providerParticipantId, participant]),
	);

	const segments: council_AttributedSegment[] = [];
	const rejected: council_TrackRejection[] = [];

	for (const track of args.tracks) {
		const parsed = council_parse_track_file_name(track.fileName);
		if (!parsed) {
			rejected.push({ fileName: track.fileName, reason: "unreadable_file_name" });
			continue;
		}

		// Track recording writes audio peer streams. A screen-share or video file reaching this list
		// would carry a different participant timeline, so it is not merged into the spoken transcript.
		if (parsed.streamKind !== "peer" || parsed.mediaKind !== "audio") {
			rejected.push({ fileName: track.fileName, reason: "not_an_audio_peer_track" });
			continue;
		}

		const participant = participantsByProviderId.get(parsed.providerParticipantId);
		if (!participant) {
			rejected.push({ fileName: track.fileName, reason: "unknown_participant" });
			continue;
		}

		for (const segment of track.segments) {
			segments.push({
				startMs: segment.startMs + track.startOffsetMs,
				endMs: segment.endMs + track.startOffsetMs,
				text: segment.text,
				participantId: participant.participantId,
				displayName: participant.displayName,
			});
		}
	}

	// Meeting order, and a stable tiebreak so two speakers starting in the same millisecond do not
	// swap places between runs and make the stored artifact non-reproducible.
	segments.sort((left, right) => {
		if (left.startMs !== right.startMs) {
			return left.startMs - right.startMs;
		}
		if (left.endMs !== right.endMs) {
			return left.endMs - right.endMs;
		}
		return left.participantId < right.participantId ? -1 : left.participantId > right.participantId ? 1 : 0;
	});

	return { segments, rejected };
}

/**
 * The provider fills these into `peerData` instead of a real speaker. Treat them as reserved: a
 * transcript carrying one of them has no identity in it, whatever else it contains.
 */
const PROVIDER_PLACEHOLDER_SPEAKER_IDS = new Set(["TEST", "unique_id", "user_id", "custom_participant_id"]);

/**
 * Say whether the provider's own transcript carries real identity.
 *
 * Council does not build the artifact from that transcript, but it stores it as a diagnostic, and the
 * day Cloudflare fixes the defect this is what notices. It answers false while any speaker id is a
 * placeholder or is absent from the session's participant list.
 */
/**
 * Turn the provider's own transcript JSON into attributed lines.
 *
 * Use this only when track files never arrived. Speaker ids in that JSON are placeholder
 * garbage today, so a missing name becomes "Unknown speaker". A display name the provider
 * filled in is still whatever it typed, not a verified identity.
 */
export function council_provider_transcript_fallback_segments(rawJson: string) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		return [] as council_AttributedSegment[];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}

	const segments: council_AttributedSegment[] = [];
	for (const line of parsed) {
		if (typeof line !== "object" || line === null) {
			continue;
		}
		const record = line as {
			sentence?: unknown;
			startTime?: unknown;
			endTime?: unknown;
			peerData?: { id?: unknown; displayName?: unknown };
		};
		if (typeof record.sentence !== "string" || record.sentence.length === 0) {
			continue;
		}
		const startMs = typeof record.startTime === "number" && Number.isFinite(record.startTime) ? record.startTime : 0;
		const endMs = typeof record.endTime === "number" && Number.isFinite(record.endTime) ? record.endTime : startMs;
		const displayName =
			typeof record.peerData?.displayName === "string" && record.peerData.displayName.length > 0
				? record.peerData.displayName
				: "Unknown speaker";
		const participantId =
			typeof record.peerData?.id === "string" && record.peerData.id.length > 0 ? record.peerData.id : "unknown";
		segments.push({
			startMs,
			endMs,
			text: record.sentence,
			participantId,
			displayName,
		});
	}
	return segments;
}

export function council_provider_transcript_has_real_identity(args: {
	speakerIds: string[];
	participants: council_Participant[];
}) {
	if (args.speakerIds.length === 0) {
		return false;
	}

	const known = new Set(args.participants.map((participant) => participant.providerParticipantId));
	return args.speakerIds.every((id) => !PROVIDER_PLACEHOLDER_SPEAKER_IDS.has(id) && known.has(id));
}

/** Every ASCII punctuation character CommonMark lets a backslash escape. */
const MARKDOWN_ESCAPABLE_REGEX = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu;

/**
 * Escape text for inline Markdown.
 *
 * Escape the whole ASCII punctuation set rather than a chosen subset. One rule has no gaps, and the
 * gap that matters here is `<`: the app renders stored Markdown with raw HTML passthrough and no
 * sanitizer, so an unescaped `<` in a display name or in speech becomes real HTML in the reader's
 * browser. A backslash before punctuation renders as the punctuation alone, so the rendered
 * transcript reads normally.
 *
 * Line breaks are removed first. A newline inside a name would end the line it sits on and let the
 * rest of the name become its own Markdown block, which no amount of character escaping undoes.
 */
export function council_escape_markdown_inline(text: string) {
	return text.replace(/[\r\n]+/gu, " ").replace(MARKDOWN_ESCAPABLE_REGEX, (character) => `\\${character}`);
}

/** `0:08` stamps, and `1:02:03` once the meeting passes an hour, so a reader can find the moment
 * in the recording. */
function format_timestamp(totalMs: number) {
	const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (value: number) => String(value).padStart(2, "0");
	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Render the finished transcript.
 *
 * Every name and every spoken line goes through the inline escape, and both sit on one line after a
 * timestamp. Keeping them inline is deliberate: a line prefix such as `# {name}` would hand a name
 * the power to open a heading, and the escape alone would not take it back.
 */
export function council_render_transcript_markdown(args: {
	title: string;
	segments: council_AttributedSegment[];
	/**
	 * Recorded tracks whose speech is not in `segments`. The pipeline refused some before Whisper
	 * ran, and attribution refused the rest. The count has to be rendered, not just logged: the
	 * member reads this file in the same folder as the raw track audio, and a finalized
	 * `transcript.md` is never rewritten by a redrive.
	 */
	droppedTrackCount: number;
	/**
	 * True when the pipeline judged the recording too short to process. Such a run skips track
	 * discovery entirely, so it read no track file and no provider transcript, and it must not claim
	 * the meeting was silent.
	 */
	recordingWasTooShort: boolean;
	/**
	 * True when the provider left the recording UPLOADING with duration 0 and no track files
	 * after the whole poll. Speech may still exist in the provider transcript. Do not call
	 * that meeting silent.
	 */
	recordingFilesNeverPublished: boolean;
}) {
	const lines = [`# ${council_escape_markdown_inline(args.title)}`, ""];

	if (args.droppedTrackCount > 0) {
		lines.push(
			args.droppedTrackCount === 1
				? "_1 recorded track could not be transcribed, so any speech in it is missing below._"
				: `_${args.droppedTrackCount} recorded tracks could not be transcribed, so any speech in them is missing below._`,
			"",
		);
	}

	if (args.segments.length === 0) {
		// A too-short recording is skipped before any track is read, so this run never looked for
		// speech at all. Say what the pipeline actually did instead of calling the meeting silent.
		if (args.recordingWasTooShort) {
			lines.push("_The recording was too short to process, so no transcript was produced._");
			return `${lines.join("\n")}\n`;
		}
		// Track files never arrived. The meeting may still have spoken; we just could not read
		// the audio. Say that, and do not call the room silent.
		if (args.recordingFilesNeverPublished) {
			lines.push("_The recording files never arrived, so no transcript was produced._");
			return `${lines.join("\n")}\n`;
		}
		// Only say the meeting was silent when every recorded track really was read. With a dropped
		// track the honest statement is about the tracks that were read, and the line above names the
		// rest.
		lines.push(args.droppedTrackCount > 0 ? "_No other speech was recorded._" : "_No speech was recorded._");
		return `${lines.join("\n")}\n`;
	}

	// These lines came from the provider transcript because the audio files never arrived.
	// Names in that file are not the same attribution track files give us.
	if (args.recordingFilesNeverPublished) {
		lines.push(
			"_The recording files never arrived. This text is the provider's own transcript. Speaker names may be unlabeled._",
			"",
		);
	}

	lines.push(
		"Names are the ones participants typed when they joined. They are not verified identities.",
		"",
	);
	for (const segment of args.segments) {
		lines.push(
			`- \`${format_timestamp(segment.startMs)}\` **${council_escape_markdown_inline(segment.displayName)}:** ${council_escape_markdown_inline(segment.text)}`,
		);
	}

	return `${lines.join("\n")}\n`;
}
