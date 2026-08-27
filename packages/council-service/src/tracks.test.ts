import { describe, expect, test } from "vitest";

import {
	council_attribute_composite_segments,
	council_attribute_tracks,
	council_COMPOSITE_AUDIO_FILE_NAME,
	council_COMPOSITE_SPEAKER_ID,
	council_COMPOSITE_SPEAKER_NAME,
	council_COMPOSITE_VIDEO_FILE_NAME,
	council_escape_markdown_inline,
	council_is_composite_audio_file,
	council_is_composite_video_file,
	council_parse_track_file_name,
	council_provider_transcript_fallback_segments,
	council_provider_transcript_has_real_identity,
	council_render_transcript_markdown,
	type council_Participant,
	type council_Track,
} from "./tracks.ts";

/**
 * The durable ids are the exact `custom_participant_id` values sent by the M0 run. The provider ids
 * and file names are the exact values its Add Participant and track-recording responses returned.
 * Inventing either shape here would let the join pass against ids the provider never linked.
 */
const ALICE: council_Participant = {
	participantId: "m0-alice",
	providerParticipantId: "aaa011ac-fa6a-4acb-8b0a-32eaf9a401aa",
	displayName: "Alice Bramble",
};
const BOB: council_Participant = {
	participantId: "m0-bob",
	providerParticipantId: "aaabcb4c-4fcd-47eb-9abf-70324357174f",
	displayName: "Bob Castellane",
};

const ALICE_TRACK_FILE =
	"default_aaa011ac-fa6a-4acb-8b0a-32eaf9a401aa_199b5879-0d9d-4052-a3c9-e4ccd2b1334e_peer_audio_1786714394062.webm";
const BOB_TRACK_FILE =
	"default_aaabcb4c-4fcd-47eb-9abf-70324357174f_de6533ba-5825-4246-b3c0-d5882ba3d124_peer_audio_1786714394655.webm";

/** Each fixture speaker says one phrase nobody else says, so a crossed pair is visible on sight. */
const ALICE_PHRASE = "the archive keys are in the second drawer";
const BOB_PHRASE = "the vote is scheduled for thursday morning";

const alice_track = (fileName = ALICE_TRACK_FILE): council_Track => ({
	fileName,
	startOffsetMs: 0,
	segments: [{ startMs: 23_000, endMs: 28_000, text: ALICE_PHRASE }],
});

const bob_track = (fileName = BOB_TRACK_FILE): council_Track => ({
	fileName,
	startOffsetMs: 0,
	segments: [{ startMs: 8_000, endMs: 13_000, text: BOB_PHRASE }],
});

describe("council_parse_track_file_name", () => {
	test("reads the provider participant id out of a real track name", () => {
		expect(council_parse_track_file_name(ALICE_TRACK_FILE)).toEqual({
			prefix: "default",
			providerParticipantId: ALICE.providerParticipantId,
			peerId: "199b5879-0d9d-4052-a3c9-e4ccd2b1334e",
			streamKind: "peer",
			mediaKind: "audio",
			recordedAtMs: 1_786_714_394_062,
		});
	});

	test("keeps the participant id when the caller's prefix contains underscores", () => {
		const parsed = council_parse_track_file_name(`council_meeting_2_${ALICE_TRACK_FILE.slice("default_".length)}`);

		// Counting forward would have read "meeting" as the participant id.
		expect(parsed?.prefix).toBe("council_meeting_2");
		expect(parsed?.providerParticipantId).toBe(ALICE.providerParticipantId);
	});

	// A 4-field name leaves the timestamp field undefined, so "too few fields" is refused by the
	// timestamp guard and never proves the field-count guard. The prefix-less row is what proves it:
	// five fixed fields, nothing else wrong, so only the count guard can refuse it. The empty-id rows
	// blank one field each, so each one leaves a single guard to refuse it.
	test.each([
		["no extension", "default_a_b_peer_audio_1786714394062"],
		["too few fields", "default_peer_audio_1786714394062.webm"],
		["non-numeric timestamp", "default_a_b_peer_audio_whenever.webm"],
		["no prefix before the five fixed fields", "aaa011ac_199b5879_peer_audio_1786714394062.webm"],
		["an empty participant id", "default__199b5879_peer_audio_1786714394062.webm"],
		["an empty peer id", "default_aaa011ac__peer_audio_1786714394062.webm"],
	])("refuses a name with %s", (_label, fileName) => {
		expect(council_parse_track_file_name(fileName)).toBeNull();
	});
});

