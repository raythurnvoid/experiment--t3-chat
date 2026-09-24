import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { activities_is_active } from "./activities_db.ts";
import { files_nodes_db_set_restricted_scope } from "./files_nodes.ts";
import { organizations_membership_lifetimes_db_ensure } from "./organizations_membership_lifetimes.ts";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";

// Scheduled steps never run on their own under fake timers. Each test drives `advance` itself.
// Move the clock with `vi.setSystemTime`. `vi.advanceTimersByTime` would also run the scheduled step.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/**
 * The owner, plus an admin member. The admin manages every open item but cannot see a restricted
 * item without a grant.
 */
async function fixture(transactionLimits: NonNullable<Parameters<typeof test_convex>[0]>["transactionLimits"] = true) {
	const t = test_convex({ transactionLimits });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const member = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "policy-run-member" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			active: true,
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			role: "admin",
			now: Date.now(),
		});
		return { userId, membershipId };
	});
	const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId });
	return { t, db, asOwner, member, asMember };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function folder(f: Fixture, path: string) {
	const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		path,
	});
	if (created._nay) throw new Error(created._nay.message);
	return created._yay.nodeId;
}

/**
 * Make an empty folder its own restricted scope. Nothing inside it needs the cascade.
 */
async function hide(f: Fixture, nodeId: Id<"files_nodes">) {
	await f.t.run((ctx) =>
		files_nodes_db_set_restricted_scope(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			nodeId,
			restrictedScopeNodeId: nodeId,
		}),
	);
}

async function restrict(f: Fixture, nodeId: Id<"files_nodes">) {
	expect(
		await f.asOwner.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId }),
	).toEqual({ _yay: null });
}

async function grant(f: Fixture, nodeId: Id<"files_nodes">, level: "read" | "manage") {
	expect(
		await f.asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: f.db.membershipId,
			nodeId,
			principal: { kind: "user", userId: f.member.userId },
			level,
		}),
	).toEqual({ _yay: null });
}

async function demote_to_member(f: Fixture) {
	expect(
		await f.asOwner.mutation(api.access_control.set_user_role, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.member.userId,
			role: "member",
		}),
	).toEqual({ _yay: null });
}

async function start_as_member(f: Fixture, nodeId: Id<"files_nodes">) {
	const started = await f.asMember.mutation(api.files_write_policy_runs.start, {
		membershipId: f.member.membershipId,
		nodeId,
		writePolicy: { mode: "read_only" },
	});
	if (started._nay) throw new Error(started._nay.message);
	return started._yay.activityId;
}

async function read_activity(f: Fixture, activityId: Id<"activities">) {
	const activity = await f.t.run((ctx) => ctx.db.get("activities", activityId));
	if (activity?.source.kind !== "files_write_policy_run") throw new Error("Missing protection activity");
	return { ...activity, source: activity.source };
}

async function step(f: Fixture, activityId: Id<"activities">) {
	const activity = await read_activity(f, activityId);
	await f.t.mutation(internal.files_write_policy_runs.advance, { runId: activity.source.id });
	return await read_activity(f, activityId);
}

async function run_to_end(f: Fixture, activityId: Id<"activities">) {
	for (let count = 0; count < 100; count++) {
		const activity = await step(f, activityId);
		if (!activities_is_active(activity.status)) return activity;
	}
	throw new Error("The protection job did not finish");
}

