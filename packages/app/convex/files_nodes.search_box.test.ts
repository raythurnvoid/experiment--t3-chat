import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import type { FunctionArgs } from "convex/server";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { test_convex, test_move_nodes, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import type { files_metadata_SearchPlan } from "../shared/files-metadata.ts";
import { files_search_query_parse, files_search_query_to_plans } from "../shared/files-search-query.ts";
import {
	upsert_pending_update_internal_for_test,
	test_materialize_markdown_file,
	reset_file_write_rate_limits,
	seed_search_box_fixture,
	seed_grant_only_member,
	list_values,
	statusOpenPlans,
	search_saved_page,
	search_saved_plans,
} from "./files_nodes.setup.test.ts";

const generateTextMock = vi.hoisted(() => vi.fn());
const streamTextMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>();
	return {
		...actual,
		generateText: generateTextMock,
		streamText: streamTextMock,
	};
});

// Tests that run the real SDK set this fake provider model. The receipt middleware stays real.
const inlineAiProvider = vi.hoisted(() => ({ model: null as MockLanguageModelV3 | null }));
vi.mock("@ai-sdk/openai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ai-sdk/openai")>();
	return {
		...actual,
		openai: Object.assign(() => inlineAiProvider.model, actual.openai),
	};
});

const test = baseTest;

