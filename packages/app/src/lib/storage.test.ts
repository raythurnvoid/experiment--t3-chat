import { afterEach, describe, expect, test } from "vitest";
import { app_local_storage_get_value, app_local_storage_set_value } from "./storage.ts";

afterEach(() => localStorage.clear());

describe("files_last_open_target", () => {
	test.each([{ kind: "root" }, { kind: "saved", id: "saved_file" }, { kind: "private", id: "private_draft" }] as const)(
		"keeps the $kind target kind",
		(target) => {
			const key = `app_state::files_last_open_target::scope::roundtrip_${target.kind}` as const;
			app_local_storage_set_value(key, target);
			expect(app_local_storage_get_value(key)).toEqual(target);
			expect(JSON.parse(localStorage.getItem(key)!)).toEqual(target);
		},
	);

	test.each([
		"private_draft",
		'{"kind":"private"}',
		'{"kind":"saved","id":4}',
		'{"kind":"private","id":""}',
		'{"kind":"other","id":"file"}',
		"null",
	])("rejects an untagged or invalid saved value: %s", (raw) => {
		const key = `app_state::files_last_open_target::scope::invalid_${raw}` as const;
		localStorage.setItem(key, raw);
		expect(app_local_storage_get_value(key)).toBeNull();
	});
});