async function read_policy(f: Fixture, nodeId: Id<"files_nodes">) {
	return (await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.writePolicy;
}

function progress_of(activity: Doc<"activities">) {
	const { completed, skipped, blocked, discovered, total } = activity.progress!;
	return { completed, skipped, blocked, discovered, total };
}

describe("start", () => {
	test("queues one private job with no names, then the first step marks it running", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		await folder(f, "/box/a");

		const activityId = await start_as_member(f, box);
		const queued = await read_activity(f, activityId);
		expect(queued).toMatchObject({
			status: "queued",
			visibility: "requester",
			feedVisible: true,
			title: "Apply protection to folder contents",
			targets: [],
			resultKind: "saved",
			userId: f.member.userId,
			membershipId: f.member.membershipId,
		});
		expect(queued.startedAt).toBeUndefined();

		expect(await f.t.run((ctx) => ctx.db.get("files_write_policy_runs", queued.source.id))).toMatchObject({
			folderId: box,
			folderTreePath: "/box/",
			cursor: null,
		});

		vi.setSystemTime(Date.now() + 1000);
		const finished = await step(f, activityId);
		expect(finished.startedAt).toBe(Date.now());
		expect(finished.status).toBe("succeeded");
	});

	test("refuses a second job while the first is still running", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const other = await folder(f, "/other");
		await start_as_member(f, box);

		const second = await f.asMember.mutation(api.files_write_policy_runs.start, {
			membershipId: f.member.membershipId,
			nodeId: other,
			writePolicy: null,
		});
		expect(second._nay?.message).toBe("Another protection update is still running.");
	});

	test("refuses a person who cannot manage the folder and writes nothing", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		await demote_to_member(f);

		const refused = await f.asMember.mutation(api.files_write_policy_runs.start, {
			membershipId: f.member.membershipId,
			nodeId: box,
			writePolicy: { mode: "read_only" },
		});
		expect(refused._nay?.message).toBe("Permission denied");
		expect(await f.t.run((ctx) => ctx.db.query("files_write_policy_runs").collect())).toEqual([]);
	});

	test("refuses a new job while a data reset deletes the workspace files", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		await f.t.run((ctx) =>
			ctx.db.patch("organizations_workspaces", f.db.workspaceId, { pluginDataPurgeStartedAt: Date.now() }),
		);

		const refused = await f.asMember.mutation(api.files_write_policy_runs.start, {
			membershipId: f.member.membershipId,
			nodeId: box,
			writePolicy: { mode: "read_only" },
		});
		expect(refused._nay?.message).toBe("Permission denied");
		expect(await f.t.run((ctx) => ctx.db.query("files_write_policy_runs").collect())).toEqual([]);
	});
});