describe("council_attribute_tracks", () => {
	test("binds each speaker's phrase to that speaker and leaves the crossed pairs absent", () => {
		const { segments, rejected } = council_attribute_tracks({
			tracks: [alice_track(), bob_track()],
			participants: [ALICE, BOB],
		});

		expect(rejected).toEqual([]);
		const spokenBy = new Map(segments.map((segment) => [segment.text, segment.displayName]));
		expect(spokenBy.get(ALICE_PHRASE)).toBe("Alice Bramble");
		expect(spokenBy.get(BOB_PHRASE)).toBe("Bob Castellane");
		expect(segments.map((segment) => segment.participantId)).toEqual([BOB.participantId, ALICE.participantId]);
		// The crossed pairs are the failure this whole design exists to prevent, so pin their absence.
		expect(spokenBy.get(ALICE_PHRASE)).not.toBe("Bob Castellane");
		expect(spokenBy.get(BOB_PHRASE)).not.toBe("Alice Bramble");
	});

	test("fails the identity assertion when the two track ids are swapped", () => {
		// Break-on-purpose: hand Alice's phrase to Bob's file name and Bob's to Alice's. If attribution
		// came from anything other than the id inside the file name, this would still pass.
		const { segments } = council_attribute_tracks({
			tracks: [
				{ ...alice_track(BOB_TRACK_FILE) },
				{ ...bob_track(ALICE_TRACK_FILE) },
			],
			participants: [ALICE, BOB],
		});

		const spokenBy = new Map(segments.map((segment) => [segment.text, segment.displayName]));
		expect(spokenBy.get(ALICE_PHRASE)).toBe("Bob Castellane");
		expect(spokenBy.get(BOB_PHRASE)).toBe("Alice Bramble");
	});

	test("puts the tracks on the meeting clock through each track's own offset", () => {
		// Each file starts when its participant joined. Bob joined 15s after the recording started, so
		// his 8s mark is 23s of meeting time and lands after Alice's 12s mark, not before it.
		const { segments } = council_attribute_tracks({
			tracks: [
				{ ...alice_track(), startOffsetMs: 0, segments: [{ startMs: 12_000, endMs: 14_000, text: ALICE_PHRASE }] },
				{ ...bob_track(), startOffsetMs: 15_000 },
			],
			participants: [ALICE, BOB],
		});

		expect(segments.map((segment) => segment.displayName)).toEqual(["Alice Bramble", "Bob Castellane"]);
		expect(segments[1]?.startMs).toBe(23_000);
	});

	test("merges a participant's second track after a reconnect", () => {
		const reconnected: council_Track = {
			fileName: ALICE_TRACK_FILE.replace("199b5879-0d9d-4052-a3c9-e4ccd2b1334e", "77c3e0d1-1111-2222-3333-444455556666"),
			startOffsetMs: 40_000,
			segments: [{ startMs: 1_000, endMs: 2_000, text: "back again" }],
		};

		const { segments, rejected } = council_attribute_tracks({
			tracks: [alice_track(), reconnected],
			participants: [ALICE],
		});

		expect(rejected).toEqual([]);
		expect(segments.every((segment) => segment.displayName === "Alice Bramble")).toBe(true);
		expect(segments.map((segment) => segment.text)).toEqual([ALICE_PHRASE, "back again"]);
	});

	test("drops a track whose id is not a participant instead of guessing the nearest one", () => {
		const stranger = alice_track(
			ALICE_TRACK_FILE.replace(ALICE.providerParticipantId, "99999999-9999-9999-9999-999999999999"),
		);

		const { segments, rejected } = council_attribute_tracks({ tracks: [stranger], participants: [ALICE, BOB] });

		expect(segments).toEqual([]);
		expect(rejected).toEqual([{ fileName: stranger.fileName, reason: "unknown_participant" }]);
	});

	// Two independent conditions refuse a track here: the stream must be a peer stream, and the media
	// must be audio. A file wrong in both fields is still refused with either condition deleted, so
	// each condition also gets a row that breaks its own field alone. No such file exists today,
	// because composite start writes the mixed files, and older track recordings write
	// per-participant audio only. These rows are the file shapes the guard exists to refuse.
	test.each([
		["a peer video track", "_peer_video_"],
		["a screen-share audio track", "_screenshare_audio_"],
		["a screen-share video track", "_screenshare_video_"],
	])("drops %s instead of merging it into the spoken transcript", (_label, streamAndMedia) => {
		const track = alice_track(ALICE_TRACK_FILE.replace("_peer_audio_", streamAndMedia));

		const { segments, rejected } = council_attribute_tracks({ tracks: [track], participants: [ALICE] });

		expect(segments).toEqual([]);
		expect(rejected).toEqual([{ fileName: track.fileName, reason: "not_an_audio_peer_track" }]);
	});
});

