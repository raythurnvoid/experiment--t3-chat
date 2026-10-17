import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_create_saved_text_file } from "./setup.test.ts";
import type { access_control_Subject } from "./access_control.ts";
import { files_nodes_db_get_path_access } from "./files_nodes.ts";
import { fixture, mock_share_storage, reset_rate_limits, type Fixture } from "./files_share_links.setup.test.ts";

beforeEach(mock_share_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/** What the member (or `subject`) gets for `path`: the status, and the name of the node when one is sent. */
function member_access(f: Fixture, path: string, subject?: access_control_Subject) {
	return f.t.run(async (ctx) => {
		const access = await files_nodes_db_get_path_access(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			subject: subject ?? { kind: "user", userId: f.memberId, plugin: null },
			path,
		});
		return { status: access.status, name: access.status === "missing" ? null : (access.node?.name ?? null) };
	});
}

async function node_at(f: Fixture, path: string) {
	return await f.t.run(
		async (ctx) =>
			(await ctx.db
				.query("files_nodes")
				.filter((q) => q.eq(q.field("path"), path))
				.first())!._id,
	);
}

async function restrict(f: Fixture, nodeId: Id<"files_nodes">) {
	await reset_rate_limits(f.t, [f.db.userId]);
	const result = await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId });
	expect(result._nay).toBeUndefined();
}

/** `/r` restricted by the owner, with the file `/r/d/x.md`, and the open file `/open/a.md`. */
async function seed(f: Fixture) {
	await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/r/d/x.md" });
	await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path: "/open/a.md" });
	await restrict(f, await node_at(f, "/r"));
}

test("a locked file answers locked, not missing", async () => {
	const f = await fixture();
	await seed(f);
	await restrict(f, await node_at(f, "/open/a.md"));

	expect(await member_access(f, "/open/a.md")).toEqual({ status: "locked", name: "a.md" });
});

test("every path under a locked folder answers locked, whether it exists or not", async () => {
	const f = await fixture();
	await seed(f);

	expect((await member_access(f, "/r/d/x.md")).status).toBe("locked");
	expect((await member_access(f, "/r/d")).status).toBe("locked");
	expect((await member_access(f, "/r/nope.md")).status).toBe("locked");
	expect((await member_access(f, "/r/d/nope/deeper.md")).status).toBe("locked");
});

test("a locked node's entry is shown only when its parent is readable", async () => {
	const f = await fixture();
	await seed(f);

	expect(await member_access(f, "/r")).toEqual({ status: "locked", name: "r" });
	expect(await member_access(f, "/r/d")).toEqual({ status: "locked", name: null });
	expect(await member_access(f, "/r/d/x.md")).toEqual({ status: "locked", name: null });
});

test("a deep share under a locked folder is found", async () => {
	const f = await fixture();
	await seed(f);
	await reset_rate_limits(f.t, [f.db.userId]);
	const shared = await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
		membershipId: f.db.membershipId,
		nodeId: await node_at(f, "/r/d"),
		principal: { kind: "user", userId: f.memberId },
		level: "read",
	});
	expect(shared._nay).toBeUndefined();

	expect(await member_access(f, "/r/d/x.md")).toEqual({ status: "found", name: "x.md" });
	// Below a readable folder, a missing name is missing, even inside a folder the member cannot open.
	expect((await member_access(f, "/r/d/nope.md")).status).toBe("missing");
});

test("a missing path under a readable folder is missing", async () => {
	const f = await fixture();
	await seed(f);

	expect(await member_access(f, "/open/nope.md")).toEqual({ status: "missing", name: null });
	expect((await member_access(f, "/nope/deeper.md")).status).toBe("missing");
	expect((await member_access(f, "/open/a.md")).status).toBe("found");
});

test("a file in the middle of a path answers missing", async () => {
	const f = await fixture();
	await seed(f);

	expect((await member_access(f, "/open/a.md/x.md")).status).toBe("missing");
});

test("a file in the middle of a path under a locked folder answers locked", async () => {
	const f = await fixture();
	await seed(f);

	// Same answer whether `x.md` exists or not, so the path does not tell which files are inside.
	expect((await member_access(f, "/r/d/x.md/y")).status).toBe("locked");
	expect((await member_access(f, "/r/d/nope.md/y")).status).toBe("locked");
});

test("a caller who cannot read the workspace root gets locked for every top-level name", async () => {
	const f = await fixture();
	await seed(f);
	const serviceAccountId = await f.t.run(async (ctx) => {
		const now = Date.now();
		return await ctx.db.insert("access_control_service_accounts", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			name: "No role",
			createdBy: f.db.userId,
			createdAt: now,
			updatedAt: now,
			revokedAt: null,
		});
	});
	const account = { kind: "service_account", serviceAccountId } as const;

	expect(await member_access(f, "/open/a.md", account)).toEqual({ status: "locked", name: null });
	expect(await member_access(f, "/nope.md", account)).toEqual({ status: "locked", name: null });
	expect(await member_access(f, "/open/a.md/y", account)).toEqual({ status: "locked", name: null });
});

test("a chat that cannot use the workspace gets missing, not locked", async () => {
	const f = await fixture();
	await seed(f);
	const threadId = await f.t.run((ctx) =>
		ctx.db.insert("ai_chat_threads", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			clientGeneratedId: "client_path_access",
			title: "Chat",
			archived: true,
			runtime: "aisdk_5",
			createdBy: f.memberId,
			updatedBy: f.memberId,
			updatedAt: Date.now(),
			newestNodeId: null,
			starred: false,
		}),
	);
	const ask = (agentSource?: { threadId: Id<"ai_chat_threads"> }) =>
		f.t.query(internal.files_nodes.get_path_access, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			subject: { kind: "user", userId: f.memberId, plugin: null },
			path: "/r/d/x.md",
			...(agentSource && {
				agentSource: {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userId: f.memberId,
					membershipId: f.memberMembershipId,
					membershipLifetime: 0,
					threadId: agentSource.threadId,
				},
			}),
		});

	expect((await ask()).status).toBe("locked");
	// The chat is archived, so it reaches no file of this workspace.
	expect((await ask({ threadId })).status).toBe("missing");
});

test("the id door says locked for a node under a locked folder, and gives no name", async () => {
	const f = await fixture();
	await seed(f);
	const ask = async (fileNodeId: string) =>
		await f.asMember.query(api.files_tree.get_file_node_access_for_membership, {
			membershipId: f.memberMembershipId,
			fileNodeId,
		});

	expect(await ask(await node_at(f, "/r/d/x.md"))).toBe("locked");
	expect(await ask(await node_at(f, "/open/a.md"))).toBe("found");
	expect(await ask("not-an-id")).toBe("missing");
	// The normal id door still answers null, so it sends no name.
	expect(
		await f.asMember.query(api.files_tree.get_file_node_for_membership, {
			membershipId: f.memberMembershipId,
			fileNodeId: await node_at(f, "/r/d/x.md"),
		}),
	).toBeNull();
});

test("the path page query says locked or missing", async () => {
	const f = await fixture();
	await seed(f);
	const ask = async (path: string) =>
		await f.asMember.query(api.files_nodes.get_path_access_for_membership, {
			membershipId: f.memberMembershipId,
			path,
		});

	expect(await ask("/r/nope.md")).toBe("locked");
	expect(await ask("/open/nope.md")).toBe("missing");
});
