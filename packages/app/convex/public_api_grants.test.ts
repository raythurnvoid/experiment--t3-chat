import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID, files_u8_to_array_buffer, files_yjs_create_empty_state_update } from "../server/files.ts";

const textEncoder = new TextEncoder();

async function sha256_hex(input: string) {
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function seed_public_api_grant(args: {
	t: ReturnType<typeof test_convex>;
	workspaceId: Id<"workspaces">;
	projectId: Id<"workspaces_projects">;
	userId: Id<"users">;
	token: string;
	scopes?: Array<"files:list" | "files:read">;
	pathPrefix?: string | null;
	now?: number;
}) {
	await args.t.mutation(internal.public_api.create_grant, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		userId: args.userId,
		threadId: null,
		principalKey: "grant_test",
		tokenHash: await sha256_hex(args.token),
		scopes: args.scopes ?? ["files:list", "files:read"],
		pathPrefix: args.pathPrefix ?? null,
		now: args.now ?? Date.now(),
	});
}

async function seed_markdown_file(args: {
	t: ReturnType<typeof test_convex>;
	workspaceId: Id<"workspaces">;
	projectId: Id<"workspaces_projects">;
	userId: Id<"users">;
	path: string;
	markdown: string;
}) {
	const nodeId = await args.t.run(async (ctx) => {
		const now = Date.now();
		const name = args.path.split("/").at(-1);
		if (!name) {
			throw new Error("Expected a file path");
		}
		const parentPath = args.path.slice(0, args.path.lastIndexOf("/")) || "/";
		let parentId: Id<"files_nodes"> | typeof files_ROOT_ID = files_ROOT_ID;
		if (parentPath !== "/") {
			const existingParent = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId)
						.eq("path", parentPath)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (existingParent) {
				parentId = existingParent._id;
			} else {
				const parentName = parentPath.split("/").at(-1);
				if (!parentName) {
					throw new Error("Expected a parent folder path");
				}
				parentId = await ctx.db.insert("files_nodes", {
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					path: parentPath,
					treePath: `${parentPath}/`,
					pathDepth: parentPath.split("/").filter(Boolean).length,
					lowercaseExtension: null,
					name: parentName,
					kind: "folder",
					parentId: files_ROOT_ID,
					createdBy: args.userId,
					updatedBy: args.userId,
					updatedAt: now,
				});
			}
		}

		const markdownAssetId = await ctx.db.insert("files_r2_assets", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			kind: "content",
			r2Bucket: "test-bucket",
			size: 0,
			createdBy: args.userId,
			updatedAt: now,
		});
		const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			kind: "yjs_snapshot",
			r2Bucket: "test-bucket",
			size: 0,
			createdBy: args.userId,
			updatedAt: now,
		});
		const fileNodeId = await ctx.db.insert("files_nodes", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
			treePath: args.path,
			pathDepth: args.path.split("/").filter(Boolean).length,
			lowercaseExtension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : null,
			name,
			kind: "file",
			contentType: "text/markdown;charset=utf-8",
			assetId: markdownAssetId,
			parentId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
		});
		const yjsSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			fileNodeId,
			sequence: 0,
			assetId: yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
		});
		const yjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			fileNodeId,
			lastSequence: 0,
		});
		await ctx.db.patch("files_nodes", fileNodeId, {
			yjsSnapshotId,
			yjsLastSequenceId,
		});
		return fileNodeId;
	});

	const baseYjsUpdate = files_u8_to_array_buffer(files_yjs_create_empty_state_update());
	const pending = await args.t.mutation(internal.files_pending_updates.upsert_file_pending_update_in_db, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		userId: args.userId,
		nodeId,
		baseYjsSequence: 0,
		baseYjsUpdate,
		unstagedMarkdown: args.markdown,
	});
	if (pending._nay) {
		throw new Error(pending._nay.message);
	}

	return nodeId;
}

function grant_headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

