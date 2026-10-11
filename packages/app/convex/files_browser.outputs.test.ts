/// <reference types="vite/client" />
// Browser file output, file read, draft capture and file chooser tests. Session tests are in
// files_browser.sessions.test.ts, and the rest in files_browser.test.ts.
import { R2 } from "@convex-dev/r2";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_convex,
	test_create_saved_text_file,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { quotas_db_ensure } from "./quotas.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_create_private_node_by_path } from "./files_nodes.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import {
	runnerQueue,
	runnerCalls,
	HTML_TEXT,
	seed_html_file,
	authed,
	runner_open_session,
	sha256_hex,
	seed_browser_file_scope,
	browserFile,
	prepare_browser_file,
	type WebFixture,
	seed_web_member,
	add_workspace_member,
	start_web_session,
	saved_node_id_by_path,
} from "./files_browser.setup.test.ts";

const model = vi.hoisted(() => ({ streamText: vi.fn() }));
// Pause real action calls so the race tests can use public human controls.
const browserActionGate = vi.hoisted(() => ({
	call: null as
		| null
		| ((
				args: {
					operation: "query" | "mutation";
					name: string;
					phase: "before" | "after";
				} & Record<string, unknown>,
		  ) => Promise<void>),
}));
vi.mock("./_generated/server.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./_generated/server.js")>();
	return {
		...original,
		internalAction: ((definition: Parameters<typeof original.internalAction>[0]) => {
			if (typeof definition === "function") return original.internalAction(definition);
			return original.internalAction({
				...definition,
				handler: async (ctx, ...args) => {
					const runQuery = ctx.runQuery.bind(ctx);
					const runMutation = ctx.runMutation.bind(ctx);
					ctx.runQuery = async (ref, callArgs) => {
						await browserActionGate.call?.({
							operation: "query",
							name: getFunctionName(ref),
							phase: "before",
							...(callArgs as Record<string, unknown>),
						});
						const result = await runQuery(ref, callArgs);
						await browserActionGate.call?.({
							operation: "query",
							name: getFunctionName(ref),
							phase: "after",
							...(callArgs as Record<string, unknown>),
						});
						return result;
					};
					ctx.runMutation = async (ref, callArgs) => {
						const result = await runMutation(ref, callArgs);
						await browserActionGate.call?.({
							operation: "mutation",
							name: getFunctionName(ref),
							phase: "after",
							...(callArgs as Record<string, unknown>),
						});
						return result;
					};
					return definition.handler(ctx, ...args);
				},
			});
		}) as typeof original.internalAction,
	};
});
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: model.streamText,
}));

beforeEach(() => {
	model.streamText.mockReset();
	model.streamText.mockImplementation(() => ({
		toUIMessageStream: () =>
			new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "start", messageId: "answer" });
					controller.enqueue({ type: "finish" });
					controller.close();
				},
			}),
		response: Promise.resolve({ messages: [] }),
		consumeStream: async () => {},
	}));
});

afterEach(() => {
	browserActionGate.call = null;
});

