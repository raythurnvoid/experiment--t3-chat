import { describe, expect, test } from "vitest";

import {
	council_attribute_tracks,
	council_escape_markdown_inline,
	council_parse_track_file_name,
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

	test.each([
		["no extension", "default_a_b_peer_audio_1786714394062"],
		["too few fields", "default_peer_audio_1786714394062.webm"],
		["non-numeric timestamp", "default_a_b_peer_audio_whenever.webm"],
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

	test("drops a screen-share track so its separate timeline never joins the spoken transcript", () => {
		const screenShare = alice_track(ALICE_TRACK_FILE.replace("_peer_audio_", "_screenshare_video_"));

		const { segments, rejected } = council_attribute_tracks({ tracks: [screenShare], participants: [ALICE] });

		expect(segments).toEqual([]);
		expect(rejected).toEqual([{ fileName: screenShare.fileName, reason: "not_an_audio_peer_track" }]);
	});
});

describe("council_provider_transcript_has_real_identity", () => {
	test.each(["TEST", "unique_id", "user_id", "custom_participant_id"])(
		"rejects the provider placeholder %s",
		(placeholder) => {
			expect(
				council_provider_transcript_has_real_identity({
					speakerIds: [placeholder],
					participants: [ALICE, BOB],
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

		const markdown = council_render_transcript_markdown({ title: "Weekly sync", segments });

		expect(markdown).not.toMatch(UNESCAPED_ANGLE_BRACKET_REGEX);
		expect(markdown).toContain("\\<script\\>Alice");
		expect(markdown).toContain("Bob Castellane");
		expect(markdown).toContain("`0:08`");
	});

	test("says so plainly when nothing was recorded", () => {
		expect(council_render_transcript_markdown({ title: "Empty", segments: [] })).toContain("No speech was recorded");
	});

	test("stamps past an hour with hours", () => {
		const { segments } = council_attribute_tracks({
			tracks: [{ ...alice_track(), segments: [{ startMs: 3_723_000, endMs: 3_725_000, text: "late" }] }],
			participants: [ALICE],
		});

		expect(council_render_transcript_markdown({ title: "Long", segments })).toContain("`1:02:03`");
	});
});