describe("council_attribute_composite_segments", () => {
	test("binds mixed-file speech to the fixed Meeting name", () => {
		expect(council_is_composite_audio_file(council_COMPOSITE_AUDIO_FILE_NAME)).toBe(true);
		expect(council_is_composite_video_file(council_COMPOSITE_VIDEO_FILE_NAME)).toBe(true);

		expect(
			council_attribute_composite_segments([{ startMs: 1000, endMs: 2000, text: ALICE_PHRASE }]),
		).toEqual([
			{
				startMs: 1000,
				endMs: 2000,
				text: ALICE_PHRASE,
				participantId: council_COMPOSITE_SPEAKER_ID,
				displayName: council_COMPOSITE_SPEAKER_NAME,
			},
		]);
	});
});

describe("council_provider_transcript_has_real_identity", () => {
	test.each(["TEST", "unique_id", "user_id", "custom_participant_id"])(
		"rejects the provider placeholder %s",
		(placeholder) => {
			expect(
				council_provider_transcript_has_real_identity({
					// Give the placeholder to a real participant as its provider id. The "is this
					// speaker in the session?" check then passes and only the reserved-set check can
					// refuse. Against UUID fixtures the placeholder is an unknown id anyway, and this
					// test would pass with the reserved set deleted.
					speakerIds: [placeholder],
					participants: [{ ...ALICE, providerParticipantId: placeholder }, BOB],
				}),
			).toBe(false);
		},
	);

	test("rejects a speaker id absent from the session participant list", () => {
		expect(
			council_provider_transcript_has_real_identity({
				speakerIds: [ALICE.providerParticipantId, "99999999-9999-9999-9999-999999999999"],
				participants: [ALICE, BOB],
			}),
		).toBe(false);
	});

	test("rejects an empty transcript rather than calling it identified", () => {
		expect(council_provider_transcript_has_real_identity({ speakerIds: [], participants: [ALICE] })).toBe(false);
	});

	test("accepts ids that all match the session participants", () => {
		expect(
			council_provider_transcript_has_real_identity({
				speakerIds: [ALICE.providerParticipantId, BOB.providerParticipantId],
				participants: [ALICE, BOB],
			}),
		).toBe(true);
	});
});

/**
 * An escaped `<` still contains the character, so "does not contain `<`" can never pass. What stops
 * CommonMark from opening raw HTML is the backslash in front of it, so that is what to assert.
 */
const UNESCAPED_ANGLE_BRACKET_REGEX = /(?:^|[^\\])</u;

describe("council_escape_markdown_inline", () => {
	test("neutralizes an HTML payload typed as a display name", () => {
		const escaped = council_escape_markdown_inline('<img src=x onerror="alert(1)">');

		// The app renders stored Markdown with raw HTML passthrough and no sanitizer, so the backslash
		// in front of `<` is what decides whether this becomes an element in a reader's browser.
		expect(escaped).not.toMatch(UNESCAPED_ANGLE_BRACKET_REGEX);
		expect(escaped).toContain("\\<img");
	});

	test("removes line breaks so a name cannot start its own Markdown block", () => {
		expect(council_escape_markdown_inline("Alice\n\n# Meeting cancelled")).toBe("Alice \\# Meeting cancelled");
	});

	test("escapes the table and link characters that would break out of their position", () => {
		expect(council_escape_markdown_inline("a|b]c(d")).toBe("a\\|b\\]c\\(d");
	});
});

