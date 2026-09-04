import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { getFunctionName } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID, files_u8_to_array_buffer } from "../server/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import {
	r2_create_asset_key,
	r2_create_upload_staging_key,
	r2_confirmed_object_delete,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_server_side_copy,
} from "./r2_client.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { crypto_random_hex, crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import {
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_ORGANIZATION_ID,
} from "../shared/organizations.ts";
import type { api_schemas_Main } from "../shared/api-schemas.ts";
import type { plugins_Capability } from "../shared/plugins.ts";
import { quotas_db_ensure, quotas_db_get } from "./quotas.ts";
import { rate_limiter_check_by_key, rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

const r2Objects = new Map<string, string | ArrayBuffer>();
const r2ObjectMetadata = new Map<string, { size: number; etag: string }>();

function install_r2_object_reads() {
	r2Objects.clear();
	r2ObjectMetadata.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		r2Objects.delete(key);
		r2ObjectMetadata.delete(key);
	});
	// Copy inside the in-memory R2 map instead of calling the component's real S3 client. Mirror the
	// real action: verify the source against the expected identity before copying.
	vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
		const body = r2Objects.get(args.sourceKey);
		const metadata = r2ObjectMetadata.get(args.sourceKey);
		if (body === undefined && metadata === undefined) {
			return { outcome: "source_missing" as const };
		}
		const size = metadata?.size ?? (typeof body === "string" ? body.length : (body?.byteLength ?? 0));
		const etag = metadata?.etag;
		if (
			(args.expectedSize !== undefined && size !== args.expectedSize) ||
			(args.expectedEtag !== undefined && (etag === undefined || etag !== args.expectedEtag))
		) {
			return { outcome: "source_changed" as const };
		}
		r2Objects.set(args.destinationKey, body ?? "");
		if (metadata !== undefined) {
			r2ObjectMetadata.set(args.destinationKey, metadata);
		}
		return { outcome: "copied" as const, size, etag };
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Objects.set(
					key,
					init.body instanceof ArrayBuffer || typeof init.body === "string"
						? init.body
						: init.body
							? await new Response(init.body).arrayBuffer()
							: "",
				);
				return new Response(null, { status: 200 });
			}
			if (!urlString.startsWith("https://r2.test/object?key=")) {
				return new Response(null, { status: 404 });
			}

			const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
			const body = r2Objects.get(key);
			const metadata = r2ObjectMetadata.get(key);
			return body === undefined
				? new Response(null, { status: 404 })
				: new Response(body, {
						status: 200,
						headers:
							metadata === undefined
								? undefined
								: { "Content-Length": String(metadata.size), ETag: metadata.etag },
					});
		}),
	);
}

function defer_download_url() {
	let markStarted: (() => void) | null = null;
	let release: (() => void) | null = null;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const signerExpiresIn: number[] = [];
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(async (key: string, options?: { expiresIn?: number }) => {
		signerExpiresIn.push(options?.expiresIn ?? 900);
		markStarted?.();
		await gate;
		return `https://r2.test/object?key=${encodeURIComponent(key)}`;
	});
	return { started, release: () => release?.(), signerExpiresIn };
}

function auth_headers(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
	};
}

async function seed_signed_in_membership(args: { t: ReturnType<typeof test_convex>; clerkUserId: string }) {
	return await args.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", {
			clerkUserId: args.clerkUserId,
		});
		return await test_mocks_fill_db_with.membership(ctx, { userId });
	});
}

async function seed_public_file_write_stage(args: {
	t: ReturnType<typeof test_convex>;
	db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
	path: string;
	expiresAt: number;
}) {
	return await args.t.run(async (ctx) => {
		const now = Date.now();
		const insert_asset = async (kind: "yjs_snapshot" | "content_snapshot") =>
			await ctx.db.insert("files_r2_assets", {
				organizationId: args.db.organizationId,
				workspaceId: args.db.workspaceId,
				kind,
				r2Bucket: "test-bucket",
				size: 1,
				createdBy: args.db.userId,
				unfinalizedExpiresAt: args.expiresAt,
				updatedAt: now,
			});
		const yjsSnapshotAssetId = await insert_asset("yjs_snapshot");
		const contentSnapshotAssetId = await insert_asset("content_snapshot");
		const stageId = await ctx.db.insert("public_api_file_write_stages", {
			organizationId: args.db.organizationId,
			workspaceId: args.db.workspaceId,
			userId: args.db.userId,
			path: args.path,
			overwrite: "replace",
			yjsSnapshotAssetId,
			contentSnapshotAssetId,
			expiresAt: args.expiresAt,
			updatedAt: now,
		});
		const keys = [yjsSnapshotAssetId, contentSnapshotAssetId].map((assetId) =>
			r2_create_asset_key({
				organizationId: args.db.organizationId,
				workspaceId: args.db.workspaceId,
				assetId,
			}),
		);
		return { stageId, yjsSnapshotAssetId, contentSnapshotAssetId, keys };
	});
}

async function seed_public_api_grant(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	token: string;
}) {
	await args.t.mutation(internal.public_api.create_grant, {
		organizationId: args.organizationId,
		workspaceId: args.workspaceId,
		userId: args.userId,
		threadId: null,
		principalKey: "grant_public_test",
		tokenHash: await crypto_sha256_hex(args.token),
		scopes: ["files:list", "files:read"],
		pathPrefix: null,
		now: Date.now(),
	});
}