describe("browser file outputs", () => {
	test("creates generic files with exact parent review and replays after Save", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const first = await prepare_browser_file({ t, scope });
		expect(
			(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).filter((node) => node.state === "active"),
		).toEqual([]);
		const finalArgs = { ...scope, receiptId: first.receiptId, attemptId: browserFile.attemptId };
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, finalArgs);
		if (finalized._nay) throw new Error(finalized._nay.message);
		const second = await prepare_browser_file({
			t,
			scope,
			changes: {
				requestId: "file-output-2",
				size: 0,
				contentType: "application/x-custom",
			},
		});
		const secondResult = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: second.receiptId,
			attemptId: browserFile.attemptId,
		});
		expect([finalized._yay.path, secondResult._yay?.path]).toEqual(["/reports/capture.bin", "/reports/capture-2.bin"]);
		expect(secondResult._yay).toMatchObject({ size: 0, contentType: "application/x-custom" });

		const asUser = authed(t, scope.userId);
		const target = finalized._yay.target;
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target,
		});
		expect(view).toMatchObject({ readiness: "ready", canAccept: false, canAcceptWithParents: true });
		expect(view!.requiredParents.map((parent) => parent.path)).toEqual(["/reports"]);
		// The pending `reports` folder sits at the root, so no saved folder is above the chain.
		expect(view!.savedParentId).toBeNull();
		expect(view!.entry.pendingUpdate?.createIntent).toMatchObject({ kind: "stored", size: 8 });
		expect(view!.entry.pendingUpdate?.threadIds).toEqual([scope.threadId]);
		const readArgs = {
			userId: scope.userId,
			membershipId: scope.membershipId,
			agentSource: scope.agentSource,
			path: finalized._yay.path,
			target,
		};
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._yay?.assetId).toBe(
			first.assetId,
		);
		for (const parent of view!.requiredParents) {
			expect(
				(
					await test_save_file_pending_update(asUser, {
						membershipId: scope.membershipId,
						target: parent.target,
						pendingUpdateId: parent.pendingUpdateId,
						reviewedRevision: parent.reviewedRevision,
					})
				)._nay,
			).toBeUndefined();
		}
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: scope.membershipId,
			target,
			pendingUpdateId: view!.entry.pendingUpdate!._id,
			reviewedRevision: view!.entry.pendingUpdate!.revision,
		});
		if (saved._nay) throw new Error(saved._nay.message);
		if (target.kind !== "private") throw new Error("Expected private target");
		await t.run(async (ctx) => {
			const receipt = await ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_privateNode", (q) => q.eq("privateNodeId", target.id))
				.first();
			if (receipt) await ctx.db.delete("files_pending_node_publish_receipts", receipt._id);
			await ctx.db.delete("files_pending_nodes", target.id);
			await ctx.db.patch("files_browser_sessions", scope.sessionId, { control: "closed" });
		});
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._yay?.target).toEqual(
			saved._yay.target,
		);
		// Completed retries resolve the same file. They cannot create again after the browser closes.
		expect((await t.mutation(internal.files_browser.finalize_file_output, finalArgs))._yay?.target).toEqual(
			saved._yay.target,
		);
		await t.mutation(internal.files_ingestion.abort_file, {
			userId: scope.userId,
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			receiptId: first.receiptId,
			attemptId: browserFile.attemptId,
		});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", first.assetId))).not.toBeNull();
	});

	test("keeps completed files when a later item exceeds the node quota", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		await t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...scope, quotaName: "files_private_nodes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 2 });
		});
		const first = await prepare_browser_file({ t, scope });
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: first.receiptId,
			attemptId: browserFile.attemptId,
		});
		expect(finalized._yay).toBeDefined();
		expect(
			(
				await t.mutation(internal.files_browser.prepare_file_output, {
					...scope,
					...browserFile,
					requestId: "file-output-2",
					path: "/reports/second.bin",
				})
			)._nay,
		).toBeDefined();
		const nodes = await t.run((ctx) => ctx.db.query("files_pending_nodes").collect());
		expect(nodes.filter((node) => node.state === "active")).toHaveLength(2);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", first.assetId))).not.toBeNull();
	});

	test.each(["control", "load", "navigation", "source", "thread", "ask"] as const)(
		"rechecks %s before finalizing bytes",
		async (change) => {
			const t = test_convex();
			const scope = await seed_browser_file_scope(t);
			const prepared = await prepare_browser_file({ t, scope });
			if (change === "control")
				await t.run((ctx) =>
					ctx.db.patch("files_browser_sessions", scope.sessionId, {
						controlGen: scope.expectedAgentLease.controlGen + 1,
					}),
				);
			if (change === "load")
				await t.run((ctx) =>
					ctx.db.patch("files_browser_sessions", scope.sessionId, { loadGen: scope.expectedAgentLease.loadGen + 1 }),
				);
			if (change === "navigation")
				await t.run((ctx) =>
					ctx.db.patch("files_browser_sessions", scope.sessionId, {
						navigationGeneration: scope.expectedAgentLease.navGen + 1,
					}),
				);
			if (change === "source")
				await t.run((ctx) => ctx.db.patch("files_browser_sessions", scope.sessionId, { sourceHash: "changed" }));
			if (change === "thread")
				await t.run((ctx) => ctx.db.patch("ai_chat_threads", scope.threadId, { archived: true }));
			expect(
				(
					await t.mutation(internal.files_browser.finalize_file_output, {
						...scope,
						...(change === "ask" ? { modeId: "ask" as const } : {}),
						receiptId: prepared.receiptId,
						attemptId: browserFile.attemptId,
					})
				)._nay,
			).toBeDefined();
			expect(
				(await t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).filter((node) => node.state === "active"),
			).toEqual([]);
			await t.mutation(internal.files_ingestion.abort_file, {
				userId: scope.userId,
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				receiptId: prepared.receiptId,
				attemptId: browserFile.attemptId,
			});
			const job = await t.run((ctx) =>
				ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", prepared.r2Key))
					.first(),
			);
			expect(job?.putMayArriveUntil).toBeGreaterThan(Date.now());
			expect(job?.privateStorageReservationId).toBeDefined();
			expect(
				(await t.run((ctx) => ctx.db.get("files_private_storage_reservations", job!.privateStorageReservationId!)))
					?.settlement.kind,
			).toBe("held");
		},
	);

	test("Ask and a foreign thread fail before allocating bytes", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		expect(
			(await t.mutation(internal.files_browser.prepare_file_output, { ...scope, ...browserFile, modeId: "ask" }))._nay,
		).toBeDefined();
		await t.run((ctx) => ctx.db.patch("ai_chat_threads", scope.threadId, { workspaceId: "other-workspace" }));
		expect(
			(await t.mutation(internal.files_browser.prepare_file_output, { ...scope, ...browserFile }))._nay,
		).toBeDefined();
		expect(await t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toEqual([]);
	});

	test("never overwrites a saved name hidden by a proposed delete", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: scope.membershipId,
			path: browserFile.path,
			textContent: "existing file",
		});
		await t.run((ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: scope.userId,
				target: { kind: "saved", id: nodeId },
				revision: 1,
				pendingArchive: { fromPath: browserFile.path },
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + 4 * 60 * 60 * 1000,
			}),
		);
		const prepared = await prepare_browser_file({ t, scope });
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: prepared.receiptId,
			attemptId: browserFile.attemptId,
		});
		expect(finalized._yay?.path).toBe("/reports/capture-2.bin");
		expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.archiveOperationId).toBeNull();
	});

	test("reads across same-tenant threads and refuses cross-tenant reads and discarded replay", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const prepared = await prepare_browser_file({ t, scope });
		const finalArgs = { ...scope, receiptId: prepared.receiptId, attemptId: browserFile.attemptId };
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, finalArgs);
		if (finalized._nay) throw new Error(finalized._nay.message);
		const target = finalized._yay.target;
		const threadId = await t.run(async (ctx) => {
			const thread = await ctx.db.get("ai_chat_threads", scope.threadId);
			const { _id: _id, _creationTime: _time, ...fields } = thread!;
			return await ctx.db.insert("ai_chat_threads", { ...fields, clientGeneratedId: "branch-files" });
		});
		const readArgs = {
			userId: scope.userId,
			membershipId: scope.membershipId,
			agentSource: { ...scope.agentSource, threadId },
			path: finalized._yay.path,
			target,
		};
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._yay).toBeDefined();
		await t.run((ctx) => ctx.db.patch("ai_chat_threads", threadId, { organizationId: "other-tenant" }));
		expect((await t.query(internal.files_nodes_content.get_file_read_source, readArgs))._nay).toBeDefined();
		const asUser = authed(t, scope.userId);
		const view = await asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target,
		});
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: scope.membershipId,
					target,
					pendingUpdateId: view!.entry.pendingUpdate!._id,
					reviewedRevision: view!.entry.pendingUpdate!.revision,
				})
			)._nay,
		).toBeUndefined();
		expect((await t.mutation(internal.files_browser.finalize_file_output, finalArgs))._nay).toBeDefined();
	});

	test("keeps the first hold when a later item exceeds private byte quota", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		await t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...scope, quotaName: "files_private_user_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 8 });
		});
		const first = await prepare_browser_file({ t, scope });
		await expect(
			t.mutation(internal.files_browser.prepare_file_output, {
				...scope,
				...browserFile,
				requestId: "file-output-2",
			}),
		).rejects.toThrow("pending files");
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", first.assetId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_ingestion_receipts").collect())).toHaveLength(1);
	});
});

