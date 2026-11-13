import { expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with, test_rename_node } from "./setup.test.ts";
import type { Doc, Id } from "./_generated/dataModel";
import { public_api_http_get_file_read_only, public_api_http_set_file_read_only } from "./public_api.ts";

async function setup() {
	const t = test_convex();
	const db = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "clerk-read-only-test" });
		return test_mocks_fill_db_with.membership(ctx, { userId });
	});
	const owner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folder = await owner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "reports",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	const nodeId = folder._yay.nodeId;
	const key = async (scopes: Doc<"api_credentials">["scopes"]) => {
		const result = await owner.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			serviceAccountId: null,
			name: "Read-only test",
			scopes,
		});
		if (result._nay) throw new Error(result._nay.message);
		return result._yay;
	};
	const post = (token: string, path: string, body: unknown) =>
		t.fetch(path, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	return { t, db, owner, nodeId, key, post };
}

test("the flag-only key scope can set and clear a locked item; old scopes cannot", async () => {
	const { t, nodeId, key, post } = await setup();
	const manager = await key(["files:read", "files:read-only"]);
	const oldManager = await key(["files:read", "files:write", "files:permissions"]);
	expect((await post(oldManager.credential, "/api/v1/files/read-only/set", { nodeId, readOnly: true })).status).toBe(
		403,
	);
	expect((await post(manager.credential, "/api/v1/files/read-only/set", { nodeId, readOnly: true })).status).toBe(200);
	const first = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	expect(first?.readOnly).toBe(true);
	expect(first?.readOnlyDecisionId).toEqual(expect.any(String));
	const read = await post(manager.credential, "/api/v1/files/read-only/get", { nodeId });
	expect(await read.json()).toEqual({ nodeId, readOnly: true, canEdit: true });
	expect((await post(manager.credential, "/api/v1/files/read-only/set", { nodeId, readOnly: false })).status).toBe(200);
	expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
		readOnly: false,
		readOnlyDecisionId: null,
	});
});

test("read-only get accepts a path and returns the same item as its ID", async () => {
	const { nodeId, key, post } = await setup();
	const reader = await key(["files:read"]);
	const byPath = await post(reader.credential, "/api/v1/files/read-only/get", { path: "//reports///" });
	expect(byPath.status, "path getter succeeds").toBe(200);
	expect(await byPath.json()).toEqual({ nodeId, readOnly: false, canEdit: true });
	const byId = await post(reader.credential, "/api/v1/files/read-only/get", { nodeId });
	expect(await byId.json()).toEqual({ nodeId, readOnly: false, canEdit: true });
});

test("read-only set changes the named path in its mutation", async () => {
	const { t, nodeId, key, post } = await setup();
	const manager = await key(["files:read-only"]);
	const set = () => post(manager.credential, "/api/v1/files/read-only/set", { path: "/reports", readOnly: true });
	const first = await set();
	expect(first.status, "flag-only path setter succeeds").toBe(200);
	expect(await first.json()).toEqual({ nodeId });
	const saved = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	expect(saved?.readOnly).toBe(true);
	expect(saved?.readOnlyDecisionId).toEqual(expect.any(String));
	expect((await set()).status).toBe(200);
	expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.readOnlyDecisionId).toBe(saved?.readOnlyDecisionId);
	expect(
		(await post(manager.credential, "/api/v1/files/read-only/set", { path: "/reports", readOnly: false })).status,
	).toBe(200);
	expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
		readOnly: false,
		readOnlyDecisionId: null,
	});
});

test("list and stat return each readable item's local readOnly flag", async () => {
	const { db, owner, nodeId, key, post } = await setup();
	const child = await owner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: nodeId,
		path: "child",
	});
	expect(child._nay).toBeUndefined();
	expect(
		await owner.mutation(api.files_nodes.read_only_set, { membershipId: db.membershipId, nodeId, readOnly: true }),
	).toEqual({ _yay: null });
	const reader = await key(["files:list"]);
	const items: Array<{ path: string; readOnly: boolean; readOnlyDecisionId?: unknown }> = [];
	let pages = 0;
	for (let cursor: string | null = null; ;) {
		const response = await post(reader.credential, "/api/v1/files/list", {
			path: "/",
			recursive: true,
			limit: 1,
			cursor,
		});
		expect(response.status).toBe(200);
		const page = await response.json();
		items.push(...page.items);
		pages++;
		if (page.isDone) break;
		cursor = page.cursor;
	}
	expect(pages).toBeGreaterThan(1);
	expect
		.soft(
			items.map(({ path, readOnly }) => ({ path, readOnly })),
			"list returns local flags",
		)
		.toEqual([
			{ path: "/reports", readOnly: true },
			{ path: "/reports/child", readOnly: false },
		]);
	expect(items.every((item) => !("readOnlyDecisionId" in item))).toBe(true);
	const stat = await post(reader.credential, "/api/v1/files/stat", { paths: items.map((item) => item.path) });
	expect(stat.status).toBe(200);
	expect(await stat.json(), "stat returns local flags").toMatchObject({
		items: [
			{ path: "/reports", item: { readOnly: true } },
			{ path: "/reports/child", item: { readOnly: false } },
		],
	});
});