async function seed_markdown_file(args: {
	t: ReturnType<typeof test_convex>;
	organizationId: Id<"organizations">;
	workspaceId: Id<"organizations_workspaces">;
	userId: Id<"users">;
	path: string;
	committedMarkdown: string;
	pendingMarkdown?: string;
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
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.organizationId)
						.eq("workspaceId", args.workspaceId)
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
					organizationId: args.organizationId,
					workspaceId: args.workspaceId,
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

		const baseYjsDoc = new YDoc();
		// A `.md` fixture builds a rich text document by definition.
		const baseYjsDocFromMarkdown = files_yjs_doc_update_from_text({
			mut_yjsDoc: baseYjsDoc,
			text: args.committedMarkdown,
			rootKind: "rich_text",
		});
		if (baseYjsDocFromMarkdown._nay) {
			throw new Error(baseYjsDocFromMarkdown._nay.message);
		}
		const baseMarkdownResult = files_yjs_doc_get_text({
			yjsDoc: baseYjsDoc,
			rootKind: "rich_text",
		});
		if (baseMarkdownResult._nay) {
			throw new Error(baseMarkdownResult._nay.message);
		}

		const markdownAssetId = await ctx.db.insert("files_r2_assets", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "content",
			r2Bucket: "test-bucket",
			size: files_get_utf8_byte_size(baseMarkdownResult._yay),
			createdBy: args.userId,
			updatedAt: now,
		});
		const markdownAssetKey = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: markdownAssetId,
		});
		await ctx.db.patch("files_r2_assets", markdownAssetId, {
			r2Key: markdownAssetKey,
		});
		r2Objects.set(markdownAssetKey, baseMarkdownResult._yay);

		const yjsSnapshotUpdate = files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc));
		baseYjsDoc.destroy();
		const yjsSnapshotAssetId = await ctx.db.insert("files_r2_assets", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: "yjs_snapshot",
			r2Bucket: "test-bucket",
			size: yjsSnapshotUpdate.byteLength,
			createdBy: args.userId,
			updatedAt: now,
		});
		const yjsSnapshotAssetKey = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: yjsSnapshotAssetId,
		});
		await ctx.db.patch("files_r2_assets", yjsSnapshotAssetId, {
			r2Key: yjsSnapshotAssetKey,
		});
		r2Objects.set(yjsSnapshotAssetKey, yjsSnapshotUpdate);

		const fileNodeId = await ctx.db.insert("files_nodes", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			path: args.path,
			treePath: args.path,
			pathDepth: args.path.split("/").filter(Boolean).length,
			lowercaseExtension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : null,
			name,
			kind: "file",
			contentType: "text/markdown;charset=utf-8",
			assetId: markdownAssetId,
			yjsRootKind: "rich_text",
			parentId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
		});
		const yjsSnapshotId = await ctx.db.insert("files_yjs_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId,
			sequence: 0,
			assetId: yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: now,
		});
		const yjsLastSequenceId = await ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId,
			lastSequence: 0,
			unmaterializedUpdateCount: 0,
			unmaterializedUpdateBytes: 0,
			lineageGeneration: 0,
		});
		await ctx.db.patch("files_nodes", fileNodeId, {
			yjsSnapshotId,
			yjsLastSequenceId,
		});
		return fileNodeId;
	});

	if (args.pendingMarkdown != null) {
		// Mirror the agent flow: stage the text under a server-side batch, then run the finishing
		// action that carries only ids; the action reconstructs the base from the seeded snapshot.
		const batch = await args.t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				userId: args.userId,
				nodeId,
			},
		);
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const staged = await args.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: args.pendingMarkdown,
		});
		if (staged._nay) {
			throw new Error(staged._nay.message);
		}
		const pending = await args.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId,
			operationBatchId: batch._yay.operationBatchId,
		});
		if (pending._nay) {
			throw new Error(pending._nay.message);
		}
	}

	return nodeId;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("public files API", () => {
	test("returns only the public validation message for malformed request bodies", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-validation" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-validation",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Validation key",
			scopes: ["files:list", "files:read", "files:write", "files:download"],
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		for (const [path, body] of [
			["/api/v1/files/list", { limit: 0 }],
			["/api/v1/files/list", { scanLimit: 0 }],
			["/api/v1/files/list", { contentTypePrefixes: [] }],
			["/api/v1/files/read", { path: "/file.md", maxBytes: 0 }],
			["/api/v1/files/read-many", { paths: [] }],
			["/api/v1/files/write", { path: 42, content: "" }],
			["/api/v1/files/download-urls", { fileNodeIds: [] }],
		] as const) {
			const response = await t.fetch(path, {
				method: "POST",
				headers: auth_headers(created._yay.credential),
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ message: "Request body validation failed" });
		}

		const invalidJson = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(created._yay.credential),
			body: "{",
		});
		expect(invalidJson.status).toBe(400);
		expect(await invalidJson.json()).toEqual({ message: "Failed to parse request body as JSON" });

		type PublicValidationError =
			| api_schemas_Main["/api/v1/files/list"]["POST"]["response"][400]["body"]
			| api_schemas_Main["/api/v1/files/read"]["POST"]["response"][400]["body"]
			| api_schemas_Main["/api/v1/files/read-many"]["POST"]["response"][400]["body"]
			| api_schemas_Main["/api/v1/files/write"]["POST"]["response"][400]["body"]
			| api_schemas_Main["/api/v1/files/download-urls"]["POST"]["response"][400]["body"];
		expectTypeOf<PublicValidationError>().toMatchTypeOf<{ message: string }>();
	});

	test("creates an API credential, reads files, updates usage, and revokes access", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-files" });
		await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/payments/payment-001.md",
			committedMarkdown: "---\namount: 12.50\n---\nPayment one\n",
			pendingMarkdown: "---\namount: 999.00\n---\nPending private draft\n",
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-files",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Files reader",
			scopes: ["files:list", "files:read"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		const listResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/payments", recursive: true, kind: "file", extension: "md" }),
		});
		expect(listResponse.status).toBe(200);
		const listBody = (await listResponse.json()) as { items: Array<{ path: string }> };
		expect(listBody.items.map((item) => item.path)).toEqual(["/payments/payment-001.md"]);

		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/payments/payment-001.md" }),
		});
		expect(readResponse.status).toBe(200);
		const readBody = (await readResponse.json()) as { content: string; pendingUpdateId?: string | null };
		expect(readBody.content).toContain("amount: 12.50");
		expect(readBody).not.toHaveProperty("pendingUpdateId");

		const readManyResponse = await t.fetch("/api/v1/files/read-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ paths: ["/payments/payment-001.md"] }),
		});
		expect(readManyResponse.status).toBe(200);
		const readManyBody = (await readManyResponse.json()) as {
			files: Array<{ content: string; pendingUpdateId?: string | null }>;
			errors: Array<{ path: string; message: string }>;
		};
		expect(readManyBody.files[0]?.content).toContain("amount: 12.50");
		expect(readManyBody.files[0]?.content).not.toContain("amount: 999.00");
		expect(readManyBody.files[0]).not.toHaveProperty("pendingUpdateId");
		expect(readManyBody.errors).toEqual([]);

		const afterUse = await t.run(async (ctx) => {
			return await ctx.db.get("api_credentials", created._yay!.credentialId);
		});
		expect(afterUse?.lastUsedAt).toEqual(expect.any(Number));

		const listed = await asUser.query(api.public_api.api_credentials_list, {
			membershipId: db.membershipId,
		});
		expect(listed._nay).toBeUndefined();
		expect(listed._yay).toEqual([
			expect.objectContaining({
				credentialId: created._yay!.credentialId,
				name: "Files reader",
				keyId: created._yay!.keyId,
				obfuscatedValue: expect.stringContaining("****"),
				scopes: ["files:list", "files:read"],
			}),
		]);

		const revoked = await asUser.mutation(api.public_api.api_credential_revoke, {
			membershipId: db.membershipId,
			credentialId: created._yay!.credentialId,
		});
		expect(revoked._nay).toBeUndefined();
		const quotaAfterRevoke = await asUser.query(api.quotas.get, {
			quotaName: "active_api_credentials",
			membershipId: db.membershipId,
		});
		expect(quotaAfterRevoke?.usedCount).toBe(0);

		const afterRevoke = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/" }),
		});
		expect(afterRevoke.status).toBe(401);
	});

	test("writes Markdown files and issues download URLs with a user API key", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-write" });

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-write",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Files writer",
			scopes: ["files:list", "files:read", "files:write", "files:download"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		for (const body of [
			{ path: "notes/report.md", content: "# Report" },
			{ path: "/", content: "# Report" },
			{ path: "/notes/report.txt", content: "# Report" },
			{ path: "/notes/report.md", content: "" },
		]) {
			const response = await t.fetch("/api/v1/files/write", {
				method: "POST",
				headers: auth_headers(credential),
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/notes/report.md", content: "# Report\n\nWritten via the public API\n" }),
		});
		expect(written.status).toBe(200);
		const writtenBody = (await written.json()) as { path: string; nodeId: string; contentType: string };
		expect(writtenBody).toEqual({
			path: "/notes/report.md",
			nodeId: expect.any(String),
			contentType: "text/markdown;charset=utf-8",
		});

		const listResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/notes" }),
		});
		expect(listResponse.status).toBe(200);
		const listBody = (await listResponse.json()) as { items: Array<{ path: string; nodeId: string }> };
		expect(listBody.items).toEqual([expect.objectContaining({ path: "/notes/report.md", nodeId: writtenBody.nodeId })]);

		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/notes/report.md" }),
		});
		expect(readResponse.status).toBe(200);
		expect(((await readResponse.json()) as { content: string }).content).toContain("Written via the public API");

		const conflict = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/notes/report.md", content: "# Replacement", overwrite: "fail" }),
		});
		expect(conflict.status).toBe(409);
		expect(((await conflict.json()) as { message: string }).message).toBe("A file already exists at this path");

		// Overwriting an editable Markdown file replaces its content in place: the nodeId stays
		// stable so open editors and links keep working.
		const replaced = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/notes/report.md", content: "# Replacement\n\nReplaced via the public API\n" }),
		});
		expect(replaced.status).toBe(200);
		const replacedBody = (await replaced.json()) as { nodeId: string };
		expect(replacedBody.nodeId).toBe(writtenBody.nodeId);

		const download = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ fileNodeIds: [replacedBody.nodeId], expiresInSeconds: 60 }),
		});
		expect(download.status).toBe(200);
		const downloadBody = (await download.json()) as {
			items: Array<{ fileNodeId: string; url: string; expiresAt: number }>;
		};
		expect(downloadBody.items[0]?.fileNodeId).toBe(replacedBody.nodeId);
		expect(downloadBody.items[0]?.expiresAt).toBeGreaterThan(Date.now());
		const downloaded = await fetch(downloadBody.items[0]!.url);
		expect(downloaded.status).toBe(200);
		expect(await downloaded.text()).toContain("Replaced via the public API");

		// Every published write consumed its stage; nothing is left for the cleanup cron.
		const stages = await t.run(async (ctx) => await ctx.db.query("public_api_file_write_stages").collect());
		expect(stages).toEqual([]);
	});

	test("the write route creates a non-collaborative file with no Yjs docs", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-non-collaborative" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-non-collaborative",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Files writer",
			scopes: ["files:list", "files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		const content = "---\ntitle: Imported\nowner: ada\n---\n\n# Imported\n\nno collaboration here\n";
		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/imported/report.md", content, nonCollaborative: true }),
		});
		expect(written.status).toBe(200);
		const writtenBody = (await written.json()) as { nodeId: string };

		const stored = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", writtenBody.nodeId as Id<"files_nodes">);
			return {
				nonCollaborative: node?.nonCollaborative,
				yjsRootKind: node?.yjsRootKind,
				hasPointers: node?.yjsSnapshotId !== undefined || node?.yjsLastSequenceId !== undefined,
				yjsSnapshots: (await ctx.db.query("files_yjs_snapshots").collect()).length,
				yjsLastSequences: (await ctx.db.query("files_yjs_docs_last_sequences").collect()).length,
				yjsUpdates: (await ctx.db.query("files_yjs_updates").collect()).length,
				assetKinds: (await ctx.db.query("files_r2_assets").collect()).map((asset) => asset.kind),
				metadataFields: (await ctx.db.query("files_metadata_docs").collect())
					.map((entry) => entry.qualifiedField)
					.sort(),
				stages: (await ctx.db.query("public_api_file_write_stages").collect()).length,
			};
		});

		// The file is editable text — it keeps its shape — but it has no collaborative document at
		// all, and no leftover Yjs snapshot asset from the staging step.
		expect(stored.nonCollaborative).toBe(true);
		expect(stored.yjsRootKind).toBe("rich_text");
		expect(stored.hasPointers).toBe(false);
		expect(stored.yjsSnapshots).toBe(0);
		expect(stored.yjsLastSequences).toBe(0);
		expect(stored.yjsUpdates).toBe(0);
		expect(stored.assetKinds).toEqual(["content_snapshot"]);
		expect(stored.stages).toBe(0);

		// Frontmatter indexing still runs, so these files stay findable by metadata search. Each key
		// produces a field doc and a value doc, and the route adds its own `source: api` key.
		expect(stored.metadataFields).toEqual([
			"frontmatter.owner",
			"frontmatter.owner",
			"frontmatter.title",
			"frontmatter.title",
			"metadata.source",
			"metadata.source",
		]);

		// The read route serves the committed content, so a caller cannot tell the difference.
		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/imported/report.md" }),
		});
		expect(readResponse.status).toBe(200);
		expect(((await readResponse.json()) as { content: string }).content).toContain("no collaboration here");

		// Without the flag the same route still creates a normal collaborative file. Without this
		// the checks above could pass because the route ignores the flag and never builds a
		// document at all.
		const collaborative = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/imported/normal.md", content: "# Normal\n\nbody\n" }),
		});
		expect(collaborative.status).toBe(200);
		const collaborativeNodeId = ((await collaborative.clone().json()) as { nodeId: string }).nodeId;
		const collaborativeNode = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", collaborativeNodeId as Id<"files_nodes">);
			return {
				nonCollaborative: node?.nonCollaborative,
				hasPointers: node?.yjsSnapshotId !== undefined && node?.yjsLastSequenceId !== undefined,
			};
		});
		expect(collaborativeNode.nonCollaborative).toBeUndefined();
		expect(collaborativeNode.hasPointers).toBe(true);

		// The flag is read only when the write creates the file. Sending it over the collaborative
		// file keeps that file collaborative: turning collaboration off deletes the edit history,
		// and only the Properties dialog asks the user about that. An importer that always sends
		// the flag must not flip a file behind their back.
		const flagOnExisting = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				path: "/imported/normal.md",
				content: "# Normal\n\nsecond body\n",
				nonCollaborative: true,
			}),
		});
		expect(flagOnExisting.status).toBe(200);
		expect(((await flagOnExisting.clone().json()) as { nodeId: string }).nodeId).toBe(collaborativeNodeId);
		const afterFlagOnExisting = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", collaborativeNodeId as Id<"files_nodes">);
			return {
				nonCollaborative: node?.nonCollaborative,
				hasPointers: node?.yjsSnapshotId !== undefined && node?.yjsLastSequenceId !== undefined,
				versions: (await ctx.db.query("files_snapshots").collect()).filter(
					(snapshot) => snapshot.fileNodeId === (collaborativeNodeId as Id<"files_nodes">),
				).length,
			};
		});
		expect(afterFlagOnExisting.nonCollaborative).toBeUndefined();
		expect(afterFlagOnExisting.hasPointers).toBe(true);
		expect(afterFlagOnExisting.versions).toBe(2);
		const readAfterFlag = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/imported/normal.md" }),
		});
		expect(readAfterFlag.status).toBe(200);
		expect(((await readAfterFlag.json()) as { content: string }).content).toBe("# Normal\n\nsecond body\n");

		// Writing again over the non-collaborative file replaces its text in place. Without this the
		// write would archive the file and create a new one, so a repeated import would change the
		// nodeId every run.
		const replaced = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				path: "/imported/report.md",
				content: "# Imported\n\nsecond import\n",
			}),
		});
		expect(replaced.status).toBe(200);
		expect(((await replaced.json()) as { nodeId: string }).nodeId).toBe(writtenBody.nodeId);

		const afterReplace = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", writtenBody.nodeId as Id<"files_nodes">);
			return {
				nonCollaborative: node?.nonCollaborative,
				archived: node?.archiveOperationId !== undefined,
				yjsSnapshots: (await ctx.db.query("files_yjs_snapshots").collect()).length,
				// One version per write on this file, plus the one the collaborative file created.
				versions: (await ctx.db.query("files_snapshots").collect()).filter(
					(snapshot) => snapshot.fileNodeId === (writtenBody.nodeId as Id<"files_nodes">),
				).length,
			};
		});
		expect(afterReplace.nonCollaborative).toBe(true);
		expect(afterReplace.archived).toBe(false);
		// The collaborative file made the only Yjs snapshot in the workspace; the replace made none.
		expect(afterReplace.yjsSnapshots).toBe(1);
		expect(afterReplace.versions).toBe(2);

		const readAgain = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/imported/report.md" }),
		});
		expect(((await readAgain.json()) as { content: string }).content).toContain("second import");

		// A re-import of the same text mints no new version.
		const unchanged = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				path: "/imported/report.md",
				content: "# Imported\n\nsecond import\n",
				skipIfUnchanged: true,
			}),
		});
		expect(unchanged.status).toBe(200);
		expect((await unchanged.json()) as { unchanged?: boolean }).toMatchObject({ unchanged: true });
		expect(
			await t.run(async (ctx) =>
				(await ctx.db.query("files_snapshots").collect()).filter(
					(snapshot) => snapshot.fileNodeId === (writtenBody.nodeId as Id<"files_nodes">),
				).length,
			),
		).toBe(2);
	});

	test("ordinary cleanup ledgers orphaned keys after the stage already vanished", async () => {
		const t = test_convex();
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("keep jobs pending"));
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-orphaned-stage" });
		const staged = await seed_public_file_write_stage({
			t,
			db,
			path: "/orphaned.md",
			expiresAt: Date.now() + 60_000,
		});

		// A plugin run may finish and remove the stage while its R2 writes are still running. The
		// action must still create deletion jobs for the exact keys after those writes finish.
		await t.run(async (ctx) => {
			await ctx.db.delete("files_r2_assets", staged.yjsSnapshotAssetId);
			await ctx.db.delete("files_r2_assets", staged.contentSnapshotAssetId);
			await ctx.db.delete("public_api_file_write_stages", staged.stageId);
		});
		await t.mutation(internal.public_api.cleanup_file_write_stage, {
			stageId: staged.stageId,
			orphanedKeys: staged.keys,
			orphanedScope: { organizationId: db.organizationId, workspaceId: db.workspaceId },
		});

		const jobs = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.map((job) => job.r2Key).sort()).toEqual([...staged.keys].sort());
		expect(jobs.every((job) => job.reason === "failed_create")).toBe(true);
		// This fallback runs after the action's R2 writes finish. It must not shorten a later delete
		// time already saved by earlier cleanup.
		expect(jobs.every((job) => job.putMayArriveUntil === undefined)).toBe(true);
	});

	test("stage cleanup keeps a tombstone through a late action PUT after the action crashes", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-late-stage-put" });
		const now = Date.now();
		const expiresAt = now + 60_000;
		const staged = await seed_public_file_write_stage({
			t,
			db,
			path: "/late-stage-put.md",
			expiresAt,
		});
		const [key] = staged.keys;
		if (!key) {
			throw new Error("Expected a staged R2 key");
		}

		// Plugin or tenant cleanup may run while the request still writes to R2. Simulate cleanup
		// finishing before that late write arrives.
		await t.mutation(internal.public_api.cleanup_file_write_stage, { stageId: staged.stageId });
		const job = await t.run(async (ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", key))
				.first(),
		);
		if (!job) {
			throw new Error("Expected a deletion job");
		}
		const putMayArriveUntil = expiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS;
		expect(job.putMayArriveUntil).toBe(putMayArriveUntil);
		r2Objects.delete(key);
		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
			deletedAt: now,
		});
		expect(
			await t.run(async (ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id)),
		).toMatchObject({ nextAttemptAt: putMayArriveUntil });

		// The R2 write then arrives and the action crashes. The saved job must delete once more after
		// no later write can arrive.
		r2Objects.set(key, "late bytes");
		vi.spyOn(Date, "now").mockReturnValue(putMayArriveUntil + 1);
		await t.action(internal.r2_client.process_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
		});
		expect(r2Objects.has(key)).toBe(false);
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id))).toBeNull();
	});

	test("expired public file write stages hand every exact key to the deletion ledger", async () => {
		const t = test_convex();
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(new Error("keep jobs pending"));
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-expired-stage" });
		const now = Date.now();
		const staged = await seed_public_file_write_stage({
			t,
			db,
			path: "/expired.md",
			expiresAt: now - 1,
		});

		const cleaned = await t.mutation(internal.public_api.cleanup_expired_file_write_stages, {
			_test_now: now,
			batchSize: 10,
			_test_disableReschedule: true,
		});
		expect(cleaned).toEqual({ deletedCount: 1, done: true });

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs.map((job) => job.r2Key).sort()).toEqual([...staged.keys].sort());
			expect(jobs.every((job) => job.reason === "failed_create")).toBe(true);
			expect(
				jobs.every((job) => job.putMayArriveUntil === now - 1 + r2_PUT_MAY_ARRIVE_MARGIN_MS),
			).toBe(true);
			expect(await ctx.db.get("files_r2_assets", staged.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", staged.contentSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("public_api_file_write_stages", staged.stageId)).toBeNull();
		});
	});

	// A file the public API creates says so, so a member can tell API-written files from what
	// somebody uploaded or the agent wrote.
	test("POST /api/v1/files/write stamps the api source on a file it creates", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-stamp" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-stamp",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Stamp writer",
			scopes: ["files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/api-stamped/report.md", content: "# Title\n" }),
		});
		expect(written.status).toBe(200);

		const metadataDocs = await t.run(async (ctx) => {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/api-stamped/report.md")
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (!node) {
				throw new Error("Expected the written file node");
			}
			return await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_qualifiedField", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", node._id),
				)
				.collect();
		});
		expect(
			Object.fromEntries(
				metadataDocs.filter((doc) => doc.docKind === "value").map((doc) => [doc.qualifiedField, doc.stringValue]),
			),
		).toEqual({ "metadata.source": "api" });
	});

	test("POST /api/v1/files/write with CRLF content stores LF everywhere", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-lf" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-lf",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "LF writer",
			scopes: ["files:read", "files:write", "files:download"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		// One leading BOM plus CRLF and a lone CR: the request boundary normalizes all of them
		// BEFORE the byte count and the fan-out, so the document, the R2 snapshot, the chunks and
		// the stored size all agree on one LF string.
		const crlfContent = "\uFEFF# Title\r\n\r\nline one\r\nline two\rline three\n";
		const normalizedContent = "# Title\n\nline one\nline two\nline three\n";

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/lf/report.md", content: crlfContent }),
		});
		expect(written.status).toBe(200);
		const writtenBody = (await written.json()) as { nodeId: string };

		// Chunks (the read route serves committed chunks) agree on LF.
		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/lf/report.md" }),
		});
		expect(readResponse.status).toBe(200);
		expect(((await readResponse.json()) as { content: string }).content).toBe(normalizedContent);

		// The R2 content snapshot holds the same LF bytes.
		const download = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ fileNodeIds: [writtenBody.nodeId], expiresInSeconds: 60 }),
		});
		expect(download.status).toBe(200);
		const downloadBody = (await download.json()) as { items: Array<{ url: string }> };
		const downloaded = await fetch(downloadBody.items[0]!.url);
		expect(await downloaded.text()).toBe(normalizedContent);

		// The stored size is the normalized byte count.
		const assetSize = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", writtenBody.nodeId as Id<"files_nodes">);
			const asset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			return asset?.size;
		});
		expect(assetSize).toBe(files_get_utf8_byte_size(normalizedContent));

		// The document holds the LF text. Re-sending the normalized string with skipIfUnchanged
		// writes it into the reconstructed document, and only an already-LF document makes that
		// write a no-op.
		const unchanged = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/lf/report.md", content: normalizedContent, skipIfUnchanged: true }),
		});
		expect(unchanged.status).toBe(200);
		expect((await unchanged.json()) as object).toMatchObject({ nodeId: writtenBody.nodeId, unchanged: true });
	});

	test("signed download URLs pin the name-derived type and serve non-media as attachments", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-attachment" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-attachment",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Attachment checker",
			scopes: ["files:write", "files:download"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/attach/report.md", content: "# Attachment check\n" }),
		});
		expect(written.status).toBe(200);
		const writtenBody = (await written.json()) as { nodeId: string };

		const getUrlSpy = vi.spyOn(R2.prototype, "getUrl");
		getUrlSpy.mockClear();
		const download = await t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ fileNodeIds: [writtenBody.nodeId], expiresInSeconds: 60 }),
		});
		expect(download.status).toBe(200);

		// The pinned type and disposition are the whole defense because a presigned R2 GET carries no
		// nosniff/CSP). Editable text derives its type from the NAME and never serves inline.
		const signingCall = getUrlSpy.mock.calls.find(([, options]) => options?.responseContentType !== undefined);
		expect(signingCall?.[1]).toMatchObject({
			responseContentType: "text/markdown;charset=utf-8",
			responseContentDisposition: "attachment; filename*=UTF-8''report.md",
		});
	});

	test("skipIfUnchanged skips staging when the content did not change", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-skip-unchanged" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-skip-unchanged",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Skip writer",
			scopes: ["files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		const content = "# Report\n\nStable content\n";
		const first = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/skip/report.md", content }),
		});
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { nodeId: string };

		const before = await t.run(async (ctx) => ({
			snapshots: (await ctx.db.query("files_snapshots").collect()).length,
			assets: (await ctx.db.query("files_r2_assets").collect()).length,
		}));

		// Same content again with the flag: no new version snapshot, no new asset docs.
		const unchanged = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/skip/report.md", content, skipIfUnchanged: true }),
		});
		expect(unchanged.status).toBe(200);
		expect(await unchanged.json()).toEqual({
			path: "/skip/report.md",
			nodeId: firstBody.nodeId,
			contentType: "text/markdown;charset=utf-8",
			unchanged: true,
		});
		const after = await t.run(async (ctx) => ({
			snapshots: (await ctx.db.query("files_snapshots").collect()).length,
			assets: (await ctx.db.query("files_r2_assets").collect()).length,
		}));
		expect(after).toEqual(before);

		// Changed content with the flag writes normally.
		const changed = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/skip/report.md", content: "# Report\n\nNew content\n", skipIfUnchanged: true }),
		});
		expect(changed.status).toBe(200);
		const changedBody = (await changed.json()) as { nodeId: string };
		expect(changedBody.nodeId).toBe(firstBody.nodeId);
		expect(changedBody).not.toHaveProperty("unchanged");

		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/skip/report.md" }),
		});
		expect(readResponse.status).toBe(200);
		expect(((await readResponse.json()) as { content: string }).content).toContain("New content");
	});

	test("a replace that cannot recreate the file does not archive it", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-nested-scope-owner" });

		// /outer and /outer/inner are each restricted on their own. The writer holds the inner scope
		// and nothing on the outer one, which is what nested scopes are for.
		const seeded = await t.run(async (ctx) => {
			const now = Date.now();
			const outerId = await ctx.db.insert("files_nodes", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: files_ROOT_ID,
				name: "outer",
				path: "/outer",
				treePath: "/outer/",
				pathDepth: 1,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
			});
			const innerId = await ctx.db.insert("files_nodes", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: outerId,
				name: "inner",
				path: "/outer/inner",
				treePath: "/outer/inner/",
				pathDepth: 2,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", outerId, { restrictedScopeNodeId: outerId });
			await ctx.db.patch("files_nodes", innerId, { restrictedScopeNodeId: innerId });

			const writerId = await ctx.db.insert("users", { clerkUserId: "clerk-nested-scope-writer" });
			const writerMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: writerId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: writerId,
				role: "member",
				now,
			});
			for (const permission of ["content.read", "content.write"] as const) {
				await ctx.db.insert("access_control_permission_grants", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					resourceKind: "file",
					resourceId: String(innerId),
					principalKind: "user",
					userId: writerId,
					permission,
					createdAt: now,
					updatedAt: now,
				});
			}

			return { outerId, innerId, writerId, writerMembershipId };
		});

		const targetNodeId = await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/outer/inner/report.md",
			committedMarkdown: "# Original",
		});

		const stageId = await t.run(async (ctx) => {
			const now = Date.now();
			// Inserted rather than created through `api_credential_create`: publication only reads the
			// doc's owner and revocation, and the real mutation drags in the credential quota.
			const credentialId = await ctx.db.insert("api_credentials", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: seeded.writerId,
				name: "Nested writer",
				keyId: "key-nested-writer",
				obfuscatedValue: "sk_...aaaa",
				secretHash: "hash",
				scopes: ["files:read", "files:write"],
				createdAt: now,
				revokedAt: null,
				lastUsedAt: null,
			});
			const asset = async (kind: "yjs_snapshot" | "content_snapshot") =>
				await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind,
					r2Bucket: "test",
					size: 1,
					createdBy: seeded.writerId,
					updatedAt: now,
				});
			return await ctx.db.insert("public_api_file_write_stages", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: seeded.writerId,
				credentialId,
				path: "/outer/inner/report.md",
				overwrite: "replace",
				yjsSnapshotAssetId: await asset("yjs_snapshot"),
				contentSnapshotAssetId: await asset("content_snapshot"),
				expiresAt: now + 60_000,
				updatedAt: now,
			});
		});

		// Recreation has to walk /outer, which this writer cannot write, so the replace fails.
		const published = await t.mutation(internal.public_api.publish_file_write, {
			stageId,
			content: "# Replacement",
			// This is the file that `prepare_file_write` would remember.
			targetAnchor: { kind: "existing", nodeId: targetNodeId },
		});
		expect(published._nay?.message).toBe("Permission denied");

		// The point of the fix: the refusal must not leave the caller with no file.
		await t.run(async (ctx) => {
			const target = await ctx.db.get("files_nodes", targetNodeId);
			expect(target?.archiveOperationId).toBeUndefined();
			expect(target?.path).toBe("/outer/inner/report.md");
		});
	});

	test("the public API write routes refuse a file the caller may read but not write", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const owner = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-sharee-owner" });

		// /shared is restricted, so inside it only a grant counts. That is the one shape where the
		// workspace-level check every write route already makes says yes and the node-level checks
		// are the only thing left to say no.
		const sharedId = await t.run(async (ctx) => {
			const now = Date.now();
			const folderId = await ctx.db.insert("files_nodes", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				parentId: files_ROOT_ID,
				name: "shared",
				path: "/shared",
				treePath: "/shared/",
				pathDepth: 1,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: owner.userId,
				updatedBy: owner.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", folderId, { restrictedScopeNodeId: folderId });
			return folderId;
		});

		const notesId = await seed_markdown_file({
			t,
			organizationId: owner.organizationId,
			workspaceId: owner.workspaceId,
			userId: owner.userId,
			path: "/shared/notes.md",
			committedMarkdown: "# Owner only",
		});
		// Every node in the subtree carries the scope, the way `restrict_node` stamps it.
		await t.run(async (ctx) => await ctx.db.patch("files_nodes", notesId, { restrictedScopeNodeId: sharedId }));

		const legacyId = await t.run(async (ctx) => {
			const now = Date.now();
			// No Yjs pointers: a stored upload rather than an editable doc, which is what sends /write
			// down the archive-and-recreate path instead of the fill-in-place one. Restricted on itself
			// and sitting at the root, so its own check is the only gate — inside a restricted folder
			// the ancestor walk refuses the write before that check is ever reached.
			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				parentId: files_ROOT_ID,
				name: "legacy.md",
				path: "/legacy.md",
				treePath: "/legacy.md",
				pathDepth: 1,
				kind: "file",
				lowercaseExtension: "md",
				contentType: "text/markdown;charset=utf-8",
				createdBy: owner.userId,
				updatedBy: owner.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			return nodeId;
		});

		const seed_member_key = async (args: {
			clerkUserId: string;
			subject: string;
			readGrantNodeIds: Array<Id<"files_nodes">>;
		}) => {
			const member = await t.run(async (ctx) => {
				const now = Date.now();
				const userId = await ctx.db.insert("users", { clerkUserId: args.clerkUserId });
				// The write route's credit gate bills the acting member, so the fixture pays.
				await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
				const organization = await ctx.db.get("organizations", owner.organizationId);
				const defaultWorkspaceId = organization!.defaultWorkspaceId!;

				for (const workspaceId of [defaultWorkspaceId, owner.workspaceId]) {
					await ctx.db.insert("organizations_workspaces_users", {
						organizationId: owner.organizationId,
						workspaceId,
						userId,
						active: true,
						updatedAt: now,
					});
				}
				// "member" carries workspace-level content.write, so no refusal below can come from the
				// route's own workspace check. The organization role lives on the default workspace, the
				// same way an invite writes it.
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: owner.organizationId,
					workspaceId: defaultWorkspaceId,
					userId,
					role: "member",
					now,
				});
				for (const nodeId of args.readGrantNodeIds) {
					await ctx.db.insert("access_control_permission_grants", {
						organizationId: owner.organizationId,
						workspaceId: owner.workspaceId,
						resourceKind: "file",
						resourceId: String(nodeId),
						principalKind: "user",
						userId,
						permission: "content.read",
						createdAt: now,
						updatedAt: now,
					});
				}
				await quotas_db_ensure(ctx, {
					quotaName: "active_api_credentials",
					userId,
					organizationId: owner.organizationId,
					workspaceId: owner.workspaceId,
					now,
				});

				const membershipId = await ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", owner.workspaceId).eq("userId", userId))
					.first()
					.then((membership) => membership!._id);

				return { userId, membershipId } as const;
			});

			const created = await t
				.withIdentity({ issuer: "https://clerk.test", subject: args.subject, external_id: member.userId })
				.mutation(api.public_api.api_credential_create, {
					membershipId: member.membershipId,
					name: args.subject,
					scopes: ["files:read", "files:write"],
				});
			expect(created._nay).toBeUndefined();
			return created._yay!.credential;
		};

		const readerKey = await seed_member_key({
			clerkUserId: "clerk-public-api-sharee-reader",
			subject: "public-api-sharee-reader",
			readGrantNodeIds: [sharedId, legacyId],
		});

		// Control: outside the restricted folder this same key creates files. Without it every 403
		// below could just as well be a broken key, a missing scope or a missing membership.
		const ownFile = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(readerKey),
			body: JSON.stringify({ paths: ["/reader-notes.md"] }),
		});
		expect(ownFile.status).toBe(200);

		// The other half of the control: the reader really can see the restricted file, so the
		// refusals below are about writing it and not about finding it.
		const read = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(readerKey),
			body: JSON.stringify({ path: "/shared/notes.md" }),
		});
		expect(read.status).toBe(200);

		// The touch route's already-exists shortcut answers without staging anything, so it has to
		// ask the node itself. Answering 200 here while /write answers 403 is the contradiction.
		const touched = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(readerKey),
			body: JSON.stringify({ paths: ["/shared/notes.md"] }),
		});
		expect(touched.status).toBe(403);

		// publish_file_fill re-asks at commit time: an editable file is written in place.
		const filled = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(readerKey),
			body: JSON.stringify({ path: "/shared/notes.md", content: "# Mine now\n", overwrite: "replace" }),
		});
		expect(filled.status).toBe(403);

		// The unchanged skip must not answer where the publish would refuse: identical content
		// with the flag still gets the same 403, so the unchanged marker cannot confirm a
		// restricted file's exact content to a caller who may read but not write it.
		const skipped = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(readerKey),
			body: JSON.stringify({ path: "/shared/notes.md", content: "# Owner only", skipIfUnchanged: true }),
		});
		expect(skipped.status).toBe(403);
		expect(await skipped.json()).toEqual({ message: "Permission denied" });

		// publish_file_write asks before archiving what is already there.
		const replaced = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(readerKey),
			body: JSON.stringify({ path: "/legacy.md", content: "# Mine now\n", overwrite: "replace" }),
		});
		expect(replaced.status).toBe(403);

		// Somebody with no grant cannot even see the file, so the route stages a create and
		// publish_file_touch is the one that finds the node and refuses.
		const outsiderKey = await seed_member_key({
			clerkUserId: "clerk-public-api-sharee-outsider",
			subject: "public-api-sharee-outsider",
			readGrantNodeIds: [],
		});
		const collided = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(outsiderKey),
			body: JSON.stringify({ paths: ["/shared/notes.md"] }),
		});
		expect(collided.status).toBe(403);

		// A refusal must not be a write: both files are untouched and no stage is left behind.
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", notesId).then((node) => node?.archiveOperationId)).toBeUndefined();
			expect(await ctx.db.get("files_nodes", legacyId).then((node) => node?.archiveOperationId)).toBeUndefined();
			expect(await ctx.db.query("public_api_file_write_stages").collect()).toEqual([]);
		});
	});

	test("touches empty Markdown files and fills them in place", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-touch" });

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-touch",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Files toucher",
			scopes: ["files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		for (const body of [
			{ paths: [] },
			{ paths: ["meetings/video.mp4.transcript.md"] },
			{ paths: ["/meetings/video.mp4.transcript.txt"] },
			{ paths: ["/meetings/video.mp4.transcript.md", "/meetings/video.mp4.transcript.md"] },
		]) {
			const response = await t.fetch("/api/v1/files/touch", {
				method: "POST",
				headers: auth_headers(credential),
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
		}

		const touched = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ paths: ["/meetings/video.mp4.transcript.md", "/meetings/video.mp4.summary.md"] }),
		});
		expect(touched.status).toBe(200);
		const touchedBody = (await touched.json()) as {
			files: Array<{ path: string; nodeId: string; created: boolean }>;
		};
		expect(touchedBody.files).toEqual([
			{ path: "/meetings/video.mp4.transcript.md", nodeId: expect.any(String), created: true },
			{ path: "/meetings/video.mp4.summary.md", nodeId: expect.any(String), created: true },
		]);

		// Touched files read back as empty editable Markdown files.
		const readEmpty = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/meetings/video.mp4.transcript.md" }),
		});
		expect(readEmpty.status).toBe(200);
		expect(((await readEmpty.json()) as { content: string }).content).toBe("");

		// Producer shape pair for the empty-document case: the node has a shape and the document
		// has no root at all (an empty root is never encoded), and that pair is legal.
		const touchedNodeId = touchedBody.files[0]!.nodeId as Id<"files_nodes">;
		const touchedYjsSnapshotBytes = await t.run(async (ctx) => {
			const fileNode = await ctx.db.get("files_nodes", touchedNodeId);
			expect(fileNode?.yjsRootKind).toBe("rich_text");
			if (!fileNode?.yjsSnapshotId) {
				throw new Error("Expected the touched node to hold a Yjs snapshot pointer");
			}
			const yjsSnapshotDoc = await ctx.db.get("files_yjs_snapshots", fileNode.yjsSnapshotId);
			const yjsSnapshotAsset = yjsSnapshotDoc ? await ctx.db.get("files_r2_assets", yjsSnapshotDoc.assetId) : null;
			return yjsSnapshotAsset?.r2Key ? r2Objects.get(yjsSnapshotAsset.r2Key) : undefined;
		});
		if (!(touchedYjsSnapshotBytes instanceof ArrayBuffer)) {
			throw new Error("Expected the touched Yjs snapshot bytes to be captured as an ArrayBuffer");
		}
		const touchedSnapshotYjsDoc = files_yjs_doc_create_from_array_buffer_update(touchedYjsSnapshotBytes);
		expect([...touchedSnapshotYjsDoc.share.keys()]).toEqual([]);

		// A repeated touch is an idempotent no-op returning the same nodes.
		const repeated = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ paths: ["/meetings/video.mp4.transcript.md", "/meetings/video.mp4.summary.md"] }),
		});
		expect(repeated.status).toBe(200);
		const repeatedBody = (await repeated.json()) as {
			files: Array<{ path: string; nodeId: string; created: boolean }>;
		};
		expect(repeatedBody.files).toEqual([
			{ path: "/meetings/video.mp4.transcript.md", nodeId: touchedBody.files[0]!.nodeId, created: false },
			{ path: "/meetings/video.mp4.summary.md", nodeId: touchedBody.files[1]!.nodeId, created: false },
		]);

		// Writing to a touched path fills the placeholder node instead of replacing it.
		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/meetings/video.mp4.transcript.md", content: "# Transcript\n\nHello there\n" }),
		});
		expect(written.status).toBe(200);
		expect(((await written.json()) as { nodeId: string }).nodeId).toBe(touchedBody.files[0]!.nodeId);

		const readFilled = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/meetings/video.mp4.transcript.md" }),
		});
		expect(readFilled.status).toBe(200);
		expect(((await readFilled.json()) as { content: string }).content).toContain("Hello there");

		// The fill appended a non-user Yjs update that open editor sessions apply as a remote change.
		const transcriptNodeId = touchedBody.files[0]!.nodeId as Id<"files_nodes">;
		const yjsUpdates = await t.run(
			async (ctx) =>
				await ctx.db
					.query("files_yjs_updates")
					.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
						q
							.eq("organizationId", db.organizationId)
							.eq("workspaceId", db.workspaceId)
							.eq("fileNodeId", transcriptNodeId),
					)
					.collect(),
		);
		expect(yjsUpdates).toEqual([expect.objectContaining({ origin: { type: "USER_AI_EDIT" } })]);

		// A path blocked by an existing file at an intermediate segment conflicts.
		const blocked = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ paths: ["/meetings/video.mp4.transcript.md/inner.md"] }),
		});
		expect(blocked.status).toBe(409);

		// Every touch consumed or skipped its stage; nothing is left for the cleanup cron.
		const stages = await t.run(async (ctx) => await ctx.db.query("public_api_file_write_stages").collect());
		expect(stages).toEqual([]);
	});

	test("suppresses a signed url when its user API key is revoked during signing", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-signing-revoke" });
		const nodeId = await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/revoked.md",
			committedMarkdown: "# Revoke during signing\n",
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-signing-revoke",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Signing revoke",
			scopes: ["files:download"],
		});
		if (created._nay) throw new Error(created._nay.message);
		const signing = defer_download_url();

		const responsePromise = t.fetch("/api/v1/files/download-urls", {
			method: "POST",
			headers: auth_headers(created._yay.credential),
			body: JSON.stringify({ fileNodeIds: [nodeId] }),
		});
		await signing.started;
		await t.run((ctx) => ctx.db.patch("api_credentials", created._yay.credentialId, { revokedAt: Date.now() }));
		signing.release();

		const response = await responsePromise;
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthenticated" });
	});

	test("keeps public file routes scoped to tenant files and excludes reserved GLOBAL/GITHUB mounts", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-mount-isolation" });
		const mountSentinel = "reserved mount sentinel Zorptelemetry\n";

		await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/tenant-visible.md",
			committedMarkdown: "tenant visible content\n",
		});
		const mounted = await t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: "/t3-chat/README.md",
			rawText: mountSentinel,
		});
		if (mounted._nay) {
			throw new Error(`Expected reserved mount fixture to materialize: ${mounted._nay.message}`);
		}

		const reservedRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: organizations_GLOBAL_ORGANIZATION_ID,
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			userId: db.userId,
			path: "/t3-chat/README.md",
			mode: { kind: "full", maxBytes: 1_000_000 },
		});
		expect(reservedRead?.content).toBe(mountSentinel);

		const token = "8".repeat(64);
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token,
		});

		const listRoot = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(token),
			body: JSON.stringify({ path: "/", recursive: true }),
		});
		expect(listRoot.status).toBe(200);
		const listRootBody = (await listRoot.json()) as { items: Array<{ path: string }> };
		expect(listRootBody.items.map((item) => item.path)).toEqual(["/tenant-visible.md"]);

		for (const path of ["/t3-chat", "/.mounts/t3-chat"]) {
			const listMount = await t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ path, recursive: true }),
			});
			expect(listMount.status).toBe(200);
			const listMountBody = (await listMount.json()) as { items: Array<{ path: string }> };
			expect(listMountBody.items).toEqual([]);
		}

		for (const path of ["/t3-chat/README.md", "/.mounts/t3-chat/README.md"]) {
			const readMount = await t.fetch("/api/v1/files/read", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ path }),
			});
			expect(readMount.status).toBe(404);
		}

		const readMany = await t.fetch("/api/v1/files/read-many", {
			method: "POST",
			headers: auth_headers(token),
			body: JSON.stringify({
				paths: ["/tenant-visible.md", "/t3-chat/README.md", "/.mounts/t3-chat/README.md"],
			}),
		});
		expect(readMany.status).toBe(200);
		const readManyBody = (await readMany.json()) as {
			files: Array<{ path: string; content: string }>;
			errors: Array<{ path: string; message: string }>;
		};
		expect(readManyBody.files).toEqual([
			expect.objectContaining({ path: "/tenant-visible.md", content: expect.stringContaining("tenant visible") }),
		]);
		expect(readManyBody.errors.map((error) => error.path)).toEqual([
			"/t3-chat/README.md",
			"/.mounts/t3-chat/README.md",
		]);
		expect(JSON.stringify(readManyBody)).not.toContain("Zorptelemetry");
	});

	test("rotates an API credential and refuses to rotate revoked credentials", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-rotate" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-rotate",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Rotating key",
			scopes: ["files:list"],
		});
		expect(created._nay).toBeUndefined();

		const rotated = await asUser.mutation(api.public_api.api_credential_rotate, {
			membershipId: db.membershipId,
			credentialId: created._yay!.credentialId,
		});
		expect(rotated._nay).toBeUndefined();
		expect(rotated._yay!.credentialId).not.toBe(created._yay!.credentialId);
		expect(rotated._yay!.credential).not.toBe(created._yay!.credential);
		const quotaAfterRotate = await asUser.query(api.quotas.get, {
			quotaName: "active_api_credentials",
			membershipId: db.membershipId,
		});
		expect(quotaAfterRotate?.usedCount).toBe(1);

		const oldKeyResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(created._yay!.credential),
			body: JSON.stringify({ path: "/" }),
		});
		expect(oldKeyResponse.status).toBe(401);

		const newKeyResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(rotated._yay!.credential),
			body: JSON.stringify({ path: "/" }),
		});
		expect(newKeyResponse.status).toBe(200);

		const rotateRevoked = await asUser.mutation(api.public_api.api_credential_rotate, {
			membershipId: db.membershipId,
			credentialId: created._yay!.credentialId,
		});
		expect(rotateRevoked._nay?.message).toBe("Not found");
	});

	test("lets an active workspace member manage their own API credentials", async () => {
		const t = test_convex();
		const owner = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-permission-owner" });
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", {
				clerkUserId: "clerk-public-api-permission-member",
			});
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				active: true,
			});
			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId,
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-permission-member",
			external_id: member.userId,
		});

		const created = await asMember.mutation(api.public_api.api_credential_create, {
			membershipId: member.membershipId,
			name: "  Member key  ",
			scopes: ["files:list"],
		});
		expect(created._nay).toBeUndefined();

		const listed = await asMember.query(api.public_api.api_credentials_list, {
			membershipId: member.membershipId,
		});
		expect(listed._yay).toEqual([expect.objectContaining({ name: "Member key" })]);

		const revoked = await asMember.mutation(api.public_api.api_credential_revoke, {
			membershipId: member.membershipId,
			credentialId: created._yay!.credentialId,
		});
		expect(revoked._nay).toBeUndefined();
	});

	test("keeps personal API credentials private from other active members", async () => {
		const t = test_convex();
		const owner = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-private-owner" });
		const member = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", {
				clerkUserId: "clerk-public-api-private-member",
			});
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				active: true,
			});
			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId,
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asMember = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-private-member",
			external_id: member.userId,
		});
		const asOwner = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-private-owner",
			external_id: owner.userId,
		});

		const created = await asMember.mutation(api.public_api.api_credential_create, {
			membershipId: member.membershipId,
			name: "Member key",
			scopes: ["files:list"],
		});
		expect(created._nay).toBeUndefined();

		const listed = await asOwner.query(api.public_api.api_credentials_list, {
			membershipId: owner.membershipId,
		});
		expect(listed._yay).toEqual([]);

		const rotated = await asOwner.mutation(api.public_api.api_credential_rotate, {
			membershipId: owner.membershipId,
			credentialId: created._yay!.credentialId,
		});
		expect(rotated._nay?.message).toBe("Not found");

		const revoked = await asOwner.mutation(api.public_api.api_credential_revoke, {
			membershipId: owner.membershipId,
			credentialId: created._yay!.credentialId,
		});
		expect(revoked._nay?.message).toBe("Not found");

		const memberList = await asMember.query(api.public_api.api_credentials_list, {
			membershipId: member.membershipId,
		});
		expect(memberList._yay).toEqual([expect.objectContaining({ credentialId: created._yay!.credentialId })]);
	});

	test("validates API credential name boundaries", async () => {
		const blankTest = test_convex();
		const blankDb = await seed_signed_in_membership({
			t: blankTest,
			clerkUserId: "clerk-public-api-name-blank",
		});
		const asBlankUser = blankTest.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-name-blank",
			external_id: blankDb.userId,
		});
		const blank = await asBlankUser.mutation(api.public_api.api_credential_create, {
			membershipId: blankDb.membershipId,
			name: "   ",
			scopes: ["files:list"],
		});
		expect(blank._nay?.message).toBe("API key name is required");

		const lengthTest = test_convex();
		const lengthDb = await seed_signed_in_membership({
			t: lengthTest,
			clerkUserId: "clerk-public-api-name-length",
		});
		const asLengthUser = lengthTest.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-name-length",
			external_id: lengthDb.userId,
		});
		const maximumLength = await asLengthUser.mutation(api.public_api.api_credential_create, {
			membershipId: lengthDb.membershipId,
			name: "a".repeat(80),
			scopes: ["files:list"],
		});
		expect(maximumLength._nay).toBeUndefined();

		const tooLong = await asLengthUser.mutation(api.public_api.api_credential_create, {
			membershipId: lengthDb.membershipId,
			name: "a".repeat(81),
			scopes: ["files:list"],
		});
		expect(tooLong._nay?.message).toBe("API key name must be 80 characters or fewer");
	});

	test("uses the active API credential quota counter when creating keys", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-active-cap" });
		await t.run(async (ctx) => {
			for (let index = 0; index < 19; index += 1) {
				const keyId = `pk_${index.toString(16).padStart(32, "0")}`;
				await ctx.db.insert("api_credentials", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					name: `Active ${index}`,
					keyId,
					obfuscatedValue: `${keyId}.****0000`,
					secretHash: `hash-${index}`,
					scopes: ["files:list"],
					createdAt: index,
					revokedAt: null,
					lastUsedAt: null,
				});
			}

			const quota = await quotas_db_get(ctx, {
				quotaName: "active_api_credentials",
				userId: db.userId,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
			});
			await ctx.db.patch("quotas", quota._id, {
				usedCount: 19,
				updatedAt: Date.now(),
			});
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-active-cap",
			external_id: db.userId,
		});

		const twentieth = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Active 20",
			scopes: ["files:list"],
		});
		expect(twentieth._nay).toBeUndefined();

		const overLimit = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Active 21",
			scopes: ["files:list"],
		});
		expect(overLimit._nay?.message).toBe("You can have up to 20 active API keys in this workspace");

		const credentials = await asUser.query(api.public_api.api_credentials_list, {
			membershipId: db.membershipId,
		});
		expect(credentials._nay).toBeUndefined();
		expect(credentials._yay?.filter((credential) => credential.revokedAt === null)).toHaveLength(20);
		expect(credentials._yay?.some((credential) => credential.name === "Active 21")).toBe(false);

		const quota = await asUser.query(api.quotas.get, {
			quotaName: "active_api_credentials",
			membershipId: db.membershipId,
		});
		expect(quota).toMatchObject({
			quotaName: "active_api_credentials",
			usedCount: 20,
			maxCount: 20,
		});
	});

	test("allows seeded workspace admins to create API credentials", async () => {
		const t = test_convex();
		const owner = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-admin-owner" });
		const admin = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", {
				clerkUserId: "clerk-public-api-admin",
			});
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				active: true,
			});
			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId,
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				now,
			});
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				role: "admin",
				createdAt: now,
				updatedAt: now,
			});
			return { userId, membershipId };
		});
		const asAdmin = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-admin",
			external_id: admin.userId,
		});

		const created = await asAdmin.mutation(api.public_api.api_credential_create, {
			membershipId: admin.membershipId,
			name: "Admin key",
			scopes: ["files:list"],
		});

		expect(created._nay).toBeUndefined();
		expect(created._yay?.credential).toMatch(/^pk_[0-9a-f]{32}\.[0-9a-f]{64}$/u);
	});

	test("enforces scopes and accepts public API grants on public routes", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-scope" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-scope",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "List only",
			scopes: ["files:list"],
		});
		expect(created._nay).toBeUndefined();

		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(created._yay!.credential),
			body: JSON.stringify({ path: "/anything.md" }),
		});
		expect(readResponse.status).toBe(403);
		let lastWrongScopeStatus = readResponse.status;
		for (let index = 0; index < 20; index += 1) {
			const response = await t.fetch("/api/v1/files/read", {
				method: "POST",
				headers: auth_headers(created._yay!.credential),
				body: JSON.stringify({ path: "/anything.md" }),
			});
			lastWrongScopeStatus = response.status;
		}
		expect(lastWrongScopeStatus).toBe(429);

		const publicApiGrantToken = "3".repeat(64);
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token: publicApiGrantToken,
		});

		const publicListWithGrantToken = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(publicApiGrantToken),
			body: JSON.stringify({ path: "/" }),
		});
		expect(publicListWithGrantToken.status).toBe(200);
	});

	test("refuses writes and download URLs without the matching scope or principal kind", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-write-scope" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-write-scope",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Read only",
			scopes: ["files:list", "files:read"],
		});
		expect(created._nay).toBeUndefined();

		const grantToken = "9".repeat(64);
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token: grantToken,
		});

		// Read-only credentials miss the scope; grants are the wrong principal kind entirely.
		for (const token of [created._yay!.credential, grantToken]) {
			const writeResponse = await t.fetch("/api/v1/files/write", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ path: "/blocked.md", content: "# Blocked" }),
			});
			expect(writeResponse.status).toBe(403);

			const downloadResponse = await t.fetch("/api/v1/files/download-urls", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ fileNodeIds: ["some-node"] }),
			});
			expect(downloadResponse.status).toBe(403);
		}
	});

	test("maps every read file scope to request-time content.read permission", async () => {
		const t = test_convex();
		const owner = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-owner" });
		const keyId = `pk_${"4".repeat(32)}`;
		const secret = "5".repeat(64);
		const credential = `${keyId}.${secret}`;
		await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", {
				clerkUserId: "clerk-public-api-no-read",
			});
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				active: true,
			});
			await ctx.db.insert("api_credentials", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				name: "No read permission",
				keyId,
				obfuscatedValue: `${keyId}.****${secret.slice(-4)}`,
				secretHash: await crypto_sha256_hex(secret),
				scopes: ["files:list", "files:read", "files:download"],
				createdAt: Date.now(),
				revokedAt: null,
				lastUsedAt: null,
			});
		});

		for (const request of [
			{ path: "/api/v1/files/list", body: { path: "/" } },
			{ path: "/api/v1/files/read", body: { path: "/notes.md" } },
			{ path: "/api/v1/files/download-urls", body: { fileNodeIds: ["missing-node"] } },
		] as const) {
			const response = await t.fetch(request.path, {
				method: "POST",
				headers: auth_headers(credential),
				body: JSON.stringify(request.body),
			});
			expect(response.status).toBe(403);
		}
	});

	test("refuses a write to a viewer's API key while still allowing it to read", async () => {
		const t = test_convex();
		const owner = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-viewer-owner" });

		// A normal member, not the organization owner. The permission check answers "yes" for the owner
		// before it even looks at a role, so a key created by the owner would prove nothing here.
		const viewer = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-public-api-viewer" });
			const organization = await ctx.db.get("organizations", owner.organizationId);
			const defaultWorkspaceId = organization!.defaultWorkspaceId!;

			for (const workspaceId of [defaultWorkspaceId, owner.workspaceId]) {
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: owner.organizationId,
					workspaceId,
					userId,
					active: true,
					updatedAt: now,
				});
			}
			// The organization role is stored on the default workspace, the same way an invite
			// writes it.
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: owner.organizationId,
				workspaceId: defaultWorkspaceId,
				userId,
				role: "viewer",
				now,
			});

			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId,
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				now,
			});

			const membershipId = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) => q.eq("workspaceId", owner.workspaceId).eq("userId", userId))
				.first()
				.then((membership) => membership!._id);

			return { userId, membershipId } as const;
		});

		const asViewer = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-viewer",
			external_id: viewer.userId,
		});

		// Creating a key checks nothing on purpose. API keys belong to one user, and a scope the owner
		// of the key cannot use is simply meant to answer 403 when it is used. That choice only works
		// because of the permission check made on every request, shown below. So this test also checks
		// that creating the key succeeds.
		const created = await asViewer.mutation(api.public_api.api_credential_create, {
			membershipId: viewer.membershipId,
			name: "Viewer key",
			scopes: ["files:list", "files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/notes/viewer.md", content: "# Nope\n" }),
		});
		expect(written.status).toBe(403);

		// Control: the same key works on a read route. Without this, a broken key, a wrong scope or a
		// missing membership would give the same 403 and the test would prove nothing.
		const listed = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/" }),
		});
		expect(listed.status).toBe(200);
	});

	test("lists active and revoked API credentials newest first", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-list-active" });
		await t.run(async (ctx) => {
			for (let index = 0; index < 101; index += 1) {
				const keyId = `pk_${index.toString(16).padStart(32, "0")}`;
				await ctx.db.insert("api_credentials", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					name: `Revoked ${index}`,
					keyId,
					obfuscatedValue: `${keyId}.****0000`,
					secretHash: `hash-${index}`,
					scopes: ["files:list"],
					createdAt: index,
					revokedAt: index + 1,
					lastUsedAt: null,
				});
			}
			await ctx.db.insert("api_credentials", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				name: "Active older",
				keyId: `pk_${"a".repeat(32)}`,
				obfuscatedValue: `pk_${"a".repeat(32)}.****0000`,
				secretHash: "active-hash",
				scopes: ["files:list"],
				createdAt: 102,
				revokedAt: null,
				lastUsedAt: null,
			});
			await ctx.db.insert("api_credentials", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				name: "Active newest",
				keyId: `pk_${"b".repeat(32)}`,
				obfuscatedValue: `pk_${"b".repeat(32)}.****0000`,
				secretHash: "active-newest-hash",
				scopes: ["files:list"],
				createdAt: 103,
				revokedAt: null,
				lastUsedAt: null,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-list-active",
			external_id: db.userId,
		});
		const listed = await asUser.query(api.public_api.api_credentials_list, {
			membershipId: db.membershipId,
		});
		expect(listed._nay).toBeUndefined();
		expect(listed._yay?.slice(0, 4)).toEqual([
			expect.objectContaining({ name: "Active newest", revokedAt: null }),
			expect.objectContaining({ name: "Active older", revokedAt: null }),
			expect.objectContaining({ name: "Revoked 100", revokedAt: 101 }),
			expect.objectContaining({ name: "Revoked 99", revokedAt: 100 }),
		]);
		expect(listed._yay).toHaveLength(100);
	});

	test("rate-limits repeated malformed bearer tokens by client and route", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-bad-token-rate" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "public-api-bad-token-rate",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Valid after bad tokens",
			scopes: ["files:list"],
		});
		expect(created._nay).toBeUndefined();

		let lastStatus = 0;
		for (let index = 0; index < 11; index += 1) {
			const response = await t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(`bad-token-${index}`),
				body: JSON.stringify({ path: "/" }),
			});
			lastStatus = response.status;
		}

		expect(lastStatus).toBe(429);

		const validResponse = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(created._yay!.credential),
			body: JSON.stringify({ path: "/" }),
		});
		expect(validResponse.status).toBe(200);
	});

	test("rate-limits repeated well-formed unknown public API grant tokens", async () => {
		const t = test_convex();
		let lastStatus = 0;
		for (let index = 0; index < 11; index += 1) {
			const token = index.toString(16).padStart(64, "0");
			const response = await t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(token),
				body: JSON.stringify({ path: "/" }),
			});
			lastStatus = response.status;
		}

		expect(lastStatus).toBe(429);
	});

	test("returns 404 for the retired plugin host routes", async () => {
		const t = test_convex();
		for (const path of ["/api/plugins/v1/write-markdown", "/api/plugins/v1/source-temporary-url"]) {
			const response = await t.fetch(path, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			expect(response.status).toBe(404);
		}
	});
});