describe("get_file_read_source", () => {
	test.each(["team leave and reinvite", "another user's chat", "archived chat", "third workspace"] as const)(
		"reads both roots but refuses %s without hiding home files from their owner",
		async (change) => {
			const t = test_convex();
			const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const home = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			const third = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { userId: home.userId, organizationName: "third-image-root" }),
			);
			const asOwner = authed(t, owner.userId);
			const asUser = authed(t, home.userId);
			const invite = { organizationId: owner.organizationId, workspaceId: owner.workspaceId, userIdToAdd: home.userId };
			expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invite)).toEqual({
				_yay: null,
			});
			const membership = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
					)
					.first(),
			);
			if (!membership) throw new Error("Expected team membership");
			const thread = await asUser.mutation(api.ai_chat.thread_create, {
				membershipId: membership._id,
				clientGeneratedId: "two-root-image-read",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
				userId: home.userId,
				membershipId: membership._id,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			const agentSource = {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId: home.userId,
				membershipId: membership._id,
				membershipLifetime: captured._yay.membershipLifetime,
				threadId: thread._yay.threadId,
			};
			const path = "/image.png";
			const files = await t.run(async (ctx) => {
				const files = [];
				for (const destination of [captured._yay.current, home, third]) {
					const scope = {
						organizationId: destination.organizationId,
						workspaceId: destination.workspaceId,
						userId: home.userId,
					};
					const assetId = await ctx.db.insert("files_r2_assets", {
						organizationId: scope.organizationId,
						workspaceId: scope.workspaceId,
						createdBy: home.userId,
						kind: "content",
						r2Bucket: "test",
						size: 8,
						updatedAt: Date.now(),
					});
					const r2Key = r2_create_asset_key({ ...scope, assetId });
					await ctx.db.patch("files_r2_assets", assetId, { r2Key });
					const reserved = await files_private_storage_db_reserve(ctx, {
						...scope,
						resource: { kind: "asset", id: assetId, r2Key },
						byteCount: 8,
					});
					if (reserved._nay) throw new Error(reserved._nay.message);
					const created = await files_nodes_db_create_private_node_by_path(ctx, {
						...scope,
						path,
						kind: "file",
						content: { kind: "stored", assetId, size: 8, contentType: "image/png" },
					});
					if (created._nay) throw new Error(created._nay.message);
					files.push({ membershipId: destination.membershipId, target: created._yay.target, assetId });
				}
				return files;
			});
			for (const file of files.slice(0, 2)) {
				const read = await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: home.userId,
					membershipId: file.membershipId,
					agentSource,
					path,
				});
				expect(read._yay).toMatchObject({ target: file.target, assetId: file.assetId });
			}
			if (change === "team leave and reinvite") {
				expect(
					await asUser.mutation(api.organizations.remove_user_from_organization, {
						organizationId: owner.organizationId,
						userIdToRemove: home.userId,
					}),
				).toEqual({ _yay: null });
				expect(await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, invite)).toEqual({
					_yay: null,
				});
				const renewedMembership = await t.run((ctx) =>
					ctx.db
						.query("organizations_workspaces_users")
						.withIndex("by_workspace_user_active", (q) =>
							q.eq("workspaceId", owner.workspaceId).eq("userId", home.userId).eq("active", true),
						)
						.first(),
				);
				if (!renewedMembership) throw new Error("Expected renewed team membership");
				const renewed = await t.mutation(internal.ai_chat_workspaces.capture, {
					userId: home.userId,
					membershipId: renewedMembership._id,
				});
				if (renewed._nay) throw new Error(renewed._nay.message);
				expect(renewed._yay.membershipLifetime).not.toBe(agentSource.membershipLifetime);
				expect(
					(
						await t.query(internal.files_nodes_content.get_file_read_source, {
							userId: home.userId,
							membershipId: home.membershipId,
							agentSource: {
								...agentSource,
								membershipId: renewedMembership._id,
								membershipLifetime: renewed._yay.membershipLifetime,
							},
							path,
						})
					)._yay?.target,
				).toEqual(files[1]!.target);
			}
			if (change === "another user's chat")
				await t.run((ctx) => ctx.db.patch("ai_chat_threads", agentSource.threadId, { createdBy: owner.userId }));
			if (change === "archived chat")
				await t.run((ctx) => ctx.db.patch("ai_chat_threads", agentSource.threadId, { archived: true }));
			const selected = files[change === "third workspace" ? 2 : 1]!;
			for (const target of [undefined, selected.target])
				expect(
					await t.query(internal.files_nodes_content.get_file_read_source, {
						userId: home.userId,
						membershipId: selected.membershipId,
						agentSource,
						path,
						target,
					}),
				).toEqual({ _nay: { message: "File unavailable" } });
			// The source chat limits the agent, not the owner's regular Files view.
			const visible = await asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: selected.membershipId,
				target: selected.target,
			});
			expect(visible?.entry.node._id).toBe(selected.target.id);
		},
	);

	test("keeps pending files owner-only and uses current saved grants through the old private ID", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const path = "/reports/shared.bin";
		const prepared = await prepare_browser_file({ t, scope, changes: { path } });
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: prepared.receiptId,
			attemptId: browserFile.attemptId,
		});
		if (finalized._nay) throw new Error(finalized._nay.message);

		const target = finalized._yay.target;

		// A second member of the same workspace. A capture is still a private draft, so this member
		// cannot read it, whatever their workspace role says.
		const member = await t.run(async (ctx) => {
			const { userId } = await test_mocks_fill_db_with.membership(ctx, {
				organizationName: "personal",
				workspaceName: "home",
			});
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, { ...scope, userId, role: "member", now: Date.now() });
			return { userId, membershipId };
		});
		const memberThread = await authed(t, member.userId).mutation(api.ai_chat.thread_create, {
			membershipId: member.membershipId,
			clientGeneratedId: "member-image-reader",
			lastMessageAt: Date.now(),
		});
		if (memberThread._nay) throw new Error(memberThread._nay.message);
		const captured = await t.mutation(internal.ai_chat_workspaces.capture, member);
		if (captured._nay) throw new Error(captured._nay.message);
		const memberRead = {
			...member,
			agentSource: {
				...scope.agentSource,
				...member,
				threadId: memberThread._yay.threadId,
				membershipLifetime: captured._yay.membershipLifetime,
			},
			path,
			target,
		};
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._nay).toBeDefined();

		const asOwner = authed(t, scope.userId);
		const view = await asOwner.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target,
		});
		for (const parent of view!.requiredParents) {
			expect(
				(
					await test_save_file_pending_update(asOwner, {
						membershipId: scope.membershipId,
						target: parent.target,
						pendingUpdateId: parent.pendingUpdateId,
						reviewedRevision: parent.reviewedRevision,
					})
				)._nay,
			).toBeUndefined();
		}
		const saved = await test_save_file_pending_update(asOwner, {
			membershipId: scope.membershipId,
			target,
			pendingUpdateId: view!.entry.pendingUpdate!._id,
			reviewedRevision: view!.entry.pendingUpdate!.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved file");
		const nodeId = saved._yay.target.id;

		// After Save the member reads the file through the same old private target, and their access
		// follows the saved file's current sharing from here on.
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._yay?.target).toEqual(
			saved._yay.target,
		);

		expect(
			(await asOwner.mutation(api.files_sharing.restrict_node, { membershipId: scope.membershipId, nodeId }))._nay,
		).toBeUndefined();
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._nay).toBeDefined();
		expect(
			(
				await asOwner.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: scope.membershipId,
					nodeId,
					principal: { kind: "user", userId: member.userId },
					level: "read",
				})
			)._nay,
		).toBeUndefined();
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._yay).toBeDefined();
		expect(
			(
				await asOwner.mutation(api.files_sharing.remove_node_share_grant, {
					membershipId: scope.membershipId,
					nodeId,
					principal: { kind: "user", userId: member.userId },
				})
			)._nay,
		).toBeUndefined();
		expect((await t.query(internal.files_nodes_content.get_file_read_source, memberRead))._nay).toBeDefined();

		// A user from another tenant never reads the file, whatever the sharing says.
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-file-reader" }),
		);
		expect(
			(
				await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: other.userId,
					membershipId: other.membershipId,
					agentSource: scope.agentSource,
					path,
					target: saved._yay.target,
				})
			)._nay,
		).toBeDefined();

		// An archived file is gone for its owner too, so the old private target stops working.
		await t.run((ctx) => ctx.db.patch("files_nodes", nodeId, { archiveOperationId: "archived" }));
		expect(
			(
				await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: scope.userId,
					membershipId: scope.membershipId,
					agentSource: scope.agentSource,
					path,
					target,
				})
			)._nay,
		).toBeDefined();
	});

	test("refuses the file immediately when normal pending expiry fences it", async () => {
		const t = test_convex();
		const scope = await seed_browser_file_scope(t);
		const path = "/reports/expired.bin";
		const prepared = await prepare_browser_file({ t, scope, changes: { path } });
		const finalized = await t.mutation(internal.files_browser.finalize_file_output, {
			...scope,
			receiptId: prepared.receiptId,
			attemptId: browserFile.attemptId,
		});
		if (finalized._nay) throw new Error(finalized._nay.message);

		const target = finalized._yay.target;
		const view = await authed(t, scope.userId).query(api.files_pending_updates.get_file_pending_target, {
			membershipId: scope.membershipId,
			target,
		});
		const pendingUpdateId = view!.entry.pendingUpdate!._id;

		const draft = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId));
		if (!draft?.expiresAt) throw new Error("Expected the pending draft expiry");
		vi.spyOn(Date, "now").mockReturnValue(draft.expiresAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			userId: scope.userId,
		});

		expect(
			(
				await t.query(internal.files_nodes_content.get_file_read_source, {
					userId: scope.userId,
					membershipId: scope.membershipId,
					agentSource: scope.agentSource,
					path,
					target,
				})
			)._nay,
		).toBeDefined();
	});
});

