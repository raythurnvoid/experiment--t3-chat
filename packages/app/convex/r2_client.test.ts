import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { r2 } from "./r2_client.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "review-upload") => ({
		key,
		url: `https://r2.test/upload/${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key) => `https://r2.test/${encodeURIComponent(key)}`);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("review-work" as never);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("Unexpected review test request");
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function create_upload(t: ReturnType<typeof test_convex>) {
	const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId, name: "Test User" });
	const created = await asUser.mutation(api.files_nodes.create_upload_node, {
		membershipId: db.membershipId,
		parentId: files_ROOT_ID,
		filename: "review.png",
		contentType: "image/png",
		size: 1024,
	});
	if (created._nay) throw new Error(created._nay.message);
	const asset = await t.run(async (ctx) => ctx.db.get("files_r2_assets", created._yay.assetId));
	if (!asset) throw new Error("Expected an upload asset");
	return { ...created._yay, asset };
}

async function post_event(
	t: ReturnType<typeof test_convex>,
	upload: Awaited<ReturnType<typeof create_upload>>,
	args: { id: string; size: number; etag: string },
) {
	return await t.fetch("/api/r2/event", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			cloudflareMessageId: args.id,
			attempts: 1,
			event: {
				action: "PutObject",
				bucket: upload.asset.r2Bucket,
				object: {
					key: `organizations/${upload.asset.organizationId}/workspaces/${upload.asset.workspaceId}/assets/${upload.assetId}`,
					size: args.size,
					eTag: args.etag,
				},
				eventTime: new Date().toISOString(),
			},
		}),
	});
}

describe("direct upload publication", () => {
	test("signs the create-only condition and the recorded URL lifetime", async () => {
		vi.spyOn(R2.prototype, "generateUploadUrl").mockRestore();
		const upload = await r2.generateUploadUrl("signer-test", { createOnly: true, expiresIn: 900 });
		const query = new URL(upload.url).searchParams;
		expect(query.get("X-Amz-SignedHeaders")?.split(";")).toContain("if-none-match");
		expect(query.get("X-Amz-Expires")).toBe("900");
		const internalUpload = await r2.generateUploadUrl("internal-write");
		expect(new URL(internalUpload.url).searchParams.get("X-Amz-SignedHeaders")?.split(";")).not.toContain(
			"if-none-match",
		);
	});

	test("overlapping events cannot change the object written by one signed attempt", async () => {
		const t = test_convex();
		const upload = await create_upload(t);
		let object: { body: string; etag: string } | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.method === "PUT") {
					expect(input).toBe(upload.url);
					if (object && new Headers(init.headers).get("If-None-Match") === "*") {
						return new Response(null, { status: 412 });
					}
					object = { body: String(init.body), etag: "first-etag" };
					return new Response(null);
				}
				return object
					? new Response(object.body, { headers: { "Content-Length": String(object.body.length), ETag: object.etag } })
					: new Response(null, { status: 404 });
			}),
		);
		expect((await fetch(upload.url, { method: "PUT", headers: upload.headers, body: "first" })).status).toBe(200);
		expect(
			(await fetch(upload.url, { method: "PUT", headers: upload.headers, body: "second-bytes" })).status,
		).toBe(412);
		const results = await Promise.all([
			post_event(t, upload, { id: "first", size: 5, etag: "first-etag" }),
			post_event(t, upload, { id: "duplicate", size: 5, etag: "first-etag" }),
		]);
		expect(results.map((response) => response.status)).toEqual([204, 204]);
		const saved = await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId));
		expect({ size: saved?.size, etag: saved?.etag }).toEqual({ size: object?.body.length, etag: object?.etag });
	});

	test("stores a bare etag from the current weak response header", async () => {
		const t = test_convex();
		const upload = await create_upload(t);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("first", {
						headers: { "Content-Length": "5", ETag: 'W/"same-etag"' },
					}),
			),
		);
		expect((await post_event(t, upload, { id: "weak", size: 12, etag: "stale-event" })).status).toBe(204);
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId))).toMatchObject({
			size: 5,
			etag: "same-etag",
		});
	});
	test("an existing empty object with Content-Length zero needs no range request", async () => {
		const t = test_convex();
		const upload = await create_upload(t);
		const fetchSpy = vi.fn(async () => new Response(null, { headers: { "Content-Length": "0", ETag: '"empty"' } }));
		vi.stubGlobal("fetch", fetchSpy);
		expect((await post_event(t, upload, { id: "review-empty", size: 0, etag: "empty" })).status).toBe(204);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId))).toMatchObject({ size: 0 });
	});

	test("a range 416 becomes an HTTP retry before Content-Range is parsed", async () => {
		const t = test_convex();
		const upload = await create_upload(t);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				return new Headers(init?.headers).has("Range")
					? new Response(null, { status: 416, headers: { "Content-Range": "bytes */0" } })
					: new Response(null, { headers: { ETag: '"empty"' } });
			}),
		);
		expect((await post_event(t, upload, { id: "review-range", size: 0, etag: "empty" })).status).toBe(500);
		expect((await t.run(async (ctx) => ctx.db.get("files_r2_assets", upload.assetId)))?.r2Key).toBeUndefined();
	});
});