describe("files upload-urls", () => {
	async function seed_write_credential(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
		clerkSubject: string;
	}) {
		const asUser = args.t.withIdentity({
			issuer: "https://clerk.test",
			subject: args.clerkSubject,
			external_id: args.db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: args.db.membershipId,
			name: "Uploader",
			scopes: ["files:list", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		return { asUser, credential: created._yay!.credential };
	}

	async function post_r2_event_for_asset(args: {
		t: ReturnType<typeof test_convex>;
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		assetId: Id<"files_r2_assets">;
		bucket: string;
		size: number;
	}) {
		const liveKey = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: args.assetId,
		});
		const stagingKey = r2_create_upload_staging_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: args.assetId,
		});
		const seededBytes = r2Objects.get(liveKey);
		if (seededBytes !== undefined) {
			r2Objects.delete(liveKey);
			r2Objects.set(stagingKey, seededBytes);
		} else if (!r2Objects.has(stagingKey)) {
			r2Objects.set(stagingKey, "");
		}
		r2ObjectMetadata.set(stagingKey, { size: args.size, etag: `etag_${args.assetId}` });
		return await args.t.fetch("/api/r2/event", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_EVENTS_SECRET}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				cloudflareMessageId: `message_${args.assetId}`,
				attempts: 1,
				event: {
					action: "PutObject",
					bucket: args.bucket,
					object: {
						key: stagingKey,
						size: args.size,
						eTag: `etag_${args.assetId}`,
					},
					eventTime: "2026-08-02T00:00:00.000Z",
				},
			}),
		});
	}

	test("mints upload targets, consumes the byte quota, and skipProcessing skips conversion", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_upload_urls_test" as never);
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls" });
		const { asUser, credential } = await seed_write_credential({ t, db, clerkSubject: "upload-urls" });

		const response = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/imports/call-001.md", contentType: "text/markdown;charset=utf-8", size: 64 },
					{ path: "/imports/media/call-001.mp3", contentType: "audio/mpeg", size: 2048 },
				],
				skipProcessing: true,
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			files: Array<{ path: string; nodeId: string; uploadUrl: string; headers: Record<string, string> }>;
		};
		expect(body.files).toEqual([
			{
				path: "/imports/call-001.md",
				nodeId: expect.any(String),
				uploadUrl: expect.stringContaining("https://r2.test/upload"),
				headers: { "Content-Type": "text/markdown;charset=utf-8" },
			},
			{
				path: "/imports/media/call-001.mp3",
				nodeId: expect.any(String),
				uploadUrl: expect.stringContaining("https://r2.test/upload"),
				headers: { "Content-Type": "audio/mpeg" },
			},
		]);

		// Assets are born settled (processing skipped) and carry the orphan-sweep deadline.
		const assets = await t.run(async (ctx) => {
			const nodes = await Promise.all(
				body.files.map((file) => ctx.db.get("files_nodes", file.nodeId as Id<"files_nodes">)),
			);
			return await Promise.all(
				nodes.map((node) => (node?.assetId ? ctx.db.get("files_r2_assets", node.assetId) : Promise.resolve(null))),
			);
		});
		for (const asset of assets) {
			expect(asset?.kind).toBe("upload");
			expect(asset?.processingWorkId).toBeNull();
			expect(asset?.r2Key).toBeUndefined();
			expect(asset?.unfinalizedExpiresAt).toBeGreaterThan(Date.now());
		}

		// The quota consumed the declared bytes of the whole batch.
		const quota = await asUser.query(api.quotas.get, {
			quotaName: "public_api_upload_bytes",
			membershipId: db.membershipId,
		});
		expect(quota?.usedCount).toBe(64 + 2048);

		// The finalizer records the .md object without starting Markdown conversion.
		const mdAsset = assets[0]!;
		const eventResponse = await post_r2_event_for_asset({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: mdAsset._id,
			bucket: mdAsset.r2Bucket,
			size: 64,
		});
		expect(eventResponse.status).toBe(204);
		const finalized = await t.run(async (ctx) => ctx.db.get("files_r2_assets", mdAsset._id));
		expect(finalized?.r2Key).toBeDefined();
		expect(finalized?.unfinalizedExpiresAt).toBeUndefined();
		expect(finalized?.processingWorkId).toBeNull();
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.r2.finalize_uploaded_text_file,
			expect.anything(),
		);
	});

	test("without skipProcessing an uploaded Markdown file starts conversion", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_upload_urls_convert" as never);
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-convert" });
		const { credential } = await seed_write_credential({ t, db, clerkSubject: "upload-urls-convert" });

		const response = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [{ path: "/imports/editable.md", contentType: "text/markdown;charset=utf-8", size: 64 }],
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { files: Array<{ nodeId: string }> };
		const asset = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", body.files[0]!.nodeId as Id<"files_nodes">);
			return node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
		});
		// Not settled: the finalizer decides processing when the object lands.
		expect(asset?.processingWorkId).toBeUndefined();

		const eventResponse = await post_r2_event_for_asset({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset!._id,
			bucket: asset!.r2Bucket,
			size: 64,
		});
		expect(eventResponse.status).toBe(204);
		expect(enqueueActionSpy).toHaveBeenCalledWith(
			expect.anything(),
			internal.r2.finalize_uploaded_text_file,
			expect.objectContaining({ assetId: asset!._id }),
		);
	});

	// Objective 19(a): what makes /read work for a plain-text file is the upload conversion, so
	// this test pins the pre-conversion 404 and the post-conversion content together.
	test("an uploaded plain-text file becomes editable and /files/read returns its content", async () => {
		const t = test_convex();
		install_r2_object_reads();
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_upload_urls_read" as never);
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-read" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "upload-urls-read",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Upload reader",
			scopes: ["files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		// The client media type is deliberately generic: the classifier over the name decides.
		const content = "key: value\nother: 2\n";
		const minted = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{
						path: "/imports/notes.yaml",
						contentType: "text/plain;charset=utf-8",
						size: files_get_utf8_byte_size(content),
					},
				],
			}),
		});
		expect(minted.status).toBe(200);
		const mintedBody = (await minted.json()) as { files: Array<{ nodeId: string }> };
		const asset = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", mintedBody.files[0]!.nodeId as Id<"files_nodes">);
			return node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
		});

		// The pre-conversion pin: a stored upload is not readable, so /read answers 404.
		const readBefore = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/imports/notes.yaml" }),
		});
		expect(readBefore.status).toBe(404);

		r2Objects.set(
			r2_create_asset_key({
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				assetId: asset!._id,
			}),
			content,
		);
		const eventResponse = await post_r2_event_for_asset({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset!._id,
			bucket: asset!.r2Bucket,
			size: files_get_utf8_byte_size(content),
		});
		expect(eventResponse.status).toBe(204);
		// The Workpool enqueue is mocked, so run the conversion action directly.
		await asUser.action(internal.r2.finalize_uploaded_text_file, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: asset!._id,
			eventId: "event_upload_urls_read",
		});

		// The conversion made the node editable, so /read now serves the committed content.
		const readAfter = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/imports/notes.yaml" }),
		});
		expect(readAfter.status).toBe(200);
		expect(((await readAfter.json()) as { content: string }).content).toBe(content);
	});

	test("refuses read-only keys and grant tokens", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-scope" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "upload-urls-scope",
			external_id: db.userId,
		});
		const readOnly = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Reader",
			scopes: ["files:list", "files:read"],
		});
		expect(readOnly._nay).toBeUndefined();

		const requestBody = JSON.stringify({
			files: [{ path: "/imports/blocked.png", contentType: "image/png", size: 64 }],
		});
		const readOnlyResponse = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(readOnly._yay!.credential),
			body: requestBody,
		});
		expect(readOnlyResponse.status).toBe(403);

		// Grants can never carry write scopes, so the kind gate and the scope check both refuse them.
		const grantToken = "c".repeat(64);
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token: grantToken,
		});
		const grantResponse = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(grantToken),
			body: requestBody,
		});
		expect(grantResponse.status).toBe(403);
	});

	test("rejects invalid batches and conflicting paths with the offending path", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-validation" });
		const { credential } = await seed_write_credential({ t, db, clerkSubject: "upload-urls-validation" });
		await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/existing/report.md",
			committedMarkdown: "# Existing",
		});

		const post = async (body: unknown) =>
			await t.fetch("/api/v1/files/upload-urls", {
				method: "POST",
				headers: auth_headers(credential),
				body: JSON.stringify(body),
			});

		const nonCanonical = await post({ files: [{ path: "imports/x.png", contentType: "image/png", size: 1 }] });
		expect(nonCanonical.status).toBe(400);
		expect(await nonCanonical.json()).toEqual({
			message: "Path must be absolute and normalized",
			path: "imports/x.png",
		});

		const duplicate = await post({
			files: [
				{ path: "/imports/x.png", contentType: "image/png", size: 1 },
				{ path: "/imports/x.png", contentType: "image/png", size: 1 },
			],
		});
		expect(duplicate.status).toBe(400);
		expect(await duplicate.json()).toEqual({ message: "Duplicate path in batch", path: "/imports/x.png" });

		const conflict = await post({
			files: [{ path: "/existing/report.md", contentType: "text/markdown;charset=utf-8", size: 1 }],
			overwrite: "fail",
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({
			message: "A file already exists at this path",
			path: "/existing/report.md",
		});

		const folderCollision = await post({ files: [{ path: "/existing", contentType: "image/png", size: 1 }] });
		expect(folderCollision.status).toBe(409);
		expect(await folderCollision.json()).toEqual({
			message: "The path cannot point to a folder",
			path: "/existing",
		});

		// All-or-nothing: none of the refused batches minted anything.
		const quota = await t.run(async (ctx) =>
			ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("quotaName", "public_api_upload_bytes"),
				)
				.first(),
		);
		expect(quota).toBeNull();
	});

	test("checks restricted ancestor nodes before reporting their kind", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-restricted-owner" });
		const hiddenFileId = await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/hidden-file.md",
			committedMarkdown: "# Hidden",
		});
		await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/visible-file.md",
			committedMarkdown: "# Visible",
		});

		// A normal member, not the organization owner: the owner passes every node check by
		// definition, so an owner-held key would prove nothing here.
		const writer = await t.run(async (ctx) => {
			const now = Date.now();
			const outerId = await ctx.db.insert("files_nodes", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: files_ROOT_ID,
				name: "outer",
				path: "/outer",
				treePath: "/outer/",
				pathDepth: 1,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", outerId, { restrictedScopeNodeId: outerId });
			await ctx.db.patch("files_nodes", hiddenFileId, { restrictedScopeNodeId: hiddenFileId });

			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-upload-urls-restricted-writer" });
			// The key owner pays for this workspace, and uploads are closed to `Free`. This test wants
			// the permission answer, so put the owner on a paying plan.
			await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				now,
			});
			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				now,
			});
			return { userId, membershipId };
		});

		const asWriter = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "upload-urls-restricted-writer",
			external_id: writer.userId,
		});
		const created = await asWriter.mutation(api.public_api.api_credential_create, {
			membershipId: writer.membershipId,
			name: "Member uploader",
			scopes: ["files:write"],
		});
		expect(created._nay).toBeUndefined();
		const credential = created._yay!.credential;

		const refused = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [{ path: "/outer/media/photo.png", contentType: "image/png", size: 64 }],
			}),
		});
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: "Permission denied", path: "/outer/media/photo.png" });

		// A hidden intermediate file gets the same denial as a hidden folder. Its kind must not
		// turn the response into the visible structural 409 below.
		const hiddenFileRefused = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [{ path: "/hidden-file.md/photo.png", contentType: "image/png", size: 64 }],
			}),
		});
		expect(hiddenFileRefused.status).toBe(403);
		expect(await hiddenFileRefused.json()).toEqual({
			message: "Permission denied",
			path: "/hidden-file.md/photo.png",
		});

		// Control: an intermediate file the key owner may write still reports the structural
		// conflict importers use.
		const visibleFileConflict = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [{ path: "/visible-file.md/photo.png", contentType: "image/png", size: 64 }],
			}),
		});
		expect(visibleFileConflict.status).toBe(409);
		expect(await visibleFileConflict.json()).toEqual({
			message: "An intermediate segment is owned by a file",
			path: "/visible-file.md/photo.png",
		});

		// Control: the same key mints outside the restricted folder. Without this, a broken key or
		// missing membership would give the same 403 and the test would prove nothing.
		const allowed = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [{ path: "/open/photo.png", contentType: "image/png", size: 64 }],
			}),
		});
		expect(allowed.status).toBe(200);
	});

	test("files list reports a file as pending until its object is confirmed", async () => {
		const t = test_convex();
		install_r2_object_reads();
		vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("work_upload_urls_list" as never);
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-list" });
		const { credential } = await seed_write_credential({ t, db, clerkSubject: "upload-urls-list" });

		const minted = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [{ path: "/imports/pending.bin", contentType: "application/octet-stream", size: 512 }],
				skipProcessing: true,
			}),
		});
		expect(minted.status).toBe(200);
		await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/imports/doc.md",
			committedMarkdown: "# Ready",
		});

		const list = async (path: string) => {
			const response = await t.fetch("/api/v1/files/list", {
				method: "POST",
				headers: auth_headers(credential),
				body: JSON.stringify({ path }),
			});
			expect(response.status).toBe(200);
			return (await response.json()) as {
				items: Array<{ path: string; kind: string; status: string | null; size: number | null }>;
			};
		};

		// Before the PUT lands: the minted file is pending, the seeded file is ready with its
		// size, and folders carry no status.
		const before = await list("/imports");
		expect(before.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "/imports/pending.bin", status: "pending", size: 512 }),
				expect.objectContaining({ path: "/imports/doc.md", status: "ready", size: expect.any(Number) }),
			]),
		);
		const rootList = await list("/");
		expect(rootList.items).toEqual([
			expect.objectContaining({ path: "/imports", kind: "folder", status: null, size: null }),
		]);

		const pendingAsset = await t.run(async (ctx) => {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/imports/pending.bin")
						.eq("archiveOperationId", undefined),
				)
				.first();
			return node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
		});
		const eventResponse = await post_r2_event_for_asset({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			assetId: pendingAsset!._id,
			bucket: pendingAsset!.r2Bucket,
			size: 512,
		});
		expect(eventResponse.status).toBe(204);

		const after = await list("/imports");
		expect(after.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "/imports/pending.bin", status: "ready", size: 512 })]),
		);
	});

	test("refuses a batch that would cross the workspace upload byte budget", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-quota" });
		const { credential } = await seed_write_credential({ t, db, clerkSubject: "upload-urls-quota" });

		// Push the budget to 10 bytes below the cap, so a 64-byte file crosses it.
		await t.run(async (ctx) => {
			const now = Date.now();
			const quotaId = await quotas_db_ensure(ctx, {
				quotaName: "public_api_upload_bytes",
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				now,
			});
			const quota = await ctx.db.get("quotas", quotaId);
			await ctx.db.patch("quotas", quotaId, { usedCount: quota!.maxCount - 10, updatedAt: now });
		});

		const refused = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [{ path: "/imports/big.bin", contentType: "application/octet-stream", size: 64 }],
			}),
		});
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: "Upload quota exceeded" });

		// The refused batch neither minted a node nor consumed more budget.
		const after = await t.run(async (ctx) => {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/imports/big.bin")
						.eq("archiveOperationId", undefined),
				)
				.first();
			const quota = await ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("quotaName", "public_api_upload_bytes"),
				)
				.first();
			return { node, quota };
		});
		expect(after.node).toBeNull();
		expect(after.quota!.usedCount).toBe(after.quota!.maxCount - 10);
	});

	test("refuses a batch when the payer is on Free, before the quota doc is seeded", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-plan" });
		const { credential } = await seed_write_credential({ t, db, clerkSubject: "upload-urls-plan" });
		await t.run(async (ctx) => test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" }));

		const refused = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [{ path: "/imports/paid.bin", contentType: "application/octet-stream", size: 64 }],
			}),
		});
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: "This workspace's plan does not include file uploads" });

		// A mutation that returns `_nay` still commits whatever it wrote first, so the plan door has to
		// come before the quota doc is created. No node and no quota doc means it did.
		const after = await t.run(async (ctx) => {
			const node = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/imports/paid.bin")
						.eq("archiveOperationId", undefined),
				)
				.first();
			const quota = await ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("quotaName", "public_api_upload_bytes"),
				)
				.first();
			return { node, quota };
		});
		expect(after.node).toBeNull();
		expect(after.quota).toBeNull();
	});

	test("refuses a batch over the item cap", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-cap" });
		const { credential } = await seed_write_credential({ t, db, clerkSubject: "upload-urls-cap" });

		const response = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: Array.from({ length: 21 }, (_, index) => ({
					path: `/cap/file-${index}.bin`,
					contentType: "application/octet-stream",
					size: 8,
				})),
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ message: "Request body validation failed" });
	});

	test("a multi-file mint charges one principal unit per minted URL", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-upload-urls-charge" });
		const { credential } = await seed_write_credential({ t, db, clerkSubject: "upload-urls-charge" });

		const response = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/charge/a.bin", contentType: "application/octet-stream", size: 8 },
					{ path: "/charge/b.bin", contentType: "application/octet-stream", size: 8 },
					{ path: "/charge/c.bin", contentType: "application/octet-stream", size: 8 },
				],
			}),
		});
		expect(response.status).toBe(200);

		// Auth charged 1 and the batch charged 2 more on the same route-scoped key, so of the
		// bucket's capacity of 20 exactly 17 remain: a 17-token check passes, an 18-token one fails.
		const chargeKey = `user_api_key:${credential.split(".")[0]}:/api/v1/files/upload-urls`;
		const canTakeRemaining = await t.run(async (ctx) =>
			rate_limiter_check_by_key(ctx, { name: "public_api_principal", key: chargeKey, count: 17 }),
		);
		expect(canTakeRemaining).toBeNull();
		const canTakeOneMore = await t.run(async (ctx) =>
			rate_limiter_check_by_key(ctx, { name: "public_api_principal", key: chargeKey, count: 18 }),
		);
		expect(canTakeOneMore).not.toBeNull();
	});
});

