import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";

const text = "Private notebook\nSecond line\n";
const path = "/notes/note.txt";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("file-read-source-test-work" as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "file-read-source-test-key",
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function seed_file(t: ReturnType<typeof test_convex>, membershipId: Id<"organizations_workspaces_users">) {
	const nodeId = await test_create_saved_text_file(t, { membershipId, path, textContent: text });
	const node = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	if (!node || node.parentId === files_ROOT_ID) throw new Error("Expected a file inside notes");
	const membership = await t.run((ctx) => ctx.db.get("organizations_workspaces_users", membershipId));
	if (!membership) throw new Error("Expected membership");
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: membership.userId });
	expect(
		await asUser.mutation(api.files_metadata.set_entries, {
			membershipId,
			fileNodeId: nodeId,
			metadataYaml: "topic: notebook",
		}),
	).toEqual({ _yay: null });
	return { nodeId, folderId: node.parentId };
}

async function fixture() {
	const t = test_convex();
	const owner = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "source-team", workspaceName: "home" }),
	);
	const home = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: home.userId });
	const invite = { organizationId: owner.organizationId, workspaceId: owner.workspaceId, userIdToAdd: home.userId };
	expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invite)).toEqual({
		_yay: null,
	});
	expect(
		await asOwner.mutation(api.access_control.set_user_role, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: home.userId,
			role: "viewer",
		}),
	).toEqual({ _yay: null });
	const membership = await t.run((ctx) =>
		ctx.db
			.query("organizations_workspaces_users")
			.withIndex("by_workspace_user_active", (q) =>
				q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
			)
			.first(),
	);
	if (!membership) throw new Error("Expected team membership");
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: membership._id,
		clientGeneratedId: "file-read-source-chat",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		membershipId: membership._id,
		userId: home.userId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const agentSource = {
		organizationId: owner.organizationId,
		workspaceId: owner.workspaceId,
		userId: home.userId,
		threadId: created._yay.threadId,
		membershipId: membership._id,
		membershipLifetime: captured._yay.membershipLifetime,
	};
	const scope = { organizationId: home.organizationId, workspaceId: home.workspaceId, userId: home.userId };
	return { t, owner, home, asOwner, asUser, invite, agentSource, scope, ...(await seed_file(t, home.membershipId)) };
}

async function leave_and_reinvite(f: Awaited<ReturnType<typeof fixture>>) {
	expect(
		await f.asUser.mutation(api.organizations.remove_user_from_organization, {
			organizationId: f.owner.organizationId,
			userIdToRemove: f.home.userId,
		}),
	).toEqual({ _yay: null });
	expect(await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, f.invite)).toEqual({
		_yay: null,
	});
}