describe("public API grants", () => {
	test("cleans expired grants in bounded batches", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const expiredToken = "6".repeat(64);
		const validToken = "7".repeat(64);

		await seed_public_api_grant({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			token: validToken,
			now,
		});
		await seed_public_api_grant({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			token: expiredToken,
			now: now - 20 * 60 * 1000,
		});

		const result = await t.mutation(internal.public_api.cleanup_expired_grants, {
			_test_now: now,
			batchSize: 10,
		});
		expect(result).toEqual({
			deletedCount: 1,
			done: true,
		});

		const grants = await t.run(async (ctx) => ctx.db.query("public_api_grants").collect());
		expect(grants).toHaveLength(1);
		expect(grants[0]?.tokenHash).toBe(await sha256_hex(validToken));
	});

	test("drains expired grant backlogs through scheduled continuation", async () => {
		vi.useFakeTimers();
		try {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const now = Date.now();
			vi.setSystemTime(now);
			await t.run(async (ctx) => {
				await Promise.all([
					...Array.from({ length: 3 }, (_, index) =>
						ctx.db.insert("public_api_grants", {
							workspaceId: db.workspaceId,
							projectId: db.projectId,
							userId: db.userId,
							threadId: null,
							principalKey: `expired_${index}`,
							tokenHash: `expired_hash_${index}`,
							scopes: ["files:list"],
							pathPrefix: null,
							createdAt: now - 20 * 60 * 1000,
							expiresAt: now - 10 * 60 * 1000,
						}),
					),
					ctx.db.insert("public_api_grants", {
						workspaceId: db.workspaceId,
						projectId: db.projectId,
						userId: db.userId,
						threadId: null,
						principalKey: "expires_after_test_now",
						tokenHash: "expires_after_test_now_hash",
						scopes: ["files:list"],
						pathPrefix: null,
						createdAt: now,
						expiresAt: now + 500,
					}),
					ctx.db.insert("public_api_grants", {
						workspaceId: db.workspaceId,
						projectId: db.projectId,
						userId: db.userId,
						threadId: null,
						principalKey: "valid",
						tokenHash: "valid_hash",
						scopes: ["files:list"],
						pathPrefix: null,
						createdAt: now,
						expiresAt: now + 10 * 60 * 1000,
					}),
				]);
			});

			const firstBatch = await t.mutation(internal.public_api.cleanup_expired_grants_until_done, {
				_test_now: now,
				batchSize: 2,
			});
			expect(firstBatch).toEqual({
				deletedCount: 2,
				done: false,
			});

			vi.advanceTimersByTime(1000);
			await t.finishInProgressScheduledFunctions();

			const grants = await t.run(async (ctx) => ctx.db.query("public_api_grants").collect());
			expect(grants.map((grant) => grant.tokenHash).sort()).toEqual(["expires_after_test_now_hash", "valid_hash"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("rejects missing or expired grants", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const token = "0".repeat(64);
		await seed_public_api_grant({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			token,
			now: Date.now() - 20 * 60 * 1000,
		});

		const missing = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "/" }),
		});
		expect(missing.status).toBe(401);

		const expired = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/" }),
		});
		expect(expired.status).toBe(401);
	});

	test("lists and reads scoped files with pending content", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const token = "1".repeat(64);
		await seed_markdown_file({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/payments/payment-001.md",
			markdown: "---\namount: 12.50\n---\nPayment one\n",
		});
		await seed_markdown_file({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/payments/payment-002.md",
			markdown: "---\namount: 7.25\n---\nPayment two\n",
		});
		await seed_public_api_grant({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			token,
		});

		const listResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments", recursive: true, kind: "file", extension: "md", limit: 1000 }),
		});
		expect(listResponse.status).toBe(200);
		const listBody = (await listResponse.json()) as {
			items: Array<{ path: string; kind: string }>;
			isDone: boolean;
		};
		expect(listBody.items.map((item) => item.path).sort()).toEqual([
			"/payments/payment-001.md",
			"/payments/payment-002.md",
		]);
		expect(listBody.items.every((item) => item.kind === "file")).toBe(true);

		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments/payment-001.md", maxBytes: 1024 * 1024 }),
		});
		expect(readResponse.status).toBe(200);
		const readBody = (await readResponse.json()) as { path: string; content: string };
		expect(readBody.path).toBe("/payments/payment-001.md");
		expect(readBody.content).toContain("amount: 12.50");

		const readManyResponse = await t.fetch("/api/v1/files/read-many", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({
				paths: ["/payments/payment-001.md", "/payments/payment-002.md"],
				maxBytes: 1024 * 1024,
			}),
		});
		expect(readManyResponse.status).toBe(200);
		const readManyBody = (await readManyResponse.json()) as {
			files: Array<{ path: string; content: string }>;
			errors: Array<{ path: string; message: string }>;
			truncated: boolean;
		};
		expect(readManyBody.files.map((file) => file.path).sort()).toEqual([
			"/payments/payment-001.md",
			"/payments/payment-002.md",
		]);
		expect(readManyBody.files.map((file) => file.content).join("\n")).toContain("amount: 7.25");
		expect(readManyBody.errors).toEqual([]);
		expect(readManyBody.truncated).toBe(false);
	});

	test("enforces grant path prefix before listing or reading files", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const token = "2".repeat(64);
		await seed_markdown_file({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/payments/payment-001.md",
			markdown: "Payment one\n",
		});
		await seed_markdown_file({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			path: "/payments-archive/payment-001.md",
			markdown: "Archived payment\n",
		});
		await seed_public_api_grant({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			token,
			pathPrefix: "/payments",
		});

		const allowed = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments/payment-001.md" }),
		});
		expect(allowed.status).toBe(200);

		const sibling = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/payments-archive/payment-001.md" }),
		});
		expect(sibling.status).toBe(403);

		const rootList = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: grant_headers(token),
			body: JSON.stringify({ path: "/" }),
		});
		expect(rootList.status).toBe(403);
	});

	test("enforces grant file scopes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const listOnlyToken = "4".repeat(64);
		const readOnlyToken = "5".repeat(64);
		await seed_public_api_grant({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			token: listOnlyToken,
			scopes: ["files:list"],
		});
		await seed_public_api_grant({
			t,
			workspaceId: db.workspaceId,
			projectId: db.projectId,
			userId: db.userId,
			token: readOnlyToken,
			scopes: ["files:read"],
		});

		const listWithReadOnly = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: grant_headers(readOnlyToken),
			body: JSON.stringify({ path: "/" }),
		});
		expect(listWithReadOnly.status).toBe(403);

		const readWithListOnly = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: grant_headers(listOnlyToken),
			body: JSON.stringify({ path: "/payments/payment-001.md" }),
		});
		expect(readWithListOnly.status).toBe(403);

		const readManyWithListOnly = await t.fetch("/api/v1/files/read-many", {
			method: "POST",
			headers: grant_headers(listOnlyToken),
			body: JSON.stringify({ paths: ["/payments/payment-001.md"] }),
		});
		expect(readManyWithListOnly.status).toBe(403);
	});
});