describe("capture_browser_draft", () => {
	test("captures and starts a draft without saving the file", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const draftHtml = HTML_TEXT.replace("Hi", "Draft");
		const hash = await sha256_hex(draftHtml);

		const captured = await asUser.mutation(api.files_browser.capture_browser_draft, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			revision: 7,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(draftHtml).byteLength,
			hash,
		});
		expect(captured._nay).toBeUndefined();
		expect(typeof captured._yay?.uploadUrl).toBe("string");

		const storageId = await t.run((ctx) => ctx.storage.store(new Blob([draftHtml])));
		const attached = await asUser.mutation(api.files_browser.attach_draft_capture_blob, {
			membershipId: fixture.membershipId,
			captureId: captured._yay!.captureId,
			storageId,
		});
		expect(attached._nay).toBeUndefined();

		runnerQueue.push(runner_open_session({ sourceKind: "draft" }));
		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "draft",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
			draftCaptureId: captured._yay!.captureId,
			draftStorageId: storageId,
			draftRevisionAfter: 7,
		});
		expect(started._nay).toBeUndefined();
		expect(started._yay?.sourceKind).toBe("draft");
		expect(runnerCalls[0]?.body.html).toBe(draftHtml);

		// One-shot: the capture and its blob are gone, the file is untouched.
		expect(await t.run((ctx) => ctx.db.get("files_browser_draft_captures", captured._yay!.captureId))).toBe(null);
		expect(await t.run((ctx) => ctx.storage.get(storageId))).toBe(null);
	});

	test("refuses an edit that lands mid-capture", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const hash = await sha256_hex(HTML_TEXT);

		const captured = await asUser.mutation(api.files_browser.capture_browser_draft, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			revision: 7,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(HTML_TEXT).byteLength,
			hash,
		});
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob([HTML_TEXT])));
		await asUser.mutation(api.files_browser.attach_draft_capture_blob, {
			membershipId: fixture.membershipId,
			captureId: captured._yay!.captureId,
			storageId,
		});

		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "draft",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
			draftCaptureId: captured._yay!.captureId,
			draftStorageId: storageId,
			draftRevisionAfter: 8,
		});
		expect(started._nay?.message).toBe("The draft changed while loading. Refresh to try again.");
		expect(runnerCalls).toEqual([]);
	});

	test("tampered draft bytes fail the hash check", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const hash = await sha256_hex(HTML_TEXT);

		const captured = await asUser.mutation(api.files_browser.capture_browser_draft, {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			revision: 7,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(HTML_TEXT).byteLength,
			hash,
		});
		const storageId = await t.run((ctx) => ctx.storage.store(new Blob([HTML_TEXT.replace("Hi", "Tampered")])));
		await asUser.mutation(api.files_browser.attach_draft_capture_blob, {
			membershipId: fixture.membershipId,
			captureId: captured._yay!.captureId,
			storageId,
		});

		const started = await asUser.action(api.files_browser.start_browser, {
			membershipId: fixture.membershipId,
			targetKind: "saved",
			nodeId: fixture.nodeId,
			path: fixture.path,
			sourceKind: "draft",
			navigationGeneration: 1,
			navigationClientId: "client-1",
			viewport: { width: 1280, height: 900 },
			draftCaptureId: captured._yay!.captureId,
			draftStorageId: storageId,
			draftRevisionAfter: 7,
		});
		expect(started._nay?.message).toBe("Choose an available source.");
		expect(runnerCalls).toEqual([]);
	});

	test("daily capture cap refuses the 101st capture", async () => {
		const t = test_convex();
		const fixture = await seed_html_file(t);
		const asUser = authed(t, fixture.userId);
		const hash = await sha256_hex(HTML_TEXT);
		const base = {
			membershipId: fixture.membershipId,
			nodeId: fixture.nodeId,
			path: fixture.path,
			basisKind: "saved",
			basisVersion: "v1",
			navigationGeneration: 1,
			byteSize: new TextEncoder().encode(HTML_TEXT).byteLength,
			hash,
		} as const;

		for (let revision = 1; revision <= 100; revision++) {
			const captured = await asUser.mutation(api.files_browser.capture_browser_draft, { ...base, revision });
			expect(captured._nay, `capture ${revision}`).toBeUndefined();
		}
		const capped = await asUser.mutation(api.files_browser.capture_browser_draft, { ...base, revision: 101 });
		expect(capped._nay?.message).toBe("Daily browser capture limit reached.");
	});
});

