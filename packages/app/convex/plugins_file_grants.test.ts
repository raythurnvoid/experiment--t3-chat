import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { expect_under_convex_limits, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";
import { files_access_version_db_wrap } from "../server/files-access-version.ts";
import {
	plugins_file_grants_db_advance_authority,
	plugins_file_grants_db_ensure_pair,
	plugins_file_grants_db_get_pair,
	plugins_file_grants_db_validate_pair,
} from "../server/plugins-file-grants.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture() {
	const t = test_convex();
	const owner = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const data = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "file-grant-member" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			displayName: "Member",
			sortDisplayName: "member",
			updatedAt: 1,
		});
		const pluginVersionId = await ctx.db.insert("plugins_versions", {
			name: "file-grant-test",
			displayName: "File grant test",
			version: "0.1.0",
			description: "Test",
			reviewStatus: "passed",
			reviewId: null,
			isLatest: true,
			artifactHash: `sha256:${"a".repeat(64)}`,
			sourceRepositoryUrl: "https://github.com/example/file-grant-test",
			sourceOwner: "example",
			sourceRepo: "file-grant-test",
			sourceCommitSha: "a".repeat(40),
			manifestR2Key: "test/manifest.json",
			backendEntrypointFile: null,
			configuration: null,
			mounts: [],
			events: [],
			capabilities: ["workspace.files.read"],
			pages: [],
			fileViews: [],
			outboundOrigins: [],
			uiOutboundOrigins: [],
			mcpServers: [],
			mcpServersFingerprint: "none",
			skills: [],
			files: [],
			sourceStatus: "ready",
			sourceLastError: null,
			createdBy: owner.userId,
			updatedAt: 1,
			secrets: [],
			endpoints: [],
			userWritableCollections: null,
		});
		const serviceAccountId = await ctx.db.insert("access_control_service_accounts", {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			name: "File grant test",
			role: "viewer",
			createdBy: owner.userId,
			createdAt: 1,
			updatedAt: 1,
			revokedAt: null,
		});
		const installationId = await ctx.db.insert("plugins_workspace_installations", {
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			serviceAccountId,
			pluginVersionId,
			pluginName: "file-grant-test",
			status: "enabled",
			managementAccess: "workspace",
			configurationYaml: null,
			acceptedCapabilities: ["workspace.files.read"],
			capabilitiesAcceptedAt: 1,
			acceptedOutboundOrigins: [],
			outboundOriginsAcceptedAt: 1,
			acceptedUiOutboundOrigins: [],
			acceptedMcpServersFingerprint: "none",
			acceptedSkillNames: [],
			installedBy: owner.userId,
			updatedBy: owner.userId,
			updatedAt: 1,
		});
		const membership = (await ctx.db.get("organizations_workspaces_users", membershipId))!;
		const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
		const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
		const pair = await plugins_file_grants_db_ensure_pair(ctx, { installation, membership, membershipLifetime });
		return { userId, membership, installation, pair };
	});
	const add = async (name = "Selected", requestedLevel: "read" | "write" = "write") =>
		t.run(async (ctx) => {
			const rootNodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				createdBy: owner.userId,
				updatedBy: owner.userId,
				name,
				path: `/${name}`,
				treePath: `/${name}/`,
				parentId: "root",
				isRestrictedScopeRoot: true,
			});
			await ctx.db.patch("files_nodes", rootNodeId, { restrictedScopeNodeId: rootNodeId });
			const grant = async (permission: "content.read" | "content.write") =>
				ctx.db.insert("access_control_permission_grants", {
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					userId: data.userId,
					resourceKind: "file",
					resourceId: rootNodeId,
					principalKind: "user",
					permission,
					createdAt: 1,
					updatedAt: 1,
				});
			const readGrant = await grant("content.read");
			const writeGrant = await grant("content.write");
			const consentId = await ctx.db.insert("plugins_file_consents", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				pairId: data.pair._id,
				rootNodeId,
				requestedLevel,
				appliedLevel: "write",
				areaEligible: true,
				open: true,
				revision: 1,
				state: "applied",
				endedReason: null,
				createdAt: 1,
				updatedAt: 1,
			});
			return { rootNodeId, consentId, readGrant, writeGrant };
		});
	const write = async (fn: (ctx: MutationCtx) => Promise<unknown>) =>
		t.run(async (ctx) => {
			const capture = files_access_version_db_wrap(ctx);
			await fn({ ...ctx, db: capture.db });
			await capture.flush();
		});
	const queue = () => t.run((ctx) => plugins_file_grants_db_advance_authority(ctx, owner));
	const job = () =>
		t.run((ctx) =>
			ctx.db
				.query("plugins_file_grant_jobs")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", owner.organizationId).eq("workspaceId", owner.workspaceId),
				)
				.first(),
		);
	const step = async () => {
		const current = await job();
		if (!current) throw new Error("Expected a queued grant job");
		await t.mutation(internal.plugins_file_grants.advance, {
			jobId: current._id,
			step: current.step,
			phase: current.phase,
		});
	};
	const drain = async () => {
		for (let i = 0; i < 100; i++) {
			if (!(await job())) return;
			await step();
		}
		throw new Error("Grant job did not finish");
	};
	const consent = (id: Id<"plugins_file_consents">) => t.run((ctx) => ctx.db.get("plugins_file_consents", id));
	return { t, owner, ...data, add, write, queue, job, step, drain, consent };
}

