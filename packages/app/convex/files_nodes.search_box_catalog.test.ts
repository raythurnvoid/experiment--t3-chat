// Search box door tests for the key and value catalog. The search_saved door tests are in
// files_nodes.search_box.test.ts.
import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	test_compact_metadata_catalog,
	test_convex,
	test_finish_saved_scope_jobs,
	test_run_with_flush,
} from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import type { files_metadata_SearchPlan } from "../shared/files-metadata.ts";
import {
	upsert_pending_update_internal_for_test,
	reset_file_write_rate_limits,
	seed_search_box_fixture,
	seed_grant_only_member,
	list_keys,
	list_values,
	statusOpenPlans,
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
	test("every door answers somebody else's membership with its empty shape", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);
		const member = await seed_grant_only_member({ t, db: seeded.db, suffix: "other" });

		expect(
			await seeded.asOwner.action(api.files_nodes.search_saved_metadata, {
				membershipId: member.membershipId,
				plan: statusOpenPlans[0]!,
				numItems: 50,
				cursor: null,
			}),
		).toEqual({ _yay: { page: [], cursor: null, isDone: true } });
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

	test("the custom-field search refuses a cursor it did not make", async () => {
		const t = test_convex();
		const seeded = await seed_search_box_fixture(t);

		// Another door's cursor, and a value that is not JSON.
		for (const value of [JSON.stringify({ scope: "list", streams: [] }), "not json"]) {
			const cursor = await t.mutation(internal.value_store.put, { value, ttl: 60_000 });
			expect(
				await seeded.asOwner.action(api.files_nodes.search_saved_metadata, {
					membershipId: seeded.db.membershipId,
					plan: statusOpenPlans[0]!,
					numItems: 50,
					cursor,
				}),
			).toEqual({ _nay: { message: "This search cursor is not valid. Search again." } });
		}
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
			t.query(internal.files_metadata.get_index_values_by_path, {
				organizationId: seeded.db.organizationId,
				workspaceId: seeded.db.workspaceId,
				userId: member.userId,
				subject: { kind: "user", userId: member.userId, plugin: null },
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
				restrictedScopeNodeId: null,
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
		const { page: rootFolders } = await seeded.asOwner.query(api.files_tree.list_tree_children, {
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
		await test_finish_saved_scope_jobs(t);

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
					restrictedScopeNodeId: null,
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
				restrictedScopeNodeId: null,
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
		// The docs of `/tasks` move to its area with the saved scope job.
		await test_finish_saved_scope_jobs(t);

		const search = () =>
			search_saved_plans({ asWho: member.asMember, membershipId: member.membershipId, plans: statusOpenPlans });
		const keys = (folderPath?: string) =>
			list_keys({ t, asWho: member.asMember, membershipId: member.membershipId, folderPath }).then((fields) =>
				fields.map((field) => field.fieldPath),
			);
		const statusValues = (folderPath?: string) =>
			list_values({
				t,
				asWho: member.asMember,
				membershipId: member.membershipId,
				folderPath,
				fieldPath: "frontmatter.status",
				prefix: "",
			});

		// The role reads the whole workspace except the restricted `/tasks`: only the archive file is
		// found, and the suggestions at the root come from the open area only.
		expect(await search()).toEqual(new Set([seeded.archivedTaskId]));
		expect(await statusValues()).toEqual(["open"]);
		const keysBefore = await keys();
		expect(keysBefore).toContain("frontmatter.legacy");
		expect(keysBefore).not.toContain("frontmatter.regression");
		expect(keysBefore).not.toContain("metadata.status");
		expect(await statusValues("/tasks")).toEqual([]);

		await reset_file_write_rate_limits(t, seeded.db.userId);
		const granted = await seeded.asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: seeded.db.membershipId,
			nodeId: seeded.tasksFolderId,
			principal: { kind: "user", userId: member.userId },
			level: "read",
		});
		if (granted._nay) throw new Error(granted._nay.message);

		// With the grant, `/tasks` suggests its own area's keys and values.
		expect(await search()).toEqual(new Set([seeded.openTaskId, seeded.fixedTaskId, seeded.archivedTaskId]));
		expect(await statusValues()).toEqual(["open"]);
		expect(await statusValues("/tasks")).toEqual(["fixed", "open"]);
		expect(await keys("/tasks")).toContain("metadata.status");
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
});
