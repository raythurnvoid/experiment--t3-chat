import { expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Doc } from "./_generated/dataModel";

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
		writeFormat: "read_only",
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
		writeFormat: "read_only",
		stageId: prepared._yay.stageId,
		content: "text",
		targetAnchor: prepared._yay.targetAnchor,
		requestReadOnly: true,
	});
	expect(published._nay?.message).toBe("Permission denied");
});