test("invalid read-only targets are refused before mutation", async () => {
	const { t, nodeId, key, post } = await setup();
	const manager = await key(["files:read", "files:read-only"]);
	const invalid: Array<[Record<string, unknown>, string]> = [
		[{}, "Request body validation failed"],
		[{ nodeId, path: "/reports" }, "Request body validation failed"],
		[{ nodeId: null }, "Request body validation failed"],
		[{ path: null }, "Request body validation failed"],
		[{ path: 42 }, "Request body validation failed"],
		[{ nodeId, patth: "/reports" }, 'Unknown request field "patth". Remove it.'],
		[{ path: "reports" }, "Path must be absolute."],
		[{ path: "" }, "Path must be absolute."],
		[{ path: "/" }, "Path must not be the workspace root."],
		[{ path: "///" }, "Path must not be the workspace root."],
	];
	for (const action of ["get", "set"]) {
		for (const [target, message] of invalid) {
			const response = await post(manager.credential, `/api/v1/files/read-only/${action}`, {
				...target,
				...(action === "set" ? { readOnly: true } : {}),
			});
			expect(response.status, JSON.stringify(target)).toBe(400);
			expect(await response.json()).toEqual({ message });
		}
		const rootId = await post(manager.credential, `/api/v1/files/read-only/${action}`, {
			nodeId: "root",
			...(action === "set" ? { readOnly: true } : {}),
		});
		expect(rootId.status).toBe(404);
	}
	expect((await post(manager.credential, "/api/v1/files/read-only/set", { path: "/reports" })).status).toBe(400);
	expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.readOnly).toBe(false);
});

test("overlong read-only paths are refused before policy lookup", async () => {
	const { t, nodeId, key } = await setup();
	const manager = await key(["files:read", "files:read-only"]);
	let policyCalls = 0;
	for (const action of ["get", "set"] as const) {
		const result = await t.action(async (ctx) => {
			const runQuery: typeof ctx.runQuery = async (ref, args) => {
				if (getFunctionName(ref) === "public_api:get_file_read_only") policyCalls++;
				return await ctx.runQuery(ref, args);
			};
			const runMutation: typeof ctx.runMutation = async (ref, args) => {
				if (getFunctionName(ref) === "public_api:set_file_read_only") policyCalls++;
				return await ctx.runMutation(ref, args);
			};
			const request = new Request(`https://app.test/api/v1/files/read-only/${action}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${manager.credential}`, "Content-Type": "application/json" },
				body: JSON.stringify({ path: `/${"a".repeat(4096)}`, ...(action === "set" ? { readOnly: true } : {}) }),
			});
			return action === "get"
				? await public_api_http_get_file_read_only({
						ctx: { ...ctx, runQuery },
						request,
						path: "/api/v1/files/read-only/get",
					})
				: await public_api_http_set_file_read_only({
						ctx: { ...ctx, runMutation },
						request,
						path: "/api/v1/files/read-only/set",
					});
		});
		expect.soft(result.status, `${action}: overlong target is a request error`).toBe(400);
		expect.soft(result.body).toEqual({ message: "Paths can have at most 1,024 characters." });
	}
	expect(policyCalls, "overlong paths make no policy call").toBe(0);
	expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.readOnly).toBe(false);
});

test("path setter changes the current occupant after a move", async () => {
	const { t, db, owner, nodeId, key } = await setup();
	const manager = await key(["files:read-only"]);
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const response = t.action(async (ctx) => {
		const runMutation: typeof ctx.runMutation = async (ref, args) => {
			if (getFunctionName(ref) === "public_api:set_file_read_only") {
				started.resolve();
				await released.promise;
			}
			return await ctx.runMutation(ref, args);
		};
		const request = new Request("https://app.test/api/v1/files/read-only/set", {
			method: "POST",
			headers: { Authorization: `Bearer ${manager.credential}`, "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/reports", readOnly: true }),
		});
		return await public_api_http_set_file_read_only({
			ctx: { ...ctx, runMutation },
			request,
			path: "/api/v1/files/read-only/set",
		});
	});
	await started.promise;
	let replacementId: Id<"files_nodes">;
	try {
		expect(
			(await test_rename_node(t, owner, { membershipId: db.membershipId, nodeId, path: "moved" }))._nay,
		).toBeUndefined();
		const replacement = await owner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: "reports",
		});
		if (replacement._nay) throw new Error(replacement._nay.message);
		replacementId = replacement._yay.nodeId;
	} finally {
		released.resolve();
	}
	const result = await response;
	expect(result.status).toBe(200);
	expect.soft(result.body, "setter names the current occupant").toEqual({ nodeId: replacementId });
	expect
		.soft((await t.run((ctx) => ctx.db.get("files_nodes", replacementId)))?.readOnly, "replacement changes")
		.toBe(true);
	expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.readOnly, "moved original stays unchanged").toBe(
		false,
	);
});