describe("files write-many", () => {
	async function seed_bulk_writer_credential(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
		clerkSubject: string;
	}) {
		const asUser = args.t.withIdentity({
			issuer: "https://clerk.test",
			subject: args.clerkSubject,
			external_id: args.db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: args.db.membershipId,
			name: "Bulk writer",
			scopes: ["files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		return { asUser, credential: created._yay!.credential, credentialId: created._yay!.credentialId };
	}

	async function find_active_node(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
		path: string;
	}) {
		return await args.t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.db.organizationId)
						.eq("workspaceId", args.db.workspaceId)
						.eq("path", args.path)
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
	}

	test("writes new files and fills existing ones with per-item results", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-write-many" });
		const { credential } = await seed_bulk_writer_credential({ t, db, clerkSubject: "write-many" });

		const first = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/bulk/existing.md", content: "# Existing\n\nFirst version\n" }),
		});
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as { nodeId: string };

		const response = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/bulk/new-1.md", content: "# New one\n" },
					{ path: "/bulk/nested/new-2.md", content: "# New two\n" },
					{ path: "/bulk/existing.md", content: "# Existing\n\nReplaced by the batch\n" },
				],
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			written: Array<{ path: string; nodeId: string; contentType: string }>;
			errors: Array<{ path: string; message: string; errorCode: string }>;
		};
		expect(body.errors).toEqual([]);
		expect(body.written).toEqual([
			{ path: "/bulk/new-1.md", nodeId: expect.any(String), contentType: "text/markdown;charset=utf-8" },
			{ path: "/bulk/nested/new-2.md", nodeId: expect.any(String), contentType: "text/markdown;charset=utf-8" },
			// Same fill-in-place behavior as the single route: the nodeId stays stable.
			{ path: "/bulk/existing.md", nodeId: firstBody.nodeId, contentType: "text/markdown;charset=utf-8" },
		]);

		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/bulk/existing.md" }),
		});
		expect(readResponse.status).toBe(200);
		expect(((await readResponse.json()) as { content: string }).content).toContain("Replaced by the batch");

		// Every published write consumed its stage; nothing is left for the cleanup cron.
		const stages = await t.run(async (ctx) => await ctx.db.query("public_api_file_write_stages").collect());
		expect(stages).toEqual([]);

		// Publishing also cleared every sweep deadline: no finalized asset is left sweepable.
		const assets = await t.run(async (ctx) => await ctx.db.query("files_r2_assets").collect());
		const finalizedAssets = assets.filter((asset) => asset.r2Key !== undefined);
		expect(finalizedAssets.length).toBeGreaterThan(0);
		for (const asset of finalizedAssets) {
			expect(asset.unfinalizedExpiresAt).toBeUndefined();
		}
	});

	test("refuses an oversized or overfull batch", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-write-many-limits" });
		const { credential } = await seed_bulk_writer_credential({ t, db, clerkSubject: "write-many-limits" });

		// One item over the 8 MB whole-request cap is refused without being buffered.
		const oversized = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ files: [{ path: "/big.md", content: "x".repeat(8_500_000) }] }),
		});
		expect(oversized.status).toBe(400);
		expect(await oversized.json()).toEqual({ message: "Request body is too large" });

		// One item over the batch item cap fails shape validation.
		const overfull = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: Array.from({ length: 21 }, (_, index) => ({ path: `/cap/file-${index}.md`, content: "# Cap\n" })),
			}),
		});
		expect(overfull.status).toBe(400);
		expect(await overfull.json()).toEqual({ message: "Request body validation failed" });

		for (const path of ["/big.md", "/cap/file-0.md"]) {
			expect(await find_active_node({ t, db, path })).toBeNull();
		}
	});

	test("a credential revoked mid-batch aborts the request with 401", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-write-many-revoked" });
		const { credential, credentialId } = await seed_bulk_writer_credential({
			t,
			db,
			clerkSubject: "write-many-revoked",
		});

		// Revoke the credential while the second file's staged objects upload, after the first
		// file already published. The publish revalidation then refuses every later item.
		const stubbedFetch = globalThis.fetch;
		let stagedPutCount = 0;
		vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
				stagedPutCount += 1;
				// Each created file PUTs two staged objects, so count 3 is the second file's first PUT.
				if (stagedPutCount === 3) {
					await t.run(async (ctx) => {
						await ctx.db.patch("api_credentials", credentialId, { revokedAt: Date.now() });
					});
				}
			}
			return await stubbedFetch(url, init);
		});

		const response = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/abort/first.md", content: "# First\n" },
					{ path: "/abort/second.md", content: "# Second\n" },
					{ path: "/abort/third.md", content: "# Third\n" },
				],
			}),
		});
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: "Unauthenticated" });

		// The first file survived; the aborted items were never published and left no stage.
		expect(await find_active_node({ t, db, path: "/abort/first.md" })).not.toBeNull();
		expect(await find_active_node({ t, db, path: "/abort/second.md" })).toBeNull();
		expect(await find_active_node({ t, db, path: "/abort/third.md" })).toBeNull();
		const stages = await t.run(async (ctx) => await ctx.db.query("public_api_file_write_stages").collect());
		expect(stages).toEqual([]);
	});

	test("refuses the whole batch when one item fails validation and writes nothing", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-write-many-validation" });
		const { credential } = await seed_bulk_writer_credential({ t, db, clerkSubject: "write-many-validation" });

		const invalid = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/ok/good.md", content: "# Good\n" },
					{ path: "/bad/report.txt", content: "# Bad\n" },
				],
			}),
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({
			message: "Path must end in a valid Markdown (.md) file name.",
			path: "/bad/report.txt",
		});

		const duplicate = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/dup/a.md", content: "# A\n" },
					{ path: "/dup/a.md", content: "# B\n" },
				],
			}),
		});
		expect(duplicate.status).toBe(400);
		expect(await duplicate.json()).toEqual({ message: "Duplicate path in batch", path: "/dup/a.md" });

		// The refused batches wrote nothing: not even their valid items exist.
		for (const path of ["/ok/good.md", "/dup/a.md"]) {
			expect(await find_active_node({ t, db, path })).toBeNull();
		}
		const stages = await t.run(async (ctx) => await ctx.db.query("public_api_file_write_stages").collect());
		expect(stages).toEqual([]);
	});

	test("a per-item conflict leaves the other items written and reported", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-write-many-conflict" });
		const { credential } = await seed_bulk_writer_credential({ t, db, clerkSubject: "write-many-conflict" });

		const first = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/bulk-c/existing.md", content: "# Existing\n" }),
		});
		expect(first.status).toBe(200);

		const response = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/bulk-c/new-1.md", content: "# New one\n" },
					{ path: "/bulk-c/existing.md", content: "# Clobber\n", overwrite: "fail" },
					{ path: "/bulk-c/new-2.md", content: "# New two\n" },
				],
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			written: Array<{ path: string; nodeId: string; contentType: string }>;
			errors: Array<{ path: string; message: string; errorCode: string }>;
		};
		expect(body.written.map((file) => file.path)).toEqual(["/bulk-c/new-1.md", "/bulk-c/new-2.md"]);
		expect(body.errors).toEqual([
			{ path: "/bulk-c/existing.md", message: "A file already exists at this path", errorCode: "conflict" },
		]);

		// The item after the conflict was still written.
		expect(await find_active_node({ t, db, path: "/bulk-c/new-2.md" })).not.toBeNull();
	});

	test("refuses read-only keys and public API grants", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-write-many-scope" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "write-many-scope",
			external_id: db.userId,
		});
		const readOnly = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Read only",
			scopes: ["files:list", "files:read"],
		});
		expect(readOnly._nay).toBeUndefined();

		const files = [{ path: "/refused/a.md", content: "# A\n" }];
		const readOnlyResponse = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(readOnly._yay!.credential),
			body: JSON.stringify({ files }),
		});
		expect(readOnlyResponse.status).toBe(403);

		const grantToken = "ab".repeat(32);
		await seed_public_api_grant({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			token: grantToken,
		});
		const grantResponse = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(grantToken),
			body: JSON.stringify({ files }),
		});
		expect(grantResponse.status).toBe(403);

		expect(await find_active_node({ t, db, path: "/refused/a.md" })).toBeNull();
	});

	test("skipIfUnchanged marks unchanged items and still writes changed ones", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-write-many-skip" });
		const { credential } = await seed_bulk_writer_credential({ t, db, clerkSubject: "write-many-skip" });

		const stable = "# Stable\n\nSame on both runs\n";
		const firstRun = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/rerun/stable.md", content: stable },
					{ path: "/rerun/changed.md", content: "# Before\n" },
				],
			}),
		});
		expect(firstRun.status).toBe(200);
		const firstBody = (await firstRun.json()) as { written: Array<{ path: string; nodeId: string }> };
		const stableNodeId = firstBody.written[0]!.nodeId;

		const count_stable_snapshots = async () =>
			await t.run(
				async (ctx) =>
					(await ctx.db.query("files_snapshots").collect()).filter((snapshot) => snapshot.fileNodeId === stableNodeId)
						.length,
			);
		const stableSnapshotsBefore = await count_stable_snapshots();

		const rerun = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/rerun/stable.md", content: stable },
					{ path: "/rerun/changed.md", content: "# After\n" },
				],
				skipIfUnchanged: true,
			}),
		});
		expect(rerun.status).toBe(200);
		const rerunBody = (await rerun.json()) as {
			written: Array<{ path: string; nodeId: string; contentType: string; unchanged?: boolean }>;
			errors: Array<unknown>;
		};
		expect(rerunBody.errors).toEqual([]);
		expect(rerunBody.written).toEqual([
			{ path: "/rerun/stable.md", nodeId: stableNodeId, contentType: "text/markdown;charset=utf-8", unchanged: true },
			{
				path: "/rerun/changed.md",
				nodeId: firstBody.written[1]!.nodeId,
				contentType: "text/markdown;charset=utf-8",
			},
		]);

		// The unchanged file gained no new version snapshot; the changed one was rewritten.
		expect(await count_stable_snapshots()).toBe(stableSnapshotsBefore);
		const readResponse = await t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/rerun/changed.md" }),
		});
		expect(readResponse.status).toBe(200);
		expect(((await readResponse.json()) as { content: string }).content).toContain("After");
	});

	test("an exhausted bulk bucket rejects the whole batch before any write", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-write-many-rate" });
		const { credential } = await seed_bulk_writer_credential({ t, db, clerkSubject: "write-many-rate" });

		// Drain the whole bulk bucket for this credential's principal key up front.
		const drained = await t.run(async (ctx) =>
			rate_limiter_limit_by_key(ctx, {
				name: "public_api_files_write_bulk",
				key: `user_api_key:${credential.split(".")[0]}`,
				count: 100,
			}),
		);
		expect(drained).toBeNull();

		const blocked = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: Array.from({ length: 20 }, (_, index) => ({
					path: `/blocked/file-${index}.md`,
					content: "# Blocked\n",
				})),
			}),
		});
		expect(blocked.status).toBe(429);
		const blockedBody = (await blocked.json()) as { message: string; retryAfterMs: number };
		expect(typeof blockedBody.retryAfterMs).toBe("number");

		// The refused batch staged and wrote nothing.
		expect(await find_active_node({ t, db, path: "/blocked/file-0.md" })).toBeNull();
		const stages = await t.run(async (ctx) => await ctx.db.query("public_api_file_write_stages").collect());
		expect(stages).toEqual([]);
	});
});

