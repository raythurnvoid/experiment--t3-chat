import { Workpool } from "@convex-dev/workpool";
import { R2 } from "@convex-dev/r2";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import { files_pending_updates_action_stage_private_state_family } from "./files_pending_updates.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	ai_chat_tool_create_edit_file,
	ai_chat_tool_create_set_file_metadata,
	ai_chat_write_file_outputs,
} from "../server/server-ai-tools.ts";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { files_ROOT_ID, files_u8_to_array_buffer, type files_PendingTarget } from "../shared/files.ts";

beforeEach(() => {
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("file-source-test-work" as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key) => ({
		key: key ?? "test",
		url: `https://r2.test/upload?key=${encodeURIComponent(key ?? "test")}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	const objects = new Map<string, BodyInit>();
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		objects.delete(key);
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key") ?? "";
			if (init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return new Response(body ?? null, { status: body === undefined ? 404 : 200 });
		}),
	);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

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
		clientGeneratedId: "file-source-chat",
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
	return { t, owner, home, asOwner, asUser, invite, agentSource, scope };
}

describe("agent file write source", () => {
	test("one output batch creates separate review files in both workspaces", async () => {
		const f = await fixture();
		expect(
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.home.userId,
				role: "member",
			}),
		).toEqual({ _yay: null });
		const result = await f.t.action((ctx) =>
			ai_chat_write_file_outputs(
				ctx,
				f.agentSource,
				(["current", "personal"] as const).map((workspace) => ({
					workspace,
					path: "/output.bin",
					bytes: new Uint8Array([1, 2, 3]),
				})),
				{ title: "Code files", requestId: "two-destinations", modeId: "agent" },
			),
		);
		expect(result.metadata.status).toBe("succeeded");
		expect(result.metadata.files).toHaveLength(2);
		const saved = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(saved.filter((node) => node.name === "output.bin")).toEqual([]);
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(proposals.map((proposal) => proposal.workspaceId).sort()).toEqual(
			[f.owner.workspaceId, f.home.workspaceId].sort(),
		);
		for (const proposal of proposals) expect(proposal.threadIds).toEqual([f.agentSource.threadId]);
		const receipts = await f.t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect());
		expect(new Set(receipts.map((receipt) => receipt.requestId)).size).toBe(2);
		for (const receipt of receipts) expect(receipt.agentSource).toEqual(f.agentSource);
		for (const proposal of proposals) {
			const output = await f.asUser.query(api.ai_chat_files.get_file_output_target, {
				membershipId: f.agentSource.membershipId,
				target: proposal.target,
			});
			expect(output).toMatchObject({
				path: "/output.bin",
				target: proposal.target,
				readiness: "ready",
				organizationName: proposal.workspaceId === f.home.workspaceId ? "personal" : "source-team",
				workspaceName: "home",
			});
			expect(
				await f.asOwner.query(api.ai_chat_files.get_file_output_target, {
					membershipId: f.owner.membershipId,
					target: proposal.target,
				}),
			).toBeNull();
		}
	});

	test("home output uses the user's plan and Save payer, not the team owner", async () => {
		const f = await fixture();
		expect(
			await f.asOwner.mutation(api.organizations.set_organization_billing_mode, {
				organizationId: f.owner.organizationId,
				billingMode: "organization_owner",
			}),
		).toEqual({ _yay: null });
		await f.t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: f.home.userId, plan: "Free" }));
		const write = () =>
			f.t.action((ctx) =>
				ai_chat_write_file_outputs(
					ctx,
					f.agentSource,
					[
						{
							workspace: "personal",
							path: "/paid-output.bin",
							bytes: new Uint8Array([1, 2, 3]),
						},
					],
					{ title: "Home output", requestId: "home-payer", modeId: "agent" },
				),
			);
		expect((await write()).metadata.status).toBe("errored");
		expect(await f.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual([]);
		await f.t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: f.home.userId, plan: "Pro" }));
		const balances = () =>
			f.t.run(async (ctx) => ({
				owner: (await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", f.owner.userId))
					.unique())!.meter!.balance,
				user: (await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", f.home.userId))
					.unique())!.meter!.balance,
			}));
		const before = await balances();
		const written = await write();
		expect(written.metadata.status).toBe("succeeded");
		expect(await balances()).toEqual(before);
		const proposal = (await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect()))[0]!;
		expect(proposal.workspaceId).toBe(f.home.workspaceId);
		const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.home.membershipId,
			target: proposal.target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		expect(saved._nay).toBeUndefined();
		expect(saved._yay?.target.kind).toBe("saved");
		expect(await balances()).toEqual({ owner: before.owner, user: before.user - 1 });
	});

	test("output links keep the destination after Save and refuse a third workspace", async () => {
		const f = await fixture();
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			agentSource: f.agentSource,
			threadId: f.agentSource.threadId,
			path: "/my-output",
			kind: "folder",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a folder proposal");
		const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.home.membershipId,
			target: created._yay.target,
			pendingUpdateId: created._yay.pendingUpdateId,
			reviewedRevision: 1,
		});
		expect(saved._nay).toBeUndefined();
		const output = await f.asUser.query(api.ai_chat_files.get_file_output_target, {
			membershipId: f.agentSource.membershipId,
			target: created._yay.target,
		});
		expect(output).toMatchObject({
			path: "/my-output",
			target: { kind: "saved" },
			organizationName: "personal",
			workspaceName: "home",
		});
		if (output?.target.kind !== "saved") throw new Error("Expected a saved output");
		expect(
			await f.asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: f.home.membershipId,
				nodeIds: [output.target.id],
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.query(api.ai_chat_files.get_file_output_target, {
				membershipId: f.agentSource.membershipId,
				target: created._yay.target,
			}),
		).toBeNull();
		const third = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				userId: f.home.userId,
				organizationName: "third-team",
				workspaceName: "home",
			}),
		);
		const thirdFile = await test_create_saved_text_file(f.t, {
			membershipId: third.membershipId,
			path: "/third.txt",
			textContent: "Third workspace",
		});
		expect(
			await f.asUser.query(api.ai_chat_files.get_file_output_target, {
				membershipId: f.agentSource.membershipId,
				target: { kind: "saved", id: thirdFile },
			}),
		).toBeNull();
	});

	test.each(["text", "stored"] as const)("output finalization keeps the original source (%s)", async (kind) => {
		const f = await fixture();
		let prepared = false;
		const result = await f.t.action((ctx) =>
			ai_chat_write_file_outputs(
				{
					...ctx,
					runMutation: async (ref, ...args) => {
						const reply = await ctx.runMutation(ref, ...args);
						if (!prepared && getFunctionName(ref) === getFunctionName(internal.ai_chat_files.prepare_file_output)) {
							expect(reply).toMatchObject({ _yay: { kind } });
							prepared = true;
							expect(
								await f.asUser.mutation(api.organizations.remove_user_from_organization, {
									organizationId: f.owner.organizationId,
									userIdToRemove: f.home.userId,
								}),
							).toEqual({ _yay: null });
							expect(
								await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, f.invite),
							).toEqual({ _yay: null });
						}
						return reply;
					},
				},
				f.agentSource,
				[
					{
						workspace: "personal",
						path: kind === "text" ? "/output.txt" : "/output.bin",
						bytes: new TextEncoder().encode("private"),
					},
				],
				{ title: "Code files", requestId: "revoked-output", modeId: "agent" },
			),
		);
		expect(prepared).toBe(true);
		expect(result.metadata).toMatchObject({ status: "errored", files: [] });
		const receipts = await f.t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect());
		expect(receipts).toEqual([expect.objectContaining({ state: { kind: "aborted" }, agentSource: f.agentSource })]);
		const nodes = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.filter((node) => node.state === "active")).toEqual([]);
		if (kind === "text") expect(nodes).toEqual([expect.objectContaining({ state: "discarded" })]);
	});

	test.each([false, true])("preparation checks the original source before rebasing (revoked=%s)", async (revoked) => {
		vi.useFakeTimers();
		const f = await fixture();
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.home.membershipId,
			path: "/notes.txt",
			textContent: "first: original\nlast: original\n",
		});
		expect(
			await f.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.home.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
		await f.t.action(async (ctx) => {
			const edit = ai_chat_tool_create_edit_file(ctx, { ...f.agentSource, getThreadId: () => f.agentSource.threadId });
			await edit.execute!(
				{
					workspace: "personal",
					path: "/notes.txt",
					oldString: "first: original",
					newString: "first: proposed",
					replaceAll: false,
				},
				{ toolCallId: "edit", messages: [] },
			);
		});
		expect(
			await f.asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: f.home.membershipId,
				nodeId,
				text: "first: original\nlast: saved\n",
			}),
		).toEqual({ _yay: null });
		const before = await f.t.run(async (ctx) => ({
			proposal: await ctx.db.query("files_pending_updates").first(),
			batches: await ctx.db.query("files_pending_update_operation_batches").collect(),
		}));
		if (!before.proposal) throw new Error("Expected a stale proposal");
		if (revoked) {
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
		const prepared = await f.t.action(internal.files_pending_updates.prepare_file_pending_update_for_agent, {
			...f.scope,
			agentSource: f.agentSource,
			target: { kind: "saved", id: nodeId },
		});
		const after = await f.t.run(async (ctx) => ({
			proposal: await ctx.db.get("files_pending_updates", before.proposal!._id),
			batches: await ctx.db.query("files_pending_update_operation_batches").collect(),
		}));
		const newBatches = after.batches.filter((batch) => !before.batches.some((old) => old._id === batch._id));
		if (revoked) {
			expect(prepared._nay).toBeDefined();
			expect(after.proposal).toEqual(before.proposal);
			expect(newBatches).toEqual([]);
		} else {
			expect(prepared._nay).toBeUndefined();
			expect(after.proposal?.content?.baseStateId).not.toBe(before.proposal.content?.baseStateId);
			// A successful rebase consumes its temporary batch in the commit.
			expect(newBatches).toEqual([]);
		}
		// Review is the user's own home operation, even after the source chat has ended.
		expect(
			(
				await f.asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
					membershipId: f.home.membershipId,
					target: { kind: "saved", id: nodeId },
					pendingUpdateId: before.proposal._id,
				})
			)._nay,
		).toBeUndefined();
	});

	test("a team viewer edits only their selected home file, with review", async () => {
		const f = await fixture();
		for (const membership of [f.owner, f.home])
			await test_create_saved_text_file(f.t, {
				membershipId: membership.membershipId,
				path: "/notes.txt",
				textContent: "original",
			});
		const edit = (workspace: "current" | "personal") =>
			f.t.action(async (ctx) => {
				const tool = ai_chat_tool_create_edit_file(ctx, {
					...f.agentSource,
					getThreadId: () => f.agentSource.threadId,
				});
				return await tool.execute!(
					{ workspace, path: "/notes.txt", oldString: "original", newString: "private", replaceAll: false },
					{ toolCallId: `edit-${workspace}`, messages: [] },
				);
			});
		expect(await edit("personal")).toMatchObject({ metadata: { workspace: "personal", path: "/notes.txt" } });
		await expect(edit("current")).rejects.toThrow("Cannot edit /notes.txt");
		const proposals = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		expect(proposals).toEqual([
			expect.objectContaining({
				workspaceId: f.home.workspaceId,
				userId: f.home.userId,
				threadIds: [f.agentSource.threadId],
			}),
		]);
		for (const overlayUserId of [undefined, f.home.userId]) {
			expect(
				await f.t.query(internal.files_nodes.read_file_content_from_chunks, {
					...f.scope,
					overlayUserId,
					committedOnly: overlayUserId === undefined,
					path: "/notes.txt",
					mode: { kind: "full", maxBytes: 1024 },
				}),
			).toMatchObject({ content: overlayUserId ? "private" : "original" });
		}
	});

	test.each([false, true])(
		"metadata rechecks the source after destination resolution (revoked=%s)",
		async (revoked) => {
			const f = await fixture();
			for (const membership of [f.owner, f.home]) {
				const created = await (membership === f.home ? f.asUser : f.asOwner).mutation(
					api.files_nodes.create_folder_node,
					{
						membershipId: membership.membershipId,
						parentId: files_ROOT_ID,
						path: "/notes",
					},
				);
				if (created._nay) throw new Error(created._nay.message);
			}
			const write = f.t.action(async (ctx) => {
				const tool = ai_chat_tool_create_set_file_metadata(
					{
						...ctx,
						runQuery: async (ref, ...args) => {
							const result = await ctx.runQuery(ref, ...args);
							if (revoked && getFunctionName(ref) === getFunctionName(internal.ai_chat_workspaces.resolve)) {
								expect(result).toMatchObject({ _yay: { workspaceId: f.home.workspaceId } });
								expect(
									await f.asUser.mutation(api.organizations.remove_user_from_organization, {
										organizationId: f.owner.organizationId,
										userIdToRemove: f.home.userId,
									}),
								).toEqual({ _yay: null });
								expect(
									await f.asOwner.mutation(api.organizations.invite_user_to_organization_workspace, f.invite),
								).toEqual({ _yay: null });
							}
							return result;
						},
					},
					{ ...f.agentSource, getThreadId: () => f.agentSource.threadId },
				);
				return await tool.execute!(
					{ workspace: "personal", path: "/notes", set: [{ key: "private-note", value: true }], remove: [] },
					{ toolCallId: "metadata", messages: [] },
				);
			});
			if (revoked) await expect(write).rejects.toThrow("Chat is no longer available");
			else
				expect(await write).toMatchObject({
					metadata: { workspace: "personal", entries: [{ key: "private-note", value: true }] },
				});
			const docs = await f.t.run((ctx) => ctx.db.query("files_metadata_docs").collect());
			const marked = docs.filter((doc) => doc.docKind === "value" && doc.fieldPath === "metadata.private-note");
			expect(marked).toHaveLength(revoked ? 0 : 1);
			if (!revoked) expect(marked[0]).toMatchObject({ workspaceId: f.home.workspaceId });
		},
	);

	test.each([
		{ kind: "saved", revoked: false },
		{ kind: "saved", revoked: true },
		{ kind: "private", revoked: false },
		{ kind: "private", revoked: true },
	] as const)("home removal checks the source chat ($kind, revoked=$revoked)", async ({ kind, revoked }) => {
		const f = await fixture();
		let target: files_PendingTarget;
		if (kind === "saved") {
			const created = await f.asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: f.home.membershipId,
				parentId: files_ROOT_ID,
				path: "/notes",
			});
			if (created._nay) throw new Error(created._nay.message);
			target = { kind: "saved", id: created._yay.nodeId };
		} else {
			const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				...f.scope,
				agentSource: f.agentSource,
				threadId: f.agentSource.threadId,
				path: "/notes",
				kind: "folder",
			});
			if (created._nay) throw new Error(created._nay.message);
			target = created._yay.target;
		}
		const before = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		if (revoked) {
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
		const removed = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
			...f.scope,
			target,
			threadId: f.agentSource.threadId,
			agentSource: f.agentSource,
		});
		const after = await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect());
		if (revoked) {
			expect(removed._nay).toEqual({ message: "Chat is no longer available" });
			expect(after).toEqual(before);
			expect(
				await f.t.query(internal.files_nodes.get_visible_entry_by_path, {
					organizationId: f.home.organizationId,
					workspaceId: f.home.workspaceId,
					visibilityUserId: f.home.userId,
					overlayUserId: f.home.userId,
					path: "/notes",
				}),
			).not.toBeNull();
		} else {
			expect(removed._nay).toBeUndefined();
			if (kind === "saved")
				expect(after).toEqual([expect.objectContaining({ target, pendingArchive: { fromPath: "/notes" } })]);
			else
				expect(
					await f.t.query(internal.files_nodes.get_visible_entry_by_path, {
						organizationId: f.home.organizationId,
						workspaceId: f.home.workspaceId,
						visibilityUserId: f.home.userId,
						overlayUserId: f.home.userId,
						path: "/notes",
					}),
				).toBeNull();
		}
	});

	test("the user can still save a finished home proposal after leaving its source team", async () => {
		const f = await fixture();
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			agentSource: f.agentSource,
			threadId: f.agentSource.threadId,
			path: "/kept-notes",
			kind: "folder",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a folder proposal");
		expect(
			await f.asUser.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.owner.organizationId,
				userIdToRemove: f.home.userId,
			}),
		).toEqual({ _yay: null });
		const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: f.home.membershipId,
			target: created._yay.target,
			pendingUpdateId: created._yay.pendingUpdateId,
			reviewedRevision: 1,
		});
		expect(saved._nay).toBeUndefined();
		expect(
			await f.t.query(internal.files_nodes.get_visible_entry_by_path, {
				organizationId: f.home.organizationId,
				workspaceId: f.home.workspaceId,
				visibilityUserId: f.home.userId,
				path: "/kept-notes",
			}),
		).toMatchObject({ kind: "saved", node: { kind: "folder", createdBy: f.home.userId } });
	});

	test.each([false, true])(
		"private text commit checks the captured source after staging (revoked=%s)",
		async (revoked) => {
			const f = await fixture();
			const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				...f.scope,
				agentSource: f.agentSource,
				threadId: f.agentSource.threadId,
				path: "/private-note.txt",
				kind: "file",
			});
			if (
				created._nay ||
				created._yay.target.kind !== "private" ||
				!created._yay.operationBatchId ||
				!created._yay.pendingUpdateId
			)
				throw new Error("Expected a private text batch");
			const { target, operationBatchId, pendingUpdateId } = created._yay;
			const text = "My private working note\n";
			const doc = files_yjs_doc_create_from_text({ text, rootKind: "plain_text" });
			if ("_nay" in doc) throw new Error(doc._nay.message);
			const bytes = files_u8_to_array_buffer(encodeStateAsUpdate(doc));
			doc.destroy();
			const staged = await f.t.action((ctx) =>
				files_pending_updates_action_stage_private_state_family(ctx, {
					...f.scope,
					operationBatchId,
					base: bytes,
					staged: bytes,
					unstaged: bytes,
				}),
			);
			if (staged._nay) throw new Error(staged._nay.message);
			const before = await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
			expect(
				(await f.t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", operationBatchId)))?.agentSource,
			).toEqual(f.agentSource);
			if (revoked) {
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
			const committed = await f.t.mutation(internal.files_pending_updates.commit_private_file_pending_update_in_db, {
				membershipId: f.home.membershipId,
				privateNodeId: target.id,
				pendingUpdateId,
				expectedRevision: before!.revision,
				family: staged._yay,
				unstagedText: text,
				threadId: f.agentSource.threadId,
			});
			const after = await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
			if (revoked) {
				expect(committed._nay).toEqual({ message: "Not found" });
				expect(after).toEqual(before);
			} else {
				expect(committed._nay).toBeUndefined();
				expect(after?.content?.base.kind).toBe("new");
				expect(after?.revision).toBe(before!.revision + 1);
				expect(
					await f.t.query(internal.files_nodes.read_file_content_from_chunks, {
						...f.scope,
						path: "/private-note.txt",
						overlayUserId: f.home.userId,
						mode: { kind: "full", maxBytes: 1024 },
					}),
				).toMatchObject({ content: text });
			}
		},
	);

	test("a team viewer can create home drafts, not team drafts or files in a third workspace", async () => {
		const f = await fixture();
		const third = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				userId: f.home.userId,
				organizationName: "third-team",
				workspaceName: "home",
			}),
		);
		for (const scope of [
			f.scope,
			{ ...f.scope, organizationId: f.owner.organizationId, workspaceId: f.owner.workspaceId },
			{ ...f.scope, organizationId: third.organizationId, workspaceId: third.workspaceId },
		]) {
			const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
				...scope,
				agentSource: f.agentSource,
				threadId: f.agentSource.threadId,
				path: "/notes",
				kind: "folder",
			});
			if (scope.workspaceId === f.home.workspaceId) expect(created._yay).toMatchObject({ created: true });
			else expect(created._nay).toBeDefined();
		}
		const drafts = await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(drafts).toHaveLength(1);
		expect(drafts[0]).toMatchObject({ workspaceId: f.home.workspaceId, userId: f.home.userId, name: "notes" });
	});
});
