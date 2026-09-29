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

describe("files_folder_columns", () => {
	test("keeps valid folder choices and drops invalid entries", () => {
		const key = "app_state::files_folder_columns::scope::valid_choices";
		localStorage.setItem(key, JSON.stringify({
			root: ["name", "metadata.rank", "frontmatter.rank"],
			folder: ["name", "updated_by", "created", "type", "size"],
			missingName: ["updated"],
			repeats: ["name", "name"],
			badField: ["name", "rank"],
			tooMany: ["name", "updated_by", "updated", "created", "type", "size", "metadata.a", "metadata.b", "metadata.c"],
		}));
		expect(app_local_storage_get_value(key)).toEqual({
			root: ["name", "metadata.rank", "frontmatter.rank"],
			folder: ["name", "updated_by", "created", "type", "size"],
		});
	});

	test.each(["bad JSON", "null", "[]", "4"])("uses no stored choices for %s", (raw) => {
		const key = `app_state::files_folder_columns::scope::invalid_choices_${raw}` as const;
		localStorage.setItem(key, raw);
		expect(app_local_storage_get_value(key)).toEqual({});
	});

	test("keeps choices separate by membership", () => {
		const first = "app_state::files_folder_columns::scope::first_member";
		const second = "app_state::files_folder_columns::scope::second_member";
		app_local_storage_set_value(first, { root: ["name", "size"] });
		app_local_storage_set_value(second, { root: ["name", "created"] });
		expect(app_local_storage_get_value(first)).toEqual({ root: ["name", "size"] });
		expect(app_local_storage_get_value(second)).toEqual({ root: ["name", "created"] });
	});

	test("reads only the last 100 valid folder choices", () => {
		const key = "app_state::files_folder_columns::scope::bounded_history";
		localStorage.setItem(key, JSON.stringify(Object.fromEntries(
			Array.from({ length: 101 }, (_, index) => [`folder_${index}`, ["name"]]),
		)));
		const choices = app_local_storage_get_value(key);
		expect(Object.keys(choices)).toHaveLength(100);
		expect(choices.folder_0).toBeUndefined();
		expect(choices.folder_100).toEqual(["name"]);
	});
});