describe("files write billing", () => {
	async function seed_billing_writer(args: { t: ReturnType<typeof test_convex>; clerkSubject: string }) {
		const db = await seed_signed_in_membership({ t: args.t, clerkUserId: `clerk-${args.clerkSubject}` });
		const asUser = args.t.withIdentity({
			issuer: "https://clerk.test",
			subject: args.clerkSubject,
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Billing writer",
			scopes: ["files:list", "files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		return { db, credential: created._yay!.credential };
	}

	/**
	 * Move the payer to Free and empty the meter, which is the only state the credit gate refuses.
	 */
	async function drain_credits(args: { t: ReturnType<typeof test_convex>; userId: Id<"users"> }) {
		await args.t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: args.userId, plan: "Free" });
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", args.userId))
				.first();
			if (!snapshot?.meter) {
				throw new Error("Expected a seeded usage snapshot");
			}
			await ctx.db.patch("billing_usage_snapshots", snapshot._id, {
				meter: { ...snapshot.meter, balance: 0 },
			});
		});
	}

	function spy_billing_enqueue() {
		const spy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_public_api_billing_test" as never);
		// Generated-API references are proxies without stable identity, so compare function names.
		const ingestName = getFunctionName(internal.billing.ingest_events);
		const file_save_events = () =>
			spy.mock.calls
				.filter((call) => getFunctionName(call[1] as never) === ingestName)
				.flatMap((call) => (call[2] as { events: Array<Record<string, unknown>> }).events);
		return { spy, file_save_events };
	}

	async function read_version_snapshot_asset_ids(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
		nodeId: string;
	}) {
		return await args.t.run(async (ctx) => {
			const snapshots = await ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q
						.eq("organizationId", args.db.organizationId)
						.eq("workspaceId", args.db.workspaceId)
						.eq("fileNodeId", args.nodeId as Id<"files_nodes">),
				)
				.order("asc")
				.collect();
			return snapshots.map((snapshot) => snapshot.assetId);
		});
	}

	test("the write route refuses with 402 when the payer has no credits and writes nothing", async () => {
		const t = test_convex();
		const { db, credential } = await seed_billing_writer({ t, clerkSubject: "write-billing-402" });
		await drain_credits({ t, userId: db.userId });

		const refused = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/billing/refused.md", content: "# Refused\n" }),
		});
		expect(refused.status).toBe(402);
		expect(await refused.json()).toEqual({ message: "Insufficient funds" });

		const node = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/billing/refused.md")
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
		expect(node).toBeNull();
	});

	test("a create and a fill each emit one file_save with their content snapshot asset id", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const { db, credential } = await seed_billing_writer({ t, clerkSubject: "write-billing-emit" });
		const { file_save_events } = spy_billing_enqueue();

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/billing/report.md", content: "# Report\n" }),
		});
		expect(written.status).toBe(200);
		const writtenBody = (await written.json()) as { nodeId: string };

		const filled = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/billing/report.md", content: "# Report\n\nFilled\n" }),
		});
		expect(filled.status).toBe(200);
		expect(((await filled.json()) as { nodeId: string }).nodeId).toBe(writtenBody.nodeId);

		// The create's version part is the staged content snapshot that became the first version
		// snapshot; the fill's is the snapshot its own publish stored. One version-snapshot row per
		// committed write, in order.
		const snapshotAssetIds = await read_version_snapshot_asset_ids({ t, db, nodeId: writtenBody.nodeId });
		expect(snapshotAssetIds).toHaveLength(2);
		const events = file_save_events();
		expect(events).toHaveLength(2);
		for (const [index, event] of events.entries()) {
			expect(event).toEqual(
				expect.objectContaining({
					name: "file_save",
					externalCustomerId: db.userId,
					externalMemberId: db.userId,
					externalId: `file_save::${db.userId}::${db.userId}::${db.organizationId}::${db.workspaceId}::${writtenBody.nodeId}::${snapshotAssetIds[index]}`,
					metadata: expect.objectContaining({
						amount: 1,
						actorUserId: db.userId,
						billedUserId: db.userId,
						version: String(snapshotAssetIds[index]),
					}),
				}),
			);
		}
	});

	test("a skipIfUnchanged no-op emits nothing but is still gated", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const { db, credential } = await seed_billing_writer({ t, clerkSubject: "write-billing-skip" });
		const { file_save_events } = spy_billing_enqueue();

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/billing/skip.md", content: "# Same\n" }),
		});
		expect(written.status).toBe(200);
		expect(file_save_events()).toHaveLength(1);

		const unchanged = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/billing/skip.md", content: "# Same\n", skipIfUnchanged: true }),
		});
		expect(unchanged.status).toBe(200);
		expect(((await unchanged.json()) as { unchanged?: boolean }).unchanged).toBe(true);
		// No publish happened, so no second event.
		expect(file_save_events()).toHaveLength(1);

		// The gate runs before the unchanged comparison: a broke Free payer is refused even for a
		// write that would have changed nothing.
		await drain_credits({ t, userId: db.userId });
		const refused = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/billing/skip.md", content: "# Same\n", skipIfUnchanged: true }),
		});
		expect(refused.status).toBe(402);
		expect(await refused.json()).toEqual({ message: "Insufficient funds" });
	});

	test("touch stays free: a broke payer still creates empty placeholders and no event is sent", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const { db, credential } = await seed_billing_writer({ t, clerkSubject: "write-billing-touch" });
		const { file_save_events } = spy_billing_enqueue();
		await drain_credits({ t, userId: db.userId });

		const touched = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ paths: ["/billing/placeholder.md"] }),
		});
		expect(touched.status).toBe(200);
		const touchedBody = (await touched.json()) as { files: Array<{ path: string; created: boolean }> };
		expect(touchedBody.files).toEqual([expect.objectContaining({ path: "/billing/placeholder.md", created: true })]);
		expect(file_save_events()).toHaveLength(0);
	});

	test("write-many refuses the whole batch with 402 and stages nothing", async () => {
		const t = test_convex();
		const { db, credential } = await seed_billing_writer({ t, clerkSubject: "write-many-billing-402" });
		await drain_credits({ t, userId: db.userId });

		const refused = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/billing/batch-1.md", content: "# One\n" },
					{ path: "/billing/batch-2.md", content: "# Two\n" },
				],
			}),
		});
		expect(refused.status).toBe(402);
		expect(await refused.json()).toEqual({ message: "Insufficient funds" });

		const after = await t.run(async (ctx) => {
			const nodes = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", db.organizationId)
						.eq("workspaceId", db.workspaceId)
						.eq("path", "/billing/batch-1.md")
						.eq("archiveOperationId", undefined),
				)
				.collect();
			const stages = await ctx.db.query("public_api_file_write_stages").collect();
			return { nodes, stages };
		});
		expect(after.nodes).toEqual([]);
		expect(after.stages).toEqual([]);
	});

	test("write-many emits one event per written item and none for a per-item conflict", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const { credential } = await seed_billing_writer({ t, clerkSubject: "write-many-billing-emit" });
		const { file_save_events } = spy_billing_enqueue();

		const first = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/billing/existing.md", content: "# Existing\n" }),
		});
		expect(first.status).toBe(200);
		expect(file_save_events()).toHaveLength(1);

		const response = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({
				files: [
					{ path: "/billing/new-1.md", content: "# New one\n" },
					{ path: "/billing/new-2.md", content: "# New two\n" },
					{ path: "/billing/existing.md", content: "# Conflict\n", overwrite: "fail" },
				],
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			written: Array<{ path: string }>;
			errors: Array<{ path: string; errorCode: string }>;
		};
		expect(body.written).toHaveLength(2);
		expect(body.errors).toEqual([expect.objectContaining({ path: "/billing/existing.md", errorCode: "conflict" })]);

		// One event per committed item; the refused item emits nothing.
		expect(file_save_events()).toHaveLength(3);
	});

	test("an owner-billed organization charges the owner while the actor stays attributed", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const { db, credential } = await seed_billing_writer({ t, clerkSubject: "write-billing-owner" });
		const { file_save_events } = spy_billing_enqueue();

		// Rewire the seeded organization to owner billing with a different paying owner.
		const ownerId = await t.run(async (ctx) => {
			const owner = await ctx.db.insert("users", { clerkUserId: "clerk-write-billing-org-owner" });
			await test_mocks_fill_db_with.plan(ctx, { userId: owner, plan: "Pay As You Go" });
			await ctx.db.patch("organizations", db.organizationId, {
				default: false,
				billingMode: "organization_owner",
				ownerUserId: owner,
			});
			// The actor wrote through the organization-owner shortcut before the rewire, so give
			// the actor an explicit member role to keep write authority.
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				role: "member",
				now: Date.now(),
			});
			return owner;
		});

		const written = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/billing/owner.md", content: "# Owner billed\n" }),
		});
		expect(written.status).toBe(200);

		const events = file_save_events();
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual(
			expect.objectContaining({
				externalCustomerId: ownerId,
				externalMemberId: db.userId,
				metadata: expect.objectContaining({
					billedUserId: ownerId,
					actorUserId: db.userId,
				}),
			}),
		);
	});
});