describe("advance", () => {
	test("updates 120 items in three steps of 50 and leaves archived items and the folder alone", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const ids: Id<"files_nodes">[] = [];
		for (let index = 0; index < 120; index++) ids.push(await folder(f, `/box/c${String(index).padStart(3, "0")}`));
		const archived = await folder(f, "/box/zz-archived");
		expect(
			await f.asOwner.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds: [archived] }),
		).toEqual({ _yay: null });
		// One item already has the rule. It is counted as skipped.
		expect(
			await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
				membershipId: f.db.membershipId,
				nodeId: ids[7]!,
				writePolicy: { mode: "read_only" },
			}),
		).toEqual({ _yay: null });

		const activityId = await start_as_member(f, box);
		expect(progress_of(await step(f, activityId))).toEqual({
			completed: 49,
			skipped: 1,
			blocked: 0,
			discovered: 50,
			total: null,
		});
		expect(progress_of(await step(f, activityId))).toMatchObject({ discovered: 100, total: null });
		const finished = await step(f, activityId);
		expect(finished.status).toBe("succeeded");
		expect(progress_of(finished)).toEqual({ completed: 119, skipped: 1, blocked: 0, discovered: 120, total: 120 });

		for (const id of ids) expect(await read_policy(f, id)).toEqual({ mode: "read_only" });
		expect(await read_policy(f, archived)).toBeNull();
		expect(await read_policy(f, box)).toBeNull();
	});

	test("unlocking contents clears each child's own rule", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const first = await folder(f, "/box/first");
		const second = await folder(f, "/box/second");
		for (const nodeId of [first, second])
			expect(
				await f.asOwner.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: f.db.membershipId,
					nodeId,
					writePolicy: { mode: "read_only" },
				}),
			).toEqual({ _yay: null });

		const started = await f.asOwner.mutation(api.files_write_policy_runs.start, {
			membershipId: f.db.membershipId,
			nodeId: box,
			writePolicy: null,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect((await run_to_end(f, started._yay.activityId)).status).toBe("succeeded");
		expect(await read_policy(f, first)).toBeNull();
		expect(await read_policy(f, second)).toBeNull();
	});

	test("counts a visible item it cannot manage as blocked, and never counts a hidden one", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const open = await folder(f, "/box/open");
		const shown = await folder(f, "/box/shown");
		const hidden = await folder(f, "/box/hidden");
		await restrict(f, shown);
		await grant(f, shown, "read");
		await restrict(f, hidden);

		const activityId = await start_as_member(f, box);
		const finished = await run_to_end(f, activityId);
		expect(finished).toMatchObject({ status: "partial", errorMessage: null, targets: [] });
		expect(progress_of(finished)).toEqual({ completed: 1, skipped: 0, blocked: 1, discovered: 2, total: 2 });
		expect(await read_policy(f, open)).toEqual({ mode: "read_only" });
		expect(await read_policy(f, shown)).toBeNull();
		expect(await read_policy(f, hidden)).toBeNull();

		// The member cannot see `hidden`. That is why it is not counted.
		expect(
			await f.asMember.query(api.files_nodes.get_file_node_for_membership, {
				membershipId: f.member.membershipId,
				fileNodeId: String(hidden),
			}),
		).toBeNull();
	});

	test("a re-run where every managed item already matches and one is blocked ends failed", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		await folder(f, "/box/open");
		const shown = await folder(f, "/box/shown");
		await restrict(f, shown);
		await grant(f, shown, "read");

		expect((await run_to_end(f, await start_as_member(f, box))).status).toBe("partial");
		const rerun = await run_to_end(f, await start_as_member(f, box));
		expect(rerun.status).toBe("failed");
		expect(progress_of(rerun)).toEqual({ completed: 0, skipped: 1, blocked: 1, discovered: 2, total: 2 });
	});

	test("skips a hidden folder with everything inside it, even items the person manages", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const hidden = await folder(f, "/box/b");
		const inner = await folder(f, "/box/b/g");
		const after = await folder(f, "/box/c");
		// `g` is shared with the member, so they could change it on its own. Its hidden parent still
		// hides it from this job, like `chmod -R` skips a folder it cannot read.
		await restrict(f, inner);
		await grant(f, inner, "manage");
		await restrict(f, hidden);

		const finished = await run_to_end(f, await start_as_member(f, box));
		expect(progress_of(finished)).toEqual({ completed: 1, skipped: 0, blocked: 0, discovered: 1, total: 1 });
		expect(await read_policy(f, inner)).toBeNull();
		expect(await read_policy(f, hidden)).toBeNull();
		expect(await read_policy(f, after)).toEqual({ mode: "read_only" });
	});

	test("a hidden file never hides siblings whose names start with its name", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		await folder(f, "/box/b");
		const siblings = [await folder(f, "/box/b-x"), await folder(f, "/box/bc"), await folder(f, "/box/b0")];
		const hiddenFile = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: box,
				name: "b",
				kind: "file",
				path: "/box/b",
				treePath: "/box/b",
				pathDepth: 2,
			}),
		);
		await hide(f, hiddenFile);

		const finished = await run_to_end(f, await start_as_member(f, box));
		expect(finished.status).toBe("succeeded");
		for (const id of siblings) expect(await read_policy(f, id)).toEqual({ mode: "read_only" });
		expect(await read_policy(f, hiddenFile)).toBeNull();
	});

	test("updates a file whose path is the first path after a hidden folder's contents", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		// The hidden folder `/box/b` is the last node of the first page of 50. Its contents end before
		// "/box/b0", so the next page must start at that exact path.
		for (let index = 0; index < 49; index++) await hide(f, await folder(f, `/box/a${String(index).padStart(3, "0")}`));
		await hide(f, await folder(f, "/box/b"));
		const boundFile = await f.t.run((ctx) =>
			ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				createdBy: f.db.userId,
				updatedBy: f.db.userId,
				parentId: box,
				name: "b0",
				kind: "file",
				path: "/box/b0",
				treePath: "/box/b0",
				pathDepth: 2,
			}),
		);

		const finished = await run_to_end(f, await start_as_member(f, box));
		expect(progress_of(finished)).toEqual({ completed: 1, skipped: 0, blocked: 0, discovered: 1, total: 1 });
		expect(await read_policy(f, boundFile)).toEqual({ mode: "read_only" });
	});

	test("skips hidden folders inside the page instead of reading the page again", async () => {
		// Each hidden folder used to end the page, so 200 hidden siblings cost 200 page reads of 50.
		// This read limit fits one read of each node, but not those repeated pages.
		const f = await fixture({ documentsRead: 4_000 });
		const box = await folder(f, "/box");
		for (let index = 0; index < 200; index++) await hide(f, await folder(f, `/box/h${String(index).padStart(3, "0")}`));
		const after = await folder(f, "/box/z");

		const finished = await run_to_end(f, await start_as_member(f, box));
		expect(progress_of(finished)).toEqual({ completed: 1, skipped: 0, blocked: 0, discovered: 1, total: 1 });
		expect(await read_policy(f, after)).toEqual({ mode: "read_only" });
	});

	test("hidden items between managed ones still give steps of exactly 50", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		for (let index = 0; index < 60; index++) {
			const prefix = `/box/c${String(index).padStart(3, "0")}`;
			await folder(f, prefix);
			if (index % 2 === 0) await hide(f, await folder(f, `${prefix}-hidden`));
		}

		const activityId = await start_as_member(f, box);
		expect(progress_of(await step(f, activityId))).toMatchObject({ completed: 50, discovered: 50 });
		const finished = await step(f, activityId);
		expect(finished.status).toBe("succeeded");
		expect(progress_of(finished)).toEqual({ completed: 60, skipped: 0, blocked: 0, discovered: 60, total: 60 });
	});

	test("a step that stops at the check limit shows nothing until the next full 50 or the end", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		// Step 1 counts `a` and checks 199 hidden folders. Showing 1 would tell the person that step
		// passed exactly 199 hidden items. Step 2 checks only hidden folders, and its 200th check is the
		// hidden folder `i`. Step 3 must start after everything inside `i`.
		await folder(f, "/box/a");
		for (let index = 0; index < 398; index++) await hide(f, await folder(f, `/box/h${String(index).padStart(3, "0")}`));
		const hidden = await folder(f, "/box/i");
		const inner = await folder(f, "/box/i/g");
		const after = await folder(f, "/box/z");
		await restrict(f, inner);
		await grant(f, inner, "manage");
		await restrict(f, hidden);

		const activityId = await start_as_member(f, box);
		const first = await step(f, activityId);
		expect(progress_of(first)).toMatchObject({ completed: 0, discovered: 0 });
		expect(await f.t.run((ctx) => ctx.db.get("files_write_policy_runs", first.source.id))).toMatchObject({
			unpublishedProgress: { completed: 1, skipped: 0, blocked: 0 },
		});
		vi.setSystemTime(Date.now() + 60_000);
		const quiet = await step(f, activityId);
		expect(quiet.status).toBe("running");
		expect(quiet.updatedAt).toBe(first.updatedAt);
		expect(quiet.deadlineAt).toBe(first.deadlineAt);
		expect(progress_of(quiet)).toEqual(progress_of(first));
		expect(await f.t.run((ctx) => ctx.db.get("files_write_policy_runs", quiet.source.id))).toMatchObject({
			cursor: { treePath: "/box/i0", inclusive: true },
		});

		const finished = await run_to_end(f, activityId);
		expect(progress_of(finished)).toEqual({ completed: 2, skipped: 0, blocked: 0, discovered: 2, total: 2 });
		expect(await read_policy(f, inner)).toBeNull();
		expect(await read_policy(f, after)).toEqual({ mode: "read_only" });
	});

	test("a step stops after reading 1,000 nodes, even when it checked only a few of them", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		// Each page holds one hidden folder and its 49 items. Only the folder is checked, so 20 pages
		// make 1,000 reads but only 20 checks.
		for (let index = 0; index < 21; index++) {
			const hidden = `/box/h${String(index).padStart(2, "0")}`;
			await hide(f, await folder(f, hidden));
			for (let child = 0; child < 49; child++) await folder(f, `${hidden}/c${String(child).padStart(2, "0")}`);
		}

		const activityId = await start_as_member(f, box);
		const first = await step(f, activityId);
		expect(first.status).toBe("running");
		expect(await f.t.run((ctx) => ctx.db.get("files_write_policy_runs", first.source.id))).toMatchObject({
			cursor: { treePath: "/box/h190", inclusive: true },
		});

		const finished = await run_to_end(f, activityId);
		expect(progress_of(finished)).toEqual({ completed: 0, skipped: 0, blocked: 0, discovered: 0, total: 0 });
	});

	test("stops at the next step when the person loses management of the folder", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const ids: Id<"files_nodes">[] = [];
		for (let index = 0; index < 60; index++) ids.push(await folder(f, `/box/c${String(index).padStart(3, "0")}`));

		const activityId = await start_as_member(f, box);
		await step(f, activityId);
		await demote_to_member(f);

		const failed = await step(f, activityId);
		expect(failed).toMatchObject({
			status: "failed",
			errorMessage: "You can no longer change this folder's protection.",
		});
		expect(progress_of(failed)).toMatchObject({ completed: 50 });
		expect(await read_policy(f, ids[49]!)).toEqual({ mode: "read_only" });
		expect(await read_policy(f, ids[50]!)).toBeNull();
	});

	test("stops at the next step after a leave and re-join", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const ids: Id<"files_nodes">[] = [];
		for (let index = 0; index < 60; index++) ids.push(await folder(f, `/box/c${String(index).padStart(3, "0")}`));

		const activityId = await start_as_member(f, box);
		await step(f, activityId);
		// A new membership doc replaces the old one, like a leave and a new invite.
		await f.t.run(async (ctx) => {
			await ctx.db.patch("organizations_workspaces_users", f.member.membershipId, { active: false });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.member.userId,
				active: true,
			});
			await organizations_membership_lifetimes_db_ensure(
				ctx,
				(await ctx.db.get("organizations_workspaces_users", membershipId))!,
			);
		});

		const failed = await step(f, activityId);
		expect(failed).toMatchObject({
			status: "failed",
			errorMessage: "You can no longer change this folder's protection.",
		});
		expect(await read_policy(f, ids[50]!)).toBeNull();
	});

	test("stops when the folder moves during the job", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const ids: Id<"files_nodes">[] = [];
		for (let index = 0; index < 60; index++) ids.push(await folder(f, `/box/c${String(index).padStart(3, "0")}`));

		const activityId = await start_as_member(f, box);
		await step(f, activityId);
		expect(
			await f.asOwner.mutation(api.files_nodes.rename_node, {
				membershipId: f.db.membershipId,
				nodeId: box,
				path: "moved",
			}),
		).toEqual({ _yay: null });

		expect(await step(f, activityId)).toMatchObject({
			status: "failed",
			errorMessage: "The folder moved or was archived during the update. Run it again.",
		});
		expect(await read_policy(f, ids[50]!)).toBeNull();
	});

	test("stops when the folder is archived during the job", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		for (let index = 0; index < 60; index++) await folder(f, `/box/c${String(index).padStart(3, "0")}`);

		// Use the Editable rule. Read-only children would block the archive itself.
		const started = await f.asMember.mutation(api.files_write_policy_runs.start, {
			membershipId: f.member.membershipId,
			nodeId: box,
			writePolicy: null,
		});
		if (started._nay) throw new Error(started._nay.message);
		const activityId = started._yay.activityId;
		expect(progress_of(await step(f, activityId))).toMatchObject({ skipped: 50 });
		expect(
			await f.asOwner.mutation(api.files_nodes.archive_nodes, { membershipId: f.db.membershipId, nodeIds: [box] }),
		).toEqual({ _yay: null });

		const failed = await step(f, activityId);
		expect(failed).toMatchObject({
			status: "failed",
			errorMessage: "The folder moved or was archived during the update. Run it again.",
		});
		expect(progress_of(failed)).toMatchObject({ skipped: 50, total: null });
	});

	test("Stop cancels the job and later steps write nothing", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const ids: Id<"files_nodes">[] = [];
		for (let index = 0; index < 60; index++) ids.push(await folder(f, `/box/c${String(index).padStart(3, "0")}`));

		const activityId = await start_as_member(f, box);
		await step(f, activityId);
		expect(
			await f.asMember.mutation(api.activities.request_stop, { membershipId: f.member.membershipId, activityId }),
		).toEqual({ _yay: null });

		const stopped = await step(f, activityId);
		expect(stopped).toMatchObject({ status: "canceled", errorMessage: null });
		expect(progress_of(stopped)).toMatchObject({ completed: 50, total: null });
		expect(await read_policy(f, ids[49]!)).toEqual({ mode: "read_only" });
		expect(await read_policy(f, ids[50]!)).toBeNull();
	});

	test("Stop after a step that showed nothing still shows the items that step updated", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		// Step 1 updates `a`, then stops at the check limit on the hidden folders and shows nothing yet.
		const a = await folder(f, "/box/a");
		for (let index = 0; index < 199; index++) await hide(f, await folder(f, `/box/h${String(index).padStart(3, "0")}`));
		await folder(f, "/box/z");

		const activityId = await start_as_member(f, box);
		expect(progress_of(await step(f, activityId))).toMatchObject({ completed: 0 });
		expect(
			await f.asMember.mutation(api.activities.request_stop, { membershipId: f.member.membershipId, activityId }),
		).toEqual({ _yay: null });

		const stopped = await read_activity(f, activityId);
		expect(stopped.status).toBe("canceled");
		expect(progress_of(stopped)).toEqual({ completed: 1, skipped: 0, blocked: 0, discovered: 1, total: null });
		expect(await read_policy(f, a)).toEqual({ mode: "read_only" });
	});

	test("a job that keeps making progress may run longer than the idle limit", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		for (let index = 0; index < 120; index++) await folder(f, `/box/c${String(index).padStart(3, "0")}`);

		const activityId = await start_as_member(f, box);
		for (let count = 0; count < 2; count++) {
			await step(f, activityId);
			vi.setSystemTime(Date.now() + 20 * 60 * 1000);
		}
		expect((await step(f, activityId)).status).toBe("succeeded");
	});

	test("times out when no step ran for 30 minutes", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		for (let index = 0; index < 60; index++) await folder(f, `/box/c${String(index).padStart(3, "0")}`);

		const activityId = await start_as_member(f, box);
		await step(f, activityId);
		vi.setSystemTime(Date.now() + 30 * 60 * 1000);
		expect(await step(f, activityId)).toMatchObject({
			status: "timed_out",
			errorMessage: "The protection update reached its time limit.",
		});
	});

	test("the deadline cron times out a job whose step never ran", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const child = await folder(f, "/box/a");

		const activityId = await start_as_member(f, box);
		await f.t.mutation(internal.activities.recover_expired, {
			_test_now: Date.now() + 30 * 60 * 1000,
			_test_disableReschedule: true,
		});
		expect(await read_activity(f, activityId)).toMatchObject({
			status: "timed_out",
			errorMessage: "The protection update reached its time limit.",
		});
		expect((await step(f, activityId)).status).toBe("timed_out");
		expect(await read_policy(f, child)).toBeNull();
	});
});

describe("files_write_policy_runs_db_delete_run_batch", () => {
	test("history cleanup deletes the run with its Activity", async () => {
		const f = await fixture();
		const box = await folder(f, "/box");
		const activityId = await start_as_member(f, box);
		const finished = await run_to_end(f, activityId);

		await f.t.mutation(internal.activities.cleanup_history, {
			_test_now: finished.expiresAt! + 1,
			_test_disableReschedule: true,
		});
		expect(await f.t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_write_policy_runs", finished.source.id))).toBeNull();
	});
});
