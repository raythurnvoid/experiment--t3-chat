import { expect, test } from "vitest";

import { internal } from "./_generated/api.js";
import { activities_db_start } from "./activities_db.ts";
import { fixture } from "./files_archive_runs.setup.test.ts";
import { insert_installation } from "./files_share_links.setup.test.ts";

test("the access switch waits for every live run state without changing old credentials", async () => {
	const f = await fixture();
	const installationId = await insert_installation(f);
	const { runId, activityId } = await f.t.run(async (ctx) => {
		const installation = (await ctx.db.get("plugins_workspace_installations", installationId))!;
		const runId = await ctx.db.insert("plugins_event_runs", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			installationId,
			pluginVersionId: installation.pluginVersionId,
			serviceAccountId: installation.serviceAccountId,
			actorUserId: f.db.userId,
			event: "ui.invoke.requested",
			eventId: "personal-file-switch-test",
			acceptedCapabilities: [],
			apiCallCount: 0,
			outputWriteCount: 0,
		});
		const activityId = await activities_db_start(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			source: {
				kind: "plugin_run",
				id: runId,
				installationId,
				pluginName: installation.pluginName,
				event: "ui.invoke.requested",
			},
			title: "Personal file switch test",
			targets: [],
			visibility: "shared",
			feedVisible: false,
			status: "running",
			resultKind: "plugin_result",
			deadlineAt: Date.now() + 60 * 60 * 1000,
			now: Date.now(),
		});
		return { runId, activityId };
	});
	for (const status of ["queued", "running", "awaiting_input", "stopping"] as const) {
		await f.t.run((ctx) => ctx.db.patch("activities", activityId, { status }));
		expect(
			(await f.t.mutation(internal.migrations.switch_plugin_file_access, { installationId }))._nay,
			`the switch waits for ${status} work`,
		).toBeDefined();
	}
	await f.t.run((ctx) => ctx.db.patch("activities", activityId, { status: "succeeded" }));
	expect(
		await f.t.mutation(internal.migrations.switch_plugin_file_access, { installationId }),
		"settled runs allow the switch",
	).toEqual({ _yay: null });
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_workspace_installations", installationId)))?.fileAccessModel,
		"the switch selects personal consent",
	).toBe("personal");
	expect(
		(await f.t.run((ctx) => ctx.db.get("plugins_event_runs", runId)))?.filePairId,
		"the switch never gives an old credential a new pair",
	).toBeUndefined();
});