describe("files read-only locks", () => {
	async function seed_locks_writer(args: { t: ReturnType<typeof test_convex>; clerkUserId: string }) {
		const db = await seed_signed_in_membership({ t: args.t, clerkUserId: args.clerkUserId });
		const asUser = args.t.withIdentity({
			issuer: "https://clerk.test",
			subject: args.clerkUserId,
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Lock writer",
			scopes: ["files:read", "files:write"],
		});
		expect(created._nay).toBeUndefined();
		return { db, asUser, credential: created._yay!.credential, credentialId: created._yay!.credentialId };
	}

	async function seed_locks_member_writer(args: { t: ReturnType<typeof test_convex>; clerkUserId: string }) {
		const db = await seed_signed_in_membership({ t: args.t, clerkUserId: `${args.clerkUserId}-owner` });
		const member = await args.t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: args.clerkUserId });
			// The write route's credit gate bills the acting member, so the fixture pays.
			await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				now,
			});
			await quotas_db_ensure(ctx, {
				quotaName: "active_api_credentials",
				userId,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				now,
			});
			return { userId, membershipId };
		});

		const asUser = args.t.withIdentity({
			issuer: "https://clerk.test",
			subject: args.clerkUserId,
			external_id: member.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: member.membershipId,
			name: "Lock race writer",
			scopes: ["files:write"],
		});
		expect(created._nay).toBeUndefined();
		const owner = args.t.withIdentity({
			issuer: "https://clerk.test",
			subject: `${args.clerkUserId}-owner`,
			external_id: db.userId,
		});
		return {
			db,
			owner,
			userId: member.userId,
			credential: created._yay!.credential,
			credentialId: created._yay!.credentialId,
		};
	}

	async function find_active_node(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
		path: string;
	}) {
		return await args.t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.db.organizationId)
						.eq("workspaceId", args.db.workspaceId)
						.eq("path", args.path)
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
	}

	async function set_lock(args: {
		writer: Awaited<ReturnType<typeof seed_locks_writer>>;
		nodeId: Id<"files_nodes">;
		locked: boolean;
	}) {
		const result = args.locked
			? await args.writer.asUser.mutation(api.files_nodes.set_node_read_only, {
					membershipId: args.writer.db.membershipId,
					nodeId: args.nodeId,
				})
			: await args.writer.asUser.mutation(api.files_nodes.set_node_writable, {
					membershipId: args.writer.db.membershipId,
					nodeId: args.nodeId,
				});
		expect(result._nay).toBeUndefined();
	}

	/**
	 * Keep every enqueued deletion-ledger job row visible to assertions: a rejected confirmed
	 * delete records a failed attempt instead of settling the job away.
	 */
	function stub_confirmed_deletes() {
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockRejectedValue(
			new Error("confirmed delete disabled in this test"),
		);
	}

	function defer_file_stage_puts() {
		const installedFetch = globalThis.fetch;
		let startedPutCount = 0;
		let markPutsStarted: () => void = () => {};
		let releasePuts: () => void = () => {};
		const putsStarted = new Promise<void>((resolve) => {
			markPutsStarted = resolve;
		});
		const putsReleased = new Promise<void>((resolve) => {
			releasePuts = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
					startedPutCount += 1;
					if (startedPutCount === 2) {
						markPutsStarted();
					}
					await putsReleased;
				}
				return await installedFetch(input, init);
			}),
		);
		return { putsStarted, releasePuts };
	}

	async function seed_restricted_root_folder(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
		name: string;
	}) {
		return await args.t.run(async (ctx) => {
			const now = Date.now();
			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: args.db.organizationId,
				workspaceId: args.db.workspaceId,
				parentId: files_ROOT_ID,
				name: args.name,
				path: `/${args.name}`,
				treePath: `/${args.name}/`,
				pathDepth: 1,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: args.db.userId,
				updatedBy: args.db.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			return nodeId;
		});
	}

	async function write_file(args: {
		t: ReturnType<typeof test_convex>;
		credential: string;
		path: string;
		content: string;
		overwrite?: "replace" | "fail";
		skipIfUnchanged?: boolean;
	}) {
		return await args.t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(args.credential),
			body: JSON.stringify({
				path: args.path,
				content: args.content,
				...(args.overwrite ? { overwrite: args.overwrite } : {}),
				...(args.skipIfUnchanged === undefined ? {} : { skipIfUnchanged: args.skipIfUnchanged }),
			}),
		});
	}

	async function read_file_content(args: { t: ReturnType<typeof test_convex>; credential: string; path: string }) {
		const response = await args.t.fetch("/api/v1/files/read", {
			method: "POST",
			headers: auth_headers(args.credential),
			body: JSON.stringify({ path: args.path }),
		});
		expect(response.status).toBe(200);
		return ((await response.json()) as { content: string }).content;
	}

	test("a locked file answers the public write with a 409 conflict while the internal name stays read_only", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-write" });
		const nodeId = await seed_markdown_file({
			t,
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			path: "/locks/doc.md",
			committedMarkdown: "# Original\n",
		});

		await set_lock({ writer, nodeId, locked: true });

		const refused = await write_file({ t, credential: writer.credential, path: "/locks/doc.md", content: "# Change\n" });
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ message: "This item is read-only." });

		// The public vocabulary is 409/conflict; the internal refusal keeps its `read_only` name.
		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/locks/doc.md",
			overwrite: "replace",
			contentSize: 9,
			yjsSnapshotSize: 0,
		});
		expect(prepared._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });

		// The first check refused the write before it created temporary docs.
		expect(await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").collect())).toEqual([]);
		expect(await read_file_content({ t, credential: writer.credential, path: "/locks/doc.md" })).toContain("# Original");

		// Unlock the file and prove the same write now works.
		await set_lock({ writer, nodeId, locked: false });
		const allowed = await write_file({ t, credential: writer.credential, path: "/locks/doc.md", content: "# Change\n" });
		expect(allowed.status).toBe(200);
		expect(await read_file_content({ t, credential: writer.credential, path: "/locks/doc.md" })).toContain("# Change");
	});

	test("a locked destination folder refuses new files under it until unlocked", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-folder" });

		const seeded = await write_file({ t, credential: writer.credential, path: "/locked-dir/seed.md", content: "# Seed\n" });
		expect(seeded.status).toBe(200);
		const folder = await find_active_node({ t, db: writer.db, path: "/locked-dir" });
		expect(folder).not.toBeNull();

		await set_lock({ writer, nodeId: folder!._id, locked: true });

		// Direct child, and a deeper path whose deepest existing ancestor is the locked folder.
		for (const path of ["/locked-dir/other.md", "/locked-dir/deep/nested.md"]) {
			const refused = await write_file({ t, credential: writer.credential, path, content: "# Nope\n" });
			expect(refused.status).toBe(409);
			expect(await refused.json()).toEqual({ message: "This item is read-only." });
		}
		expect(await find_active_node({ t, db: writer.db, path: "/locked-dir/other.md" })).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").collect())).toEqual([]);
		// The refusal happened while preparing, before the stage uploaded anything. A refusal that
		// only came at publish time would have uploaded both R2 objects first and left cleanup jobs
		// for them behind.
		expect(await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual([]);

		// Unlock the folder and prove the same write now works.
		await set_lock({ writer, nodeId: folder!._id, locked: false });
		const allowed = await write_file({ t, credential: writer.credential, path: "/locked-dir/other.md", content: "# Yes\n" });
		expect(allowed.status).toBe(200);
	});

	test("write-many reports a locked item as a per-item conflict and still writes the others", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-write-many" });

		const seeded = await write_file({ t, credential: writer.credential, path: "/bulk-lock/locked.md", content: "# Keep\n" });
		expect(seeded.status).toBe(200);
		const lockedNode = await find_active_node({ t, db: writer.db, path: "/bulk-lock/locked.md" });
		await set_lock({ writer, nodeId: lockedNode!._id, locked: true });

		const response = await t.fetch("/api/v1/files/write-many", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({
				files: [
					{ path: "/bulk-lock/a.md", content: "# A\n" },
					{ path: "/bulk-lock/locked.md", content: "# Overwrite attempt\n" },
					{ path: "/bulk-lock/b.md", content: "# B\n" },
				],
			}),
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			written: Array<{ path: string; nodeId: string; contentType: string }>;
			errors: Array<{ path: string; message: string; errorCode: string }>;
		};
		// The locked item is a per-item conflict; the item after it still ran and succeeded.
		expect(body.errors).toEqual([
			{ path: "/bulk-lock/locked.md", message: "This item is read-only.", errorCode: "conflict" },
		]);
		expect(body.written).toEqual([
			{ path: "/bulk-lock/a.md", nodeId: expect.any(String), contentType: "text/markdown;charset=utf-8" },
			{ path: "/bulk-lock/b.md", nodeId: expect.any(String), contentType: "text/markdown;charset=utf-8" },
		]);
		expect(await read_file_content({ t, credential: writer.credential, path: "/bulk-lock/locked.md" })).toContain(
			"# Keep",
		);
	});

	test("skipIfUnchanged answers 409 on a locked target instead of confirming the content", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-skip" });

		const seeded = await write_file({ t, credential: writer.credential, path: "/skip-lock/doc.md", content: "# Same\n" });
		expect(seeded.status).toBe(200);

		// First prove an unchanged write returns 200 while the file is writable.
		const skipped = await write_file({
			t,
			credential: writer.credential,
			path: "/skip-lock/doc.md",
			content: "# Same\n",
			skipIfUnchanged: true,
		});
		expect(skipped.status).toBe(200);
		expect(((await skipped.json()) as { unchanged?: boolean }).unchanged).toBe(true);

		const node = await find_active_node({ t, db: writer.db, path: "/skip-lock/doc.md" });
		await set_lock({ writer, nodeId: node!._id, locked: true });

		// A 200 here would confirm the exact content of a file the caller cannot write.
		const refused = await write_file({
			t,
			credential: writer.credential,
			path: "/skip-lock/doc.md",
			content: "# Same\n",
			skipIfUnchanged: true,
		});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ message: "This item is read-only." });
		expect(await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").collect())).toEqual([]);
	});

	test("touch refuses locked targets and locked destinations and keeps earlier touches committed", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-touch" });

		// Locked existing target: the already-exists shortcut answers the conflict itself.
		const seeded = await write_file({ t, credential: writer.credential, path: "/touch-locked.md", content: "# Hold\n" });
		expect(seeded.status).toBe(200);
		const lockedFile = await find_active_node({ t, db: writer.db, path: "/touch-locked.md" });
		await set_lock({ writer, nodeId: lockedFile!._id, locked: true });
		const refusedExisting = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({ paths: ["/touch-locked.md"] }),
		});
		expect(refusedExisting.status).toBe(409);
		expect(await refusedExisting.json()).toEqual({ message: "This item is read-only." });

		// Locked destination folder: the batch refuses at the locked path, but the touch a loop
		// turn earlier already committed and stays.
		const dirSeed = await write_file({ t, credential: writer.credential, path: "/touch-dir/seed.md", content: "# S\n" });
		expect(dirSeed.status).toBe(200);
		const folder = await find_active_node({ t, db: writer.db, path: "/touch-dir" });
		await set_lock({ writer, nodeId: folder!._id, locked: true });
		const refusedBatch = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({ paths: ["/touch-fresh.md", "/touch-dir/new.md"] }),
		});
		expect(refusedBatch.status).toBe(409);
		expect(await refusedBatch.json()).toEqual({ message: "This item is read-only." });
		expect(await find_active_node({ t, db: writer.db, path: "/touch-fresh.md" })).not.toBeNull();
		expect(await find_active_node({ t, db: writer.db, path: "/touch-dir/new.md" })).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").collect())).toEqual([]);

		// Unlock the folder and prove the same touch now works.
		await set_lock({ writer, nodeId: folder!._id, locked: false });
		const allowed = await t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({ paths: ["/touch-dir/new.md"] }),
		});
		expect(allowed.status).toBe(200);
		const allowedBody = (await allowed.json()) as { files: Array<{ path: string; created: boolean }> };
		expect(allowedBody.files).toEqual([{ path: "/touch-dir/new.md", nodeId: expect.any(String), created: true }]);
	});

	test("upload-urls refuses a locked occupant or ancestor before minting anything", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-upload-urls" });

		const seeded = await write_file({ t, credential: writer.credential, path: "/up/occupied.md", content: "# Keep\n" });
		expect(seeded.status).toBe(200);
		const occupant = await find_active_node({ t, db: writer.db, path: "/up/occupied.md" });
		await set_lock({ writer, nodeId: occupant!._id, locked: true });

		const countsBefore = await t.run(async (ctx) => ({
			assets: (await ctx.db.query("files_r2_assets").collect()).length,
			nodes: (await ctx.db.query("files_nodes").collect()).length,
		}));

		// One locked replacement occupant refuses the whole batch and names the offending path.
		const refusedOccupant = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({
				files: [
					{ path: "/up/fresh.bin", contentType: "application/octet-stream", size: 10 },
					{ path: "/up/occupied.md", contentType: "text/markdown;charset=utf-8", size: 5 },
				],
			}),
		});
		expect(refusedOccupant.status).toBe(409);
		expect(await refusedOccupant.json()).toEqual({ message: "This item is read-only.", path: "/up/occupied.md" });

		// A locked ancestor folder refuses the batch the same way.
		const folder = await find_active_node({ t, db: writer.db, path: "/up" });
		await set_lock({ writer, nodeId: folder!._id, locked: true });
		const refusedAncestor = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({
				files: [{ path: "/up/sub/data.bin", contentType: "application/octet-stream", size: 7 }],
			}),
		});
		expect(refusedAncestor.status).toBe(409);
		expect(await refusedAncestor.json()).toEqual({ message: "This item is read-only.", path: "/up/sub/data.bin" });

		// Nothing was minted: no asset docs, no nodes, no quota consumption.
		const countsAfter = await t.run(async (ctx) => ({
			assets: (await ctx.db.query("files_r2_assets").collect()).length,
			nodes: (await ctx.db.query("files_nodes").collect()).length,
		}));
		expect(countsAfter).toEqual(countsBefore);
		expect(await find_active_node({ t, db: writer.db, path: "/up/fresh.bin" })).toBeNull();
		// No quota doc was even seeded: the refusal ran before the quota ensure/charge step.
		const quota = await t.run(async (ctx) =>
			(await ctx.db.query("quotas").collect()).find((doc) => doc.quotaName === "public_api_upload_bytes"),
		);
		expect(quota?.usedCount ?? 0).toBe(0);

		// Unlock the folder and prove a new upload URL can be created. The asset stores the staging
		// key and URL deadline that the accepted upload needs.
		await set_lock({ writer, nodeId: folder!._id, locked: false });
		const allowed = await t.fetch("/api/v1/files/upload-urls", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({
				files: [{ path: "/up/fresh.bin", contentType: "application/octet-stream", size: 10 }],
			}),
		});
		expect(allowed.status).toBe(200);
		const allowedBody = (await allowed.json()) as { files: Array<{ path: string; nodeId: string }> };
		const mintedAsset = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", allowedBody.files[0]!.nodeId as Id<"files_nodes">);
			return node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
		});
		expect(mintedAsset?.uploadStagingR2Key).toContain(`/upload-staging/${mintedAsset?._id}`);
		expect(mintedAsset?.uploadUrlExpiresAt).toBeGreaterThan(Date.now());
	});

	test("a lock taken while a write is staged refuses the publish and ledgers the staged objects", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-stage-race" });

		// A stored (non-editable) Markdown occupant keeps the write on the archive-and-recreate
		// door, which is the door this stage publishes through.
		const occupant = await writer.asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: writer.db.membershipId,
			parentId: "root",
			filename: "race.md",
			contentType: "text/markdown;charset=utf-8",
			size: 3,
		});
		expect(occupant._nay).toBeUndefined();
		const occupantNodeId = occupant._yay!.nodeId;

		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/race.md",
			overwrite: "replace",
			contentSize: 7,
			yjsSnapshotSize: 7,
		});
		expect(prepared._nay).toBeUndefined();
		expect(prepared._yay!.targetAnchor).toEqual({
			kind: "existing",
			nodeId: occupantNodeId,
		});

		// The race: the lock lands after staging, before publication.
		await set_lock({ writer, nodeId: occupantNodeId, locked: true });

		const published = await t.mutation(internal.public_api.publish_file_write, {
			stageId: prepared._yay!.stageId,
			content: "# New\n",
			targetAnchor: prepared._yay!.targetAnchor,
		});
		expect(published._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });

		// The refusal abandoned the stage in the same transaction: staged keys are in the durable
		// deletion ledger, the stage and asset docs are gone, and the target is untouched.
		const stagedKeys = [prepared._yay!.yjsSnapshotAssetId, prepared._yay!.contentSnapshotAssetId].map((assetId) =>
			r2_create_asset_key({
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				assetId,
			}),
		);
		const jobs = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.map((job) => job.r2Key).sort()).toEqual([...stagedKeys].sort());
		for (const job of jobs) {
			expect(job.reason).toBe("read_only_stage");
			expect(job.putMayArriveUntil).toBeUndefined();
		}
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_r2_assets", prepared._yay!.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", prepared._yay!.contentSnapshotAssetId)).toBeNull();
			expect(await ctx.db.query("public_api_file_write_stages").collect()).toEqual([]);
			const target = await ctx.db.get("files_nodes", occupantNodeId);
			expect(target?.archiveOperationId).toBeUndefined();
		});

		// Unlock the file and prove the same write now works.
		await set_lock({ writer, nodeId: occupantNodeId, locked: false });
		const prepared2 = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/race.md",
			overwrite: "replace",
			contentSize: 7,
			yjsSnapshotSize: 7,
		});
		expect(prepared2._nay).toBeUndefined();
		expect(prepared2._yay!.targetAnchor).toMatchObject({ kind: "existing" });
		const published2 = await t.mutation(internal.public_api.publish_file_write, {
			stageId: prepared2._yay!.stageId,
			content: "# New\n",
			targetAnchor: prepared2._yay!.targetAnchor,
		});
		expect(published2._nay).toBeUndefined();
		const replaced = await find_active_node({ t, db: writer.db, path: "/race.md" });
		expect(replaced?._id).toBe(published2._yay!.nodeId);
	});

	test("a staged write publishes after the lock is removed", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-aba" });

		const occupant = await writer.asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: writer.db.membershipId,
			parentId: "root",
			filename: "aba.md",
			contentType: "text/markdown;charset=utf-8",
			size: 3,
		});
		expect(occupant._nay).toBeUndefined();
		const occupantNodeId = occupant._yay!.nodeId;

		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/aba.md",
			overwrite: "replace",
			contentSize: 7,
			yjsSnapshotSize: 7,
		});
		expect(prepared._nay).toBeUndefined();

		// Only the lock state in the final mutation matters.
		await set_lock({ writer, nodeId: occupantNodeId, locked: true });
		await set_lock({ writer, nodeId: occupantNodeId, locked: false });

		const published = await t.mutation(internal.public_api.publish_file_write, {
			stageId: prepared._yay!.stageId,
			content: "# New\n",
			targetAnchor: prepared._yay!.targetAnchor,
		});
		expect(published._nay).toBeUndefined();
		expect(await find_active_node({ t, db: writer.db, path: "/aba.md" })).toMatchObject({
			_id: published._yay!.nodeId,
		});
		expect(await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").collect())).toEqual([]);
	});

	test("a lock taken while a fill is staged refuses publish_file_fill and ledgers only the content object", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-fill-race" });
		const nodeId = await seed_markdown_file({
			t,
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			path: "/fill-race/doc.md",
			committedMarkdown: "# Original\n",
		});

		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/fill-race/doc.md",
			overwrite: "replace",
			contentSize: 9,
			yjsSnapshotSize: 0,
		});
		expect(prepared._nay).toBeUndefined();
		expect(prepared._yay!.targetAnchor).toEqual({ kind: "existing", nodeId });

		await set_lock({ writer, nodeId, locked: true });

		const published = await t.mutation(internal.public_api.publish_file_fill, {
			stageId: prepared._yay!.stageId,
			content: "# Change\n",
			expectedNodeId: nodeId,
		});
		expect(published._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });

		// The fill path wrote only the content snapshot to R2, so only that key needs a deletion job.
		// Both temporary asset docs and the stage are gone.
		const contentKey = r2_create_asset_key({
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			assetId: prepared._yay!.contentSnapshotAssetId,
		});
		await t.run(async (ctx) => {
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs.map((job) => ({ r2Key: job.r2Key, reason: job.reason }))).toEqual([
				{ r2Key: contentKey, reason: "read_only_stage" },
			]);
			expect(await ctx.db.get("files_r2_assets", prepared._yay!.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", prepared._yay!.contentSnapshotAssetId)).toBeNull();
			expect(await ctx.db.query("public_api_file_write_stages").collect()).toEqual([]);
		});
		expect(await read_file_content({ t, credential: writer.credential, path: "/fill-race/doc.md" })).toContain(
			"# Original",
		);

		// Unlock the file and prove a new stage can publish.
		await set_lock({ writer, nodeId, locked: false });
		const prepared2 = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/fill-race/doc.md",
			overwrite: "replace",
			contentSize: 9,
			yjsSnapshotSize: 0,
		});
		expect(prepared2._yay!.targetAnchor).toMatchObject({ kind: "existing" });
		const lineageIds = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node?.yjsLastSequenceId) throw new Error("Expected the fill target to have a Yjs lineage");
			const oldLineageId = node.yjsLastSequenceId;
			const oldLineage = await ctx.db.get("files_yjs_docs_last_sequences", oldLineageId);
			if (!oldLineage) throw new Error("Expected the fill target lineage doc");
			const newLineageId = await ctx.db.insert("files_yjs_docs_last_sequences", {
				organizationId: oldLineage.organizationId,
				workspaceId: oldLineage.workspaceId,
				fileNodeId: oldLineage.fileNodeId,
				lastSequence: oldLineage.lastSequence,
				unmaterializedUpdateCount: oldLineage.unmaterializedUpdateCount,
				unmaterializedUpdateBytes: oldLineage.unmaterializedUpdateBytes,
				lineageGeneration: oldLineage.lineageGeneration,
			});
			await ctx.db.patch("files_nodes", nodeId, { yjsLastSequenceId: newLineageId });
			return { oldLineageId, newLineageId };
		});

		// Numeric sequence and generation can repeat after a document reset. The exact sequence-doc
		// id stops a staged fill from publishing into that new lineage.
		const staleLineage = await t.mutation(internal.public_api.publish_file_fill, {
			stageId: prepared2._yay!.stageId,
			content: "# Change\n",
			expectedNodeId: nodeId,
			expectedYjsLastSequenceId: lineageIds.oldLineageId,
		});
		expect(staleLineage._nay?.message).toBe("The file changed during the write");

		const published2 = await t.mutation(internal.public_api.publish_file_fill, {
			stageId: prepared2._yay!.stageId,
			content: "# Change\n",
			expectedNodeId: nodeId,
			expectedYjsLastSequenceId: lineageIds.newLineageId,
		});
		expect(published2._nay).toBeUndefined();
	});

	test("a create stage anchors the deepest existing ancestor and refuses when the target appears", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-anchor" });

		const seeded = await write_file({ t, credential: writer.credential, path: "/anchor/seed.md", content: "# S\n" });
		expect(seeded.status).toBe(200);

		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/anchor/sub/new.md",
			overwrite: "replace",
			contentSize: 9,
			yjsSnapshotSize: 9,
		});
		expect(prepared._nay).toBeUndefined();
		// The target does not exist yet.
		expect(prepared._yay!.targetAnchor).toEqual({ kind: "create" });

		// The expected-absent target appears while the write is staged: the stale stage must not
		// clobber it.
		const winner = await write_file({
			t,
			credential: writer.credential,
			path: "/anchor/sub/new.md",
			content: "# Winner\n",
		});
		expect(winner.status).toBe(200);

		const published = await t.mutation(internal.public_api.publish_file_write, {
			stageId: prepared._yay!.stageId,
			content: "# Loser\n",
			targetAnchor: prepared._yay!.targetAnchor,
		});
		expect(published._nay).toMatchObject({ name: "stale_write" });
		expect(await read_file_content({ t, credential: writer.credential, path: "/anchor/sub/new.md" })).toContain(
			"# Winner",
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("public_api_file_write_stages").collect()).toEqual([]);
			expect((await ctx.db.query("files_r2_object_deletion_jobs").collect()).length).toBe(2);
		});
	});

	test("a staged create refuses a current intermediate lock and succeeds after it is removed", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-epoch" });

		const seeded = await write_file({ t, credential: writer.credential, path: "/aba-dir/seed.md", content: "# S\n" });
		expect(seeded.status).toBe(200);
		const folder = await find_active_node({ t, db: writer.db, path: "/aba-dir" });

		const prepare_stage = async () =>
			await t.mutation(internal.public_api.prepare_file_write, {
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				userId: writer.db.userId,
				principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
				path: "/aba-dir/mid/new.md",
				overwrite: "replace",
				contentSize: 7,
				yjsSnapshotSize: 7,
			});
		// Two stages start while /aba-dir/mid does not exist.
		const stage1 = await prepare_stage();
		const stage3 = await prepare_stage();
		expect(stage1._nay).toBeUndefined();
		expect(stage3._nay).toBeUndefined();

		// The missing intermediate folder appears and locks while the writes are staged.
		const midId = await t.run(async (ctx) => {
			const now = Date.now();
			return await ctx.db.insert("files_nodes", {
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				parentId: folder!._id,
				name: "mid",
				path: "/aba-dir/mid",
				treePath: "/aba-dir/mid/",
				pathDepth: 2,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: writer.db.userId,
				updatedBy: writer.db.userId,
				updatedAt: now,
			});
		});
		await set_lock({ writer, nodeId: midId, locked: true });

		// Stage 1 sees the current lock and refuses.
		const published1 = await t.mutation(internal.public_api.publish_file_write, {
			stageId: stage1._yay!.stageId,
			content: "# One\n",
			targetAnchor: stage1._yay!.targetAnchor,
		});
		expect(published1._nay).toMatchObject({ name: "read_only" });

		// Stage 3 succeeds after the folder is unlocked and deleted.
		await set_lock({ writer, nodeId: midId, locked: false });
		await t.run(async (ctx) => ctx.db.delete("files_nodes", midId));

		const published3 = await t.mutation(internal.public_api.publish_file_write, {
			stageId: stage3._yay!.stageId,
			content: "# Three\n",
			targetAnchor: stage3._yay!.targetAnchor,
		});
		expect(published3._nay).toBeUndefined();
		expect(await find_active_node({ t, db: writer.db, path: "/aba-dir/mid/new.md" })).not.toBeNull();
	});

	test("write hides a restricted ancestor that appears while the stage uploads", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_member_writer({ t, clerkUserId: "clerk-lock-write-hidden-ancestor" });
		const deferred = defer_file_stage_puts();

		const writePromise = write_file({
			t,
			credential: writer.credential,
			path: "/write-hidden/new.md",
			content: "# New\n",
		});
		await deferred.putsStarted;
		const stage = await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").first());
		expect(stage?.path).toBe("/write-hidden/new.md");
		const stagedKeys = [stage!.yjsSnapshotAssetId, stage!.contentSnapshotAssetId].map((assetId) =>
			r2_create_asset_key({
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				assetId,
			}),
		);

		const hiddenFolderId = await seed_restricted_root_folder({ t, db: writer.db, name: "write-hidden" });
		deferred.releasePuts();

		const response = await writePromise;
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		expect(await find_active_node({ t, db: writer.db, path: "/write-hidden/new.md" })).toBeNull();
		await t.run(async (ctx) => {
			const hiddenFolder = await ctx.db.get("files_nodes", hiddenFolderId);
			expect(hiddenFolder?.archiveOperationId).toBeUndefined();
			expect(hiddenFolder?.restrictedScopeNodeId).toBe(hiddenFolderId);
			expect(await ctx.db.query("public_api_file_write_stages").collect()).toEqual([]);
			expect(await ctx.db.get("files_r2_assets", stage!.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", stage!.contentSnapshotAssetId)).toBeNull();
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs.map((job) => job.r2Key).sort()).toEqual([...stagedKeys].sort());
			expect(jobs.every((job) => job.reason === "failed_create")).toBe(true);
		});
	});

	test("touch hides a restricted ancestor that appears while the stage uploads", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_member_writer({ t, clerkUserId: "clerk-lock-touch-hidden-ancestor" });
		const deferred = defer_file_stage_puts();

		const touchPromise = t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({ paths: ["/touch-hidden/new.md"] }),
		});
		await deferred.putsStarted;
		const stage = await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").first());
		expect(stage?.path).toBe("/touch-hidden/new.md");
		const stagedKeys = [stage!.yjsSnapshotAssetId, stage!.contentSnapshotAssetId].map((assetId) =>
			r2_create_asset_key({
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				assetId,
			}),
		);

		const hiddenFolderId = await seed_restricted_root_folder({ t, db: writer.db, name: "touch-hidden" });
		deferred.releasePuts();

		const response = await touchPromise;
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ message: "Permission denied" });
		expect(await find_active_node({ t, db: writer.db, path: "/touch-hidden/new.md" })).toBeNull();
		await t.run(async (ctx) => {
			const hiddenFolder = await ctx.db.get("files_nodes", hiddenFolderId);
			expect(hiddenFolder?.archiveOperationId).toBeUndefined();
			expect(hiddenFolder?.restrictedScopeNodeId).toBe(hiddenFolderId);
			expect(await ctx.db.query("public_api_file_write_stages").collect()).toEqual([]);
			expect(await ctx.db.get("files_r2_assets", stage!.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", stage!.contentSnapshotAssetId)).toBeNull();
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs.map((job) => job.r2Key).sort()).toEqual([...stagedKeys].sort());
			expect(jobs.every((job) => job.reason === "failed_create")).toBe(true);
		});
	});

	test("touch succeeds when the current appeared target is writable", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_member_writer({ t, clerkUserId: "clerk-lock-touch-revoked-ancestor" });
		const outerId = await t.run(async (ctx) => {
			const now = Date.now();
			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				parentId: files_ROOT_ID,
				name: "outer",
				path: "/outer",
				treePath: "/outer/",
				pathDepth: 1,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: writer.db.userId,
				updatedBy: writer.db.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				resourceKind: "file",
				resourceId: String(nodeId),
				principalKind: "user",
				userId: writer.userId,
				permission: "content.write",
				createdAt: now,
				updatedAt: now,
			});
			return nodeId;
		});
		const deferred = defer_file_stage_puts();
		const touchPromise = t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({ paths: ["/outer/inner/new.md"] }),
		});
		await deferred.putsStarted;
		const stage = await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").first());
		expect(stage?.path).toBe("/outer/inner/new.md");
		const stagedKeys = [stage!.yjsSnapshotAssetId, stage!.contentSnapshotAssetId].map((assetId) =>
			r2_create_asset_key({
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				assetId,
			}),
		);

		const innerId = await t.run(async (ctx) => {
			const grants = await ctx.db.query("access_control_permission_grants").collect();
			for (const grant of grants) {
				if (grant.resourceId === String(outerId) && grant.userId === writer.userId) {
					await ctx.db.delete("access_control_permission_grants", grant._id);
				}
			}
			const now = Date.now();
			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				parentId: outerId,
				name: "inner",
				path: "/outer/inner",
				treePath: "/outer/inner/",
				pathDepth: 2,
				kind: "folder",
				lowercaseExtension: null,
				createdBy: writer.db.userId,
				updatedBy: writer.db.userId,
				updatedAt: now,
			});
			await ctx.db.patch("files_nodes", nodeId, { restrictedScopeNodeId: nodeId });
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				resourceKind: "file",
				resourceId: String(nodeId),
				principalKind: "user",
				userId: writer.userId,
				permission: "content.write",
				createdAt: now,
				updatedAt: now,
			});
			return nodeId;
		});
		const targetId = await seed_markdown_file({
			t,
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			path: "/outer/inner/new.md",
			committedMarkdown: "# Winner\n",
		});
		await t.run(async (ctx) => ctx.db.patch("files_nodes", targetId, { restrictedScopeNodeId: innerId }));
		const locked = await writer.owner.mutation(api.files_nodes.set_node_read_only, {
			membershipId: writer.db.membershipId,
			nodeId: outerId,
		});
		expect(locked._nay).toBeUndefined();
		const unlocked = await writer.owner.mutation(api.files_nodes.set_node_writable, {
			membershipId: writer.db.membershipId,
			nodeId: outerId,
		});
		expect(unlocked._nay).toBeUndefined();
		deferred.releasePuts();

		const response = await touchPromise;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			files: [{ path: "/outer/inner/new.md", nodeId: targetId, created: false }],
		});
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", targetId))?.archiveOperationId).toBeUndefined();
			expect(await ctx.db.query("public_api_file_write_stages").collect()).toEqual([]);
			expect(await ctx.db.get("files_r2_assets", stage!.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", stage!.contentSnapshotAssetId)).toBeNull();
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs.map((job) => job.r2Key).sort()).toEqual([...stagedKeys].sort());
		});
	});

	test("publish_file_touch refuses a destination locked during staging and a locked appeared target", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-touch-publish" });

		const seeded = await write_file({ t, credential: writer.credential, path: "/tlock/seed.md", content: "# S\n" });
		expect(seeded.status).toBe(200);
		const folder = await find_active_node({ t, db: writer.db, path: "/tlock" });

		// Create branch: the destination folder locks between staging and publish.
		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/tlock/new.md",
			overwrite: "fail",
			contentSize: 0,
			yjsSnapshotSize: 7,
		});
		expect(prepared._nay).toBeUndefined();
		await set_lock({ writer, nodeId: folder!._id, locked: true });
		const published = await t.mutation(internal.public_api.publish_file_touch, {
			stageId: prepared._yay!.stageId,
			targetAnchor: prepared._yay!.targetAnchor,
		});
		expect(published._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });
		expect(await find_active_node({ t, db: writer.db, path: "/tlock/new.md" })).toBeNull();
		await set_lock({ writer, nodeId: folder!._id, locked: false });

		// Exists branch: the target appears during staging and is locked. The touch must refuse
		// instead of answering satisfied on a locked file.
		const prepared2 = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/tlock/appeared.md",
			overwrite: "fail",
			contentSize: 0,
			yjsSnapshotSize: 7,
		});
		expect(prepared2._nay).toBeUndefined();
		const appeared = await write_file({
			t,
			credential: writer.credential,
			path: "/tlock/appeared.md",
			content: "# Here\n",
		});
		expect(appeared.status).toBe(200);
		const appearedNode = await find_active_node({ t, db: writer.db, path: "/tlock/appeared.md" });
		await set_lock({ writer, nodeId: appearedNode!._id, locked: true });
		const published2 = await t.mutation(internal.public_api.publish_file_touch, {
			stageId: prepared2._yay!.stageId,
			targetAnchor: prepared2._yay!.targetAnchor,
		});
		expect(published2._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });
		expect(await t.run(async (ctx) => ctx.db.query("public_api_file_write_stages").collect())).toEqual([]);

		// Unlock the folder and prove the same staged touch can create the file.
		const prepared3 = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			principalRef: { kind: "user_api_key", credentialId: writer.credentialId },
			path: "/tlock/new.md",
			overwrite: "fail",
			contentSize: 0,
			yjsSnapshotSize: 7,
		});
		const published3 = await t.mutation(internal.public_api.publish_file_touch, {
			stageId: prepared3._yay!.stageId,
			targetAnchor: prepared3._yay!.targetAnchor,
		});
		expect(published3._nay).toBeUndefined();
		expect(published3._yay).toMatchObject({ created: true });
	});

	test("touch succeeds when an appeared target is unlocked before publish", async () => {
		const t = test_convex();
		install_r2_object_reads();
		stub_confirmed_deletes();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-touch-appeared-aba" });

		// Hold both staged PUTs after prepare. This gives another writer time to create the target
		// and take it through a lock → unlock cycle before the touch publish transaction starts.
		const installedFetch = globalThis.fetch;
		let startedWriteCount = 0;
		let markWritesStarted: () => void = () => {};
		let releaseWrites: () => void = () => {};
		const writesStarted = new Promise<void>((resolve) => {
			markWritesStarted = resolve;
		});
		const writesReleased = new Promise<void>((resolve) => {
			releaseWrites = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (url.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
					startedWriteCount += 1;
					if (startedWriteCount === 2) {
						markWritesStarted();
					}
					await writesReleased;
				}
				return await installedFetch(input, init);
			}),
		);

		const touchPromise = t.fetch("/api/v1/files/touch", {
			method: "POST",
			headers: auth_headers(writer.credential),
			body: JSON.stringify({ paths: ["/appeared-aba.md"] }),
		});
		await writesStarted;
		const stage = await t.run(async (ctx) =>
			ctx.db
				.query("public_api_file_write_stages")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", writer.db.organizationId).eq("workspaceId", writer.db.workspaceId),
				)
				.first(),
		);
		expect(stage?.path).toBe("/appeared-aba.md");
		const stagedKeys = [stage!.yjsSnapshotAssetId, stage!.contentSnapshotAssetId].map((assetId) =>
			r2_create_asset_key({
				organizationId: writer.db.organizationId,
				workspaceId: writer.db.workspaceId,
				assetId,
			}),
		);

		const appearedNodeId = await seed_markdown_file({
			t,
			organizationId: writer.db.organizationId,
			workspaceId: writer.db.workspaceId,
			userId: writer.db.userId,
			path: "/appeared-aba.md",
			committedMarkdown: "# Winner\n",
		});
		await set_lock({ writer, nodeId: appearedNodeId, locked: true });
		await set_lock({ writer, nodeId: appearedNodeId, locked: false });
		releaseWrites();

		const response = await touchPromise;
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			files: [{ path: "/appeared-aba.md", nodeId: appearedNodeId, created: false }],
		});
		expect(await read_file_content({ t, credential: writer.credential, path: "/appeared-aba.md" })).toContain(
			"# Winner",
		);
		await t.run(async (ctx) => {
			const activeNodes = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", writer.db.organizationId)
						.eq("workspaceId", writer.db.workspaceId)
						.eq("path", "/appeared-aba.md")
						.eq("archiveOperationId", undefined),
				)
				.collect();
			expect(activeNodes.map((node) => node._id)).toEqual([appearedNodeId]);
			expect(await ctx.db.query("public_api_file_write_stages").collect()).toEqual([]);
			expect(await ctx.db.get("files_r2_assets", stage!.yjsSnapshotAssetId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", stage!.contentSnapshotAssetId)).toBeNull();
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs.map((job) => job.r2Key).sort()).toEqual([...stagedKeys].sort());
		});
	});

	test("a locked stored file refuses overwrite=replace until unlocked", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const writer = await seed_locks_writer({ t, clerkUserId: "clerk-lock-replace" });

		// This stored Markdown file is not editable, so replace is its only write path.
		const occupant = await writer.asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: writer.db.membershipId,
			parentId: "root",
			filename: "stored.md",
			contentType: "text/markdown;charset=utf-8",
			size: 3,
		});
		expect(occupant._nay).toBeUndefined();
		const occupantNodeId = occupant._yay!.nodeId;
		await set_lock({ writer, nodeId: occupantNodeId, locked: true });

		const refused = await write_file({
			t,
			credential: writer.credential,
			path: "/stored.md",
			content: "# Replace\n",
			overwrite: "replace",
		});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ message: "This item is read-only." });
		await t.run(async (ctx) => {
			const target = await ctx.db.get("files_nodes", occupantNodeId);
			expect(target?.archiveOperationId).toBeUndefined();
		});

		// Unlock the stored file and prove the same replace can archive and recreate it.
		await set_lock({ writer, nodeId: occupantNodeId, locked: false });
		const allowed = await write_file({
			t,
			credential: writer.credential,
			path: "/stored.md",
			content: "# Replace\n",
			overwrite: "replace",
		});
		expect(allowed.status).toBe(200);
		const replaced = await find_active_node({ t, db: writer.db, path: "/stored.md" });
		expect(replaced).not.toBeNull();
		expect(replaced!._id).not.toBe(occupantNodeId);
	});
});

