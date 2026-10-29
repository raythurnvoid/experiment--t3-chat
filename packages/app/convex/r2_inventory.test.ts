// @vitest-environment node
import { createHash } from "node:crypto";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

const test = baseTest.sequential;

describe("list_deleted_workspace_objects", () => {
	const accountId = "a".repeat(32);
	const bucket = "bonobo-senate-press-files";
	let t: ReturnType<typeof test_convex>;
	let organizationId: Id<"organizations">;
	let workspaceId: Id<"organizations_workspaces">;
	let prefix: string;

	beforeEach(async () => {
		vi.stubEnv("CONVEX_CLOUD_URL", "https://grand-finch-267.convex.cloud");
		vi.stubEnv("CONVEX_SITE_URL", "https://grand-finch-267.convex.site");
		vi.stubEnv("R2_BUCKET_FILES", bucket);
		vi.stubEnv("R2_ENDPOINT", `https://${accountId}.r2.cloudflarestorage.com`);
		vi.resetModules();
		t = test_convex();
		({ organizationId, workspaceId } = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx)));
		await t.run((ctx) => ctx.db.delete("organizations_workspaces", workspaceId));
		prefix = `organizations/${organizationId}/workspaces/${workspaceId}/`;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	function page_response(contents = [{ Key: `${prefix}assets/asset-one`, Size: 12 }]) {
		return {
			Name: bucket,
			Prefix: prefix,
			MaxKeys: 500,
			KeyCount: contents.length,
			IsTruncated: false,
			Contents: contents,
		};
	}

	async function install_inventory_response(response: unknown) {
		const { r2 } = await import("./r2_client.ts");
		const sendMock = vi.fn().mockResolvedValue(response);
		vi.spyOn(r2.client, "send").mockImplementation(sendMock);
		return sendMock;
	}

	test("returns hashes and asset ids without dropping noncanonical objects", async () => {
		const contents = [
			{ Key: `${prefix}assets/asset-one`, Size: 12 },
			{ Key: `${prefix}assets/nested/name`, Size: 8 },
			{ Key: `${prefix}other/private-name.txt`, Size: 4 },
		];
		const sendMock = await install_inventory_response({
			...page_response(contents),
			$metadata: { requestId: "unused" },
		});
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
		});
		expect(result).toEqual({
			_yay: {
				cloudUrl: "https://grand-finch-267.convex.cloud",
				siteUrl: "https://grand-finch-267.convex.site",
				accountId,
				bucket,
				prefix,
				organizationExists: true,
				page: contents.map((object, index) => ({
					keyHash: createHash("sha256").update(object.Key).digest("hex"),
					size: object.Size,
					assetId: index === 0 ? "asset-one" : null,
				})),
				continueCursor: null,
				isDone: true,
			},
		});
		expect(sendMock).toHaveBeenCalledTimes(1);
		const [command, options] = sendMock.mock.calls[0];
		expect(command).toBeInstanceOf(ListObjectsV2Command);
		expect(command.input).toEqual({ Bucket: bucket, Prefix: prefix, MaxKeys: 500 });
		expect(options.abortSignal).toBeInstanceOf(AbortSignal);
		expect(timeoutSpy).toHaveBeenCalledWith(30_000);
		expect(JSON.stringify(result)).not.toContain("private-name.txt");
	});

	test("refuses a live workspace before sending to R2", async () => {
		const live = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "live-organization" }),
		);
		const sendMock = await install_inventory_response({
			...page_response([]),
			Prefix: `organizations/${live.organizationId}/workspaces/${live.workspaceId}/`,
		});
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId: live.organizationId,
			workspaceId: live.workspaceId,
		});
		expect(result).toEqual({ _nay: { message: "R2 inventory requires a missing workspace" } });
		expect(sendMock).not.toHaveBeenCalled();
	});

	test("checks workspace existence again on a continued page", async () => {
		const live = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "live-organization" }),
		);
		const sendMock = await install_inventory_response({
			...page_response([]),
			Prefix: `organizations/${live.organizationId}/workspaces/${live.workspaceId}/`,
		});
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId: live.organizationId,
			workspaceId: live.workspaceId,
			cursor: "cursor-1",
		});
		expect(result._nay?.message).toBe("R2 inventory requires a missing workspace");
		expect(sendMock).not.toHaveBeenCalled();
	});

	test("accepts an empty final page after both parents are gone", async () => {
		await t.run((ctx) => ctx.db.delete("organizations", organizationId));
		await install_inventory_response({ ...page_response([]), Contents: undefined });
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
		});
		expect(result._yay).toMatchObject({ organizationExists: false, page: [], continueCursor: null, isDone: true });
	});

	test.each([0, 1])("keeps a short continued page open with %i objects", async (count) => {
		const contents = count === 0 ? [] : [{ Key: `${prefix}assets/asset-one`, Size: 12 }];
		const sendMock = await install_inventory_response({
			...page_response(contents),
			IsTruncated: true,
			NextContinuationToken: "cursor-2",
		});
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
			cursor: "cursor-1",
		});
		expect(result._yay).toMatchObject({ continueCursor: "cursor-2", isDone: false });
		expect(sendMock.mock.calls[0][0].input).toEqual({
			Bucket: bucket,
			Prefix: prefix,
			MaxKeys: 500,
			ContinuationToken: "cursor-1",
		});
	});

	test.each([
		["CONVEX_CLOUD_URL", "https://other-deployment.convex.cloud"],
		["CONVEX_SITE_URL", "https://other-deployment.convex.site"],
		["CONVEX_SITE_URL", undefined],
		["R2_BUCKET_FILES", "other-bucket"],
		["R2_ENDPOINT", "https://example.com"],
		["R2_ENDPOINT", `https://${accountId}.r2.cloudflarestorage.com/extra`],
	])("refuses a wrong %s before sending to R2", async (name, value) => {
		vi.stubEnv(name, value);
		const sendMock = await install_inventory_response(page_response());
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
		});
		expect(result._nay?.message).toBe("R2 inventory target is not the allowed dev target");
		expect(sendMock).not.toHaveBeenCalled();
	});

	test.each(["", "c".repeat(8193)])("refuses an invalid input cursor", async (cursor) => {
		const sendMock = await install_inventory_response(page_response());
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
			cursor,
		});
		expect(result._nay?.message).toBe("Invalid R2 inventory cursor");
		expect(sendMock).not.toHaveBeenCalled();
	});

	test.each([
		["missing page state", { IsTruncated: undefined }],
		["wrong bucket", { Name: "other-bucket" }],
		["wrong prefix", { Prefix: "organizations/other/" }],
		["wrong page limit", { MaxKeys: 501 }],
		["wrong key count", { KeyCount: 0 }],
		["outside-prefix key", { Contents: [{ Key: "organizations/other/file", Size: 12 }] }],
		["negative size", { Contents: [{ Key: "PREFIX", Size: -1 }] }],
		["unsafe size", { Contents: [{ Key: "PREFIX", Size: Number.MAX_SAFE_INTEGER + 1 }] }],
		["missing cursor", { IsTruncated: true }],
		["empty cursor", { IsTruncated: true, NextContinuationToken: "" }],
		["repeated cursor", { IsTruncated: true, NextContinuationToken: "cursor-1" }],
	])("refuses an invalid page with %s", async (_name, fields) => {
		const response = { ...page_response(), ...fields };
		response.Contents = response.Contents.map((object) => ({
			...object,
			Key: object.Key === "PREFIX" ? `${prefix}assets/asset-one` : object.Key,
		}));
		await install_inventory_response(response);
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
			cursor: "cursor-1",
		});
		expect(result._nay?.message).toBe("Invalid R2 inventory page");
		expect(result._yay).toBeUndefined();
	});

	test.each(["key bytes", "page size"])("refuses an oversized %s", async (kind) => {
		const contents =
			kind === "key bytes"
				? [{ Key: `${prefix}${"😀".repeat(300)}`, Size: 12 }]
				: Array.from({ length: 501 }, (_, index) => ({ Key: `${prefix}assets/asset-${index}`, Size: 12 }));
		await install_inventory_response(page_response(contents));
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
		});
		expect(result).toEqual({ _nay: { message: "Invalid R2 inventory page" } });
	});

	test("returns a fixed failure without logging the raw error", async () => {
		const sendMock = await install_inventory_response(page_response());
		sendMock.mockRejectedValue(new Error("private endpoint and credentials"));
		const logSpy = vi.spyOn(console, "log");
		const warnSpy = vi.spyOn(console, "warn");
		const errorSpy = vi.spyOn(console, "error");
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
		});
		expect(result).toEqual({ _nay: { message: "Could not list deleted workspace R2 objects" } });
		expect(logSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});

	test("parses real SDK XML in Node through a stubbed transport", async () => {
		const { r2 } = await import("./r2_client.ts");
		// setup-env blocks S3 send. Restore the SDK method on this client only; transport stays fake.
		const sdkClient = Object.getPrototypeOf(S3Client.prototype) as Pick<S3Client, "send">;
		vi.spyOn(r2.client, "send").mockImplementation(sdkClient.send);
		const handleMock = vi.spyOn(r2.client.config.requestHandler, "handle").mockResolvedValue({
			response: {
				statusCode: 200,
				headers: { "content-type": "application/xml" },
				body: new TextEncoder().encode(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Name>${bucket}</Name><Prefix>${prefix}</Prefix><MaxKeys>500</MaxKeys><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated>
<Contents><Key>${prefix}assets/asset-one</Key><Size>12</Size></Contents></ListBucketResult>`),
			},
		});
		const result = await t.action(internal.r2_inventory.list_deleted_workspace_objects, {
			organizationId,
			workspaceId,
		});
		expect(result._yay).toMatchObject({
			page: [
				{
					keyHash: createHash("sha256").update(`${prefix}assets/asset-one`).digest("hex"),
					size: 12,
					assetId: "asset-one",
				},
			],
			isDone: true,
		});
		expect(handleMock).toHaveBeenCalledTimes(1);
	});
});

describe("list_live_default_workspace_objects", () => {
	const accountId = "a".repeat(32);
	const bucket = "bonobo-senate-press-files";
	let t: ReturnType<typeof test_convex>;
	let ownerUserId: Id<"users">;
	let organizationId: Id<"organizations">;
	let workspaceId: Id<"organizations_workspaces">;
	let prefix: string;

	beforeEach(async () => {
		vi.stubEnv("CONVEX_CLOUD_URL", "https://grand-finch-267.convex.cloud");
		vi.stubEnv("CONVEX_SITE_URL", "https://grand-finch-267.convex.site");
		vi.stubEnv("R2_BUCKET_FILES", bucket);
		vi.stubEnv("R2_ENDPOINT", `https://${accountId}.r2.cloudflarestorage.com`);
		vi.resetModules();
		t = test_convex();
		const fixture = await t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
		);
		ownerUserId = fixture.userId;
		organizationId = fixture.organizationId;
		workspaceId = fixture.workspaceId;
		await t.run((ctx) => ctx.db.patch("users", ownerUserId, { clerkUserId: "clerk-inventory-owner" }));
		prefix = `organizations/${organizationId}/workspaces/${workspaceId}/`;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	async function install_inventory_response(contents: Array<{ Key: string; Size: number }> = []) {
		const { r2 } = await import("./r2_client.ts");
		const sendMock = vi.fn().mockResolvedValue({
			Name: bucket,
			Prefix: prefix,
			MaxKeys: 500,
			KeyCount: contents.length,
			IsTruncated: false,
			Contents: contents,
		});
		vi.spyOn(r2.client, "send").mockImplementation(sendMock);
		return sendMock;
	}

	test("reads only the checked live default prefix and preserves noncanonical objects", async () => {
		const contents = [
			{ Key: `${prefix}assets/asset-one`, Size: 12 },
			{ Key: `${prefix}other/private-name.txt`, Size: 4 },
		];
		const sendMock = await install_inventory_response(contents);
		const result = await t.action(internal.r2_inventory.list_live_default_workspace_objects, {
			ownerUserId,
			organizationId,
			workspaceId,
		});
		expect(result).toEqual({
			_yay: {
				cloudUrl: "https://grand-finch-267.convex.cloud",
				siteUrl: "https://grand-finch-267.convex.site",
				accountId,
				bucket,
				prefix,
				organizationExists: true,
				page: contents.map((object, index) => ({
					keyHash: createHash("sha256").update(object.Key).digest("hex"),
					size: object.Size,
					assetId: index === 0 ? "asset-one" : null,
				})),
				continueCursor: null,
				isDone: true,
			},
		});
		expect(sendMock.mock.calls[0][0].input).toEqual({ Bucket: bucket, Prefix: prefix, MaxKeys: 500 });
		expect(JSON.stringify(result)).not.toContain("private-name.txt");
	});

	test("accepts an empty final page for the exact live Clerk default", async () => {
		await install_inventory_response();
		const result = await t.action(internal.r2_inventory.list_live_default_workspace_objects, {
			ownerUserId,
			organizationId,
			workspaceId,
		});
		expect(result._yay).toMatchObject({ page: [], continueCursor: null, isDone: true });
	});

	test.each([
		"anonymous owner",
		"deleted owner",
		"finalizing owner",
		"missing owner",
		"missing organization",
		"missing workspace",
		"user default organization",
		"user default workspace",
		"organization owner",
		"organization default flag",
		"organization default workspace",
		"workspace parent",
		"workspace default flag",
	])("refuses a mismatched %s before sending to R2", async (mismatch) => {
		await t.run(async (ctx) => {
			switch (mismatch) {
				case "anonymous owner":
					await ctx.db.patch("users", ownerUserId, { clerkUserId: null });
					break;
				case "deleted owner":
					await ctx.db.patch("users", ownerUserId, { deletedAt: Date.now() });
					break;
				case "finalizing owner":
					await ctx.db.patch("users", ownerUserId, { deletionFinalizationStartedAt: Date.now() });
					break;
				case "missing owner":
					await ctx.db.delete("users", ownerUserId);
					break;
				case "missing organization":
					await ctx.db.delete("organizations", organizationId);
					break;
				case "missing workspace":
					await ctx.db.delete("organizations_workspaces", workspaceId);
					break;
				case "user default organization":
					await ctx.db.patch("users", ownerUserId, { defaultOrganizationId: undefined });
					break;
				case "user default workspace":
					await ctx.db.patch("users", ownerUserId, { defaultWorkspaceId: undefined });
					break;
				case "organization owner": {
					const otherUserId = await ctx.db.insert("users", { clerkUserId: "clerk-other-owner" });
					await ctx.db.patch("organizations", organizationId, { ownerUserId: otherUserId });
					break;
				}
				case "organization default flag":
					await ctx.db.patch("organizations", organizationId, { default: false });
					break;
				case "organization default workspace":
					await ctx.db.patch("organizations", organizationId, { defaultWorkspaceId: undefined });
					break;
				case "workspace parent": {
					const other = await test_mocks_fill_db_with.membership(ctx, { organizationName: "other-organization" });
					await ctx.db.patch("organizations_workspaces", workspaceId, { organizationId: other.organizationId });
					break;
				}
				case "workspace default flag":
					await ctx.db.patch("organizations_workspaces", workspaceId, { default: false });
					break;
			}
		});
		const sendMock = await install_inventory_response();
		const result = await t.action(internal.r2_inventory.list_live_default_workspace_objects, {
			ownerUserId,
			organizationId,
			workspaceId,
		});
		expect(result).toEqual({ _nay: { message: "R2 inventory requires this Clerk owner's live default workspace" } });
		expect(sendMock).not.toHaveBeenCalled();
	});

	test("refuses another expected owner before sending to R2", async () => {
		const otherUserId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "clerk-other-owner" }));
		const sendMock = await install_inventory_response();
		const result = await t.action(internal.r2_inventory.list_live_default_workspace_objects, {
			ownerUserId: otherUserId,
			organizationId,
			workspaceId,
		});
		expect(result).toEqual({ _nay: { message: "R2 inventory requires this Clerk owner's live default workspace" } });
		expect(sendMock).not.toHaveBeenCalled();
	});

	test("rechecks the live owner before a continued page", async () => {
		const sendMock = await install_inventory_response();
		sendMock.mockResolvedValueOnce({
			Name: bucket,
			Prefix: prefix,
			MaxKeys: 500,
			KeyCount: 0,
			Contents: [],
			IsTruncated: true,
			NextContinuationToken: "cursor-2",
		});
		const first = await t.action(internal.r2_inventory.list_live_default_workspace_objects, {
			ownerUserId,
			organizationId,
			workspaceId,
		});
		expect(first._yay).toMatchObject({ isDone: false, continueCursor: "cursor-2" });
		await t.run((ctx) => ctx.db.patch("users", ownerUserId, { clerkUserId: null }));
		const next = await t.action(internal.r2_inventory.list_live_default_workspace_objects, {
			ownerUserId,
			organizationId,
			workspaceId,
			cursor: "cursor-2",
		});
		expect(next).toEqual({ _nay: { message: "R2 inventory requires this Clerk owner's live default workspace" } });
		expect(sendMock).toHaveBeenCalledTimes(1);
	});

	test("keeps target and cursor checks on the live door", async () => {
		vi.stubEnv("CONVEX_SITE_URL", "https://other-deployment.convex.site");
		const sendMock = await install_inventory_response();
		const target = await t.action(internal.r2_inventory.list_live_default_workspace_objects, {
			ownerUserId,
			organizationId,
			workspaceId,
		});
		expect(target._nay?.message).toBe("R2 inventory target is not the allowed dev target");
		const cursor = await t.action(internal.r2_inventory.list_live_default_workspace_objects, {
			ownerUserId,
			organizationId,
			workspaceId,
			cursor: "",
		});
		expect(cursor._nay?.message).toBe("Invalid R2 inventory cursor");
		expect(sendMock).not.toHaveBeenCalled();
	});
});
