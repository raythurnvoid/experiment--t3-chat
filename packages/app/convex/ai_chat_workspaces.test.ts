import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

async function fixture(personal = false) {
	const t = test_convex();
	const db = await t.run((ctx) =>
		test_mocks_fill_db_with.membership(ctx, {
			organizationName: personal ? "personal" : "agent-team",
			workspaceName: "home",
		}),
	);
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "two-workspace-chat",
		lastMessageAt: Date.now(),
	});
	if (created._nay) throw new Error(created._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const source = { ...db, threadId: created._yay.threadId, membershipLifetime: captured._yay.membershipLifetime };
	return { t, db, asUser, source, captured: captured._yay };
}

describe("capture", () => {
	test("captures only the current workspace and the actor's personal home", async () => {
		const f = await fixture();
		const user = await f.t.run((ctx) => ctx.db.get("users", f.db.userId));
		expect(f.captured.current).toMatchObject({
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			membershipId: f.db.membershipId,
			organizationName: "agent-team",
			workspaceName: "home",
		});
		expect(f.captured.personal).toMatchObject({
			organizationId: user!.defaultOrganizationId,
			workspaceId: user!.defaultWorkspaceId,
			organizationName: "personal",
			workspaceName: "home",
		});
		expect(f.captured.personal.workspaceId).not.toBe(f.db.workspaceId);
		for (const workspace of ["current", "personal"] as const) {
			expect(await f.t.query(internal.ai_chat_workspaces.resolve, { source: f.source, workspace })).toEqual({
				_yay: f.captured[workspace],
			});
		}
	});

	test("uses the same membership when the chat starts in personal home", async () => {
		const f = await fixture(true);
		expect(f.captured.personal).toEqual(f.captured.current);
		const before = await f.t.run((ctx) => ctx.db.query("organizations_workspaces_users").collect());
		expect(await f.t.query(internal.ai_chat_workspaces.resolve, { source: f.source, workspace: "personal" })).toEqual({
			_yay: f.captured.current,
		});
		expect(await f.t.run((ctx) => ctx.db.query("organizations_workspaces_users").collect())).toEqual(before);
	});

	test("does not substitute another user's membership", async () => {
		const f = await fixture();
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		expect(
			await f.t.mutation(internal.ai_chat_workspaces.capture, {
				userId: f.db.userId,
				membershipId: other.membershipId,
			}),
		).toEqual({ _nay: { message: "Unauthorized" } });
	});
});

describe("resolve", () => {
	test("an owner cannot resolve another person's chat", async () => {
		const f = await fixture();
		const other = await f.t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const created = await f.t
			.withIdentity({ issuer: "https://clerk.test", external_id: other.userId })
			.mutation(api.ai_chat.thread_create, {
				membershipId: other.membershipId,
				clientGeneratedId: "other-private-chat",
				lastMessageAt: Date.now(),
			});
		if (created._nay) throw new Error(created._nay.message);
		for (const workspace of ["current", "personal"] as const) {
			expect(
				await f.t.query(internal.ai_chat_workspaces.resolve, {
					source: { ...f.source, threadId: created._yay.threadId },
					workspace,
				}),
			).toEqual({ _nay: { message: "Chat is no longer available" } });
		}
	});

	test("read-only team access still resolves the actor's own home", async () => {
		const f = await fixture();
		const visitor = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		expect(
			await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: visitor.userId,
			}),
		).toEqual({ _yay: null });
		expect(
			await f.asUser.mutation(api.access_control.set_user_role, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: visitor.userId,
				role: "viewer",
			}),
		).toEqual({ _yay: null });
		const membership = await f.t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", f.db.workspaceId).eq("userId", visitor.userId).eq("active", true),
				)
				.first(),
		);
		if (!membership) throw new Error("Expected invited membership");
		const asVisitor = f.t.withIdentity({ issuer: "https://clerk.test", external_id: visitor.userId });
		const created = await asVisitor.mutation(api.ai_chat.thread_create, {
			membershipId: membership._id,
			clientGeneratedId: "viewer-chat",
			lastMessageAt: Date.now(),
		});
		if (created._nay) throw new Error(created._nay.message);
		const captured = await f.t.mutation(internal.ai_chat_workspaces.capture, {
			userId: visitor.userId,
			membershipId: membership._id,
		});
		if (captured._nay) throw new Error(captured._nay.message);
		const source = {
			...f.source,
			userId: visitor.userId,
			membershipId: membership._id,
			threadId: created._yay.threadId,
			membershipLifetime: captured._yay.membershipLifetime,
		};
		expect(await f.t.query(internal.ai_chat_workspaces.resolve, { source, workspace: "personal" })).toMatchObject({
			_yay: { workspaceId: visitor.workspaceId, membershipId: visitor.membershipId },
		});
		expect(
			await asVisitor.query(api.access_control.get_current_user_workspace_permission, {
				membershipId: membership._id,
				permission: "content.write",
			}),
		).toBe(false);

		expect(
			await asVisitor.mutation(api.organizations.remove_user_from_organization, {
				organizationId: f.db.organizationId,
				userIdToRemove: visitor.userId,
			}),
		).toEqual({ _yay: null });
		for (const workspace of ["current", "personal"] as const) {
			expect(await f.t.query(internal.ai_chat_workspaces.resolve, { source, workspace })).toEqual({
				_nay: { message: "Chat is no longer available" },
			});
		}
		expect(
			await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userIdToAdd: visitor.userId,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.query(internal.ai_chat_workspaces.resolve, { source, workspace: "personal" })).toEqual({
			_nay: { message: "Chat is no longer available" },
		});
		const rejoined = await f.t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", f.db.workspaceId).eq("userId", visitor.userId).eq("active", true),
				)
				.first(),
		);
		if (!rejoined) throw new Error("Expected rejoined membership");
		const fresh = await f.t.mutation(internal.ai_chat_workspaces.capture, {
			userId: visitor.userId,
			membershipId: rejoined._id,
		});
		if (fresh._nay) throw new Error(fresh._nay.message);
		expect(fresh._yay.membershipLifetime).not.toBe(source.membershipLifetime);
		const freshSource = {
			...source,
			membershipId: rejoined._id,
			membershipLifetime: fresh._yay.membershipLifetime,
		};
		expect(
			await f.t.query(internal.ai_chat_workspaces.resolve, { source: freshSource, workspace: "personal" }),
		).toEqual({ _yay: captured._yay.personal });
		expect(
			await f.t.query(internal.ai_chat_workspaces.resolve, {
				source: { ...freshSource, membershipLifetime: source.membershipLifetime },
				workspace: "personal",
			}),
		).toEqual({ _nay: { message: "Chat is no longer available" } });
	});

	test("does not accept an extra workspace selector or a substituted source scope", async () => {
		const f = await fixture();
		await expect(
			f.t.query(internal.ai_chat_workspaces.resolve, { source: f.source, workspace: "third" as never }),
		).rejects.toThrow();
		const other = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { userId: f.db.userId, organizationName: "third-team" }),
		);
		expect(
			await f.t.query(internal.ai_chat_workspaces.resolve, {
				source: { ...f.source, ...other },
				workspace: "current",
			}),
		).toEqual({ _nay: { message: "Chat is no longer available" } });
	});
});
