import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { ai_chat_tool_create_page_tools } from "../server/server-ai-tools.ts";
import type { ai_chat_PageToolOutput } from "../shared/ai-chat-files.ts";

type TestConvex = ReturnType<typeof test_convex>;
type Membership = Awaited<ReturnType<typeof test_mocks_fill_db_with.membership>>;

/**
 * Insert a passed version of a plugin `mail` with one page tool, and its installation in the
 * membership's workspace.
 */
async function install_mail_plugin(t: TestConvex, membership: Membership) {
	const now = Date.now();
	const { organizationId, workspaceId, userId } = membership;
	return await t.run(async (ctx) => {
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "mail",
			displayName: "Mail",
			version: "1.0.0",
			description: "",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: "hash",
			sourceRepositoryUrl: "https://github.test/acme/mail",
			sourceOwner: "acme",
			sourceRepo: "mail",
			sourceCommitSha: "sha",
			manifestR2Key: "manifest",
			backendEntrypointFile: null,
			configuration: null,
			mounts: [],
			events: [],
			pages: [
				{
					id: "mail",
					title: "Mail",
					entry: "dist/frontend/index.html",
					navItem: null,
					agent: {
						tools: [
							{
								name: "create_draft",
								description: "Create a draft.",
								inputSchemaJson: JSON.stringify({ type: "object", properties: { subject: { type: "string" } } }),
							},
						],
					},
				},
			],
			fileViews: [],
			capabilities: ["agent.page-tools"],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "mcp-servers-hash",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: userId,
			updatedAt: now,
			secrets: [],
			endpoints: [],
			userWritableCollections: null,
		});
		return await ctx.db.insert("plugins_workspace_installations", {
			serviceAccountId: await ctx.db.insert("access_control_service_accounts", {
				organizationId,
				workspaceId,
				name: "mail",
				createdBy: userId,
				createdAt: now,
				updatedAt: now,
				revokedAt: null,
			}),
			organizationId,
			workspaceId,
			pluginVersionId,
			pluginName: "mail",
			status: "enabled",
			managementAccess: "selected",
			configurationYaml: null,
			acceptedCapabilities: ["agent.page-tools"],
			capabilitiesAcceptedAt: now,
			acceptedOutboundOrigins: [],
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "mcp-servers-hash",
			acceptedSkillNames: [],
			outboundOriginsAcceptedAt: now,
			sandbox: { roots: [], rebuild: null },
			installedBy: userId,
			updatedBy: userId,
			updatedAt: now,
		});
	});
}

describe("plugins page tools relay", () => {
	test("sends a call to the member's open page once and returns the page answer", async () => {
		const t = test_convex();
		const membership = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-org", workspaceName: "other" }),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", subject: "page-tools", external_id: membership.userId });
		const asOther = t.withIdentity({ issuer: "https://clerk.test", subject: "page-other", external_id: other.userId });
		const thread = await asUser.mutation(api.ai_chat.thread_create, {
			membershipId: membership.membershipId,
			clientGeneratedId: "page-tools-thread",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		await install_mail_plugin(t, membership);

		const turnPage = await t.query(internal.plugins_page_tools.get_turn_page, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			pluginName: "mail",
			pageId: "mail",
		});
		if (!turnPage) throw new Error("Expected the page to have tools");

		// The chat tool waits inside the action. The loop below plays the open page.
		const called = t.action(async (ctx) => {
			const tools = ai_chat_tool_create_page_tools(ctx, {
				ctxData: {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: membership.userId,
					getThreadId: () => thread._yay.threadId,
					runDeadline: Date.now() + 60_000,
				},
				page: turnPage,
				pageId: "mail",
				pageInstanceId: "tab-1",
			});
			return (await tools.page__create_draft!.execute!(
				{ subject: "Hi" },
				{ toolCallId: "call-1", messages: [] },
			)) as ai_chat_PageToolOutput;
		});

		const pageArgs = {
			membershipId: membership.membershipId,
			pluginName: "mail",
			pageId: "mail",
			pageInstanceId: "tab-1",
		};
		let pending = await asUser.query(api.plugins_page_tools.list_pending, pageArgs);
		while (pending.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			pending = await asUser.query(api.plugins_page_tools.list_pending, pageArgs);
		}
		expect(pending).toEqual([{ callId: pending[0]!.callId, toolName: "create_draft", inputJson: '{"subject":"Hi"}' }]);
		const { callId } = pending[0]!;

		// Another member never sees or takes the call.
		expect(
			await asOther.query(api.plugins_page_tools.list_pending, { ...pageArgs, membershipId: other.membershipId }),
		).toEqual([]);
		expect(await asOther.mutation(api.plugins_page_tools.claim_call, { membershipId: other.membershipId, callId })).toEqual(
			{ _nay: { message: "Not found" } },
		);

		// Another tab of the same member never sees the call.
		expect(await asUser.query(api.plugins_page_tools.list_pending, { ...pageArgs, pageInstanceId: "tab-2" })).toEqual([]);

		// A call is taken once.
		expect(await asUser.mutation(api.plugins_page_tools.claim_call, { membershipId: membership.membershipId, callId })).toEqual(
			{ _yay: null },
		);
		expect(await asUser.mutation(api.plugins_page_tools.claim_call, { membershipId: membership.membershipId, callId })).toEqual(
			{ _nay: { message: "This call was already taken or has ended" } },
		);
		expect(
			await asUser.mutation(api.plugins_page_tools.complete_call, {
				membershipId: membership.membershipId,
				callId,
				result: { ok: true, outputJson: '{"draftId":"d1"}' },
			}),
		).toEqual({ _yay: null });

		const output = await called;
		expect(output.output).toBe('{"draftId":"d1"}');
		expect(output.metadata.isError).toBe(false);
		expect(await t.run((ctx) => ctx.db.get("plugins_page_tool_calls", callId))).toBeNull();
	});
});