test("path policy uses the service account and refuses foreign IDs", async () => {
	const { t, db, owner, nodeId, key, post } = await setup();
	const account = await owner.mutation(api.access_control.create_service_account, {
		membershipId: db.membershipId,
		name: "Flags",
	});
	if (account._nay) throw new Error(account._nay.message);
	const created = await owner.mutation(api.public_api.api_credential_create, {
		membershipId: db.membershipId,
		serviceAccountId: account._yay.serviceAccountId,
		name: "Account flags",
		scopes: ["files:read", "files:read-only"],
	});
	if (created._nay) throw new Error(created._nay.message);
	for (const action of ["get", "set"]) {
		const flag = action === "set" ? { readOnly: true } : {};
		const denied = await post(created._yay.credential, `/api/v1/files/read-only/${action}`, {
			path: "/reports",
			...flag,
		});
		expect(denied.status, "the sponsor's owner access does not count").toBe(403);
		expect(await denied.json()).toEqual({ message: "Permission denied" });
	}
	expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.readOnly).toBe(false);
	const foreign = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "other" }));
	const otherOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: foreign.userId });
	const otherFolder = await otherOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: foreign.membershipId,
		parentId: "root",
		path: "reports",
	});
	if (otherFolder._nay) throw new Error(otherFolder._nay.message);
	const manager = await key(["files:read", "files:read-only"]);
	for (const action of ["get", "set"]) {
		const response = await post(manager.credential, `/api/v1/files/read-only/${action}`, {
			nodeId: otherFolder._yay.nodeId,
			...(action === "set" ? { readOnly: true } : {}),
		});
		expect(response.status).toBe(404);
	}
	expect((await t.run((ctx) => ctx.db.get("files_nodes", otherFolder._yay.nodeId)))?.readOnly).toBe(false);
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
	const oldScopes = await key(["files:list", "files:write"]);
	for (const action of ["get", "set"]) {
		expect(
			(
				await post(oldScopes.credential, `/api/v1/files/read-only/${action}`, {
					path: "/reports",
					...(action === "set" ? { readOnly: true } : {}),
				})
			).status,
		).toBe(403);
	}
});

test("mkdir force requires its own live grant and never clears the parent flag", async () => {
	const { t, db, owner, nodeId, key, post } = await setup();
	const writer = await key(["files:write"]);
	const forcedWriter = await key(["files:write", "files:read-only"]);
	expect((await post(writer.credential, "/api/v1/files/mkdir", { paths: ["/plain"], force: true })).status).toBe(403);
	expect(
		await owner.mutation(api.files_nodes.read_only_set, { membershipId: db.membershipId, nodeId, readOnly: true }),
	).toEqual({ _yay: null });
	const before = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	expect((await post(forcedWriter.credential, "/api/v1/files/mkdir", { paths: ["/reports/ordinary"] })).status).toBe(
		403,
	);
	expect(
		(await post(forcedWriter.credential, "/api/v1/files/mkdir", { paths: ["/reports/forced"], force: true })).status,
	).toBe(200);
	expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
		readOnly: true,
		readOnlyDecisionId: before?.readOnlyDecisionId,
	});
	await t.run((ctx) => ctx.db.patch("api_credentials", forcedWriter.credentialId, { scopes: ["files:write"] }));
	expect(
		(await post(forcedWriter.credential, "/api/v1/files/mkdir", { paths: ["/reports/revoked"], force: true })).status,
	).toBe(403);
});

test("a prepared forced write rechecks the key grant before publication", async () => {
	const { t, db, owner, nodeId, key } = await setup();
	const writer = await key(["files:write", "files:read-only"]);
	expect(
		await owner.mutation(api.files_nodes.read_only_set, { membershipId: db.membershipId, nodeId, readOnly: true }),
	).toEqual({ _yay: null });
	const prepared = await t.mutation(internal.public_api.prepare_file_write, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
		path: "/reports/staged.md",
		force: true,
		requestReadOnly: true,
		overwrite: "fail",
		contentSize: 4,
		yjsSnapshotSize: 4,
		contentType: "text/markdown",
		yjsRootKind: "rich_text",
	});
	expect(prepared._nay).toBeUndefined();
	if (prepared._nay) throw new Error(prepared._nay.message);
	expect(await t.run((ctx) => ctx.db.get("public_api_file_write_stages", prepared._yay.stageId))).toMatchObject({
		force: true,
		requestReadOnly: true,
	});
	await t.run((ctx) => ctx.db.patch("api_credentials", writer.credentialId, { scopes: ["files:write"] }));
	const published = await t.mutation(internal.public_api.publish_file_write, {
		stageId: prepared._yay.stageId,
		content: "text",
		targetAnchor: prepared._yay.targetAnchor,
		requestReadOnly: true,
	});
	expect(published._nay?.message).toBe("Permission denied");
});
