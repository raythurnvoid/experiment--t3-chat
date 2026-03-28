import { describe, expect, test } from "vitest";
import {
	workspaces_description_max_length,
	workspaces_description_normalize,
	workspaces_list_sort_compare_name_then_id,
	workspaces_list_sort_projects_for_workspace,
	workspaces_list_sort_workspaces,
	workspaces_name_autofix,
	workspaces_name_autofix_and_validate,
	workspaces_name_validate,
	workspaces_switcher_list_secondary_line,
} from "./workspaces.ts";

describe("workspaces_name_autofix", () => {
	test("keeps kebab-case letters and inserts hyphens for non-letters", () => {
		expect(workspaces_name_autofix("  Acme Labs!!  ")).toBe("acme-labs");
	});

	test("drops leading digits until the first letter", () => {
		expect(workspaces_name_autofix("123abc")).toBe("abc");
		expect(workspaces_name_autofix("42cool")).toBe("cool");
	});

	test("keeps digits after the first letter", () => {
		expect(workspaces_name_autofix("foo 2 bar")).toBe("foo-2-bar");
		expect(workspaces_name_autofix("acmeLabs2")).toBe("acmelabs2");
	});

	test("does not start or end with a hyphen after normalization", () => {
		expect(workspaces_name_autofix("---acme---")).toBe("acme");
		expect(workspaces_name_autofix("-my-work-")).toBe("my-work");
	});

	test("with trim_trailing_hyphens false, keeps trailing hyphen for live input", () => {
		expect(workspaces_name_autofix("hello_", { trim_trailing_hyphens: false })).toBe("hello-");
		expect(workspaces_name_autofix("hello ", { trim_trailing_hyphens: false })).toBe("hello-");
		expect(workspaces_name_autofix("hello🙂", { trim_trailing_hyphens: false })).toBe("hello-");
	});

	test("with trim_trailing_hyphens false, still trims leading hyphens once letters exist", () => {
		expect(workspaces_name_autofix("_hello", { trim_trailing_hyphens: false })).toBe("hello");
	});

	test("with trim_trailing_hyphens false, keeps lone separator as hyphen before any letter", () => {
		expect(workspaces_name_autofix("_", { trim_trailing_hyphens: false })).toBe("-");
		expect(workspaces_name_autofix("___", { trim_trailing_hyphens: false })).toBe("-");
	});
});

describe("workspaces_name_validate", () => {
	test("rejects empty", () => {
		const r = workspaces_name_validate("");
		expect(r._nay?.message).toBe("Name cannot be empty");
	});

	test("rejects short names", () => {
		expect(workspaces_name_validate("a")._nay?.message).toBe("Name must be at least 3 characters");
		expect(workspaces_name_validate("ab")._nay?.message).toBe("Name must be at least 3 characters");
	});

	test("accepts valid names including digits after the first char", () => {
		expect(workspaces_name_validate("abc")._yay).toBe("abc");
		expect(workspaces_name_validate("ab1")._yay).toBe("ab1");
		expect(workspaces_name_validate("a2-b3")._yay).toBe("a2-b3");
	});

	test("rejects leading digit, trailing dash, or double hyphen in normalized input", () => {
		expect(workspaces_name_validate("1ab")._nay?.message).toBe("Invalid name");
		expect(workspaces_name_validate("ab-")._nay?.message).toBe("Invalid name");
		expect(workspaces_name_validate("a--b")._nay?.message).toBe("Invalid name");
	});
});

describe("workspaces_name_autofix_and_validate", () => {
	test("accepts messy input that becomes a valid slug", () => {
		const r = workspaces_name_autofix_and_validate("  Team 2 East  ");
		expect(r._yay).toBe("team-2-east");
	});

	test("rejects when autofix leaves a name shorter than 3 characters", () => {
		expect(workspaces_name_autofix_and_validate("ab")._nay?.message).toBe("Name must be at least 3 characters");
		expect(workspaces_name_autofix_and_validate("12")._nay?.message).toBe("Name cannot be empty");
	});
});

