import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_media_validation_db_advance_content_version,
	files_media_validation_db_advance_version,
	files_media_validation_db_capture_versions,
	files_media_validation_db_can_back_media,
	files_media_validation_db_versions_match,
	files_media_validation_is_media_version,
} from "./files_media_validation.ts";
import { files_db_advance_pending_review_version } from "../server/files.ts";

describe("media validation versions", () => {
	test.each([false, true])("checks replacement presence without reading other drafts: %s", async (hasReplacement) => {
		const t = test_convex({ transactionLimits: { documentsRead: 128 } });
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const node = await t.run(async (ctx) => {
			const nodeId = await ctx.db.insert("files_nodes", {
				...test_mocks.files.base(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				createdBy: scope.userId,
				updatedBy: scope.userId,
				kind: "file",
				textKind: "plain_text",
				contentType: "text/plain",
			});
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				kind: "content",
				r2Bucket: "test-bucket",
				size: 0,
				createdBy: scope.userId,
				updatedAt: Date.now(),
			});
			for (let index = 0; index < 256; index++) {
				const userId = await ctx.db.insert("users", { clerkUserId: null });
				await ctx.db.insert("files_pending_updates", {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId,
					target: { kind: "saved", id: nodeId },
					revision: 1,
					size: 0,
					updatedAt: Date.now(),
					expiresAt: Date.now() + 60_000,
					...(hasReplacement && index === 255
						? {
								pendingReplacement: {
									assetId,
									size: 0,
									contentType: "text/plain",
									baseAssetId: assetId,
									baseContentVersion: {
										kind: "asset",
										assetId,
										contentType: "text/plain",
										textKind: "plain_text",
										collaborationEnabled: false,
									},
								},
							}
						: {}),
				});
			}
			return (await ctx.db.get("files_nodes", nodeId))!;
		});
		await expect(
			t.run((ctx) => files_media_validation_db_can_back_media(ctx, node)),
			"replacement lookup stays within the read limit",
		).resolves.toBe(hasReplacement);
	});

	test("keeps organization and workspace versions separate", async () => {
		const t = test_convex({ transactionLimits: true });
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const pins = await t.run((ctx) =>
			files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope, scope] }),
		);
		expect(pins.versions).toHaveLength(3);
		expect(pins.pendingVersions).toHaveLength(1);
		expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(true);
		await t.run((ctx) => files_media_validation_db_advance_version(ctx, scope));
		await t.run((ctx) => files_media_validation_db_advance_version(ctx, scope));
		const current = await t.run((ctx) =>
			files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope] }),
		);
		expect(current.versions[0]).toEqual(pins.versions[0]);
		expect(current.versions[1]).toEqual({ id: pins.versions[1]!.id, revision: pins.versions[1]!.revision + 2 });
		expect(current.versions[2]).toEqual(pins.versions[2]);
		expect(current.pendingVersions).toEqual(pins.pendingVersions);
		expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, pins))).toBe(false);
		expect(await t.run((ctx) => files_media_validation_db_versions_match(ctx, current))).toBe(true);
	});

	test("reads all proof clocks before waiting on a clock", async () => {
		const t = test_convex({ transactionLimits: true });
		const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const pins = await t.run((ctx) =>
			files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope] }),
		);
		await t.run(async (ctx) => {
			const started: string[] = [];
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const trackedDb = new Proxy(ctx.db, {
				get(target, key) {
					const member: unknown = Reflect.get(target, key);
					if (typeof member !== "function") return member;
					if (key === "get")
						return async (...args: unknown[]) => {
							started.push(String(args[1]));
							await gate;
							return Reflect.apply(member, target, args);
						};
					return member.bind(target);
				},
			});
			const proof = files_media_validation_db_versions_match({ ...ctx, db: trackedDb }, pins);
			let startedBeforeRelease: string[];
			try {
				startedBeforeRelease = [...started];
			} finally {
				release();
			}
			expect(await proof).toBe(true);
			expect(startedBeforeRelease, "all proof clocks start before waiting").toEqual(
				[...pins.versions, ...pins.pendingVersions].map((pin) => pin.id),
			);
		});
	});

	test.each(["organization", "workspace", "content", "pending"] as const)(
		"invalidates a proof when its %s clock changes",
		async (kind) => {
			const t = test_convex({ transactionLimits: true });
			const scope = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const pins = await t.run((ctx) =>
				files_media_validation_db_capture_versions(ctx, { userId: scope.userId, scopes: [scope] }),
			);
			await t.run(async (ctx) => {
				if (kind === "pending") await files_db_advance_pending_review_version(ctx, scope);
				else if (kind === "content") await files_media_validation_db_advance_content_version(ctx, scope);
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
					const clock = (await ctx.db.get(
						"files_media_validation_versions",
						pins.versions[1]!.id as Id<"files_media_validation_versions">,
					))!;
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

	test.each([
		{ contentType: "image/png", textKind: null, isMedia: true },
		{ contentType: "video/mp4", textKind: null, isMedia: true },
		{ contentType: "image/png", textKind: "plain_text", isMedia: false },
		{ contentType: "text/markdown", textKind: null, isMedia: false },
		{ contentType: null, textKind: null, isMedia: false },
		{ contentType: "Image/PNG", textKind: null, isMedia: false },
	] as const)("media version rule: $contentType $textKind", ({ isMedia, ...version }) => {
		expect(files_media_validation_is_media_version(version)).toBe(isMedia);
	});
});