describe("plugin file grant worker", () => {
	test("new consent queues a pass and applied-only changes do not queue another", async () => {
		const f = await fixture();
		const selected = await f.add();
		const { _id, _creationTime, ...fields } = (await f.consent(selected.consentId))!;
		await f.t.run((ctx) => ctx.db.delete("plugins_file_consents", selected.consentId));
		await f.write((ctx) =>
			ctx.db.insert("plugins_file_consents", { ...fields, appliedLevel: null, areaEligible: false, state: "pending" }),
		);
		expect(await f.job(), "new consent schedules its first applied grant").not.toBeNull();
		await f.drain();
		const consent = await f.t.run((ctx) =>
			ctx.db
				.query("plugins_file_consents")
				.withIndex("by_pair_rootNode_open", (q) =>
					q.eq("pairId", f.pair._id).eq("rootNodeId", selected.rootNodeId).eq("open", true),
				)
				.first(),
		);
		expect(consent?.appliedLevel, "the requested grant applies").toBe("write");
		await f.write((ctx) =>
			ctx.db.patch("plugins_file_consents", consent!._id, { appliedLevel: "read", updatedAt: Date.now() }),
		);
		expect(await f.job(), "applied changes do not schedule themselves").toBeNull();
	});

	test("keeps old write until apply, downgrades to read, and restores only requested write", async () => {
		const f = await fixture();
		const selected = await f.add();
		await f.write((ctx) => ctx.db.delete("access_control_permission_grants", selected.writeGrant));
		for (let i = 0; i < 3; i++) await f.step();
		expect((await f.job())?.phase).toBe("apply");
		expect((await f.consent(selected.consentId))?.appliedLevel, "old write remains until apply").toBe("write");
		await f.step();
		expect(await f.consent(selected.consentId), "the applied grant and area remain together").toMatchObject({
			requestedLevel: "write",
			appliedLevel: "read",
			areaEligible: true,
			open: true,
		});
		await f.drain();
		await f.write((ctx) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.userId,
				resourceKind: "file",
				resourceId: selected.rootNodeId,
				principalKind: "user",
				permission: "content.write",
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		await f.drain();
		expect((await f.consent(selected.consentId))?.appliedLevel, "open Edit consent can regain write").toBe("write");
		await f.write((ctx) =>
			ctx.db.patch("plugins_file_consents", selected.consentId, {
				requestedLevel: "read",
				revision: 2,
				state: "pending",
			}),
		);
		await f.drain();
		expect((await f.consent(selected.consentId))?.appliedLevel, "requested View never gains write").toBe("read");
	});

	test("ends lost read without reviving consent when access returns", async () => {
		const f = await fixture();
		const selected = await f.add();
		await f.write(async (ctx) => {
			await ctx.db.delete("access_control_permission_grants", selected.readGrant);
			await ctx.db.delete("access_control_permission_grants", selected.writeGrant);
		});
		await f.drain();
		expect(await f.consent(selected.consentId), "lost read closes the exact selection").toMatchObject({
			appliedLevel: null,
			areaEligible: false,
			open: false,
			state: "ended",
		});
		await f.write((ctx) =>
			ctx.db.insert("access_control_permission_grants", {
				organizationId: f.owner.organizationId,
				workspaceId: f.owner.workspaceId,
				userId: f.userId,
				resourceKind: "file",
				resourceId: selected.rootNodeId,
				principalKind: "user",
				permission: "content.read",
				createdAt: 1,
				updatedAt: 1,
			}),
		);
		await f.drain();
		expect((await f.consent(selected.consentId))?.open, "ended consent needs a new explicit choice").toBe(false);
	});

	test("rechecks changed consent and ignores stale callbacks and removal", async () => {
		const f = await fixture();
		const selected = await f.add();
		await f.queue();
		await f.step();
		const old = (await f.job())!;
		await f.step();
		const beforeReplay = await f.job();
		await f.t.mutation(internal.plugins_file_grants.advance, { jobId: old._id, step: old.step, phase: old.phase });
		expect(await f.job(), "an old callback cannot run a new step").toEqual(beforeReplay);
		await f.write((ctx) =>
			ctx.db.patch("plugins_file_consents", selected.consentId, { requestedLevel: "read", revision: 2 }),
		);
		await f.step();
		expect((await f.job())?.phase, "changed consent starts a fresh human check").toBe("read");
		await f.step();
		await f.write((ctx) =>
			ctx.db.patch("plugins_file_consents", selected.consentId, {
				revision: 3,
				open: false,
				state: "ended",
				appliedLevel: null,
				areaEligible: false,
				endedReason: "Removed",
			}),
		);
		await f.step();
		expect(await f.consent(selected.consentId), "a late apply cannot reopen removed consent").toMatchObject({
			revision: 3,
			open: false,
			appliedLevel: null,
			endedReason: "Removed",
		});
		await f.drain();
		expect(await f.consent(selected.consentId), "later steps cannot overwrite removed consent").toMatchObject({
			open: false,
			state: "ended",
			appliedLevel: null,
			areaEligible: false,
			endedReason: "Removed",
		});
	});

	test.each(["organizationAuthorityPin", "workspaceAuthorityPin"] as const)(
		"checks the identity and revision of %s before apply",
		async (pin) => {
			const f = await fixture();
			const selected = await f.add();
			await f.t.run((ctx) =>
				plugins_file_grants_db_advance_authority(ctx, { organizationId: f.owner.organizationId, workspaceId: null }),
			);
			await f.queue();
			for (let i = 0; i < 3; i++) await f.step();
			const previous = (await f.job())![pin]!;
			await f.t.run(async (ctx) => {
				const clock = (await ctx.db.get("plugins_file_authority_versions", previous.id))!;
				await ctx.db.delete("plugins_file_authority_versions", clock._id);
				await ctx.db.insert("plugins_file_authority_versions", {
					organizationId: clock.organizationId,
					workspaceId: clock.workspaceId,
					revision: clock.revision,
				});
				await ctx.db.patch("plugins_file_consents", selected.consentId, { appliedLevel: "read" });
			});
			await f.step();
			expect((await f.job())?.phase, "a recreated source clock invalidates the result").toBe("read");
			expect((await f.consent(selected.consentId))?.appliedLevel, "an old proof cannot overwrite applied access").toBe(
				"read",
			);
		},
	);

	test("finishes several pages and repeats a pass after an earlier selection changes", async () => {
		const f = await fixture();
		const selections: Array<Awaited<ReturnType<typeof f.add>>> = [];
		for (let i = 0; i < 4; i++) selections.push(await f.add(`Folder ${i}`));
		await f.queue();
		for (let i = 0; i < 4; i++) await f.step();
		await f.write((ctx) =>
			ctx.db.patch("plugins_file_consents", selections[0]!.consentId, { requestedLevel: "read", revision: 2 }),
		);
		for (const selected of selections.slice(1))
			await f.t.run((ctx) =>
				ctx.db.patch("plugins_file_consents", selected.consentId, { appliedLevel: null, state: "pending" }),
			);
		await f.drain();
		expect((await f.consent(selections[0]!.consentId))?.appliedLevel, "a new pass revisits the consumed cursor").toBe(
			"read",
		);
		for (const selected of selections.slice(1))
			expect((await f.consent(selected.consentId))?.appliedLevel, "all later pages apply").toBe("write");
		expect(await f.job(), "finished jobs are removed").toBeNull();
	});

	test("ends old membership lifetime but keeps consent through a temporary disable", async () => {
		const f = await fixture();
		const selected = await f.add();
		await f.t.run((ctx) => ctx.db.patch("plugins_workspace_installations", f.installation._id, { status: "disabled" }));
		await f.queue();
		await f.drain();
		expect((await f.consent(selected.consentId))?.open, "disable does not withdraw personal consent").toBe(true);
		await f.write(async (ctx) => {
			const lifetime = await ctx.db
				.query("organizations_membership_lifetimes")
				.withIndex("by_workspace_user", (q) => q.eq("workspaceId", f.owner.workspaceId).eq("userId", f.userId))
				.first();
			await ctx.db.patch("organizations_membership_lifetimes", lifetime!._id, { lifetime: lifetime!.lifetime + 1 });
		});
		expect(
			await f.t.run((ctx) => plugins_file_grants_db_validate_pair(ctx, { pairId: f.pair._id })),
			"old pair is refused at once",
		).toBeNull();
		await f.drain();
		expect((await f.consent(selected.consentId))?.open, "leave and rejoin cannot revive old consent").toBe(false);
		expect(
			await f.t.run((ctx) =>
				plugins_file_grants_db_get_pair(ctx, {
					installationId: f.installation._id,
					userId: f.userId,
					membershipLifetime: 2,
				}),
			),
		).toBeNull();
	});

	test("processes a new consent inserted behind an organization cursor", async () => {
		const f = await fixture();
		const selected = await f.add();
		await f.t.run(async (ctx) => {
			const {
				_id: _workspaceId,
				_creationTime: _workspaceTime,
				...workspace
			} = (await ctx.db.get("organizations_workspaces", f.owner.workspaceId))!;
			const workspaceId = await ctx.db.insert("organizations_workspaces", {
				...workspace,
				name: "later",
				default: false,
			});
			const { _id: _membershipId, _creationTime: _membershipTime, ...membershipFields } = f.membership;
			const membershipId = await ctx.db.insert("organizations_workspaces_users", { ...membershipFields, workspaceId });
			const membership = (await ctx.db.get("organizations_workspaces_users", membershipId))!;
			const { _id: _installationId, _creationTime: _installationTime, ...installationFields } = f.installation;
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				...installationFields,
				workspaceId,
			});
			const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
			const membershipLifetime = await organizations_membership_lifetimes_db_ensure(ctx, membership);
			const pair = await plugins_file_grants_db_ensure_pair(ctx, { installation, membership, membershipLifetime });
			const {
				_id: _nodeId,
				_creationTime: _nodeTime,
				...node
			} = (await ctx.db.get("files_nodes", selected.rootNodeId))!;
			const rootNodeId = await ctx.db.insert("files_nodes", { ...node, workspaceId });
			await ctx.db.patch("files_nodes", rootNodeId, { restrictedScopeNodeId: rootNodeId });
			for (const grantId of [selected.readGrant, selected.writeGrant]) {
				const { _id, _creationTime, ...grant } = (await ctx.db.get("access_control_permission_grants", grantId))!;
				await ctx.db.insert("access_control_permission_grants", { ...grant, workspaceId, resourceId: rootNodeId });
			}
			const {
				_id: _consentId,
				_creationTime: _consentTime,
				...consent
			} = (await ctx.db.get("plugins_file_consents", selected.consentId))!;
			await ctx.db.insert("plugins_file_consents", { ...consent, workspaceId, rootNodeId, pairId: pair._id });
			await ctx.db.delete("plugins_file_consents", selected.consentId);
			await plugins_file_grants_db_advance_authority(ctx, {
				organizationId: f.owner.organizationId,
				workspaceId: null,
			});
		});
		const job = () =>
			f.t.run((ctx) =>
				ctx.db
					.query("plugins_file_grant_jobs")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", f.owner.organizationId).eq("workspaceId", null),
					)
					.first(),
			);
		const step = async () => {
			const current = (await job())!;
			await f.t.mutation(internal.plugins_file_grants.advance, {
				jobId: current._id,
				step: current.step,
				phase: current.phase,
			});
		};
		for (let i = 0; i < 4; i++) await step();
		const added = await f.add("New selection");
		await f.t.run(async (ctx) => {
			await ctx.db.patch("plugins_file_consents", added.consentId, { appliedLevel: null, state: "pending" });
			const first = await ctx.db
				.query("plugins_file_consents")
				.withIndex("by_organization_open_workspace", (q) =>
					q.eq("organizationId", f.owner.organizationId).eq("open", true),
				)
				.first();
			expect(first?._id, "the new consent is behind the consumed workspace cursor").toBe(added.consentId);
			await plugins_file_grants_db_advance_authority(ctx, {
				organizationId: f.owner.organizationId,
				workspaceId: null,
			});
		});
		for (let i = 0; i < 40 && (await job()); i++) await step();
		expect(await job()).toBeNull();
		expect((await f.consent(added.consentId))?.appliedLevel, "the next pass reaches a new earlier selection").toBe(
			"write",
		);
	});

	test("checks a 64-folder chain within one transaction including the wrapper", async () => {
		const f = await fixture();
		const selected = await f.add();
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", selected.rootNodeId, {
				isRestrictedScopeRoot: false,
				restrictedScopeNodeId: null,
				extendedScopeNodeId: selected.rootNodeId,
				parentExtendedScopeNodeId: null,
			});
			const { _id, _creationTime, ...template } = (await ctx.db.get("files_nodes", selected.rootNodeId))!;
			let parent = { id: selected.rootNodeId, path: template.path };
			for (let depth = 2; depth <= 64; depth++) {
				const path = `${parent.path}/a`;
				const id = await ctx.db.insert("files_nodes", {
					...template,
					parentId: parent.id,
					parentExtendedScopeNodeId: parent.id,
					path,
					treePath: `${path}/`,
					pathDepth: depth,
				});
				await ctx.db.patch("files_nodes", id, { extendedScopeNodeId: id });
				parent = { id, path };
			}
			await ctx.db.patch("plugins_file_consents", selected.consentId, {
				rootNodeId: parent.id,
				appliedLevel: null,
				areaEligible: false,
			});
		});
		await f.queue();
		await f.step();
		for (const phase of ["read", "write"] as const) {
			const job = (await f.job())!;
			expect(job.phase).toBe(phase);
			const cost = await f.t.run(async (ctx) => {
				const before = await ctx.meta.getTransactionMetrics();
				await ctx.runMutation(internal.plugins_file_grants.advance, {
					jobId: job._id,
					step: job.step,
					phase: job.phase,
				});
				const after = await ctx.meta.getTransactionMetrics();
				return transaction_cost(before, after);
			});
			expect(cost.documentsRead, `${phase} walks the 64-folder chain`).toBeGreaterThan(64);
			expect(cost.databaseQueries, `${phase} includes wrapper and worker reads`).toBeLessThan(4096);
			expect_under_convex_limits(cost);
		}
		await f.drain();
		expect((await f.consent(selected.consentId))?.appliedLevel, "both deep human checks apply write").toBe("write");
	});

	test("recovers a cancelled schedule without accepting its old callback", async () => {
		const f = await fixture();
		await f.add();
		await f.queue();
		const old = (await f.job())!;
		await f.t.run(async (ctx) => {
			await ctx.scheduler.cancel(old.scheduledId!);
			await ctx.db.patch("plugins_file_grant_jobs", old._id, { dueAt: Date.now() - 1 });
		});
		await f.t.mutation(internal.plugins_file_grants.recover_due, {});
		const replacement = await f.job();
		expect(replacement?.scheduledId).not.toBe(old.scheduledId);
		await f.t.mutation(internal.plugins_file_grants.advance, { jobId: old._id, step: old.step, phase: old.phase });
		expect(await f.job(), "recovery retires the old callback").toEqual(replacement);
		await f.drain();
	});

	test("stops a late apply after workspace purge starts and never recreates its clocks", async () => {
		const f = await fixture();
		await f.add();
		await f.queue();
		for (let i = 0; i < 3; i++) await f.step();
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_workspaces", f.owner.workspaceId, { pluginDataPurgeStartedAt: Date.now() }),
		);
		await f.step();
		expect(await f.job(), "a late apply stops at the workspace purge gate").toBeNull();
		await f.t.run(async (ctx) => {
			const clock = await ctx.db
				.query("plugins_file_authority_versions")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", f.owner.organizationId).eq("workspaceId", f.owner.workspaceId),
				)
				.first();
			await ctx.db.delete("plugins_file_authority_versions", clock!._id);
		});
		await f.write((ctx) => ctx.db.patch("organizations_workspaces_users", f.membership._id, { active: false }));
		expect(await f.job(), "flush cannot recreate a purging workspace job").toBeNull();
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("plugins_file_authority_versions")
					.withIndex("by_organization_workspace", (q) =>
						q.eq("organizationId", f.owner.organizationId).eq("workspaceId", f.owner.workspaceId),
					)
					.first(),
			),
			"flush cannot recreate a purging workspace clock",
		).toBeNull();
	});

	test("does not recreate deleted consent, pair or tenant", async () => {
		const f = await fixture();
		const selected = await f.add();
		await f.queue();
		for (let i = 0; i < 3; i++) await f.step();
		await f.t.run(async (ctx) => {
			await ctx.db.delete("plugins_file_consents", selected.consentId);
			await ctx.db.delete("plugins_file_pairs", f.pair._id);
		});
		await f.drain();
		expect(await f.consent(selected.consentId)).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("plugins_file_pairs", f.pair._id))).toBeNull();
		await f.t.run((ctx) => ctx.db.delete("organizations_workspaces", f.owner.workspaceId));
		await f.queue();
		expect(await f.job(), "queueing after tenant deletion creates no job").toBeNull();
	});
});
