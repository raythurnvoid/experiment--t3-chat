import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, test as baseTest, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";

const test = baseTest.sequential;

describe("list_bucket_objects_for_cutover", () => {
	const accountId = "a".repeat(32);
	const bucket = "bonobo-senate-press-files";
	const prefix = "organizations/GLOBAL/workspaces/GITHUB/";
	const pageResponse = {
		Name: bucket,
		Prefix: prefix,
		MaxKeys: 500,
		KeyCount: 1,
		IsTruncated: false,
		Contents: [{ Key: `${prefix}assets/test-asset`, Size: 12 }],
	};

	beforeEach(() => {
		vi.stubEnv("CONVEX_CLOUD_URL", "https://grand-finch-267.convex.cloud");
		vi.stubEnv("CONVEX_SITE_URL", "https://grand-finch-267.convex.site");
		vi.stubEnv("R2_BUCKET_FILES", bucket);
		vi.stubEnv("R2_ENDPOINT", `https://${accountId}.r2.cloudflarestorage.com`);
		// Config is read at module load. Reset before loading the registered action and its R2 client.
		vi.resetModules();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	async function install_inventory_response(response: unknown) {
		const { r2 } = await import("./r2_client.ts");
		const sendMock = vi.fn().mockResolvedValue(response);
		vi.spyOn(r2.client, "send").mockImplementation(sendMock);
		return sendMock;
	}

	test("returns only safe target fields, keys and sizes from one bounded page", async () => {
		const sendMock = await install_inventory_response({
			...pageResponse,
			Contents: [{ ...pageResponse.Contents[0], ETag: "unused" }],
			$metadata: { requestId: "unused" },
		});
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
		const t = test_convex();
		const result = await t.action(internal.github_mounts_inventory.list_bucket_objects_for_cutover, {});

		expect(result).toEqual({
			_yay: {
				cloudUrl: "https://grand-finch-267.convex.cloud",
				siteUrl: "https://grand-finch-267.convex.site",
				accountId,
				bucket,
				prefix,
				page: [{ key: `${prefix}assets/test-asset`, size: 12 }],
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
	});

	test("accepts an empty final page without Contents", async () => {
		await install_inventory_response({ ...pageResponse, KeyCount: 0, Contents: undefined });
		const t = test_convex();
		const result = await t.action(internal.github_mounts_inventory.list_bucket_objects_for_cutover, {});
		expect(result._yay).toMatchObject({ page: [], continueCursor: null, isDone: true });
	});

	test.each([[pageResponse.Contents], [[]]])("keeps a short continued page open (%j)", async (contents) => {
		const sendMock = await install_inventory_response({
			...pageResponse,
			Contents: contents,
			KeyCount: contents.length,
			IsTruncated: true,
			NextContinuationToken: "cursor-2",
		});
		const t = test_convex();
		const result = await t.action(internal.github_mounts_inventory.list_bucket_objects_for_cutover, { cursor: "cursor-1" });
		expect(result._yay).toMatchObject({ continueCursor: "cursor-2", isDone: false });
		expect(sendMock).toHaveBeenCalledTimes(1);
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
		["R2_ENDPOINT", `https://${accountId}.r2.cloudflarestorage.com?secret=private`],
	])("refuses a wrong %s before sending to R2", async (name, value) => {
		vi.stubEnv(name, value);
		const sendMock = await install_inventory_response(pageResponse);
		const t = test_convex();
		const result = await t.action(internal.github_mounts_inventory.list_bucket_objects_for_cutover, {});
		expect(result._nay?.message).toBe("R2 inventory target is not the allowed dev target");
		expect(sendMock).not.toHaveBeenCalled();
	});

	test.each(["", "c".repeat(8193)])("refuses an empty or oversized cursor before sending to R2", async (cursor) => {
		const sendMock = await install_inventory_response(pageResponse);
		const t = test_convex();
		const result = await t.action(internal.github_mounts_inventory.list_bucket_objects_for_cutover, { cursor });
		expect(result._nay?.message).toBe("Invalid R2 inventory cursor");
		expect(sendMock).not.toHaveBeenCalled();
	});

	test.each([
		["missing page state", { ...pageResponse, IsTruncated: undefined }],
		["wrong page state type", { ...pageResponse, IsTruncated: "false" }],
		["wrong bucket", { ...pageResponse, Name: "other-bucket" }],
		["wrong prefix", { ...pageResponse, Prefix: "organizations/other/" }],
		["wrong page limit", { ...pageResponse, MaxKeys: 501 }],
		["wrong key count", { ...pageResponse, KeyCount: 0 }],
		["missing key", { ...pageResponse, Contents: [{ Size: 12 }] }],
		["outside-prefix key", { ...pageResponse, Contents: [{ Key: "organizations/other/file", Size: 12 }] }],
		["negative size", { ...pageResponse, Contents: [{ Key: `${prefix}asset`, Size: -1 }] }],
		["wrong size type", { ...pageResponse, Contents: [{ Key: `${prefix}asset`, Size: "12" }] }],
		["unsafe size", { ...pageResponse, Contents: [{ Key: `${prefix}asset`, Size: Number.MAX_SAFE_INTEGER + 1 }] }],
		["oversized key", { ...pageResponse, Contents: [{ Key: `${prefix}${"😀".repeat(300)}`, Size: 12 }] }],
		["missing cursor", { ...pageResponse, IsTruncated: true }],
		["empty cursor", { ...pageResponse, IsTruncated: true, NextContinuationToken: "" }],
		["repeated cursor", { ...pageResponse, IsTruncated: true, NextContinuationToken: "cursor-1" }],
		[
			"oversized page",
			{ ...pageResponse, KeyCount: 501, Contents: Array.from({ length: 501 }, () => pageResponse.Contents[0]) },
		],
	])("refuses an invalid page with %s", async (_name, response) => {
		await install_inventory_response(response);
		const t = test_convex();
		const result = await t.action(internal.github_mounts_inventory.list_bucket_objects_for_cutover, { cursor: "cursor-1" });
		expect(result._nay?.message).toBe("Invalid R2 inventory page");
		expect(result._yay).toBeUndefined();
	});

	test("returns a generic failure without logging or returning the raw error", async () => {
		const sendMock = await install_inventory_response(pageResponse);
		sendMock.mockRejectedValue(new Error("private endpoint and credentials"));
		const logSpy = vi.spyOn(console, "log");
		const warnSpy = vi.spyOn(console, "warn");
		const errorSpy = vi.spyOn(console, "error");
		const t = test_convex();
		const result = await t.action(internal.github_mounts_inventory.list_bucket_objects_for_cutover, {});
		expect(result).toEqual({ _nay: { message: "Could not list legacy R2 objects" } });
		expect(logSpy).not.toHaveBeenCalled();
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