describe("workspaces_list_sort_compare_name_then_id", () => {
	test("sorts numerically within names when numeric option applies", () => {
		const rows = [
			{ _id: "b", name: "item-10" },
			{ _id: "a", name: "item-2" },
		].sort((x, y) => workspaces_list_sort_compare_name_then_id(x, y));

		expect(rows.map((r) => r.name)).toEqual(["item-2", "item-10"]);
	});

	test("uses id as tiebreaker when names match", () => {
		const rows = [
			{ _id: "z", name: "same" },
			{ _id: "a", name: "same" },
		].sort((x, y) => workspaces_list_sort_compare_name_then_id(x, y));

		expect(rows.map((r) => r._id)).toEqual(["a", "z"]);
	});
});

describe("workspaces_list_sort_workspaces", () => {
	test("places default workspace first", () => {
		const sorted = workspaces_list_sort_workspaces([
			{ _id: "w2", name: "aaa", default: false },
			{ _id: "w1", name: "zzz", default: true },
		]);

		expect(sorted.map((w) => w._id)).toEqual(["w1", "w2"]);
	});
});

describe("workspaces_description_normalize", () => {
	test("trims and accepts empty as empty string", () => {
		expect(workspaces_description_normalize("")._yay).toBe("");
		expect(workspaces_description_normalize("   \n  ")._yay).toBe("");
		expect(workspaces_description_normalize("  hello  ")._yay).toBe("hello");
	});

	test("rejects when longer than max length", () => {
		const long = "a".repeat(workspaces_description_max_length + 1);
		expect(workspaces_description_normalize(long)._nay?.message).toBe("Description is too long");
	});

	test("accepts at max length", () => {
		const ok = "a".repeat(workspaces_description_max_length);
		expect(workspaces_description_normalize(ok)._yay).toBe(ok);
	});
});

describe("workspaces_switcher_list_secondary_line", () => {
	test("prefers stored description", () => {
		expect(
			workspaces_switcher_list_secondary_line({
				storedDescription: "Custom",
				isDefaultWorkspace: true,
				isPrimaryProject: true,
			}),
		).toBe("Custom");
	});

	test("falls back to default workspace label", () => {
		expect(
			workspaces_switcher_list_secondary_line({
				storedDescription: "",
				isDefaultWorkspace: true,
				isPrimaryProject: false,
			}),
		).toBe("Default workspace");
	});

	test("falls back to default project label", () => {
		expect(
			workspaces_switcher_list_secondary_line({
				storedDescription: "",
				isDefaultWorkspace: false,
				isPrimaryProject: true,
			}),
		).toBe("Default project");
	});

	test("returns empty when no stored text and not default primary", () => {
		expect(
			workspaces_switcher_list_secondary_line({
				storedDescription: "",
				isDefaultWorkspace: false,
				isPrimaryProject: false,
			}),
		).toBe("");
	});
});

describe("workspaces_list_sort_projects_for_workspace", () => {
	test("uses project.default when workspace has no defaultProjectId", () => {
		const workspace = { _id: "ws", name: "w", default: false };

		const sorted = workspaces_list_sort_projects_for_workspace(workspace, [
			{ _id: "p-b", name: "beta", default: false },
			{ _id: "p-a", name: "alpha", default: true },
		]);

		expect(sorted.map((p) => p._id)).toEqual(["p-a", "p-b"]);
	});

	test("places defaultProjectId match before other projects", () => {
		const workspace = {
			_id: "ws",
			name: "w",
			default: false,
			defaultProjectId: "p-home",
		};

		const sorted = workspaces_list_sort_projects_for_workspace(workspace, [
			{ _id: "p-zebra", name: "zebra", default: false },
			{ _id: "p-home", name: "home", default: false },
		]);

		expect(sorted.map((p) => p._id)).toEqual(["p-home", "p-zebra"]);
	});
});
