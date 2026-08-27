import { describe, expect, test } from "vitest";

import {
	council_HOST_UPLOAD_MAX_BYTES,
	council_RECORDING_OVER_CAP_MEMBER_SENTENCE,
	council_RECORDING_WORST_CASE_BYTES_PER_MINUTE,
	council_max_minutes_within_host_upload_cap,
	council_meeting_length_exceeds_host_upload_cap,
	council_recording_over_cap_member_sentence,
	council_recording_over_cap_reason,
	council_worst_case_recording_bytes,
} from "./env.ts";

describe("council_meeting_length_exceeds_host_upload_cap", () => {
	test("allows the largest whole-minute setting that still fits 2 GiB at the 720p worst case", () => {
		const safeMinutes = council_max_minutes_within_host_upload_cap();

		expect(safeMinutes).toBe(47);
		expect(council_RECORDING_WORST_CASE_BYTES_PER_MINUTE).toBe(45_000_000);
		expect(council_HOST_UPLOAD_MAX_BYTES).toBe(2 * 1024 * 1024 * 1024);
		expect(council_worst_case_recording_bytes(safeMinutes)).toBeLessThanOrEqual(council_HOST_UPLOAD_MAX_BYTES);
		expect(council_meeting_length_exceeds_host_upload_cap(safeMinutes)).toBe(false);
	});

	test("refuses one minute past that bound", () => {
		const unsafeMinutes = council_max_minutes_within_host_upload_cap() + 1;

		expect(unsafeMinutes).toBe(48);
		expect(council_worst_case_recording_bytes(unsafeMinutes)).toBeGreaterThan(council_HOST_UPLOAD_MAX_BYTES);
		expect(council_meeting_length_exceeds_host_upload_cap(unsafeMinutes)).toBe(true);
		// 60 minutes is the product default. The pessimistic helper still flags it.
		// Create accepts that length and only logs a warning.
		expect(council_meeting_length_exceeds_host_upload_cap(60)).toBe(true);
	});
});

describe("council_recording_over_cap_reason", () => {
	test("names how many MiB the file sits over the host cap", () => {
		expect(council_recording_over_cap_reason(council_HOST_UPLOAD_MAX_BYTES + 1)).toBe(
			"recording too large to store: 1 MiB over the limit",
		);
		expect(council_recording_over_cap_reason(council_HOST_UPLOAD_MAX_BYTES + 12 * 1024 * 1024)).toBe(
			"recording too large to store: 12 MiB over the limit",
		);
	});
});

describe("council_recording_over_cap_member_sentence", () => {
	test("is null until a ready meeting has a recording artifact failed as over the cap", () => {
		expect(council_recording_over_cap_member_sentence("ready", [])).toBeNull();
		expect(
			council_recording_over_cap_member_sentence("ready", [
				{ status: "finalized", failure_reason: null },
				{ status: "failed", failure_reason: "Upload target refused: Server Error" },
			]),
		).toBeNull();
		expect(
			council_recording_over_cap_member_sentence("processing", [
				{
					status: "failed",
					failure_reason: "recording too large to store: 1 MiB over the limit",
				},
			]),
		).toBeNull();
		expect(
			council_recording_over_cap_member_sentence("ready", [
				{
					status: "failed",
					failure_reason: "recording too large to store: 1 MiB over the limit",
				},
			]),
		).toBe(council_RECORDING_OVER_CAP_MEMBER_SENTENCE);
	});
});