function read_cases(f: Awaited<ReturnType<typeof fixture>>, agentSource?: typeof f.agentSource) {
	const scope = { ...f.scope, agentSource };
	const visible = {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
		visibilityUserId: scope.userId,
		overlayUserId: scope.userId,
		agentSource,
	};
	const target = { kind: "saved" as const, id: f.nodeId };
	const directory = { kind: "saved" as const, id: f.folderId };
	const match = { ...scope, target, pattern: "notebook", ignoreCase: false, fixedStrings: true, invert: false };
	const page = { numItems: 20, cursor: null };
	const empty = { items: [], continueCursor: "", isDone: true };
	return {
		get_by_path: {
			read: () => f.t.query(internal.files_nodes.get_by_path, { ...visible, path }),
			allowed: expect.objectContaining({ _id: f.nodeId }),
			refused: null,
		},
		get_visible_entry_by_path: {
			read: () => f.t.query(internal.files_nodes.get_visible_entry_by_path, { ...visible, path }),
			allowed: expect.objectContaining({ kind: "saved", node: expect.objectContaining({ _id: f.nodeId }) }),
			refused: null,
		},
		get_path_by_id: {
			read: () =>
				f.t.query(internal.files_nodes.get_path_by_id, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					visibilityUserId: scope.userId,
					nodeId: f.nodeId,
					agentSource,
				}),
			allowed: path,
			refused: null,
		},
		list_subtree: {
			read: () =>
				f.t.query(internal.files_nodes.list_subtree, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					visibilityUserId: scope.userId,
					agentSource,
					folderPath: "/notes",
					kind: "file",
					...page,
				}),
			allowed: expect.objectContaining({ page: [expect.objectContaining({ _id: f.nodeId })] }),
			refused: { page: [], continueCursor: "", isDone: true },
		},
		search_paths: {
			read: () =>
				f.t.query(internal.files_nodes.search_paths, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					visibilityUserId: scope.userId,
					agentSource,
					pathQuery: path,
					...page,
				}),
			allowed: expect.objectContaining({ items: [expect.objectContaining({ path })] }),
			refused: empty,
		},
		read_file_content_from_chunks: {
			read: () =>
				f.t.query(internal.files_nodes.read_file_content_from_chunks, {
					...scope,
					path,
					mode: { kind: "full", maxBytes: 1024 },
				}),
			allowed: expect.objectContaining({ target, content: text }),
			refused: null,
		},
		read_committed_file_chunks_line_range: {
			read: () =>
				f.t.query(internal.files_nodes.read_committed_file_chunks_line_range, {
					...scope,
					path,
					startLine: 1,
					maxLines: 1,
					fromEnd: false,
				}),
			allowed: expect.objectContaining({ usable: true, nodeId: f.nodeId, content: "Private notebook\n" }),
			refused: { usable: false },
		},
		read_committed_file_chunk_stats: {
			read: () => f.t.query(internal.files_nodes.read_committed_file_chunk_stats, { ...scope, path }),
			allowed: expect.objectContaining({ usable: true, nodeId: f.nodeId, lineCount: 2 }),
			refused: { usable: false },
		},
		match_text_file_lines: {
			read: () => f.t.query(internal.files_nodes.match_text_file_lines, { ...match, before: 0, after: 0 }),
			allowed: expect.objectContaining({ target, selectedCount: 1 }),
			refused: null,
		},
		match_plain_text_file_lines: {
			read: () => f.t.query(internal.files_nodes.match_plain_text_file_lines, match),
			allowed: expect.objectContaining({ target, selectedCount: 1 }),
			refused: null,
		},
		text_search_files: {
			read: () =>
				f.t.query(internal.files_nodes.text_search_files, {
					...scope,
					hasWorkspaceRead: true,
					query: "notebook",
					...page,
				}),
			allowed: expect.objectContaining({ items: [expect.objectContaining({ target, path })] }),
			refused: empty,
		},
		internal_list: {
			read: () =>
				f.t.query(internal.files_visible.internal_list, {
					...visible,
					folderPath: "/notes",
					mode: "children",
					...page,
				}),
			allowed: { _yay: expect.objectContaining({ items: [expect.objectContaining({ path })] }) },
			refused: { _yay: { items: [], continueCursor: null, isDone: true } },
		},
		internal_get_by_path: {
			read: () => f.t.query(internal.files_visible.internal_get_by_path, { ...scope, path }),
			allowed: expect.objectContaining({ kind: "saved", node: expect.objectContaining({ _id: f.nodeId }) }),
			refused: null,
		},
		internal_get_by_target: {
			read: () => f.t.query(internal.files_visible.internal_get_by_target, { ...scope, target }),
			allowed: expect.objectContaining({ kind: "saved", node: expect.objectContaining({ _id: f.nodeId }) }),
			refused: null,
		},
		internal_get_directory_path: {
			read: () => f.t.query(internal.files_visible.internal_get_directory_path, { ...scope, target: directory }),
			allowed: { target: directory, path: "/notes" },
			refused: null,
		},
		get_file_text_content_db_state_by_path: {
			read: () => f.t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, { ...scope, path }),
			allowed: expect.objectContaining({ target, content: text }),
			refused: null,
		},
		get_file_last_available_text_content_by_path: {
			read: () =>
				f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, { ...scope, path }),
			allowed: expect.objectContaining({ target, content: text }),
			refused: null,
		},
		read_file_line_range: {
			read: () =>
				f.t.action(internal.files_nodes_content.read_file_line_range, { ...scope, path, startLine: 1, maxLines: 1 }),
			allowed: expect.objectContaining({ target, content: "Private notebook\n" }),
			refused: null,
		},
		read_file_tail_lines: {
			read: () => f.t.action(internal.files_nodes_content.read_file_tail_lines, { ...scope, path, maxLines: 1 }),
			allowed: expect.objectContaining({ target, content: "Second line\n" }),
			refused: null,
		},
		read_file_content_stats: {
			read: () => f.t.action(internal.files_nodes_content.read_file_content_stats, { ...scope, path }),
			allowed: expect.objectContaining({ target, lineCount: 2, byteCount: text.length }),
			refused: null,
		},
		metadata_get_by_path: {
			read: () => f.t.query(internal.files_metadata.get_by_path, { ...scope, path }),
			allowed: expect.objectContaining({ target, fields: ["metadata.topic"] }),
			refused: null,
		},
		metadata_search: {
			read: () =>
				f.t.query(internal.files_metadata.search, {
					...scope,
					plan: { op: "eq", fieldPath: "metadata.topic", value: "notebook" },
					...page,
				}),
			allowed: expect.objectContaining({ items: [expect.objectContaining({ target, path })] }),
			refused: empty,
		},
	};
}