describe("service file writes", () => {
	const SERVICE_CAPABILITIES: plugins_Capability[] = [
		"plugin.service.connect",
		"workspace.files.write",
		"workspace.files.create-read-only",
	];

	/**
	 * Seed the docs a sealed service holds after the real exchange-and-seal flow: a ready plugin
	 * version, an enabled installation, and a grant sealed to a destination. The exchange and seal
	 * routes themselves are covered by `public_api_service_uploads.test.ts`; these tests exercise
	 * the write door behind them.
	 */
	async function seed_sealed_service(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
		acceptedCapabilities?: plugins_Capability[];
		destinationPathPrefix?: string;
		phase?: "interactive" | "processing";
		actorUserId?: Id<"users">;
		/**
		 * A second plugin in the same workspace, for the tests about one plugin's lock.
		 */
		pluginName?: string;
	}) {
		const token = `psg_${crypto_random_hex(32)}`;
		const tokenHash = await crypto_sha256_hex(token);
		const seeded = await args.t.run(async (ctx) => {
			const now = Date.now();
			const capabilities = args.acceptedCapabilities ?? SERVICE_CAPABILITIES;
			const pluginName = args.pluginName ?? "council";
			const pluginVersionId = await ctx.db.insert("plugins_versions", {
				name: pluginName,
				displayName: "Council",
				version: "0.1.0",
				description: "Meetings with named transcripts",
				reviewStatus: "passed",
				reviewId: null,
				isLatest: true,
				artifactHash: `sha256:${"a".repeat(64)}`,
				sourceRepositoryUrl: "https://github.com/bonobo/council-plugin",
				sourceOwner: "bonobo",
				sourceRepo: "council-plugin",
				sourceCommitSha: "1234567890abcdef1234567890abcdef12345678",
				manifestR2Key: "plugins/council/manifest.json",
				backendEntrypointFile: null,
				configuration: null,
				events: [],
				capabilities,
				pages: [],
				fileViews: [],
				outboundOrigins: [],
				uiOutboundOrigins: [],
				files: [],
				sourceStatus: "ready",
				sourceLastError: null,
				createdBy: args.db.userId,
				updatedAt: now,
			});
			const installationId = await ctx.db.insert("plugins_workspace_installations", {
				organizationId: args.db.organizationId,
				workspaceId: args.db.workspaceId,
				pluginVersionId,
				pluginName,
				status: "enabled",
				configurationYaml: null,
				acceptedCapabilities: capabilities,
				capabilitiesAcceptedAt: now,
				acceptedOutboundOrigins: [],
				acceptedUiOutboundOrigins: [],
				outboundOriginsAcceptedAt: now,
				installedBy: args.db.userId,
				updatedBy: args.db.userId,
				updatedAt: now,
			});
			const grantId = await ctx.db.insert("plugin_service_grants", {
				organizationId: args.db.organizationId,
				workspaceId: args.db.workspaceId,
				installationId,
				pluginVersionId,
				pluginName,
				actorUserId: args.actorUserId ?? args.db.userId,
				tokenHash,
				scopes: ["plugin_data:read", "plugin_data:write", "files:write"],
				principalKey: `plugin_service:${args.db.organizationId}:${args.db.workspaceId}:${installationId}`,
				phase: args.phase ?? "processing",
				destinationPathPrefix: args.destinationPathPrefix ?? "/meetings",
				expiresAt: now + 60 * 60 * 1000,
				updatedAt: now,
			});
			return { pluginVersionId, installationId, grantId };
		});
		return { token, ...seeded };
	}

	async function service_write(args: {
		t: ReturnType<typeof test_convex>;
		token: string;
		path: string;
		content: string;
		overwrite?: "replace" | "fail";
		skipIfUnchanged?: boolean;
		readOnly?: boolean;
	}) {
		return await args.t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(args.token),
			body: JSON.stringify({
				path: args.path,
				content: args.content,
				...(args.overwrite ? { overwrite: args.overwrite } : {}),
				...(args.skipIfUnchanged === undefined ? {} : { skipIfUnchanged: args.skipIfUnchanged }),
				...(args.readOnly === undefined ? {} : { access: { readOnly: args.readOnly } }),
			}),
		});
	}

	async function find_active_node(args: {
		t: ReturnType<typeof test_convex>;
		db: Awaited<ReturnType<typeof seed_signed_in_membership>>;
		path: string;
	}) {
		return await args.t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q
						.eq("organizationId", args.db.organizationId)
						.eq("workspaceId", args.db.workspaceId)
						.eq("path", args.path)
						.eq("archiveOperationId", undefined),
				)
				.first(),
		);
	}

	test("a sealed service write by a payer with no credits refuses with 402", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-write-broke" });
		const service = await seed_sealed_service({ t, db });
		// The grant's actor is the payer here (default-billed organization). Move them to Free with
		// an empty meter, the one state the credit gate refuses.
		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
			const snapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first();
			if (!snapshot?.meter) {
				throw new Error("Expected a seeded usage snapshot");
			}
			await ctx.db.patch("billing_usage_snapshots", snapshot._id, { meter: { ...snapshot.meter, balance: 0 } });
		});

		const refused = await service_write({
			t,
			token: service.token,
			path: "/meetings/meeting-broke/meeting.md",
			content: "# Meeting\n",
		});
		expect(refused.status).toBe(402);
		expect(await refused.json()).toEqual({ message: "Insufficient funds" });
		expect(await find_active_node({ t, db, path: "/meetings/meeting-broke/meeting.md" })).toBeNull();
	});

	test("creates its own stamped file and updates it in place", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-write-create" });
		const service = await seed_sealed_service({ t, db });

		const written = await service_write({ t, token: service.token, path: "/meetings/meeting-1/meeting.md", content: "# Meeting\n" });
		expect(written.status).toBe(200);
		const writtenBody = (await written.json()) as { path: string; nodeId: string; contentType: string };
		expect(writtenBody).toEqual({
			path: "/meetings/meeting-1/meeting.md",
			nodeId: expect.any(String),
			contentType: "text/markdown;charset=utf-8",
		});

		// The write stamps service provenance on the file, and only on the file: member sharing and
		// the member lock door keep working because the plugin-owner stamp stays unset.
		const node = await find_active_node({ t, db, path: "/meetings/meeting-1/meeting.md" });
		expect(node?.pluginServiceWritePluginName).toBe("council");
		expect(node?.pluginOwnerName).toBeUndefined();
		const folder = await find_active_node({ t, db, path: "/meetings/meeting-1" });
		expect(folder?.pluginServiceWritePluginName).toBeUndefined();
		expect(folder?.pluginOwnerName).toBeUndefined();

		const updated = await service_write({
			t,
			token: service.token,
			path: "/meetings/meeting-1/meeting.md",
			content: "# Meeting\n\nUpdated by the service\n",
		});
		expect(updated.status).toBe(200);
		expect(((await updated.json()) as { nodeId: string }).nodeId).toBe(writtenBody.nodeId);

		// Every published write consumed its stage; nothing is left for the cleanup cron.
		const stages = await t.run(async (ctx) => await ctx.db.query("public_api_file_write_stages").collect());
		expect(stages).toEqual([]);
	});

	test("refuses a path outside the seal and a grant that was never sealed", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-write-fence" });
		const service = await seed_sealed_service({ t, db });

		const outside = await service_write({ t, token: service.token, path: "/elsewhere/note.md", content: "# Out\n" });
		expect(outside.status).toBe(403);
		expect(await outside.json()).toEqual({ message: "Path is outside this grant's destination" });

		// Forge the doc the exchange refuses to mint: an interactive grant that somehow carries the
		// write scope and a destination. Only the phase is wrong, so this pins the phase fence.
		const interactive = await seed_sealed_service({ t, db, phase: "interactive" });
		const unsealed = await service_write({
			t,
			token: interactive.token,
			path: "/meetings/note.md",
			content: "# Early\n",
		});
		expect(unsealed.status).toBe(403);
		expect(await unsealed.json()).toEqual({ message: "Path is outside this grant's destination" });

		expect(await find_active_node({ t, db, path: "/elsewhere/note.md" })).toBeNull();
		expect(await find_active_node({ t, db, path: "/meetings/note.md" })).toBeNull();
	});

	test("cannot update a file it did not create, and never confirms unchanged member content", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-write-ownership" });
		const service = await seed_sealed_service({ t, db });
		const memberContent = "# Member notes\n";
		const nodeId = await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/meetings/notes.md",
			committedMarkdown: memberContent,
		});

		// Sending the member file's exact bytes with skipIfUnchanged must not answer "unchanged":
		// that answer would confirm to the service what a file it does not own contains.
		const probe = await service_write({
			t,
			token: service.token,
			path: "/meetings/notes.md",
			content: memberContent,
			skipIfUnchanged: true,
		});
		expect(probe.status).toBe(403);
		expect(await probe.json()).toEqual({ message: "Permission denied" });

		const overwrite = await service_write({
			t,
			token: service.token,
			path: "/meetings/notes.md",
			content: "# Taken over\n",
		});
		expect(overwrite.status).toBe(403);

		// A file stamped by another plugin's service refuses the same way.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { pluginServiceWritePluginName: "other-plugin" });
		});
		const foreign = await service_write({
			t,
			token: service.token,
			path: "/meetings/notes.md",
			content: "# Taken over\n",
		});
		expect(foreign.status).toBe(403);

		// The stamp is the whole gate: with its own name on the file the same update is allowed.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", nodeId, { pluginServiceWritePluginName: "council" });
		});
		const owned = await service_write({
			t,
			token: service.token,
			path: "/meetings/notes.md",
			content: "# Updated by council\n",
		});
		expect(owned.status).toBe(200);
		expect(((await owned.json()) as { nodeId: string }).nodeId).toBe(nodeId);
	});

	test("a grant revoked between prepare and publish refuses the publish and the stage can still be cleaned", async () => {
		const t = test_convex();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-write-revoked" });
		const service = await seed_sealed_service({ t, db });

		const prepared = await t.mutation(internal.public_api.prepare_file_write, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			principalRef: { kind: "plugin_service", grantId: service.grantId },
			path: "/meetings/report.md",
			overwrite: "replace",
			contentSize: 16,
			yjsSnapshotSize: 16,
		});
		expect(prepared._nay).toBeUndefined();
		const stage = prepared._yay!;

		await t.run(async (ctx) => {
			await ctx.db.patch("plugin_service_grants", service.grantId, { revokedAt: Date.now() });
		});

		const published = await t.mutation(internal.public_api.publish_file_write, {
			stageId: stage.stageId,
			content: "# Report\n",
			targetAnchor: stage.targetAnchor,
		});
		expect(published._nay?.message).toBe("Unauthenticated");
		expect(await find_active_node({ t, db, path: "/meetings/report.md" })).toBeNull();

		// The route's failure path runs this cleanup; after it nothing is left of the write.
		await t.mutation(internal.public_api.cleanup_file_write_stage, { stageId: stage.stageId });
		const stages = await t.run(async (ctx) => await ctx.db.query("public_api_file_write_stages").collect());
		expect(stages).toEqual([]);
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", stage.yjsSnapshotAssetId))).toBeNull();
		expect(await t.run(async (ctx) => ctx.db.get("files_r2_assets", stage.contentSnapshotAssetId))).toBeNull();
	});

	test("creates a read-only file, updates through its own lock, and a member unlock ends the plugin claim", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-write-lock" });
		const service = await seed_sealed_service({ t, db });

		const written = await service_write({
			t,
			token: service.token,
			path: "/meetings/meeting-1/transcript.md",
			content: "# Transcript\n",
			readOnly: true,
		});
		expect(written.status).toBe(200);
		const node = await find_active_node({ t, db, path: "/meetings/meeting-1/transcript.md" });
		expect(node).toMatchObject({
			readOnlyScopeNodeId: node!._id,
			readOnlyPluginName: "council",
			pluginServiceWritePluginName: "council",
		});

		// The plugin's own named lock does not lock the plugin out.
		const updated = await service_write({
			t,
			token: service.token,
			path: "/meetings/meeting-1/transcript.md",
			content: "# Transcript\n\nRevised\n",
		});
		expect(updated.status).toBe(200);

		// The file carries no plugin-owner stamp, so the member lock door still owns it: an unlock
		// works and ends the plugin's claim with it.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-service-write-lock",
			external_id: db.userId,
		});
		const unlocked = await asUser.mutation(api.files_nodes.set_node_writable, {
			membershipId: db.membershipId,
			nodeId: node!._id,
		});
		expect(unlocked._nay).toBeUndefined();
		const afterUnlock = await find_active_node({ t, db, path: "/meetings/meeting-1/transcript.md" });
		expect(afterUnlock?.readOnlyScopeNodeId).toBeUndefined();
		expect(afterUnlock?.readOnlyPluginName).toBeUndefined();

		// A member re-lock carries no plugin name, so the service cannot pass it.
		const relocked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: node!._id,
		});
		expect(relocked._nay).toBeUndefined();
		const refused = await service_write({
			t,
			token: service.token,
			path: "/meetings/meeting-1/transcript.md",
			content: "# Transcript\n\nAgain\n",
		});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ message: "This item is read-only." });
	});

	test("refuses the read-only option without consent or a managing actor", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-write-consent" });

		// Without the create-read-only consent the locked create refuses before writing anything.
		const unconsented = await seed_sealed_service({
			t,
			db,
			acceptedCapabilities: ["plugin.service.connect", "workspace.files.write"],
		});
		const refused = await service_write({
			t,
			token: unconsented.token,
			path: "/meetings/locked.md",
			content: "# Locked\n",
			readOnly: true,
		});
		expect(refused.status).toBe(403);
		expect(await refused.json()).toEqual({ message: "Permission denied" });
		expect(await find_active_node({ t, db, path: "/meetings/locked.md" })).toBeNull();

		// A plain member holds content.write but not content.permissions.manage: they may author
		// service files, but a lock is an ACL decision their grant cannot make.
		const member = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk-service-write-consent-member" });
			// The write route's credit gate bills the acting member, so the fixture pays.
			await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				active: true,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId,
				role: "member",
				now,
			});
			return { userId };
		});
		const memberService = await seed_sealed_service({ t, db, actorUserId: member.userId });
		const memberPlain = await service_write({
			t,
			token: memberService.token,
			path: "/meetings/member-plain.md",
			content: "# Plain\n",
		});
		expect(memberPlain.status).toBe(200);
		const memberLocked = await service_write({
			t,
			token: memberService.token,
			path: "/meetings/member-locked.md",
			content: "# Locked\n",
			readOnly: true,
		});
		expect(memberLocked.status).toBe(403);
		expect(await find_active_node({ t, db, path: "/meetings/member-locked.md" })).toBeNull();

		// The access option is a plugin feature: a user key holder locks files through the app.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-service-write-consent",
			external_id: db.userId,
		});
		const created = await asUser.mutation(api.public_api.api_credential_create, {
			membershipId: db.membershipId,
			name: "Files writer",
			scopes: ["files:write"],
		});
		expect(created._nay).toBeUndefined();
		const userKeyLocked = await t.fetch("/api/v1/files/write", {
			method: "POST",
			headers: auth_headers(created._yay!.credential),
			body: JSON.stringify({ path: "/user-locked.md", content: "# Locked\n", access: { readOnly: true } }),
		});
		expect(userKeyLocked.status).toBe(403);
		expect(await userKeyLocked.json()).toEqual({ message: "Permission denied" });
	});

	test("replaces the file its own read-only upload target created and respects another plugin's lock", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-write-target" });
		const service = await seed_sealed_service({ t, db });

		// A committed read-only upload target: the flow a transcript upload uses before the
		// service rewrites the file through the write door.
		const enqueueActionSpy = vi
			.spyOn(Workpool.prototype, "enqueueAction")
			.mockResolvedValue("work_service_write_target" as never);
		const createdTarget = await t.fetch("/api/v1/files/service-uploads/create-target", {
			method: "POST",
			headers: auth_headers(service.token),
			body: JSON.stringify({
				idempotencyKey: "meeting-1",
				targetKey: "notes",
				path: "/meetings/meeting-1/notes.md",
				contentType: "text/markdown",
				size: 16,
				readOnly: true,
				nonCollaborative: false,
			}),
		});
		expect(createdTarget.status).toBe(200);
		const target = await t.run(async (ctx) => (await ctx.db.query("plugin_service_storage_targets").collect())[0]!);
		const asset = await t.run(async (ctx) => await ctx.db.get("files_r2_assets", target.assetId));
		await t.mutation(internal.r2.process_uploaded_asset_event, {
			assetId: target.assetId,
			r2Key: `organizations/${db.organizationId}/workspaces/${db.workspaceId}/assets/${target.assetId}`,
			uploadStagingR2Key: asset!.uploadStagingR2Key!,
			size: 16,
			etag: "etag-service-write-target",
			eventId: "service-write-target-event",
		});
		enqueueActionSpy.mockRestore();
		const storedNode = await find_active_node({ t, db, path: "/meetings/meeting-1/notes.md" });
		expect(storedNode).toMatchObject({
			readOnlyScopeNodeId: storedNode!._id,
			readOnlyPluginServiceTargetId: target._id,
		});

		// The target lock is the service's own, so the write may pass it, and the same target
		// proof answers the ownership question the stored file cannot answer with a stamp.
		const replaced = await service_write({
			t,
			token: service.token,
			path: "/meetings/meeting-1/notes.md",
			content: "# Notes\n\nRewritten as text\n",
		});
		expect(replaced.status).toBe(200);
		const replacedBody = (await replaced.json()) as { nodeId: string };
		expect(replacedBody.nodeId).not.toBe(String(storedNode!._id));
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", storedNode!._id))).toMatchObject({
			archiveOperationId: expect.any(String),
		});
		const replacedNode = await find_active_node({ t, db, path: "/meetings/meeting-1/notes.md" });
		expect(replacedNode?.pluginServiceWritePluginName).toBe("council");

		// A lock naming another plugin is not this service's to pass.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", replacedNode!._id, {
				readOnlyScopeNodeId: replacedNode!._id,
				readOnlyPluginName: "other-plugin",
			});
		});
		const refused = await service_write({
			t,
			token: service.token,
			path: "/meetings/meeting-1/notes.md",
			content: "# Notes\n\nTaken\n",
		});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ message: "This item is read-only." });
	});

	test("archives its own files through the plugin archive door and releases the lock it passes", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-archive" });
		const service = await seed_sealed_service({ t, db });
		const archive = async (path: string) =>
			await t.fetch("/api/v1/files/plugin-archive", {
				method: "POST",
				headers: auth_headers(service.token),
				body: JSON.stringify({ path }),
			});

		expect(
			(await service_write({ t, token: service.token, path: "/meetings/meeting-1/summary.md", content: "# S\n" }))
				.status,
		).toBe(200);
		const archived = await archive("/meetings/meeting-1/summary.md");
		expect(archived.status).toBe(200);
		expect(await archived.json()).toEqual({ archivedNodes: 1 });
		expect(await find_active_node({ t, db, path: "/meetings/meeting-1/summary.md" })).toBeNull();

		// Archiving through its own named lock releases the lock first, so a member restore gets a
		// writable file back.
		expect(
			(
				await service_write({
					t,
					token: service.token,
					path: "/meetings/meeting-1/locked.md",
					content: "# L\n",
					readOnly: true,
				})
			).status,
		).toBe(200);
		const lockedNode = await find_active_node({ t, db, path: "/meetings/meeting-1/locked.md" });
		const lockedArchive = await archive("/meetings/meeting-1/locked.md");
		expect(lockedArchive.status).toBe(200);
		expect(await lockedArchive.json()).toEqual({ archivedNodes: 1 });
		expect(await t.run(async (ctx) => ctx.db.get("files_nodes", lockedNode!._id))).toMatchObject({
			archiveOperationId: expect.any(String),
		});
		expect(
			(await t.run(async (ctx) => ctx.db.get("files_nodes", lockedNode!._id)))?.readOnlyScopeNodeId,
		).toBeUndefined();
		expect(
			(await t.run(async (ctx) => ctx.db.get("files_nodes", lockedNode!._id)))?.readOnlyPluginName,
		).toBeUndefined();

		// Archiving an absent path is satisfied by doing nothing.
		const absent = await archive("/meetings/meeting-1/never-existed.md");
		expect(absent.status).toBe(200);
		expect(await absent.json()).toEqual({ archivedNodes: 0 });
	});

	test("the plugin archive door refuses everything that is not its own live file", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-archive-refusals" });
		const service = await seed_sealed_service({ t, db });
		const archive = async (path: string) =>
			await t.fetch("/api/v1/files/plugin-archive", {
				method: "POST",
				headers: auth_headers(service.token),
				body: JSON.stringify({ path }),
			});

		// A member's file inside the destination carries no service provenance.
		await seed_markdown_file({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			path: "/meetings/member.md",
			committedMarkdown: "# Member\n",
		});
		const memberFile = await archive("/meetings/member.md");
		expect(memberFile.status).toBe(403);
		expect(await memberFile.json()).toEqual({ message: "Permission denied" });

		// A folder can never carry service write provenance, so the service branch refuses it.
		expect(
			(await service_write({ t, token: service.token, path: "/meetings/meeting-1/summary.md", content: "# S\n" }))
				.status,
		).toBe(200);
		const folder = await archive("/meetings/meeting-1");
		expect(folder.status).toBe(403);

		// A member lock on the service's own file wins: the archive refuses instead of releasing it.
		const node = await find_active_node({ t, db, path: "/meetings/meeting-1/summary.md" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-service-archive-refusals",
			external_id: db.userId,
		});
		const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: node!._id,
		});
		expect(locked._nay).toBeUndefined();
		const memberLocked = await archive("/meetings/meeting-1/summary.md");
		expect(memberLocked.status).toBe(409);
		expect(await memberLocked.json()).toEqual({ message: "This item is read-only." });

		// The seal bounds this door the same way it bounds the write.
		const outside = await archive("/elsewhere/file.md");
		expect(outside.status).toBe(403);
		expect(await outside.json()).toEqual({ message: "Permission denied" });
	});

	test("the destination archive releases the write-created named lock", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-archive-destination" });
		const service = await seed_sealed_service({ t, db });

		expect(
			(
				await service_write({
					t,
					token: service.token,
					path: "/meetings/meeting-1/transcript.md",
					content: "# T\n",
					readOnly: true,
				})
			).status,
		).toBe(200);
		const node = await find_active_node({ t, db, path: "/meetings/meeting-1/transcript.md" });

		// The destination archive is anchored to upload targets: one upload in the destination makes
		// the sealed folder archivable, and the sweep then has to get past the write-created lock too.
		const createdTarget = await t.fetch("/api/v1/files/service-uploads/create-target", {
			method: "POST",
			headers: auth_headers(service.token),
			body: JSON.stringify({
				idempotencyKey: "meeting-1",
				targetKey: "recording",
				path: "/meetings/meeting-1/recording.mp4",
				contentType: "video/mp4",
				size: 1024,
				readOnly: false,
				nonCollaborative: false,
			}),
		});
		expect(createdTarget.status).toBe(200);

		const archived = await t.fetch("/api/v1/files/service-uploads/archive-destination", {
			method: "POST",
			headers: auth_headers(service.token),
			body: JSON.stringify({}),
		});
		expect(archived.status).toBe(200);

		// The whole destination is archived, and the named lock was released through the same
		// exception that lets the service pass it, so a member restore gets writable files back.
		const after = await t.run(async (ctx) => ctx.db.get("files_nodes", node!._id));
		expect(after?.archiveOperationId).toEqual(expect.any(String));
		expect(after?.readOnlyScopeNodeId).toBeUndefined();
		expect(after?.readOnlyPluginName).toBeUndefined();
		expect(await find_active_node({ t, db, path: "/meetings" })).toBeNull();

		// A file that kept its lock would make this whole restore refuse, so the restore is the
		// proof the release really happened.
		const archivedRoot = await t.run(async (ctx) =>
			ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_path_archiveOperation", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("path", "/meetings"),
				)
				.first(),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-service-archive-destination",
			external_id: db.userId,
		});
		const restored = await asUser.mutation(api.files_nodes.unarchive_nodes, {
			membershipId: db.membershipId,
			nodeIds: [archivedRoot!._id],
		});
		expect(restored).toEqual({ _yay: null });
		const restoredFile = await find_active_node({ t, db, path: "/meetings/meeting-1/transcript.md" });
		expect(restoredFile?.readOnlyScopeNodeId).toBeUndefined();
	});

	test("another plugin's grant cannot archive through the lock this plugin created", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-foreign-lock" });
		const owner = await seed_sealed_service({ t, db });
		const foreign = await seed_sealed_service({ t, db, pluginName: "minutes" });

		expect(
			(
				await service_write({
					t,
					token: owner.token,
					path: "/meetings/meeting-1/transcript.md",
					content: "# T\n",
					readOnly: true,
				})
			).status,
		).toBe(200);

		// The second plugin seals the same destination, so it needs its own upload target there
		// before the destination is archivable for it at all.
		const createdTarget = await t.fetch("/api/v1/files/service-uploads/create-target", {
			method: "POST",
			headers: auth_headers(foreign.token),
			body: JSON.stringify({
				idempotencyKey: "meeting-1-foreign",
				targetKey: "recording",
				path: "/meetings/meeting-1/foreign.mp4",
				contentType: "video/mp4",
				size: 1024,
				readOnly: false,
				nonCollaborative: false,
			}),
		});
		expect(createdTarget.status).toBe(200);

		// A named lock is passable only by the plugin that owns the name. To another plugin it is
		// an ordinary member lock, and it stops the whole sweep.
		const archived = await t.fetch("/api/v1/files/service-uploads/archive-destination", {
			method: "POST",
			headers: auth_headers(foreign.token),
			body: JSON.stringify({}),
		});
		expect(archived.status).toBe(409);
		expect(await archived.json()).toEqual({ message: "This item is read-only." });
		expect(await find_active_node({ t, db, path: "/meetings/meeting-1/transcript.md" })).not.toBeNull();
		expect(await find_active_node({ t, db, path: "/meetings" })).not.toBeNull();
	});

	test("a member lock on a folder above refuses the destination archive", async () => {
		const t = test_convex();
		install_r2_object_reads();
		const db = await seed_signed_in_membership({ t, clerkUserId: "clerk-service-member-lock-above" });
		const service = await seed_sealed_service({ t, db });

		expect(
			(
				await service_write({
					t,
					token: service.token,
					path: "/meetings/meeting-1/transcript.md",
					content: "# T\n",
					readOnly: true,
				})
			).status,
		).toBe(200);
		const createdTarget = await t.fetch("/api/v1/files/service-uploads/create-target", {
			method: "POST",
			headers: auth_headers(service.token),
			body: JSON.stringify({
				idempotencyKey: "meeting-1",
				targetKey: "recording",
				path: "/meetings/meeting-1/recording.mp4",
				contentType: "video/mp4",
				size: 1024,
				readOnly: false,
				nonCollaborative: false,
			}),
		});
		expect(createdTarget.status).toBe(200);

		const meetingFolder = await find_active_node({ t, db, path: "/meetings/meeting-1" });
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			subject: "clerk-service-member-lock-above",
			external_id: db.userId,
		});
		const locked = await asUser.mutation(api.files_nodes.set_node_read_only, {
			membershipId: db.membershipId,
			nodeId: meetingFolder!._id,
		});
		expect(locked._nay).toBeUndefined();

		// The plugin may pass its own named lock on the transcript, but a member's lock on the
		// folder holding it carries no plugin name. "Leave this alone" wins over the sweep.
		const archived = await t.fetch("/api/v1/files/service-uploads/archive-destination", {
			method: "POST",
			headers: auth_headers(service.token),
			body: JSON.stringify({}),
		});
		expect(archived.status).toBe(409);
		expect(await archived.json()).toEqual({ message: "This item is read-only." });
		expect(await find_active_node({ t, db, path: "/meetings/meeting-1" })).not.toBeNull();
		expect(await find_active_node({ t, db, path: "/meetings/meeting-1/transcript.md" })).not.toBeNull();
	});
});
