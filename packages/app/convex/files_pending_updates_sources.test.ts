import { RateLimiter } from "@convex-dev/rate-limiter";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValue({ ok: true, retryAfter: 0 });
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_pending_sources" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

async function fixture(homeChat = false) {
	const t = test_convex();
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const home = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
	);
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: home.userId });
	expect(
		await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userIdToAdd: home.userId,
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
	if (!membership) throw new Error("Expected source membership");
	const current = homeChat ? home : { ...owner, userId: home.userId, membershipId: membership._id };
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: current.membershipId,
		clientGeneratedId: "pending-source",
		title: "Private source title",
		lastMessageAt: 123,
	});
	if (created._nay) throw new Error(created._nay.message);
	const threadId = created._yay.threadId;
	async function folder(root: typeof home, path: string, fromChat = true) {
		const result = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			organizationId: root.organizationId,
			workspaceId: root.workspaceId,
			userId: root.userId,
			path,
			kind: "folder",
			...(fromChat ? { threadId } : {}),
		});
		if (result._nay || !result._yay.pendingUpdateId) throw new Error("Expected a draft folder");
		return result._yay;
	}
	const summary = () =>
		asUser.query(api.files_pending_updates.get_pending_source_summary, { membershipId: home.membershipId, threadId });
	const counts = () =>
		asUser.query(api.files_pending_updates.get_chat_pending_updates_summary, {
			membershipId: current.membershipId,
			threadId,
		});
	return { t, owner, home, current, membership, asOwner, asUser, threadId, folder, summary, counts };
}

