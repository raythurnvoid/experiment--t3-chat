import { describe, expect, test } from "vitest";
import {
	organizations_DESCRIPTION_MAX_LENGTH,
	organizations_NAME_MAX_LENGTH,
	organizations_description_normalize,
	organizations_list_sort_compare_name_then_id,
	organizations_list_sort_workspaces_for_organization,
	organizations_list_sort_organizations,
	organizations_name_autofix,
	organizations_name_autofix_and_validate,
	organizations_name_validate,
	organizations_switcher_list_secondary_line,
} from "./organizations.ts";

describe("organizations_name_autofix", () => {
	test("keeps kebab-case letters and inserts hyphens for non-letters", () => {
		expect(organizations_name_autofix("  Acme Labs!!  ")).toBe("acme-labs");
	});

	test("drops leading digits until the first letter", () => {
		expect(organizations_name_autofix("123abc")).toBe("abc");
		expect(organizations_name_autofix("42cool")).toBe("cool");
	});

	test("keeps digits after the first letter", () => {
		expect(organizations_name_autofix("foo 2 bar")).toBe("foo-2-bar");
		expect(organizations_name_autofix("acmeLabs2")).toBe("acmelabs2");
	});

	test("does not start or end with a hyphen after normalization", () => {
		expect(organizations_name_autofix("---acme---")).toBe("acme");
		expect(organizations_name_autofix("-my-work-")).toBe("my-work");
	});

	test("with trim_trailing_hyphens false, keeps trailing hyphen for live input", () => {
		expect(organizations_name_autofix("hello_", { trim_trailing_hyphens: false })).toBe("hello-");
		expect(organizations_name_autofix("hello ", { trim_trailing_hyphens: false })).toBe("hello-");
		expect(organizations_name_autofix("hello🙂", { trim_trailing_hyphens: false })).toBe("hello-");
	});

	test("with trim_trailing_hyphens false, still trims leading hyphens once letters exist", () => {
		expect(organizations_name_autofix("_hello", { trim_trailing_hyphens: false })).toBe("hello");
	});

	test("with trim_trailing_hyphens false, keeps lone separator as hyphen before any letter", () => {
		expect(organizations_name_autofix("_", { trim_trailing_hyphens: false })).toBe("-");
		expect(organizations_name_autofix("___", { trim_trailing_hyphens: false })).toBe("-");
	});
});

describe("organizations_name_validate", () => {
	test("rejects empty", () => {
		const r = organizations_name_validate("");
		expect(r._nay?.message).toBe("Name cannot be empty");
	});

	test("rejects short names", () => {
		expect(organizations_name_validate("a")._nay?.message).toBe("Name must be at least 3 characters");
		expect(organizations_name_validate("ab")._nay?.message).toBe("Name must be at least 3 characters");
	});

	test("accepts valid names including digits after the first char", () => {
		expect(organizations_name_validate("abc")._yay).toBe("abc");
		expect(organizations_name_validate("ab1")._yay).toBe("ab1");
		expect(organizations_name_validate("a2-b3")._yay).toBe("a2-b3");
	});

	test("rejects names longer than max length", () => {
		expect(organizations_name_validate("a".repeat(organizations_NAME_MAX_LENGTH + 1))._nay?.message).toBe(
			"Name must be at most 20 characters",
		);
	});

	test("accepts names at max length", () => {
		const name = "a".repeat(organizations_NAME_MAX_LENGTH);
		expect(organizations_name_validate(name)._yay).toBe(name);
	});

	test("rejects leading digit or double hyphen in normalized input", () => {
		expect(organizations_name_validate("1ab")._nay?.message).toBe("Invalid name");
		expect(organizations_name_validate("a--b")._nay?.message).toBe("Invalid name");
	});

	test("explains names that end with a hyphen", () => {
		expect(organizations_name_validate("ab-")._nay?.message).toBe("Name cannot end with a hyphen");
	});
});

describe("organizations_name_autofix_and_validate", () => {
	test("accepts messy input that becomes a valid slug", () => {
		const r = organizations_name_autofix_and_validate("  Team 2 East  ");
		expect(r._yay).toBe("team-2-east");
	});

	test("rejects when autofix leaves a name shorter than 3 characters", () => {
		expect(organizations_name_autofix_and_validate("ab")._nay?.message).toBe("Name must be at least 3 characters");
		expect(organizations_name_autofix_and_validate("12")._nay?.message).toBe("Name cannot be empty");
	});
});