const doors = [
	"get_by_path",
	"get_visible_entry_by_path",
	"get_path_by_id",
	"list_subtree",
	"search_paths",
	"read_file_content_from_chunks",
	"read_committed_file_chunks_line_range",
	"read_committed_file_chunk_stats",
	"match_text_file_lines",
	"match_plain_text_file_lines",
	"text_search_files",
	"internal_list",
	"internal_get_by_path",
	"internal_get_by_target",
	"internal_get_directory_path",
	"get_file_text_content_db_state_by_path",
	"get_file_last_available_text_content_by_path",
	"read_file_line_range",
	"read_file_tail_lines",
	"read_file_content_stats",
	"metadata_get_by_path",
	"metadata_search",
] as const;

describe("agent file read source", () => {
	test.each(doors)("%s keeps home reads private after team leave and reinvite", async (door) => {
		const f = await fixture();
		const live = read_cases(f, f.agentSource)[door];
		expect(await live.read()).toEqual(live.allowed);
		await leave_and_reinvite(f);
		expect(await live.read()).toEqual(live.refused);
		const ordinary = read_cases(f)[door];
		expect(await ordinary.read()).toEqual(ordinary.allowed);
		expect(
			await f.asUser.query(api.files_visible.get_path, {
				membershipId: f.home.membershipId,
				target: { kind: "saved", id: f.nodeId },
			}),
		).toBe(path);
	});

	test("every door refuses a third workspace even when the user owns it", async () => {
		const f = await fixture();
		const third = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				userId: f.home.userId,
				organizationName: "third-team",
				workspaceName: "home",
			}),
		);
		const destination = {
			...f,
			...(await seed_file(f.t, third.membershipId)),
			scope: { ...f.scope, organizationId: third.organizationId, workspaceId: third.workspaceId },
		};
		for (const door of doors) {
			const ordinary = read_cases(destination)[door];
			expect(await ordinary.read(), door).toEqual(ordinary.allowed);
			const agent = read_cases(destination, f.agentSource)[door];
			expect(await agent.read(), door).toEqual(agent.refused);
		}
	});

	test("a live source does not bypass exact node permissions in the current workspace", async () => {
		const f = await fixture();
		const destination = {
			...f,
			...(await seed_file(f.t, f.owner.membershipId)),
			scope: { ...f.scope, organizationId: f.owner.organizationId, workspaceId: f.owner.workspaceId },
		};
		for (const door of doors) {
			const live = read_cases(destination, f.agentSource)[door];
			expect(await live.read(), door).toEqual(live.allowed);
		}
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: destination.folderId,
			}),
		).toEqual({ _yay: null });
		for (const door of doors) {
			const restricted = read_cases(destination, f.agentSource)[door];
			const result = await restricted.read();
			if (door === "list_subtree") expect(result, door).toMatchObject({ page: [], isDone: true });
			else if (door === "search_paths" || door === "text_search_files" || door === "metadata_search")
				expect(result, door).toMatchObject({ items: [], isDone: true });
			else expect(result, door).toEqual(restricted.refused);
		}
	});

	test("every door binds the read user to the source user", async () => {
		const f = await fixture();
		const destination = {
			...f,
			...(await seed_file(f.t, f.owner.membershipId)),
			scope: {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.owner.userId,
			},
		};
		for (const door of doors) {
			const ordinary = read_cases(destination)[door];
			expect(await ordinary.read(), door).toEqual(ordinary.allowed);
			const agent = read_cases(destination, f.agentSource)[door];
			expect(await agent.read(), door).toEqual(agent.refused);
		}
	});
});