describe("pending source summaries", () => {
	test.each(["leave", "restrict", "rename"] as const)(
		"redacts captured copy source after %s without blocking destination Save",
		async (change) => {
			const f = await fixture();
			const source = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
				membershipId: f.owner.membershipId,
				parentId: "root",
				path: "private-source-name",
			});
			if (source._nay) throw new Error(source._nay.message);
			const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
				requestId: "source-redaction",
				sourceWorkspace: "current",
				destinationWorkspace: "personal",
				kind: "copy",
				expectedSourceCount: 1,
				sources: [{ kind: "saved", id: source._yay.nodeId }],
				targetParent: { kind: "root" },
				targetPath: "/",
				targetName: "adopted",
				missingParentNames: [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			expect(
				await f.t.mutation(internal.files_transfer.seal_for_agent, {
					membershipId: f.current.membershipId,
					threadId: f.threadId,
					runId: started._yay.runId,
				}),
			).toEqual({ _yay: null });
			for (let step = 0; step < 30; step++) {
				const run = await f.asUser.query(api.files_transfer.get, {
					membershipId: f.current.membershipId,
					runId: started._yay.runId,
				});
				if (run?.activity.status === "succeeded") break;
				await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			}
			expect(
				await f.asUser.query(api.files_transfer.get, {
					membershipId: f.current.membershipId,
					runId: started._yay.runId,
				}),
			).toMatchObject({ activity: { status: "succeeded" } });
			const before = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
				membershipId: f.home.membershipId,
				paginationOpts: { cursor: null, numItems: 5 },
			});
			const row = before.page[0];
			if (row?.kind !== "entry" || !row.entry.pendingUpdate) throw new Error("Expected ready destination copy");
			const proposal = row.entry.pendingUpdate;
			expect(proposal.copiedFrom?.path).toBe("/private-source-name");
			expect(row.copyDestination).toEqual({ personal: true, replacement: false, folderPath: "/" });
			if (change === "leave") {
				expect(
					await f.asUser.mutation(api.organizations.remove_user_from_organization, {
						organizationId: f.owner.organizationId,
						userIdToRemove: f.home.userId,
					}),
				).toEqual({ _yay: null });
			} else if (change === "restrict") {
				expect(
					(
						await f.asOwner.mutation(api.files_sharing.restrict_node, {
							membershipId: f.owner.membershipId,
							nodeId: source._yay.nodeId,
						})
					)._nay,
				).toBeUndefined();
			} else {
				expect(
					await f.asOwner.mutation(api.files_nodes.rename_node, {
						membershipId: f.owner.membershipId,
						nodeId: source._yay.nodeId,
						path: "renamed-source",
					}),
				).toEqual({ _yay: null });
			}
			const args = { membershipId: f.home.membershipId, target: proposal.target };
			const detail = await f.asUser.query(api.files_pending_updates.get_file_pending_target, args);
			const pending = await f.asUser.query(api.files_pending_updates.get_file_pending_update, args);
			const page = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
				membershipId: f.home.membershipId,
				paginationOpts: { cursor: null, numItems: 5 },
			});
			expect(detail?.entry.pendingUpdate?.copiedFrom).toBeUndefined();
			expect(pending?.copiedFrom).toBeUndefined();
			expect(JSON.stringify([detail, pending, page])).not.toContain("private-source-name");
			expect(detail?.canAccept).toBe(true);
			const prepared = await f.asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
				...args,
				pendingUpdateId: proposal._id,
			});
			expect(prepared._nay).toBeUndefined();
			expect(prepared._yay?.pendingUpdate?._id).toBe(proposal._id);
			expect(prepared._yay?.pendingUpdate?.copiedFrom).toBeUndefined();
			expect(JSON.stringify(prepared)).not.toContain("private-source-name");
			expect(detail?.copyDestination).toEqual({ personal: true, replacement: false, folderPath: "/" });
			const stored = await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id));
			expect(stored?.copiedFrom?.path).toBe("/private-source-name");
			const saved = await f.asUser.action(api.files_pending_updates.save_file_pending_update, {
				...args,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected destination Save");
			const savedId = saved._yay.target.id;
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedId))).toMatchObject({
				workspaceId: f.home.workspaceId,
				path: "/adopted",
				archiveOperationId: null,
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", source._yay.nodeId))).toMatchObject({
				archiveOperationId: null,
			});
		},
	);

	test("discloses the current team destination for a private home Copy", async () => {
		const f = await fixture();
		const source = await f.folder(f.home, "/personal-source");
		const destination = await f.asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.owner.membershipId,
			parentId: "root",
			path: "shared-destination",
		});
		if (destination._nay) throw new Error(destination._nay.message);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			requestId: "team-disclosure",
			sourceWorkspace: "personal",
			destinationWorkspace: "current",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [source.target],
			targetParent: { kind: "saved", id: destination._yay.nodeId },
			targetPath: "/shared-destination",
			targetName: "adopted",
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 30; step++) {
			const run = await f.asUser.query(api.files_transfer.get, {
				membershipId: f.current.membershipId,
				runId: started._yay.runId,
			});
			if (run?.activity.status === "succeeded") break;
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		}
		expect(
			await f.asUser.query(api.files_transfer.get, { membershipId: f.current.membershipId, runId: started._yay.runId }),
		).toMatchObject({ activity: { status: "succeeded" } });
		const page = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
			membershipId: f.current.membershipId,
			paginationOpts: { cursor: null, numItems: 5 },
		});
		const row = page.page[0];
		if (row?.kind !== "entry" || !row.entry.pendingUpdate) throw new Error("Expected destination Copy");
		expect(row.copyDestination).toEqual({ personal: false, replacement: false, folderPath: "/shared-destination" });
		const args = { membershipId: f.current.membershipId, target: row.entry.pendingUpdate.target };
		expect((await f.asUser.query(api.files_pending_updates.get_file_pending_target, args))?.copyDestination).toEqual(
			row.copyDestination,
		);
		expect(
			await f.asOwner.query(api.files_pending_updates.get_file_pending_target, {
				...args,
				membershipId: f.owner.membershipId,
			}),
		).toBeNull();
		expect(
			await f.asOwner.mutation(api.files_nodes.rename_node, {
				membershipId: f.owner.membershipId,
				nodeId: destination._yay.nodeId,
				path: "new-destination",
			}),
		).toEqual({ _yay: null });
		expect(
			(await f.asUser.query(api.files_pending_updates.get_file_pending_target, args))?.copyDestination?.folderPath,
		).toBe("/new-destination");
	});

	test("returns the creator's real source route across workspaces, including archived chats", async () => {
		const f = await fixture();
		const organization = await f.t.run((ctx) => ctx.db.get("organizations", f.owner.organizationId));
		expect(
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.owner.organizationId,
				workspaceId: organization!.defaultWorkspaceId!,
				userId: f.home.userId,
				role: "viewer",
			}),
		).toEqual({ _yay: null });
		expect(await f.summary()).toEqual({
			title: "Private source title",
			archived: false,
			updatedAt: expect.any(Number),
			lastMessageAt: 123,
			organizationName: "test-organization",
			workspaceName: "test-workspace",
		});
		await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", f.threadId, { archived: true }));
		expect(await f.summary()).toMatchObject({ archived: true, organizationName: "test-organization" });
	});

	test("returns no title or route to the organization owner or through another user's membership", async () => {
		const f = await fixture();
		expect(
			await f.asOwner.query(api.files_pending_updates.get_pending_source_summary, {
				membershipId: f.owner.membershipId,
				threadId: f.threadId,
			}),
		).toBeNull();
		expect(
			await f.asUser.query(api.files_pending_updates.get_pending_source_summary, {
				membershipId: f.owner.membershipId,
				threadId: f.threadId,
			}),
		).toBeNull();
	});

	test.each(["leave", "delete"] as const)(
		"hides a source after %s while its home proposal stays reviewable",
		async (change) => {
			const f = await fixture();
			const draft = await f.folder(f.home, "/kept");
			if (change === "leave") {
				expect(
					await f.asUser.mutation(api.organizations.remove_user_from_organization, {
						organizationId: f.owner.organizationId,
						userIdToRemove: f.home.userId,
					}),
				).toEqual({ _yay: null });
			} else {
				await f.t.run((ctx) => ctx.db.delete("ai_chat_threads", f.threadId));
			}
			expect(await f.summary()).toBeNull();
			expect(await f.counts()).toEqual([]);
			const page = await f.asUser.query(api.files_pending_updates.list_files_pending_updates, {
				membershipId: f.home.membershipId,
				paginationOpts: { cursor: null, numItems: 20 },
			});
			expect(page.page).toHaveLength(1);
			expect(page.page[0]).toMatchObject({
				kind: "entry",
				entry: { path: "/kept", pendingUpdate: { threadIds: [f.threadId] } },
			});
			const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId!));
			expect(
				await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: f.home.membershipId,
					target: draft.target,
					pendingUpdateId: proposal!._id,
					reviewedRevision: proposal!.revision,
				}),
			).toEqual({ _yay: null });
		},
	);

	test("checks source content permission even when membership stays active", async () => {
		const f = await fixture();
		const organization = await f.t.run((ctx) => ctx.db.get("organizations", f.owner.organizationId));
		const role = await f.asOwner.mutation(api.access_control.create_role, {
			organizationId: f.owner.organizationId,
			name: "No content",
			description: "",
			permissions: ["workspace.create"],
		});
		if (role._nay) throw new Error(role._nay.message);
		expect(
			await f.asOwner.mutation(api.access_control.set_user_role, {
				organizationId: f.owner.organizationId,
				workspaceId: organization!.defaultWorkspaceId!,
				userId: f.home.userId,
				role: role._yay.roleId,
			}),
		).toEqual({ _yay: null });
		expect(await f.summary()).toBeNull();
		expect(await f.counts()).toEqual([]);
	});

	test("requires authentication", async () => {
		const f = await fixture();
		await expect(
			f.t.query(api.files_pending_updates.get_pending_source_summary, {
				membershipId: f.home.membershipId,
				threadId: f.threadId,
			}),
		).rejects.toThrow("Unauthenticated");
		await expect(
			f.t.query(api.files_pending_updates.get_chat_pending_updates_summary, {
				membershipId: f.current.membershipId,
				threadId: f.threadId,
			}),
		).rejects.toThrow("Unauthenticated");
	});
});

