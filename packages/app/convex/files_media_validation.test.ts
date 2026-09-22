import { describe, expect, test } from "vitest";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_media_validation_db_advance_version,
	files_media_validation_db_capture_versions,
	files_media_validation_db_versions_match,
} from "./files_media_validation.ts";
import { files_db_advance_pending_review_version } from "../server/files.ts";

describe("media validation versions", () => {
	test("keeps organization and workspace versions separate", async () => {
		const t = test_convex({ transactionLimits: true });
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const pins = await t.run((ctx) =>
			files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope, scope] }),
		);
		expect(pins.versions).toHaveLength(2);
		expect(pins.pendingVersions).toHaveLength(1);
		expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(true);
		await t.run((ctx) => files_media_validation_db_advance_version(ctx, scope));
		await t.run((ctx) => files_media_validation_db_advance_version(ctx, scope));
		const current = await t.run((ctx) =>
			files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope] }),
		);
		expect(current.versions[0]).toEqual(pins.versions[0]);
		expect(current.versions[1]).toEqual({ id: pins.versions[1]!.id, revision: pins.versions[1]!.revision + 2 });
		expect(current.pendingVersions).toEqual(pins.pendingVersions);
		expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(false);
		expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, current))).toBe(true);
	});

	test.each(["organization", "workspace", "pending"] as const)(
		"invalidates a proof when its %s clock changes",
		async (kind) => {
			const t = test_convex({ transactionLimits: true });
			const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const pins = await t.run((ctx) =>
				files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope] }),
			);
			await t.run(async (ctx) => {
				if (kind === "pending") await files_db_advance_pending_review_version(ctx, scope);
				else
					await files_media_validation_db_advance_version(ctx, {
						organizationId: scope.organizationId,
						workspaceId: kind === "organization" ? null : scope.workspaceId,
					});
			});
			expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(false);
		},
	);

	test.each(["shared", "pending"] as const)(
		"does not accept a recreated %s clock with the same revision",
		async (kind) => {
			const t = test_convex({ transactionLimits: true });
			const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const pins = await t.run((ctx) =>
				files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope] }),
			);
			await t.run(async (ctx) => {
				if (kind === "shared") {
					const clock = (await ctx.db.get("files_media_validation_versions", pins.versions[1]!.id))!;
					await ctx.db.delete("files_media_validation_versions", clock._id);
					await ctx.db.insert("files_media_validation_versions", {
						organizationId: clock.organizationId,
						workspaceId: clock.workspaceId,
						revision: clock.revision,
					});
				} else {
					const clock = (await ctx.db.get("files_pending_review_versions", pins.pendingVersions[0]!.id))!;
					await ctx.db.delete("files_pending_review_versions", clock._id);
					await ctx.db.insert("files_pending_review_versions", {
						organizationId: clock.organizationId,
						workspaceId: clock.workspaceId,
						userId: clock.userId,
						revision: clock.revision,
					});
				}
			});
			expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(false);
		},
	);

	test("ignores another workspace and reserved source mounts", async () => {
		const t = test_convex({ transactionLimits: true });
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const other = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { userId: scope.userId, organizationName: "other-team" }),
		);
		const pins = await t.run((ctx) =>
			files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope] }),
		);
		await t.run(async (ctx) => {
			await files_media_validation_db_advance_version(ctx, other);
			await files_media_validation_db_advance_version(ctx, { organizationId: "GLOBAL", workspaceId: "GITHUB" });
			await files_media_validation_db_advance_version(ctx, { organizationId: "GLOBAL", workspaceId: "PLUGINS" });
		});
		expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(true);
		const clocks = await t.run((ctx) => ctx.db.query("files_media_validation_versions").collect());
		expect(clocks.filter((clock) => clock.workspaceId === other.workspaceId)).toHaveLength(1);
	});
});