describe("organizations_list_sort_compare_name_then_id", () => {
	test("sorts numerically within names when numeric option applies", () => {
		const rows = [
			{ _id: "b", name: "item-10" },
			{ _id: "a", name: "item-2" },
		].sort((x, y) => organizations_list_sort_compare_name_then_id(x, y));

		expect(rows.map((r) => r.name)).toEqual(["item-2", "item-10"]);
	});

	test("uses id as tiebreaker when names match", () => {
		const rows = [
			{ _id: "z", name: "same" },
			{ _id: "a", name: "same" },
		].sort((x, y) => organizations_list_sort_compare_name_then_id(x, y));

		expect(rows.map((r) => r._id)).toEqual(["a", "z"]);
	});
});

describe("organizations_list_sort_organizations", () => {
	test("places default organization first", () => {
		const sorted = organizations_list_sort_organizations([
			{ _id: "o2", name: "aaa", default: false },
			{ _id: "o1", name: "zzz", default: true },
		]);

		expect(sorted.map((organization) => organization._id)).toEqual(["o1", "o2"]);
	});
});

describe("organizations_description_normalize", () => {
	test("trims and accepts empty as empty string", () => {
		expect(organizations_description_normalize("")._yay).toBe("");
		expect(organizations_description_normalize("   \n  ")._yay).toBe("");
		expect(organizations_description_normalize("  hello  ")._yay).toBe("hello");
	});

	test("rejects when longer than max length", () => {
		const long = "a".repeat(organizations_DESCRIPTION_MAX_LENGTH + 1);
		expect(organizations_description_normalize(long)._nay?.message).toBe("Description is too long");
	});

	test("accepts at max length", () => {
		const ok = "a".repeat(organizations_DESCRIPTION_MAX_LENGTH);
		expect(organizations_description_normalize(ok)._yay).toBe(ok);
	});
});

describe("organizations_switcher_list_secondary_line", () => {
	test("prefers stored description", () => {
		expect(
			organizations_switcher_list_secondary_line({
				storedDescription: "Custom",
				isDefaultOrganization: true,
				isPrimaryWorkspace: true,
			}),
		).toBe("Custom");
	});

	test("falls back to default organization label", () => {
		expect(
			organizations_switcher_list_secondary_line({
				storedDescription: "",
				isDefaultOrganization: true,
				isPrimaryWorkspace: false,
			}),
		).toBe("Default organization");
	});

	test("falls back to default workspace label", () => {
		expect(
			organizations_switcher_list_secondary_line({
				storedDescription: "",
				isDefaultOrganization: false,
				isPrimaryWorkspace: true,
			}),
		).toBe("Default workspace");
	});

	test("returns empty when no stored text and not default primary", () => {
		expect(
			organizations_switcher_list_secondary_line({
				storedDescription: "",
				isDefaultOrganization: false,
				isPrimaryWorkspace: false,
			}),
		).toBe("");
	});
});

describe("organizations_list_sort_workspaces_for_organization", () => {
	test("uses workspace.default when organization has no defaultWorkspaceId", () => {
		const organization = { _id: "org", name: "organization", default: false };

		const sorted = organizations_list_sort_workspaces_for_organization(organization, [
			{ _id: "p-b", name: "beta", default: false },
			{ _id: "p-a", name: "alpha", default: true },
		]);

		expect(sorted.map((p) => p._id)).toEqual(["p-a", "p-b"]);
	});

	test("places defaultWorkspaceId match before other workspaces", () => {
		const organization = {
			_id: "org",
			name: "organization",
			default: false,
			defaultWorkspaceId: "p-home",
		};

		const sorted = organizations_list_sort_workspaces_for_organization(organization, [
			{ _id: "p-zebra", name: "zebra", default: false },
			{ _id: "p-home", name: "home", default: false },
		]);

		expect(sorted.map((p) => p._id)).toEqual(["p-home", "p-zebra"]);
	});
});