describe("council_render_transcript_markdown", () => {
	test("names every line and escapes both the name and the speech", () => {
		const { segments } = council_attribute_tracks({
			tracks: [
				{ ...alice_track(), segments: [{ startMs: 23_000, endMs: 28_000, text: "<b>hello</b>" }] },
				bob_track(),
			],
			participants: [{ ...ALICE, displayName: "<script>Alice</script>" }, BOB],
		});

		const markdown = council_render_transcript_markdown({
			// The title is member-typed too, and it reaches this renderer unfiltered. A title with no
			// `<` in it would leave the heading's escape untested: the whole-document check below
			// would pass with that escape deleted.
			title: "<img src=x>",
			segments,
			droppedTrackCount: 0,
			recordingWasTooShort: false,
			recordingFilesNeverPublished: false,
		});

		expect(markdown).toContain("\\<img");
		expect(markdown).not.toMatch(UNESCAPED_ANGLE_BRACKET_REGEX);
		expect(markdown).toContain("\\<script\\>Alice");
		expect(markdown).toContain("Bob Castellane");
		expect(markdown).toContain("`0:08`");
		// Every name here is whatever the joiner typed. The document has to say so, or a reader takes
		// the transcript as a record of who was actually in the room.
		expect(markdown).toContain("They are not verified identities.");
	});

	test("says so plainly when nothing was recorded", () => {
		expect(
			council_render_transcript_markdown({
				title: "Empty",
				segments: [],
				droppedTrackCount: 0,
				recordingWasTooShort: false,
				recordingFilesNeverPublished: false,
			}),
		).toContain("No speech was recorded");
	});

	test("stamps past an hour with hours", () => {
		const { segments } = council_attribute_tracks({
			tracks: [{ ...alice_track(), segments: [{ startMs: 3_723_000, endMs: 3_725_000, text: "late" }] }],
			participants: [ALICE],
		});

		expect(
			council_render_transcript_markdown({
				title: "Long",
				segments,
				droppedTrackCount: 0,
				recordingWasTooShort: false,
				recordingFilesNeverPublished: false,
			}),
		).toContain("`1:02:03`");
	});

	test("a hung upload without lines does not call the meeting silent", () => {
		const markdown = council_render_transcript_markdown({
			title: "Hung",
			segments: [],
			droppedTrackCount: 0,
			recordingWasTooShort: false,
			recordingFilesNeverPublished: true,
		});
		expect(markdown).toContain("The recording files never arrived");
		expect(markdown).not.toContain("No speech was recorded");
	});

	test("a hung upload with provider lines warns that names may be unlabeled", () => {
		const markdown = council_render_transcript_markdown({
			title: "Hung",
			segments: [
				{
					startMs: 1000,
					endMs: 2500,
					text: "hello world",
					participantId: "TEST",
					displayName: "Alice Prime",
				},
			],
			droppedTrackCount: 0,
			recordingWasTooShort: false,
			recordingFilesNeverPublished: true,
		});
		expect(markdown).toContain("This text is the provider's own transcript");
		expect(markdown).toContain("Alice Prime");
		expect(markdown).toContain("hello world");
		expect(markdown).not.toContain("No speech was recorded");
		expect(markdown).not.toContain("Names are the ones participants typed when they joined");
	});

	test("does not say composite Meeting lines are typed join names", () => {
		const markdown = council_render_transcript_markdown({
			title: "Composite",
			segments: council_attribute_composite_segments([{ startMs: 0, endMs: 1000, text: "hello" }]),
			droppedTrackCount: 0,
			recordingWasTooShort: false,
			recordingFilesNeverPublished: false,
		});
		expect(markdown).toContain("**Meeting:**");
		expect(markdown).toContain("Lines are labeled Meeting");
		expect(markdown).not.toContain("Names are the ones participants typed when they joined");
	});
});

describe("council_provider_transcript_fallback_segments", () => {
	test("reads sentences and uses the provider display name when it has one", () => {
		expect(
			council_provider_transcript_fallback_segments(
				JSON.stringify([
					{
						startTime: 1000,
						endTime: 2500,
						sentence: "hello world",
						peerData: { id: "TEST", displayName: "Alice Prime" },
					},
				]),
			),
		).toEqual([
			{
				startMs: 1000,
				endMs: 2500,
				text: "hello world",
				participantId: "TEST",
				displayName: "Alice Prime",
			},
		]);
	});

	test("labels a line with no name as Unknown speaker", () => {
		expect(
			council_provider_transcript_fallback_segments(JSON.stringify([{ sentence: "hello world", peerData: { id: "TEST" } }])),
		).toEqual([
			{
				startMs: 0,
				endMs: 0,
				text: "hello world",
				participantId: "TEST",
				displayName: "Unknown speaker",
			},
		]);
	});

	test("drops invalid JSON and lines with no sentence", () => {
		expect(council_provider_transcript_fallback_segments("{")).toEqual([]);
		expect(council_provider_transcript_fallback_segments(JSON.stringify([{ sentence: "" }]))).toEqual([]);
	});
});
