import { expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

test("Read-only keeps a decision until cleared, then setting it makes a new decision", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "reports",
	});
	if (created._nay) throw new Error(created._nay.message);
	const nodeId = created._yay.nodeId;
	const read = () => t.run((ctx) => ctx.db.get("files_nodes", nodeId));
	const set = (readOnly: boolean) =>
		asOwner.mutation(api.files_nodes.read_only_set, {
			membershipId: db.membershipId,
			nodeId,
			readOnly,
		});

	expect(await read()).toMatchObject({ readOnly: false, readOnlyDecisionId: null });
	expect(await set(true)).toEqual({ _yay: null });
	const first = await read();
	expect(first?.readOnlyDecisionId).toEqual(expect.any(String));
	expect(await set(true)).toEqual({ _yay: null });
	expect((await read())?.readOnlyDecisionId).toBe(first?.readOnlyDecisionId);
	expect(await set(false)).toEqual({ _yay: null });
	expect(await read()).toMatchObject({ readOnly: false, readOnlyDecisionId: null });
	expect(await set(true)).toEqual({ _yay: null });
	expect((await read())?.readOnlyDecisionId).not.toBe(first?.readOnlyDecisionId);
	const visible = await asOwner.query(api.files_nodes.read_only_get, { membershipId: db.membershipId, nodeId });
	expect(visible).toEqual({ nodeId, readOnly: true, canEdit: true });
	const pendingView = await asOwner.query(api.files_pending_target.get_file_pending_target, {
		membershipId: db.membershipId,
		target: { kind: "saved", id: nodeId },
	});
	expect(pendingView?.entry.node).toMatchObject({ readOnly: true });
	expect(pendingView?.entry.node).not.toHaveProperty("readOnlyDecisionId");
});

test("Read-only blocks an owner's direct child create but not a deeper child create", async () => {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folder = await asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "reports",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	const child = await asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: folder._yay.nodeId,
		path: "drafts",
	});
	if (child._nay) throw new Error(child._nay.message);
	expect(
		await asOwner.mutation(api.files_nodes.read_only_set, {
			membershipId: db.membershipId,
			nodeId: folder._yay.nodeId,
			readOnly: true,
		}),
	).toEqual({ _yay: null });
	const refused = await asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: folder._yay.nodeId,
		path: "blocked",
	});
	expect(refused._nay?.name).toBe("read_only");
	const allowed = await asOwner.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: child._yay.nodeId,
		path: "allowed",
	});
	expect(allowed._nay).toBeUndefined();
	if (allowed._nay) throw new Error(allowed._nay.message);
	expect(await t.run((ctx) => ctx.db.get("files_nodes", allowed._yay.nodeId))).toMatchObject({
		readOnly: false,
		readOnlyDecisionId: null,
	});
});