async function force_content_fallback(f: Awaited<ReturnType<typeof fixture>>) {
	// Missing chunks force the existing R2 fallback without replacing the saved file.
	await f.t.run(async (ctx) => {
		for (const chunk of await ctx.db.query("files_text_chunks").collect()) {
			if (chunk.sourceKind === "committed" && chunk.fileNodeId === f.nodeId)
				await ctx.db.delete("files_text_chunks", chunk._id);
		}
		await ctx.db.patch("files_nodes", f.nodeId, { statsId: null });
	});
}

describe("agent content action fallbacks", () => {
	test.each([
		"get_file_last_available_text_content_by_path",
		"read_file_line_range",
		"read_file_tail_lines",
		"read_file_content_stats",
	] as const)("%s rechecks the source after reading R2", async (door) => {
		const f = await fixture();
		await force_content_fallback(f);
		const fetchBody = vi.fn(async () => new Response(text));
		vi.stubGlobal("fetch", fetchBody);
		const agent = read_cases(f, f.agentSource)[door];
		expect(await agent.read()).toEqual(agent.allowed);
		expect(fetchBody).toHaveBeenCalledTimes(1);
		fetchBody.mockImplementationOnce(async () => {
			await leave_and_reinvite(f);
			return new Response(text);
		});
		expect(await agent.read()).toBeNull();
		expect(fetchBody).toHaveBeenCalledTimes(2);
		// A stale source must be refused before another external read starts.
		expect(await agent.read()).toBeNull();
		expect(fetchBody).toHaveBeenCalledTimes(2);
		const ordinary = read_cases(f)[door];
		expect(await ordinary.read()).toEqual(ordinary.allowed);
		expect(fetchBody).toHaveBeenCalledTimes(3);
	});

	test.each([
		"get_file_last_available_text_content_by_path",
		"read_file_line_range",
		"read_file_tail_lines",
		"read_file_content_stats",
	] as const)("%s rechecks exact node permission after reading R2", async (door) => {
		const f = await fixture();
		const destination = {
			...f,
			...(await seed_file(f.t, f.owner.membershipId)),
			scope: { ...f.scope, organizationId: f.owner.organizationId, workspaceId: f.owner.workspaceId },
		};
		await force_content_fallback(destination);
		const fetchBody = vi.fn(async () => new Response(text));
		vi.stubGlobal("fetch", fetchBody);
		const agent = read_cases(destination, f.agentSource)[door];
		expect(await agent.read()).toEqual(agent.allowed);
		fetchBody.mockImplementationOnce(async () => {
			expect(
				await f.asOwner.mutation(api.files_sharing.restrict_node, {
					membershipId: f.owner.membershipId,
					nodeId: destination.folderId,
				}),
			).toEqual({ _yay: null });
			return new Response(text);
		});
		expect(await agent.read()).toBeNull();
		expect(fetchBody).toHaveBeenCalledTimes(2);
		expect(
			await f.t.query(internal.ai_chat_workspaces.resolve, {
				source: f.agentSource,
				workspace: "current",
			}),
		).toMatchObject({ _yay: { workspaceId: f.owner.workspaceId } });
	});
});