describe("fill_browser_chooser_from_files", () => {
	async function seed_chooser_files(t: ReturnType<typeof test_convex>) {
		const owner = await seed_web_member({ t });
		const first = await test_create_saved_text_file(t, {
			membershipId: owner.membershipId,
			path: "/docs/first.txt",
			textContent: "first",
		});
		const second = await test_create_saved_text_file(t, {
			membershipId: owner.membershipId,
			path: "/docs/second.txt",
			textContent: "second",
		});
		return { owner, first, second };
	}

	async function fill(args: {
		t: ReturnType<typeof test_convex>;
		fixture: WebFixture;
		sessionId: Id<"files_browser_sessions">;
		nodeIds: Array<Id<"files_nodes">>;
	}) {
		const { t, fixture, nodeIds, sessionId } = args;

		return await authed(t, fixture.userId).action(api.files_browser.fill_browser_chooser_from_files, {
			membershipId: fixture.membershipId,
			sessionId,
			chooserId: "chooser-1",
			controlGen: 2,
			tabId: "tab-1",
			tabGen: 1,
			viewGen: 1,
			nodeIds,
		});
	}

	test("gives the runner short signed URLs for readable files", async () => {
		const t = test_convex();
		const { owner, first, second } = await seed_chooser_files(t);
		const started = await start_web_session({ t, fixture: owner });
		if (started._nay) throw new Error(started._nay.message);

		// Spying again returns the spy from `beforeEach`, with its mock URL.
		const getUrl = vi.spyOn(R2.prototype, "getUrl");
		const timeout = vi.spyOn(AbortSignal, "timeout");
		runnerQueue.push({ ok: true });
		expect(
			await fill({ t, fixture: owner, sessionId: started._yay.session.sessionId, nodeIds: [first, second] }),
		).toEqual({ _yay: null });
		// The runner gives the whole fill 120 seconds. Convex waits a bit longer for its answer.
		expect(timeout).toHaveBeenLastCalledWith(150_000);

		const nodes = await t.run(async (ctx) => [
			await ctx.db.get("files_nodes", first),
			await ctx.db.get("files_nodes", second),
		]);
		expect(runnerCalls.at(-1)).toEqual({
			route: "upload-fill",
			body: {
				mode: "web",
				sessionId: "runner-web-1",
				ownerId: owner.userId,
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				chooserId: "chooser-1",
				controlGen: 2,
				tabId: "tab-1",
				tabGen: 1,
				viewGen: 1,
				files: nodes.map((node) => ({
					name: node!.name,
					contentType: node!.contentType,
					url: expect.stringMatching(/^https:\/\/r2\.test\/object\?key=/u),
				})),
			},
		});
		// The runner may take up to 120 seconds for the whole fill, so the URLs outlive that.
		expect(getUrl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expiresIn: 300 }));
	});

	test("refuses the whole call when one file is not readable", async () => {
		const t = test_convex();
		const { owner, first, second } = await seed_chooser_files(t);
		const member = await add_workspace_member({ t, owner, role: "member", plan: "Pro" });
		const restricted = await authed(t, owner.userId).mutation(api.files_sharing.restrict_node, {
			membershipId: owner.membershipId,
			nodeId: second,
		});
		expect(restricted._nay).toBeUndefined();
		const started = await start_web_session({ t, fixture: member });
		if (started._nay) throw new Error(started._nay.message);

		runnerQueue.push({ ok: true });
		expect(
			await fill({ t, fixture: member, sessionId: started._yay.session.sessionId, nodeIds: [first, second] }),
		).toEqual({
			_nay: { message: "Not found" },
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
	});

	test("refuses a folder, a total over 20 MiB, and a wrong file count", async () => {
		const t = test_convex();
		const { owner, first } = await seed_chooser_files(t);
		const started = await start_web_session({ t, fixture: owner });
		if (started._nay) throw new Error(started._nay.message);
		const sessionId = started._yay.session.sessionId;

		const folderId = await saved_node_id_by_path({ t, fixture: owner, path: "/docs" });
		expect(await fill({ t, fixture: owner, sessionId, nodeIds: [folderId] })).toEqual({
			_nay: { message: "Not found" },
		});

		expect(await fill({ t, fixture: owner, sessionId, nodeIds: [] })).toEqual({
			_nay: { message: "Choose 1 to 10 files." },
		});
		expect(
			await fill({
				t,
				fixture: owner,
				sessionId,
				nodeIds: Array.from({ length: 11 }, () => first),
			}),
		).toEqual({
			_nay: { message: "Choose 1 to 10 files." },
		});

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", first);
			await ctx.db.patch("files_r2_assets", node!.assetId!, { size: 20 * 1024 * 1024 + 1 });
		});
		expect(await fill({ t, fixture: owner, sessionId, nodeIds: [first] })).toEqual({
			_nay: { message: "Files too large: a page takes at most 20 MB at once." },
		});
		expect(runnerCalls.map((call) => call.route)).toEqual(["open"]);
	});
});
