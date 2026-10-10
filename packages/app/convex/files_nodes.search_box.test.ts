import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import type { FunctionArgs } from "convex/server";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { api, components, internal } from "./_generated/api.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_move_nodes,
	test_create_saved_text_file,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import type { Id } from "./_generated/dataModel.js";
import type { files_metadata_SearchPlan } from "../shared/files-metadata.ts";
import { files_search_query_parse, files_search_query_to_plans } from "../shared/files-search-query.ts";
import {
	seed_billing_snapshot_for_user,
	upsert_pending_update_internal_for_test,
	test_setup_r2_capture,
	test_materialize_markdown_file,
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
	/**
	 * Each seeded file spends one Yjs push and the sharing steps spend tree writes, so the strict
	 * per-user limits run out inside one fixture. Reset them between steps.
	 */
	async function reset_file_write_rate_limits(t: ReturnType<typeof test_convex>, userId: Id<"users">) {
		for (const name of ["files_yjs_push_update", "files_tree_write", "files_sharing_write"]) {
			await t.mutation(components.rate_limiter.lib.resetRateLimit, { name, key: userId });
		}
	}

	/**
	 * Three tasks with frontmatter, one of them with metadata-map keys too, and a look-alike folder
	 * `/tasks-archive` that a tree-path bound with the wrong end character would include in `/tasks`.
	 */
	async function seed_search_box_fixture(t: ReturnType<typeof test_convex>) {
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		await t.run(async (ctx) => seed_billing_snapshot_for_user(ctx, db.userId));
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Search Box Owner",
			email: "search-box-owner@example.com",
		});
		test_setup_r2_capture();

		const openTaskId = await test_materialize_markdown_file({
			t,
			asUser: asOwner,
			db,
			path: "/tasks/2026-09-04-raw-media.md",
			markdown: [
				"---",
				"status: open",
				"priority: 3",
				"regression: true",
				"reported: 2026-09-04",
				"tags:",
				"  - teams",
				"  - macos",
				"source:",
				"  channel: qa-and-feedback",
				"---",
				"Body",
			].join("\n"),
		});
		await reset_file_write_rate_limits(t, db.userId);
		const fixedTaskId = await test_materialize_markdown_file({
			t,
			asUser: asOwner,
			db,
			path: "/tasks/2026-08-20-waiting-room.md",
			markdown: ["---", "status: fixed", "priority: 2", "reported: 2026-08-20", "---", "Body"].join("\n"),
		});
		await reset_file_write_rate_limits(t, db.userId);
		const archivedTaskId = await test_materialize_markdown_file({
			t,
			asUser: asOwner,
			db,
			path: "/tasks-archive/2026-07-01-old.md",
			markdown: ["---", "status: open", "priority: 1", "legacy: yes", "---", "Body"].join("\n"),
		});
		await reset_file_write_rate_limits(t, db.userId);

		// The metadata map is the second metadata kind: this file is "fixed" in its frontmatter and "open"
		// in its map, and its map holds a key with a colon.
		const written = await asOwner.mutation(api.files_metadata.set_entries, {
			membershipId: db.membershipId,
			fileNodeId: fixedTaskId,
			metadataYaml: ["status: open", "slack-message-id: '1757003021.482119'"].join("\n"),
		});
		if (written._nay) throw new Error(written._nay.message);

		const { page: rootFolders } = await asOwner.query(api.files_nodes.list_tree_children, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			kind: "folder",
			archived: false,
			restricted: false,
			paginationOpts: { numItems: 50, cursor: null },
		});
		const tasksFolderId = rootFolders.find((fileNode) => fileNode.path === "/tasks")!._id;

		return { db, asOwner, openTaskId, fixedTaskId, archivedTaskId, tasksFolderId };
	}

	/**
	 * A member with no role at all, so the workspace lets them read nothing and only a share grant
	 * can let them in. The owner passes every check, so a refusal needs this second identity.
	 */
	async function seed_grant_only_member(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;
		suffix: string;
	}) {
		const { t, db, suffix } = args;

		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: `clerk_search_box_${suffix}` });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			return { userId, membershipId };
		});
		return {
			...member,
			asMember: t.withIdentity({
				issuer: "https://clerk.test",
				external_id: member.userId,
				name: `Search Box Member ${suffix}`,
			}),
		};
	}

	/**
	 * The first page of saved keys that start with `prefix`, once the catalog compactor applied every
	 * save.
	 */
	async function list_keys(args: {
		t: ReturnType<typeof test_convex>;
		asWho: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		membershipId: Id<"organizations_workspaces_users">;
		prefix?: string;
	}) {
		await test_compact_metadata_catalog(args.t);
		const result = await args.asWho.query(api.files_metadata.list_search_fields, {
			membershipId: args.membershipId,
			prefix: args.prefix ?? "",
			paginationOpts: { numItems: 50, cursor: null },
		});
		return result.page;
	}

	/**
	 * The first page of saved string values of `fieldPath` that start with `prefix`, like `list_keys`.
	 */
	async function list_values(args: {
		t: ReturnType<typeof test_convex>;
		asWho: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		membershipId: Id<"organizations_workspaces_users">;
		fieldPath: string;
		prefix: string;
	}) {
		await test_compact_metadata_catalog(args.t);
		const result = await args.asWho.query(api.files_metadata.list_search_values, {
			membershipId: args.membershipId,
			fieldPath: args.fieldPath,
			prefix: args.prefix,
			paginationOpts: { numItems: 50, cursor: null },
		});
		return result.page;
	}

	const statusOpenPlans: files_metadata_SearchPlan[] = [
		{ op: "eq", fieldPath: "frontmatter.status", value: "open" },
		{ op: "eq", fieldPath: "metadata.status", value: "open" },
	];

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

	test("every door answers somebody else's membership with its empty shape", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "other" });

		expect(
			await seeded.asOwner.query(api.files_nodes.search_saved, {
				membershipId: member.membershipId,
				clause: { kind: "metadata", plan: statusOpenPlans[0]! },
				paginationOpts: { numItems: 50, cursor: null },
			}),
		).toEqual({ page: [], isDone: true, continueCursor: "" });
		expect(await list_keys({ t, asWho: seeded.asOwner, membershipId: member.membershipId })).toEqual([]);
		expect(
			await list_values({
				t,
				asWho: seeded.asOwner,
				membershipId: member.membershipId,
				fieldPath: "frontmatter.status",
				prefix: "",
			}),
		).toEqual([]);
		expect(
			await seeded.asOwner.query(api.files_metadata.get_search_field, {
				membershipId: member.membershipId,
				fieldPath: "frontmatter.status",
			}),
		).toBeNull();
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

	test("folder maps follow read and write grants in every metadata door", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "folder-map" });
		await reset_file_write_rate_limits(t, seeded.db.userId);
		expect(
			await seeded.asOwner.mutation(api.files_metadata.set_entries, {
				membershipId: seeded.db.membershipId,
				fileNodeId: seeded.tasksFolderId,
				metadataYaml: "folder-secret: visible-with-grant",
			}),
		).toEqual({ _yay: null });
		expect(
			(
				await seeded.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: seeded.db.membershipId,
					nodeId: seeded.tasksFolderId,
				})
			)._nay,
		).toBeUndefined();
		const plans: files_metadata_SearchPlan[] = [{ op: "exists", fieldPath: "metadata.folder-secret" }];
		const entries = () =>
			member.asMember.query(api.files_metadata.get_entries, {
				membershipId: member.membershipId,
				fileNodeId: seeded.tasksFolderId,
			});
		const byPath = () =>
			t.query(internal.files_metadata.get_by_path, {
				organizationId: seeded.db.organizationId,
				workspaceId: seeded.db.workspaceId,
				userId: member.userId,
				overlayUserId: member.userId,
				path: "/tasks",
			});
		const search = () => search_saved_plans({ asWho: member.asMember, membershipId: member.membershipId, plans });
		const fields = () => list_keys({ t, asWho: member.asMember, membershipId: member.membershipId });
		const values = () =>
			list_values({
				t,
				asWho: member.asMember,
				membershipId: member.membershipId,
				fieldPath: "metadata.folder-secret",
				prefix: "",
			});
		const set = () =>
			member.asMember.mutation(api.files_metadata.set_entries, {
				membershipId: member.membershipId,
				fileNodeId: seeded.tasksFolderId,
				metadataYaml: "folder-secret: changed",
			});
		const update = () =>
			t.mutation(internal.files_metadata.update_entries_by_path, {
				organizationId: seeded.db.organizationId,
				workspaceId: seeded.db.workspaceId,
				userId: member.userId,
				path: "/tasks",
				set: [{ key: "folder-secret", value: "agent-edit" }],
				remove: [],
			});
		expect(await entries()).toEqual([]);
		expect(await byPath()).toBeNull();
		expect(await search()).toEqual(new Set());
		// Suggestions need workspace read, so a member without it gets none.
		expect(await fields()).toEqual([]);
		expect(await values()).toEqual([]);
		expect((await set())._nay).toBeDefined();
		expect((await update())._nay).toBeDefined();

		await reset_file_write_rate_limits(t, seeded.db.userId);
		expect(
			(
				await seeded.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: seeded.db.membershipId,
					nodeId: seeded.tasksFolderId,
					principal: { kind: "user", userId: member.userId },
					level: "read",
				})
			)._nay,
		).toBeUndefined();
		expect(await entries()).toEqual([{ key: "folder-secret", value: "visible-with-grant" }]);
		expect(await byPath()).toMatchObject({
			target: { kind: "saved", id: seeded.tasksFolderId },
			fields: ["metadata.folder-secret"],
		});
		// The grant opens the folder, but not the workspace-wide suggestions.
		expect(await search()).toEqual(new Set([seeded.tasksFolderId]));
		expect(await fields()).toEqual([]);
		expect(await values()).toEqual([]);
		expect((await set())._nay).toBeDefined();
		expect((await update())._nay).toBeDefined();

		await reset_file_write_rate_limits(t, seeded.db.userId);
		expect(
			(
				await seeded.asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: seeded.db.membershipId,
					nodeId: seeded.tasksFolderId,
					principal: { kind: "user", userId: member.userId },
					level: "write",
				})
			)._nay,
		).toBeUndefined();
		expect((await set())._nay).toBeUndefined();
		expect(await entries()).toEqual([{ key: "folder-secret", value: "changed" }]);
		expect((await update())._nay).toBeUndefined();
		expect(await entries()).toEqual([{ key: "folder-secret", value: "agent-edit" }]);
	});

	test("list_search_fields lists every saved key with its kinds, to members with workspace read", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);

		const ownerFields = await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId });
		expect(ownerFields).toEqual([
			{ fieldPath: "frontmatter.legacy", valueKinds: ["string"] },
			{ fieldPath: "frontmatter.priority", valueKinds: ["number"] },
			{ fieldPath: "frontmatter.regression", valueKinds: ["boolean"] },
			{ fieldPath: "frontmatter.reported", valueKinds: ["string", "maybe_date"] },
			{ fieldPath: "frontmatter.source", valueKinds: [] },
			{ fieldPath: "frontmatter.source.channel", valueKinds: ["string"] },
			{ fieldPath: "frontmatter.status", valueKinds: ["string"] },
			{ fieldPath: "frontmatter.tags", valueKinds: ["string"] },
			{ fieldPath: "metadata.slack-message-id", valueKinds: ["string"] },
			{ fieldPath: "metadata.status", valueKinds: ["string"] },
		]);
		// A prefix ignores case, and a namespace prefix lists its whole namespace.
		expect(
			(await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, prefix: "Frontmatter.S" })).map(
				(field) => field.fieldPath,
			),
		).toEqual(["frontmatter.source", "frontmatter.source.channel", "frontmatter.status"]);
		expect(
			await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, prefix: "metadata." }),
		).toHaveLength(2);
		expect(await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, prefix: "x" })).toEqual([]);
		expect(
			await seeded.asOwner.query(api.files_metadata.get_search_field, {
				membershipId: seeded.db.membershipId,
				fieldPath: "frontmatter.regression",
			}),
		).toEqual({ valueKinds: ["boolean"] });
		expect(
			await seeded.asOwner.query(api.files_metadata.get_search_field, {
				membershipId: seeded.db.membershipId,
				fieldPath: "frontmatter.Regression",
			}),
		).toBeNull();

		// Suggestions are saved-only: a key that only exists in the owner's draft is not suggested, not
		// even to the owner.
		const pending = await upsert_pending_update_internal_for_test(t, {
			organizationId: seeded.db.organizationId,
			workspaceId: seeded.db.workspaceId,
			userId: seeded.db.userId,
			nodeId: seeded.openTaskId,
			unstagedMarkdown: ["---", "status: open", "draft-key: x", "---", "Body"].join("\n"),
		});
		if (pending._nay) throw new Error(pending._nay.message);
		const ownerFieldsWithDraft = await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId });
		expect(ownerFieldsWithDraft.map((field) => field.fieldPath)).not.toContain("frontmatter.draft-key");
		expect(ownerFieldsWithDraft.map((field) => field.fieldPath)).toContain("frontmatter.regression");

		// A member with no role reads no workspace, so they get no keys: the catalog would show keys of
		// files they cannot open.
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "fields" });
		const memberField = () =>
			member.asMember.query(api.files_metadata.get_search_field, {
				membershipId: member.membershipId,
				fieldPath: "frontmatter.legacy",
			});
		expect(await list_keys({ t, asWho: member.asMember, membershipId: member.membershipId })).toEqual([]);
		expect(await memberField()).toBeNull();

		// As a viewer they read the workspace, so they get the same saved keys as the owner. The draft
		// key stays out.
		await t.run(async (ctx) =>
			access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.db.organizationId,
				workspaceId: seeded.db.workspaceId,
				userId: member.userId,
				role: "viewer",
				now: Date.now(),
			}),
		);
		expect(await list_keys({ t, asWho: member.asMember, membershipId: member.membershipId })).toEqual(ownerFields);
		expect(await memberField()).toEqual({ valueKinds: ["string"] });
	});

	test("the key and value doors page through every row, one range per page", async () => {
		const t = test_convex({ transactionLimits: true });
		const seeded = await seed_search_box_fixture(t);
		// 120 more keys with one value each, and 450 values of one key, on the open task.
		await test_run_with_flush(t, async (ctx) => {
			const openTask = (await ctx.db.get("files_nodes", seeded.openTaskId))!;
			const doc = {
				organizationId: seeded.db.organizationId,
				workspaceId: seeded.db.workspaceId,
				fileNodeId: seeded.openTaskId,
				sourceKind: "committed" as const,
				path: openTask.path,
				treePath: openTask.treePath,
			};
			for (let index = 0; index < 120; index += 1) {
				const fieldPath = `frontmatter.page-${String(index).padStart(3, "0")}`;
				await ctx.db.insert("files_metadata_docs", { ...doc, fieldPath, docKind: "field", parentId: openTask.parentId });
			}
			for (let index = 0; index < 450; index += 1)
				await ctx.db.insert("files_metadata_docs", {
					...doc,
					fieldPath: "frontmatter.status",
					docKind: "value",
					valueKind: "string",
					stringValue: `v${String(index).padStart(3, "0")}`,
				});
		});
		await test_compact_metadata_catalog(t);

		const read_all = async <Row,>(read: (cursor: string | null) => Promise<{ page: Row[]; isDone: boolean; continueCursor: string }>) => {
			const rows: Row[] = [];
			const sizes: number[] = [];
			let cursor: string | null = null;
			for (;;) {
				const result = await read(cursor);
				rows.push(...result.page);
				sizes.push(result.page.length);
				if (result.isDone) return { rows, sizes };
				cursor = result.continueCursor;
			}
		};
		// A client asking for more than a page gets 50 rows.
		const keys = await read_all((cursor) =>
			seeded.asOwner.query(api.files_metadata.list_search_fields, {
				membershipId: seeded.db.membershipId,
				prefix: "frontmatter.page-",
				paginationOpts: { numItems: 500, cursor },
			}),
		);
		expect(keys.sizes.slice(0, 2)).toEqual([50, 50]);
		expect(keys.rows.map((row) => row.fieldPath)).toEqual(
			Array.from({ length: 120 }, (_, index) => `frontmatter.page-${String(index).padStart(3, "0")}`),
		);
		// A sparse prefix after many other keys finds its key on the first page.
		expect(
			await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, prefix: "frontmatter.sta" }),
		).toEqual([{ fieldPath: "frontmatter.status", valueKinds: ["string"] }]);

		const values = await read_all((cursor) =>
			seeded.asOwner.query(api.files_metadata.list_search_values, {
				membershipId: seeded.db.membershipId,
				fieldPath: "frontmatter.status",
				prefix: "v",
				paginationOpts: { numItems: 50, cursor },
			}),
		);
		expect(values.sizes[0]).toBe(50);
		expect(values.rows).toEqual(Array.from({ length: 450 }, (_, index) => `v${String(index).padStart(3, "0")}`));
	});

	test("archiving a folder drops its keys and values from the catalog", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const { page: rootFolders } = await seeded.asOwner.query(api.files_nodes.list_tree_children, {
			membershipId: seeded.db.membershipId,
			parentId: files_ROOT_ID,
			kind: "folder",
			archived: false,
			restricted: false,
			paginationOpts: { numItems: 50, cursor: null },
		});
		const archiveFolderId = rootFolders.find((fileNode) => fileNode.path === "/tasks-archive")!._id;
		const keys = () =>
			list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId }).then((fields) =>
				fields.map((field) => field.fieldPath),
			);
		const legacyValues = () =>
			list_values({
				t,
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				fieldPath: "frontmatter.legacy",
				prefix: "",
			});

		expect(await keys()).toContain("frontmatter.legacy");
		expect(await legacyValues()).toEqual(["yes"]);

		await reset_file_write_rate_limits(t, seeded.db.userId);
		const archived = await seeded.asOwner.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.db.membershipId,
			nodeIds: [archiveFolderId],
		});
		if (archived._nay) throw new Error(archived._nay.message);

		expect(await keys()).not.toContain("frontmatter.legacy");
		expect(await keys()).toContain("frontmatter.status");
		expect(await legacyValues()).toEqual([]);
		expect(
			await search_saved_plans({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				plans: statusOpenPlans,
			}),
		).toEqual(new Set([seeded.openTaskId, seeded.fixedTaskId]));
	});

	test("the doors refuse a field or a prefix over the cap, with data a scan would answer", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		// Frontmatter has no cap on a key path's length, so a stored field can be longer than the
		// doors accept. The control sits exactly at the cap and proves the inserted docs are what the
		// doors read. `frontmatter.a..b` is a field the key grammar refuses. The catalog counts neither.
		const longField = `frontmatter.${"a".repeat(160)}`;
		const badField = "frontmatter.a..b";
		const controlField = `frontmatter.${"b".repeat(148)}`;
		await test_run_with_flush(t, async (ctx) => {
			const openTask = (await ctx.db.get("files_nodes", seeded.openTaskId))!;
			for (const fieldPath of [longField, badField, controlField]) {
				const doc = {
					organizationId: seeded.db.organizationId,
					workspaceId: seeded.db.workspaceId,
					fileNodeId: seeded.openTaskId,
					sourceKind: "committed" as const,
					path: openTask.path,
					treePath: openTask.treePath,
					fieldPath,
				};
				await ctx.db.insert("files_metadata_docs", { ...doc, docKind: "field" });
				await ctx.db.insert("files_metadata_docs", { ...doc, docKind: "value", valueKind: "string", stringValue: "x" });
			}
			// A value longer than the prefix cap: a prefix at the cap finds it, one past the cap is refused.
			await ctx.db.insert("files_metadata_docs", {
				organizationId: seeded.db.organizationId,
				workspaceId: seeded.db.workspaceId,
				fileNodeId: seeded.openTaskId,
				sourceKind: "committed",
				path: openTask.path,
				treePath: openTask.treePath,
				fieldPath: "frontmatter.status",
				docKind: "value",
				valueKind: "string",
				stringValue: "o".repeat(201),
			});
		});
		const keys = (await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId })).map(
			(field) => field.fieldPath,
		);
		const nodeIds = (fieldPath: string) =>
			search_saved_plans({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				plans: [{ op: "exists", fieldPath }],
			}).then((found) => [...found]);
		const values = (fieldPath: string, prefix: string) =>
			list_values({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, fieldPath, prefix });

		expect(keys).toContain(controlField);
		expect(await nodeIds(controlField)).toEqual([seeded.openTaskId]);
		expect(await values(controlField, "")).toEqual(["x"]);
		for (const refused of [longField, badField]) {
			expect(keys).not.toContain(refused);
			expect(await nodeIds(refused)).toEqual([]);
			expect(await values(refused, "")).toEqual([]);
		}
		expect(await values("frontmatter.status", "o".repeat(200))).toEqual(["o".repeat(201)]);
		expect(await values("frontmatter.status", "o".repeat(201))).toEqual([]);
		// A key prefix longer than any key is refused too.
		expect(
			await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, prefix: `${controlField}b` }),
		).toEqual([]);
		expect(
			await list_keys({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, prefix: "f".repeat(161) }),
		).toEqual([]);
	});

	test("list_search_values lists distinct saved values that start with the prefix, to members with workspace read", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const values = (fieldPath: string, prefix: string) =>
			list_values({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, fieldPath, prefix });

		expect(await values("frontmatter.status", "")).toEqual(["fixed", "open"]);
		expect(await values("frontmatter.status", "o")).toEqual(["open"]);
		// The range starts at the prefix itself, so a fully typed value still lists its row.
		expect(await values("frontmatter.status", "open")).toEqual(["open"]);
		// Values keep their case.
		expect(await values("frontmatter.status", "O")).toEqual([]);
		expect(await values("frontmatter.status", "z")).toEqual([]);
		expect(await values("metadata.status", "")).toEqual(["open"]);
		expect(await values("frontmatter.tags", "")).toEqual(["macos", "teams"]);
		// Input the app never sends gets the empty answer, not an error.
		expect(await values("status", "")).toEqual([]);
		expect(await values(`frontmatter.${"a".repeat(160)}`, "")).toEqual([]);
		expect(await values("frontmatter.status", "o".repeat(201))).toEqual([]);

		// A member with no role reads no workspace, so they get no values.
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "values" });
		expect(
			await list_values({
				t,
				asWho: member.asMember,
				membershipId: member.membershipId,
				fieldPath: "frontmatter.legacy",
				prefix: "",
			}),
		).toEqual([]);
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

	test("a member with workspace read still needs the grant for a restricted folder", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "reader" });
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

		const search = () =>
			search_saved_plans({ asWho: member.asMember, membershipId: member.membershipId, plans: statusOpenPlans });
		const keys = () =>
			list_keys({ t, asWho: member.asMember, membershipId: member.membershipId }).then((fields) =>
				fields.map((field) => field.fieldPath),
			);
		const statusValues = () =>
			list_values({
				t,
				asWho: member.asMember,
				membershipId: member.membershipId,
				fieldPath: "frontmatter.status",
				prefix: "",
			});

		// The role reads the whole workspace except the restricted `/tasks`: only the archive file is
		// found. Accepted leak until a search engine arrives: suggestions still name the keys and
		// values of `/tasks`.
		expect(await search()).toEqual(new Set([seeded.archivedTaskId]));
		expect(await statusValues()).toEqual(["fixed", "open"]);
		const keysBefore = await keys();
		expect(keysBefore).toContain("frontmatter.legacy");
		expect(keysBefore).toContain("frontmatter.regression");
		expect(keysBefore).toContain("metadata.status");

		await reset_file_write_rate_limits(t, seeded.db.userId);
		const granted = await seeded.asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: seeded.db.membershipId,
			nodeId: seeded.tasksFolderId,
			principal: { kind: "user", userId: member.userId },
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);

		expect(await search()).toEqual(new Set([seeded.openTaskId, seeded.fixedTaskId, seeded.archivedTaskId]));
		expect(await statusValues()).toEqual(["fixed", "open"]);
		expect(await keys()).toContain("metadata.status");
	});

	test("list_search_values keeps the saved value while the owner has a draft", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const statusValues = (prefix: string) =>
			list_values({ t, asWho: seeded.asOwner, membershipId: seeded.db.membershipId, fieldPath: "frontmatter.status", prefix });

		// Suggestions and search rows are saved-only.
		const pending = await upsert_pending_update_internal_for_test(t, {
			organizationId: seeded.db.organizationId,
			workspaceId: seeded.db.workspaceId,
			userId: seeded.db.userId,
			nodeId: seeded.fixedTaskId,
			unstagedMarkdown: ["---", "status: triaging", "---", "Body"].join("\n"),
		});
		if (pending._nay) throw new Error(pending._nay.message);

		expect(await statusValues("f")).toEqual(["fixed"]);
		expect(await statusValues("t")).toEqual([]);
		expect(
			await search_saved_plans({
				asWho: seeded.asOwner,
				membershipId: seeded.db.membershipId,
				plans: [{ op: "eq", fieldPath: "frontmatter.status", value: "fixed" }],
			}),
		).toEqual(new Set([seeded.fixedTaskId]));
	});

	/**
	 * One first page of `search_saved`, as node ids, or the problem message.
	 */
	async function search_saved_page(args: {
		asWho: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		membershipId: Id<"organizations_workspaces_users">;
		clause: FunctionArgs<typeof api.files_nodes.search_saved>["clause"];
		folderPath?: string;
	}) {
		const result = await args.asWho.query(api.files_nodes.search_saved, {
			membershipId: args.membershipId,
			clause: args.clause,
			folderPath: args.folderPath,
			paginationOpts: { numItems: 50, cursor: null },
		});
		return new Set(result.page.map((row) => (row.kind === "problem" ? row.message : row.nodeId)));
	}

	/**
	 * `search_saved_page` for each plan of one chip, as one set: a chip with two plans is two calls.
	 */
	async function search_saved_plans(args: {
		asWho: ReturnType<ReturnType<typeof test_convex>["withIdentity"]>;
		membershipId: Id<"organizations_workspaces_users">;
		plans: files_metadata_SearchPlan[];
		folderPath?: string;
	}) {
		const pages = await Promise.all(
			args.plans.map((plan) => search_saved_page({ ...args, clause: { kind: "metadata", plan } })),
		);
		return new Set(pages.flatMap((page) => [...page]));
	}

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