beforeEach(() => {
	generateTextMock.mockReset();
	streamTextMock.mockReset();
	inlineAiProvider.model = null;
	// Keep file tests focused on file behavior; billing event enqueue behavior is
	// covered in billing tests.
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_file_test_billing_event" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("search box doors", () => {
	test("search_saved unites metadata kinds and value kinds and scopes by folder path", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const search = (plans: files_metadata_SearchPlan[], folderPath?: string) =>
			search_saved_plans({ asWho: seeded.asOwner, membershipId: seeded.db.membershipId, plans, folderPath });

		// `status:open` from either metadata kind: the open task, the fixed task through its map, the archive.
		expect(await search(statusOpenPlans)).toEqual(
			new Set([seeded.openTaskId, seeded.fixedTaskId, seeded.archivedTaskId]),
		);
		// `file.path:/tasks` stops at the folder: `/tasks-archive` shares the prefix but not the path.
		expect(await search(statusOpenPlans, "/tasks")).toEqual(new Set([seeded.openTaskId, seeded.fixedTaskId]));

		// `priority:3` asks the number and the text. Only the number exists.
		expect(
			await search([
				{ op: "eq", fieldPath: "frontmatter.priority", value: "3" },
				{ op: "eq", fieldPath: "frontmatter.priority", value: 3 },
			]),
		).toEqual(new Set([seeded.openTaskId]));
		// The plans the box really sends: a number or boolean chip carries one plan per value kind (the
		// number or boolean, and the same text), and the door must take both.
		const chipPlans = (query: string) => files_search_query_to_plans(files_search_query_parse(query).filters[0]!);
		expect(chipPlans("frontmatter.priority:3")).toHaveLength(2);
		expect(await search(chipPlans("frontmatter.priority:3"))).toEqual(new Set([seeded.openTaskId]));
		expect(await search(chipPlans("frontmatter.regression:true"))).toEqual(new Set([seeded.openTaskId]));
		expect(await search([{ op: "range", fieldPath: "frontmatter.priority", valueKind: "number", gte: 2 }])).toEqual(
			new Set([seeded.openTaskId, seeded.fixedTaskId]),
		);
		// Each bound has its own index line, so every comparator gets a case.
		expect(await search([{ op: "range", fieldPath: "frontmatter.priority", valueKind: "number", gt: 2 }])).toEqual(
			new Set([seeded.openTaskId]),
		);
		expect(await search([{ op: "range", fieldPath: "frontmatter.priority", valueKind: "number", lte: 2 }])).toEqual(
			new Set([seeded.fixedTaskId, seeded.archivedTaskId]),
		);
		expect(await search([{ op: "range", fieldPath: "frontmatter.priority", valueKind: "number", lt: 2 }])).toEqual(
			new Set([seeded.archivedTaskId]),
		);
		expect(
			await search([
				{
					op: "range",
					fieldPath: "frontmatter.reported",
					valueKind: "maybe_date",
					gte: Date.UTC(2026, 8, 4),
					lt: Date.UTC(2026, 8, 5),
				},
			]),
		).toEqual(new Set([seeded.openTaskId]));
		// A date with a time asks for its instant, so one plan sets both bounds on one index line.
		expect(await search(chipPlans("frontmatter.reported:2026-09-04T00:00:00Z"))).toEqual(new Set([seeded.openTaskId]));
		expect(await search(chipPlans("frontmatter.reported:2026-09-04T00:01:00Z"))).toEqual(new Set());
		// The folder scope applies to an exists plan too.
		expect(await search([{ op: "exists", fieldPath: "frontmatter.legacy" }], "/tasks")).toEqual(new Set());
		expect(await search([{ op: "exists", fieldPath: "frontmatter.legacy" }], "/tasks-archive")).toEqual(
			new Set([seeded.archivedTaskId]),
		);
		expect(await search([{ op: "eq", fieldPath: "frontmatter.regression", value: true }])).toEqual(
			new Set([seeded.openTaskId]),
		);
		expect(await search([{ op: "eq", fieldPath: "frontmatter.tags", value: "macos" }])).toEqual(
			new Set([seeded.openTaskId]),
		);
		// A nested map is a key of its own, without a value.
		expect(await search([{ op: "exists", fieldPath: "frontmatter.source" }])).toEqual(new Set([seeded.openTaskId]));
		expect(await search([{ op: "exists", fieldPath: "metadata.slack-message-id" }])).toEqual(
			new Set([seeded.fixedTaskId]),
		);

		// The root scope is the whole workspace.
		expect(await search(statusOpenPlans, "/")).toEqual(
			new Set([seeded.openTaskId, seeded.fixedTaskId, seeded.archivedTaskId]),
		);

		// Input the app never sends gets the empty answer, not an error.
		expect(await search([{ op: "exists", fieldPath: "frontmatter.a..b" }])).toEqual(new Set());
		expect(await search([{ op: "exists", fieldPath: "status" }])).toEqual(new Set());
		expect(await search([{ op: "exists", fieldPath: `frontmatter.${"a".repeat(160)}` }])).toEqual(new Set());
		expect(await search(statusOpenPlans, "tasks")).toEqual(new Set(["Folder not found"]));
		expect(await search(statusOpenPlans, `/${"a".repeat(1024)}`)).toEqual(new Set(["Folder not found"]));

		// Somebody else's membership answers nothing.
		const other = await t.run(async (ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org" }),
		);
		expect(
			await search_saved_plans({ asWho: seeded.asOwner, membershipId: other.membershipId, plans: statusOpenPlans }),
		).toEqual(new Set());
	});

	test("search_saved keeps a folder scope closed at its own path, whatever the characters", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		// The scope bound must sort after every path under the folder, including characters above
		// the Basic Multilingual Plane.
		await reset_file_write_rate_limits(t, seeded.db.userId);
		const emojiTaskId = await test_materialize_markdown_file({
			t,
			asUser: seeded.asOwner,
			db: seeded.db,
			path: "/tasks/x.md",
			markdown: ["---", "status: open", "---", "Body"].join("\n"),
		});
		const folder = await seeded.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: seeded.db.membershipId,
			parentId: seeded.tasksFolderId,
			path: "😀 media",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const moved = await test_move_nodes(t, seeded.asOwner, {
			membershipId: seeded.db.membershipId,
			itemIds: [emojiTaskId],
			targetParentId: folder._yay.nodeId,
		});
		expect(moved._nay).toBeUndefined();
		const search = (plans: files_metadata_SearchPlan[], folderPath: string) =>
			search_saved_plans({ asWho: seeded.asOwner, membershipId: seeded.db.membershipId, plans, folderPath });

		expect(await search(statusOpenPlans, "/tasks")).toEqual(
			new Set([seeded.openTaskId, seeded.fixedTaskId, emojiTaskId]),
		);
		expect(await search(statusOpenPlans, "/tasks/😀 media")).toEqual(new Set([emojiTaskId]));
		expect(await search([{ op: "exists", fieldPath: "frontmatter.status" }], "/tasks/😀 media")).toEqual(
			new Set([emojiTaskId]),
		);
	});

	test("search_saved answers a prefix value of any length", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		// The upper bound of the scan is built from the value. A spread of that many code points
		// into `String.fromCodePoint` would throw a RangeError instead of the empty answer.
		expect(
			await search_saved_plans({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				plans: [{ op: "prefix", fieldPath: "frontmatter.title", value: "a".repeat(300_000) }],
			}),
		).toEqual(new Set());
	});

	test("search_saved hides a restricted folder from a member until they are given it", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "search" });

		await reset_file_write_rate_limits(t, seeded.db.userId);
		const restricted = await seeded.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: seeded.db.membershipId,
			nodeId: seeded.tasksFolderId,
		});
		if (restricted._nay) throw new Error(restricted._nay.message);

		const searchAsMember = () =>
			search_saved_plans({ asWho: member.asMember, membershipId: member.membershipId, plans: statusOpenPlans });

		// No role and no grant: the open archive file must not leak through a default
		// workspace-wide read, and the restricted folder is not theirs either.
		expect(await searchAsMember()).toEqual(new Set());

		await reset_file_write_rate_limits(t, seeded.db.userId);
		const granted = await seeded.asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: seeded.db.membershipId,
			nodeId: seeded.tasksFolderId,
			principal: { kind: "user", userId: member.userId },
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);

		expect(await searchAsMember()).toEqual(new Set([seeded.openTaskId, seeded.fixedTaskId]));

		expect(
			await search_saved_plans({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				plans: statusOpenPlans,
			}),
		).toEqual(new Set([seeded.openTaskId, seeded.fixedTaskId, seeded.archivedTaskId]));
	});

	test("search_saved finds the saved value, never a draft, for the member and the author", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "draft" });
		await reset_file_write_rate_limits(t, seeded.db.userId);
		const restricted = await seeded.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: seeded.db.membershipId,
			nodeId: seeded.tasksFolderId,
		});
		if (restricted._nay) throw new Error(restricted._nay.message);
		await reset_file_write_rate_limits(t, seeded.db.userId);
		const granted = await seeded.asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: seeded.db.membershipId,
			nodeId: seeded.tasksFolderId,
			principal: { kind: "user", userId: member.userId },
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);

		// The owner's draft turns the open task into "triaging". A draft belongs to its author: the
		// member still finds the task by the committed "open", and never by "triaging".
		const pending = await upsert_pending_update_internal_for_test(t, {
			organizationId: seeded.db.organizationId,
			workspaceId: seeded.db.workspaceId,
			userId: seeded.db.userId,
			nodeId: seeded.openTaskId,
			unstagedMarkdown: ["---", "status: triaging", "---", "Body"].join("\n"),
		});
		if (pending._nay) throw new Error(pending._nay.message);

		const searchAsMember = (plans: files_metadata_SearchPlan[]) =>
			search_saved_plans({ asWho: member.asMember, membershipId: member.membershipId, plans });
		expect(await searchAsMember([{ op: "eq", fieldPath: "frontmatter.status", value: "triaging" }])).toEqual(new Set());
		expect(await searchAsMember(statusOpenPlans)).toEqual(new Set([seeded.openTaskId, seeded.fixedTaskId]));
		// A draft never reaches the catalog, so even the author's suggestions skip it. (The member reads
		// no workspace, so they get no suggestions at all.)
		expect(
			await list_values({
				t,
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				fieldPath: "frontmatter.status",
				prefix: "t",
			}),
		).toEqual([]);

		// The search box is saved-only, so the author finds the saved value too.
		expect(
			await search_saved_plans({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				plans: statusOpenPlans,
			}),
		).toEqual(new Set([seeded.openTaskId, seeded.fixedTaskId, seeded.archivedTaskId]));
	});

	test("a prefix finds a value whose next character is an emoji, like the catalog lists it", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		// Convex sorts strings by UTF-8 bytes, so `op😀` sorts above `op\uffff`. A bound built from
		// `\uffff` would drop it from the scan while the value catalog still suggests it.
		const emojiTaskId = await test_materialize_markdown_file({
			t,
			asUser: seeded.asOwner,
			db: seeded.db,
			path: "/tasks/2026-09-05-emoji.md",
			markdown: ["---", "status: op😀", "---", "Body"].join("\n"),
		});

		// The archive's task is `open` too.
		expect(
			await search_saved_plans({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				plans: [{ op: "prefix", fieldPath: "frontmatter.status", value: "op" }],
			}),
		).toEqual(new Set([seeded.openTaskId, seeded.archivedTaskId, emojiTaskId]));
		expect(
			await list_values({
				t,
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				fieldPath: "frontmatter.status",
				prefix: "op",
			}),
		).toEqual(["open", "op😀"]);
		expect(
			await list_values({
				t,
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				fieldPath: "frontmatter.status",
				prefix: "op😀",
			}),
		).toEqual(["op😀"]);
	});

	test("search_saved reads metadata eq and exists inside a folder, prefix and range without one", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const search = (plan: files_metadata_SearchPlan, folderPath?: string) =>
			search_saved_page({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				clause: { kind: "metadata", plan },
				folderPath,
			});
		const statusOpen = { op: "eq", fieldPath: "frontmatter.status", value: "open" } as const;

		expect(await search(statusOpen)).toEqual(new Set([seeded.openTaskId, seeded.archivedTaskId]));
		// `/tasks-archive` shares the prefix of `/tasks` but is not inside it.
		expect(await search(statusOpen, "/tasks")).toEqual(new Set([seeded.openTaskId]));
		expect(await search(statusOpen, "/tasks-archive")).toEqual(new Set([seeded.archivedTaskId]));
		expect(await search({ op: "eq", fieldPath: "frontmatter.priority", value: 3 }, "/tasks")).toEqual(
			new Set([seeded.openTaskId]),
		);
		expect(await search({ op: "exists", fieldPath: "frontmatter.legacy" }, "/tasks")).toEqual(new Set());
		expect(await search({ op: "exists", fieldPath: "frontmatter.legacy" }, "/tasks-archive")).toEqual(
			new Set([seeded.archivedTaskId]),
		);
		expect(await search({ op: "exists", fieldPath: "metadata.slack-message-id" })).toEqual(
			new Set([seeded.fixedTaskId]),
		);

		expect(await search({ op: "prefix", fieldPath: "frontmatter.status", value: "op" })).toEqual(
			new Set([seeded.openTaskId, seeded.archivedTaskId]),
		);
		expect(await search({ op: "range", fieldPath: "frontmatter.priority", valueKind: "number", gte: 2 })).toEqual(
			new Set([seeded.openTaskId, seeded.fixedTaskId]),
		);
		// The box refuses `prefix` and `range` with a folder, so the door answers them with nothing.
		expect(await search({ op: "prefix", fieldPath: "frontmatter.status", value: "op" }, "/tasks")).toEqual(new Set());
		expect(
			await search({ op: "range", fieldPath: "frontmatter.priority", valueKind: "number", gte: 2 }, "/tasks"),
		).toEqual(new Set());
		expect(await search({ op: "exists", fieldPath: "frontmatter.a..b" })).toEqual(new Set());

		// A draft value is never found, and the saved value still is.
		const pending = await upsert_pending_update_internal_for_test(t, {
			organizationId: seeded.db.organizationId,
			workspaceId: seeded.db.workspaceId,
			userId: seeded.db.userId,
			nodeId: seeded.openTaskId,
			unstagedMarkdown: ["---", "status: triaging", "---", "Body draftword"].join("\n"),
		});
		if (pending._nay) throw new Error(pending._nay.message);
		expect(await search({ op: "eq", fieldPath: "frontmatter.status", value: "triaging" })).toEqual(new Set());
		expect(await search(statusOpen, "/tasks")).toEqual(new Set([seeded.openTaskId]));
		expect(
			await search_saved_page({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				clause: { kind: "content", text: "draftword" },
			}),
		).toEqual(new Set());
	});

	test("search_saved scopes names by the folder's stored ancestors", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const reportId = await test_create_saved_text_file(t, {
			membershipId: seeded.db.membershipId,
			path: "/tasks/weekly-report.md",
		});
		const notesId = await test_create_saved_text_file(t, {
			membershipId: seeded.db.membershipId,
			path: "/tasks/inner/weekly-notes.md",
		});
		const oldId = await test_create_saved_text_file(t, {
			membershipId: seeded.db.membershipId,
			path: "/tasks-archive/weekly-old.md",
		});
		const rootId = await test_create_saved_text_file(t, {
			membershipId: seeded.db.membershipId,
			path: "/weekly-root.md",
		});
		// A draft the owner has not saved yet.
		const draft = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: seeded.db.organizationId,
			workspaceId: seeded.db.workspaceId,
			userId: seeded.db.userId,
			path: "/tasks/weekly-draft.md",
			kind: "file",
		});
		if (draft._nay) throw new Error(draft._nay.message);
		const search = (text: string, folderPath?: string) =>
			search_saved_page({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				clause: { kind: "name", text },
				folderPath,
			});

		expect(await search("weekly")).toEqual(new Set([reportId, notesId, oldId, rootId]));
		expect(await search("weekly", "/tasks")).toEqual(new Set([reportId, notesId]));
		expect(await search("weekly", "/tasks/inner")).toEqual(new Set([notesId]));
		expect(await search("weekly", "/tasks-archive")).toEqual(new Set([oldId]));
		expect(await search("weekly", "/")).toEqual(new Set([reportId, notesId, oldId, rootId]));
		const innerFolders = await search_saved_page({
			asWho: seeded.asOwner,
			membershipId: seeded.db.membershipId,
			clause: { kind: "name", text: "inner", nodeKind: "folder" },
		});
		expect(innerFolders.size).toBe(1);
		expect(
			await search_saved_page({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				clause: { kind: "name", text: "inner", nodeKind: "file" },
			}),
		).toEqual(new Set());

		// The folder must be a saved, active folder at exactly that path.
		for (const folderPath of ["/missing", "/Tasks", "/tasks/weekly-report.md", "tasks"]) {
			expect(await search("weekly", folderPath)).toEqual(new Set(["Folder not found"]));
		}
		// Contents have no folder scope in the box.
		expect(
			await search_saved_page({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				clause: { kind: "content", text: "Body" },
				folderPath: "/tasks",
			}),
		).toEqual(new Set());
	});

	test("search_saved refuses a folder deeper than 12 levels", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const levels = Array.from({ length: 13 }, (_, index) => `l${index + 1}`);
		const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: `/${levels.join("/")}`,
		});
		if (created._nay) throw new Error(created._nay.message);
		const twelve = `/${levels.slice(0, 12).join("/")}`;
		const deepId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: `${twelve}/deep-note.md`,
		});
		const search = (folderPath: string) =>
			search_saved_page({
				asWho: asUser,
				membershipId: db.membershipId,
				clause: { kind: "name", text: "deep" },
				folderPath,
			});

		expect(await search(twelve)).toEqual(new Set([deepId]));
		expect(await search(`/${levels.join("/")}`)).toEqual(
			new Set(["This folder is too deep to search inside. Search a folder higher up"]),
		);
	});

	test("search_saved hides restricted rows and folders from a member", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "saved" });
		await t.run(async (ctx) =>
			access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.db.organizationId,
				workspaceId: seeded.db.workspaceId,
				userId: member.userId,
				role: "member",
				now: Date.now(),
			}),
		);
		await reset_file_write_rate_limits(t, seeded.db.userId);
		const restricted = await seeded.asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: seeded.db.membershipId,
			nodeId: seeded.tasksFolderId,
		});
		if (restricted._nay) throw new Error(restricted._nay.message);
		const search = (
			who: "owner" | "member",
			clause: FunctionArgs<typeof api.files_nodes.search_saved>["clause"],
			folderPath?: string,
		) =>
			search_saved_page({
				asWho: who === "owner" ? seeded.asOwner : member.asMember,
				membershipId: who === "owner" ? seeded.db.membershipId : member.membershipId,
				clause,
				folderPath,
			});
		const statusOpen = {
			kind: "metadata",
			plan: { op: "eq", fieldPath: "frontmatter.status", value: "open" },
		} as const;
		const allTasks = new Set([seeded.openTaskId, seeded.fixedTaskId, seeded.archivedTaskId]);

		// Every task name starts with the year, so it is a word start of each one.
		expect(await search("owner", { kind: "name", text: "2026" })).toEqual(allTasks);
		expect(await search("member", { kind: "name", text: "2026" })).toEqual(new Set([seeded.archivedTaskId]));
		expect(await search("owner", { kind: "content", text: "Body" })).toEqual(allTasks);
		expect(await search("member", { kind: "content", text: "Body" })).toEqual(new Set([seeded.archivedTaskId]));
		expect(await search("member", statusOpen)).toEqual(new Set([seeded.archivedTaskId]));
		expect(await search("owner", statusOpen, "/tasks")).toEqual(new Set([seeded.openTaskId]));
		// An unreadable folder answers like a missing one.
		expect(await search("member", statusOpen, "/tasks")).toEqual(new Set(["Folder not found"]));
		expect(await search("member", { kind: "name", text: "2026" }, "/tasks")).toEqual(new Set(["Folder not found"]));

		// An exact path or a node id finds one readable, active row. Paths keep their case.
		const openTaskPath = "/tasks/2026-09-04-raw-media.md";
		expect(await search("owner", { kind: "path", path: openTaskPath })).toEqual(new Set([seeded.openTaskId]));
		expect(await search("owner", { kind: "path", path: seeded.openTaskId })).toEqual(new Set([seeded.openTaskId]));
		expect(await search("owner", { kind: "path", path: "/Tasks/2026-09-04-raw-media.md" })).toEqual(new Set());
		expect(await search("owner", { kind: "path", path: "/tasks" })).toEqual(new Set([seeded.tasksFolderId]));
		expect(await search("member", { kind: "path", path: openTaskPath })).toEqual(new Set());
		expect(await search("member", { kind: "path", path: seeded.openTaskId })).toEqual(new Set());
		expect(await search("member", { kind: "path", path: "/tasks-archive/2026-07-01-old.md" })).toEqual(
			new Set([seeded.archivedTaskId]),
		);

		// Public links, inside a folder too. A member never sees the restricted file's link.
		await t.run(async (ctx) => {
			for (const nodeId of [seeded.openTaskId, seeded.archivedTaskId]) {
				await ctx.db.insert("files_share_links", {
					organizationId: seeded.db.organizationId,
					workspaceId: seeded.db.workspaceId,
					nodeId,
					token: `token-${nodeId}`,
					restrictedScopeNodeId: null,
					ancestorNodeIds: [],
					createdBy: seeded.db.userId,
					createdAt: Date.now(),
				});
			}
		});
		expect(await search("owner", { kind: "link" })).toEqual(new Set([seeded.openTaskId, seeded.archivedTaskId]));
		expect(await search("owner", { kind: "link" }, "/tasks")).toEqual(new Set([seeded.openTaskId]));
		expect(await search("member", { kind: "link" })).toEqual(new Set([seeded.archivedTaskId]));

		// An archived row is gone.
		await reset_file_write_rate_limits(t, seeded.db.userId);
		const archived = await seeded.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.db.membershipId,
			nodeIds: [seeded.archivedTaskId],
		});
		if (archived._nay) throw new Error(archived._nay.message);
		expect(await search("owner", { kind: "path", path: seeded.archivedTaskId })).toEqual(new Set());
		expect(await search("owner", { kind: "name", text: "2026" })).toEqual(
			new Set([seeded.openTaskId, seeded.fixedTaskId]),
		);
	});
});
