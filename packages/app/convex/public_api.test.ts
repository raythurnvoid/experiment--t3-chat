import { R2 } from "@convex-dev/r2";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import {
	files_ROOT_ID,
	files_u8_to_array_buffer,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
} from "../server/files.ts";
import { r2_create_asset_key } from "./r2.ts";
import { files_get_utf8_byte_size } from "../shared/files.ts";
import { organizations_GLOBAL_GITHUB_WORKSPACE_ID, organizations_GLOBAL_ORGANIZATION_ID } from "../shared/organizations.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

const textEncoder = new TextEncoder();
const r2Objects = new Map<string, string | ArrayBuffer>();

function install_r2_object_reads() {
	r2Objects.clear();
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => {
		const key = customKey ?? "test-upload-key";
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key: string) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (urlString.startsWith("https://r2.test/upload?key=") && init?.method === "PUT") {
				const key = decodeURIComponent(urlString.slice("https://r2.test/upload?key=".length));
				r2Objects.set(key, init.body instanceof ArrayBuffer || typeof init.body === "string" ? init.body : "");
				return new Response(null, { status: 200 });
			}
			if (!urlString.startsWith("https://r2.test/object?key=")) {
				return new Response(null, { status: 404 });
			}

			const key = decodeURIComponent(urlString.slice("https://r2.test/object?key=".length));
			const body = r2Objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
}

async function sha256_hex(input: string) {
	const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
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
		tokenHash: await sha256_hex(args.token),
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
		const baseYjsDocFromMarkdown = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: baseYjsDoc,
			markdown: args.committedMarkdown,
		});
		if (baseYjsDocFromMarkdown._nay) {
			throw new Error(baseYjsDocFromMarkdown._nay.message);
		}
		const baseMarkdownResult = files_yjs_doc_get_markdown({
			yjsDoc: baseYjsDoc,
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
		});
		await ctx.db.patch("files_nodes", fileNodeId, {
			yjsSnapshotId,
			yjsLastSequenceId,
		});
		return fileNodeId;
	});

	if (args.pendingMarkdown != null) {
		const baseYjsDoc = new YDoc();
		const baseYjsDocFromMarkdown = files_yjs_doc_update_from_markdown({
			mut_yjsDoc: baseYjsDoc,
			markdown: args.committedMarkdown,
		});
		if (baseYjsDocFromMarkdown._nay) {
			throw new Error(baseYjsDocFromMarkdown._nay.message);
		}
		const baseYjsUpdate = files_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc));
		baseYjsDoc.destroy();

		const pending = await args.t.mutation(internal.files_pending_updates.upsert_file_pending_update_in_db, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.userId,
			nodeId,
			baseYjsSequence: 0,
			baseYjsUpdate,
			unstagedMarkdown: args.pendingMarkdown,
		});
		if (pending._nay) {
			throw new Error(pending._nay.message);
		}
	}

	return nodeId;
}

describe("public files API", () => {
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

		const afterRevoke = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/" }),
		});
		expect(afterRevoke.status).toBe(401);
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
		const mounted = await t.action(internal.files_nodes.create_file_node_internal, {
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

	test("requires dedicated API credential management permission", async () => {
		const t = test_convex();
		const owner = await seed_signed_in_membership({ t, clerkUserId: "clerk-public-api-permission-owner" });
		const member = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", {
				clerkUserId: "clerk-public-api-permission-member",
			});
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				userId,
				active: true,
			});
			await ctx.db.insert("access_control_permission_grants", {
				organizationId: owner.organizationId,
				workspaceId: owner.workspaceId,
				resourceKind: "workspace",
				resourceId: String(owner.workspaceId),
				principalKind: "user",
				userId,
				permission: "asset.permissions.manage",
				createdAt: now,
				updatedAt: now,
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
			name: "Should not create",
			scopes: ["files:list"],
		});

		expect(created._nay?.message).toBe("Permission denied");
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

	test("requires request-time file read permission", async () => {
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
				secretHash: await sha256_hex(secret),
				scopes: ["files:list"],
				createdAt: Date.now(),
				revokedAt: null,
				lastUsedAt: null,
			});
		});

		const response = await t.fetch("/api/v1/files/list", {
			method: "POST",
			headers: auth_headers(credential),
			body: JSON.stringify({ path: "/" }),
		});
		expect(response.status).toBe(403);
	});

	test("lists active API credentials before old revoked keys", async () => {
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
				name: "Active key",
				keyId: `pk_${"a".repeat(32)}`,
				obfuscatedValue: `pk_${"a".repeat(32)}.****0000`,
				secretHash: "active-hash",
				scopes: ["files:list"],
				createdAt: 102,
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
		expect(listed._yay?.[0]).toEqual(expect.objectContaining({ name: "Active key", revokedAt: null }));
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
});