describe("chat pending destination counts", () => {
	test("counts only this owner's chat in current and own home, with real routes", async () => {
		const f = await fixture();
		await f.folder(f.current, "/current");
		await f.folder(f.home, "/home-one");
		await f.folder(f.home, "/home-two");
		await f.folder(f.home, "/manual", false);
		await f.folder(f.owner, "/other-owner", false);
		const third = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { userId: f.home.userId, organizationName: "third" }),
		);
		await f.folder(third, "/third");
		expect(await f.counts()).toEqual([
			{
				workspace: "current",
				organizationName: "test-organization",
				workspaceName: "test-workspace",
				count: 1,
				truncated: false,
			},
			{ workspace: "personal", organizationName: "personal", workspaceName: "home", count: 2, truncated: false },
		]);
		expect(
			await f.asUser.query(api.files_pending_updates.get_files_pending_updates_summary, {
				membershipId: f.home.membershipId,
			}),
		).toEqual({ count: 3, truncated: false });
	});

	test("counts a folder draft that holds a draft as part of that draft", async () => {
		const f = await fixture();
		await f.folder(f.current, "/nest/inner");
		expect(await f.counts()).toEqual([
			{
				workspace: "current",
				organizationName: "test-organization",
				workspaceName: "test-workspace",
				count: 1,
				truncated: false,
			},
			{ workspace: "personal", organizationName: "personal", workspaceName: "home", count: 0, truncated: false },
		]);
	});

	test("deduplicates a home chat's two roots", async () => {
		const f = await fixture(true);
		await f.folder(f.home, "/home");
		expect(await f.counts()).toEqual([
			{ workspace: "current", organizationName: "personal", workspaceName: "home", count: 1, truncated: false },
		]);
	});

	test("caps each destination scan and marks an incomplete count", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			for (let index = 0; index < 501; index++) {
				const result = await files_pending_nodes_db_create(ctx, {
					organizationId: f.current.organizationId,
					workspaceId: f.current.workspaceId,
					userId: f.home.userId,
					parent: { kind: "root" },
					name: `draft-${index}`,
					kind: "folder",
					threadId: f.threadId,
				});
				if (result._nay) throw new Error(result._nay.message);
			}
		});
		await f.folder(f.home, "/home");
		expect(await f.counts()).toEqual([
			{
				workspace: "current",
				organizationName: "test-organization",
				workspaceName: "test-workspace",
				count: 500,
				truncated: true,
			},
			{ workspace: "personal", organizationName: "personal", workspaceName: "home", count: 1, truncated: false },
		]);
	});

	test("refuses other creators, foreign current workspaces, and optimistic ids", async () => {
		const f = await fixture();
		await f.folder(f.current, "/current");
		expect(
			await f.asOwner.query(api.files_pending_updates.get_chat_pending_updates_summary, {
				membershipId: f.owner.membershipId,
				threadId: f.threadId,
			}),
		).toEqual([]);
		expect(
			await f.asUser.query(api.files_pending_updates.get_chat_pending_updates_summary, {
				membershipId: f.home.membershipId,
				threadId: f.threadId,
			}),
		).toEqual([]);
		expect(
			await f.asUser.query(api.files_pending_updates.get_chat_pending_updates_summary, {
				membershipId: f.current.membershipId,
				threadId: "ai_thread-new",
			}),
		).toEqual([]);
	});

	test("omits a home root without live access and counts archived chats", async () => {
		const f = await fixture();
		await f.folder(f.current, "/current");
		await f.folder(f.home, "/home");
		await f.t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", f.home.membershipId, { active: false });
			await ctx.db.patch("ai_chat_threads", f.threadId, { archived: true });
		});
		expect(await f.counts()).toEqual([
			{
				workspace: "current",
				organizationName: "test-organization",
				workspaceName: "test-workspace",
				count: 1,
				truncated: false,
			},
		]);
	});
});
