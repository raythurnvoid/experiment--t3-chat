import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, internal } from "./_generated/api.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { text_search_files_all_pages } from "./files_nodes.setup.test.ts";
import {
	create_file_fixture,
	create_pending_proposal,
	mock_nodes_content_storage,
	objects,
	prepare_agent_replacement,
	start_agent_copy,
} from "./files_nodes_content.setup.test.ts";
import { test_create_saved_text_file, test_meta_search } from "./setup.test.ts";
import { files_metadata_stringify_entries_yaml } from "../shared/files-metadata.ts";
import { files_u8_to_array_buffer } from "../shared/files.ts";
import { files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_metadata_read_full_page } from "../server/files-metadata-read.ts";

type Fixture = Awaited<ReturnType<typeof create_file_fixture>>;
type PageResult = {
	_yay?: { json: string; cursor: string | null; isDone: boolean };
	_nay?: { message: string };
};
type Page = {
	sourceKind: "committed" | "pending";
	fields: string[];
	values: (
		| { valueIndex: number; field: string; valueKind: string; value: string | number | boolean }
		| { valueIndex: number; field: string; valueKind: "string"; fragment: string; offset: number; totalLength: number }
	)[];
	isDone: boolean;
	continueCursor: string | null;
};

function page(result: PageResult) {
	if (!result._yay) throw new Error(result._nay?.message ?? "Expected a full-value page");
	expect(new TextEncoder().encode(result._yay.json).length).toBeLessThanOrEqual(64 * 1024);
	const parsed = JSON.parse(result._yay.json) as Page;
	expect(parsed.continueCursor).toBe(result._yay.cursor);
	expect(parsed.isDone).toBe(result._yay.isDone);
	expect(parsed.isDone).toBe(parsed.continueCursor === null);
	return parsed;
}

function full_values(pages: Page[]) {
	const values = new Map<number, string | number | boolean>();
	for (const current of pages) {
		for (const value of current.values) {
			if ("fragment" in value) {
				const previous = values.get(value.valueIndex) ?? "";
				expect(typeof previous).toBe("string");
				expect(value.offset).toBe(String(previous).length);
				expect(value.fragment.isWellFormed()).toBe(true);
				const joined = String(previous) + value.fragment;
				expect(joined.length).toBeLessThanOrEqual(value.totalLength);
				values.set(value.valueIndex, joined);
			} else {
				expect(values.has(value.valueIndex)).toBe(false);
				values.set(value.valueIndex, value.value);
			}
		}
	}
	for (const current of pages) {
		for (const value of current.values) {
			if ("fragment" in value) expect(String(values.get(value.valueIndex)).length).toBe(value.totalLength);
		}
	}
	return [...values.values()];
}

async function all_pages(read: (cursor: string | null) => Promise<PageResult>, first?: Page) {
	const pages = first ? [first] : [];
	const cursors = new Set<string>();
	let cursor = first?.continueCursor ?? null;
	if (first?.isDone) return pages;
	for (;;) {
		const current = page(await read(cursor));
		pages.push(current);
		if (current.isDone) return pages;
		cursor = current.continueCursor;
		if (cursor === null) throw new Error("Expected a continuation");
		expect(cursors.has(cursor), "Each page moves forward").toBe(false);
		cursors.add(cursor);
	}
}

function read_path(fixture: Fixture, field: string, cursor: string | null = null, path = "/restore.md") {
	return fixture.asUser.action((ctx) =>
		files_metadata_read_full_page(ctx, {
			caller: {
				kind: "path",
				args: {
					subject: { kind: "user" as const, userId: fixture.scope.userId, plugin: null },
					...fixture.scope,
					overlayUserId: fixture.db.userId,
					path,
				},
			},
			field,
			format: "json",
			cursor,
		}),
	);
}

function read_saved(fixture: Fixture, field: string, cursor: string | null = null) {
	return fixture.asUser.action(api.files_metadata_node.get_full_field_values, {
		membershipId: fixture.db.membershipId,
		target: { kind: "saved", id: fixture.nodeId },
		field,
		cursor,
	});
}

async function turn_off_collaboration(fixture: Fixture) {
	expect(
		(
			await fixture.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: fixture.db.membershipId,
				nodeId: fixture.nodeId,
				acknowledgeDropCollaborativeHistory: true,
			})
		)._nay,
	).toBeUndefined();
}

let saveRequestNumber = 0;

async function replace_text(fixture: Fixture, text: string) {
	expect(
		(
			await fixture.asUser.action(api.files_nodes_content.replace_file_content, {
				requestId: `metadata-save:${++saveRequestNumber}`,
				membershipId: fixture.db.membershipId,
				nodeId: fixture.nodeId,
				text,
			})
		)._nay,
	).toBeUndefined();
}

async function load_editor_document(fixture: Fixture) {
	const snapshotKey = await fixture.t.run(async (ctx) => {
		const snapshot = await ctx.db.get("files_yjs_snapshots", fixture.pointers.yjsSnapshotId);
		if (!snapshot) throw new Error("Missing editor snapshot");
		const asset = await ctx.db.get("files_r2_assets", snapshot.assetId);
		if (!asset?.r2Key) throw new Error("Missing editor snapshot object");
		return asset.r2Key;
	});
	const document = new YjsDoc();
	applyUpdate(document, new Uint8Array(await new Response(objects.get(snapshotKey)).arrayBuffer()));
	return { document, snapshotKey };
}

async function push_editor_text(fixture: Fixture, document: YjsDoc, text: string) {
	const before = encodeStateVector(document);
	const updated = files_yjs_doc_update_from_text({ mut_yjsDoc: document, rootKind: "rich_text", text });
	if (updated._nay) throw new Error(updated._nay.message);
	expect(
		(
			await fixture.asUser.mutation(api.files_nodes.yjs_push_update, {
				membershipId: fixture.db.membershipId,
				nodeId: fixture.nodeId,
				expectedYjsLastSequenceId: fixture.pointers.yjsLastSequenceId,
				update: files_u8_to_array_buffer(encodeStateAsUpdate(document, before)),
				sessionId: "metadata-editor",
			})
		)._nay,
	).toBeUndefined();
}

function pause_snapshot_fetch(snapshotKey: string) {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const baseFetch = vi.mocked(fetch).getMockImplementation()!;
	let paused = false;
	vi.mocked(fetch).mockImplementation(async (input, init) => {
		const response = await baseFetch(input, init);
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		if (!paused && url.searchParams.get("key") === snapshotKey) {
			paused = true;
			started.resolve();
			await released.promise;
		}
		return response;
	});
	return { started: started.promise, isPaused: () => paused, release: released.resolve };
}

beforeEach(mock_nodes_content_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("full metadata reads", () => {
	test("plain text keeps YAML document markers out of frontmatter reads", async () => {
		const fixture = await create_file_fixture("plain_text", "---\nstatus: open\n---\n");
		const saved = page(await read_saved(fixture, "frontmatter.status"));
		expect(saved.fields, "Plain text has no Markdown frontmatter").toEqual([]);
		expect(full_values([saved])).toEqual([]);
		const draft = "---\nstatus: draft\n---\n";
		await create_pending_proposal({ fixture, texts: { staged: draft, unstaged: draft } });
		const pending = page(await read_path(fixture, "frontmatter.status", null, "/restore.txt"));
		expect(pending.fields, "A plain-text draft also has no Markdown frontmatter").toEqual([]);
		expect(full_values([pending])).toEqual([]);
	});

	test("saved frontmatter keeps distinct long values and every Unicode fragment", async () => {
		const prefix = "😀".repeat(24_000);
		const values = [prefix + "first", prefix + "second"];
		const fixture = await create_file_fixture("rich_text", `---\nsummary: ${JSON.stringify(values)}\n---\n\nBody\n`);
		const pages = await all_pages((cursor) => read_saved(fixture, "frontmatter.summary", cursor));
		expect(full_values(pages), "Full values are not deduped by their short search copy").toEqual(values);
		expect(pages.length).toBeGreaterThan(1);
		expect(pages.every((current) => current.sourceKind === "committed")).toBe(true);
		expect(pages.flatMap((current) => current.fields)).toEqual(["frontmatter.summary"]);
	});

	test("the owner path reads a ready draft while the table and its full reader stay saved", async () => {
		const fixture = await create_file_fixture("rich_text", "---\nsummary: saved\n---\n\nBody\n");
		await create_pending_proposal({
			fixture,
			texts: {
				staged: "---\nsummary: staged\n---\n\nBody\n",
				unstaged: "---\nsummary: owner draft\n---\n\nBody\n",
			},
		});
		const pending = page(await read_path(fixture, "frontmatter.summary"));
		expect(pending.sourceKind).toBe("pending");
		expect(full_values([pending])).toEqual(["owner draft"]);
		const saved = page(await read_saved(fixture, "frontmatter.summary"));
		expect(saved.sourceKind).toBe("committed");
		expect(full_values([saved])).toEqual(["saved"]);
		expect(
			await fixture.asUser.query(api.files_metadata.get_field_values, {
				membershipId: fixture.db.membershipId,
				target: { kind: "saved", id: fixture.nodeId },
				fields: ["frontmatter.summary"],
				afterField: null,
			}),
		).toMatchObject({ values: [{ field: "frontmatter.summary", value: "saved", isPreview: false }] });
	});

	test("full frontmatter reads current editor updates before their index is materialized", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture("rich_text", "---\nsummary: saved\n---\n\nBody\n");
		const { document } = await load_editor_document(fixture);
		try {
			await push_editor_text(fixture, document, "---\nsummary: current editor\n---\n\nBody\n");
			const savedIndex = await fixture.asUser.query(api.files_metadata.get_field_values, {
				membershipId: fixture.db.membershipId,
				target: { kind: "saved", id: fixture.nodeId },
				fields: ["frontmatter.summary"],
				afterField: null,
			});
			expect(savedIndex?.values, "The index still holds the last materialized text").toEqual([
				{ field: "frontmatter.summary", value: "saved", isPreview: false },
			]);
			expect(
				full_values([page(await read_saved(fixture, "frontmatter.summary"))]),
				"The full reader includes current editor text",
			).toEqual(["current editor"]);
		} finally {
			document.destroy();
		}
	});

	test("a same-file editor change during the snapshot fetch refuses the full page", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture("rich_text", "---\nsummary: saved\n---\n\nBody\n");
		const { document, snapshotKey } = await load_editor_document(fixture);
		await push_editor_text(fixture, document, "---\nsummary: first editor version\n---\n\nBody\n");
		const pause = pause_snapshot_fetch(snapshotKey);
		const reading = read_saved(fixture, "frontmatter.summary");
		try {
			await Promise.race([
				pause.started,
				reading.then(() => {
					throw new Error("The full read finished without reaching the snapshot GET");
				}),
			]);
			expect(pause.isPaused(), "The read reached the snapshot GET").toBe(true);
			await push_editor_text(fixture, document, "---\nsummary: second editor version\n---\n\nBody\n");
			pause.release();
			expect(await reading, "The full reader withholds a page from an old editor version").toEqual({
				_nay: { message: "File changed. Start a new read." },
			});
		} finally {
			pause.release();
			document.destroy();
			await reading;
		}
	});

	test("removing a normal share during the snapshot fetch withholds the full page", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture("rich_text", "---\nsummary: saved\n---\n\nBody\n");
		const { document, snapshotKey } = await load_editor_document(fixture);
		await push_editor_text(fixture, document, "---\nsummary: private editor text\n---\n\nBody\n");
		const viewer = await fixture.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "metadata_full_fetch_reader" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.db.organizationId,
				workspaceId: fixture.db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
				displayName: "",
				sortDisplayName: "",
			});
			await access_control_db_ensure_role_assignment(ctx, {
				...fixture.scope,
				userId,
				role: "viewer",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asViewer = fixture.t.withIdentity({ issuer: "https://clerk.test", external_id: viewer.userId });
		expect(
			(
				await fixture.asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.nodeId,
				})
			)._nay,
		).toBeUndefined();
		const grant = {
			membershipId: fixture.db.membershipId,
			nodeId: fixture.nodeId,
			principal: { kind: "user" as const, userId: viewer.userId },
			level: "read" as const,
		};
		expect((await fixture.asUser.mutation(api.files_sharing.set_node_share_grant, grant))._nay).toBeUndefined();
		const pause = pause_snapshot_fetch(snapshotKey);
		const reading = asViewer.action(api.files_metadata_node.get_full_field_values, {
			membershipId: viewer.membershipId,
			target: { kind: "saved", id: fixture.nodeId },
			field: "frontmatter.summary",
			cursor: null,
		});
		try {
			await Promise.race([
				pause.started,
				reading.then(() => {
					throw new Error("The shared read finished without reaching the snapshot GET");
				}),
			]);
			expect(pause.isPaused(), "The shared read reached the snapshot GET").toBe(true);
			expect(
				(
					await fixture.asUser.mutation(api.files_sharing.remove_node_share_grant, {
						membershipId: grant.membershipId,
						nodeId: grant.nodeId,
						principal: grant.principal,
					})
				)._nay,
			).toBeUndefined();
			pause.release();
			expect(await reading, "The full reader withholds values after the share is removed").toEqual({
				_nay: { message: "File changed or its text is unavailable. Start a new read." },
			});
		} finally {
			pause.release();
			document.destroy();
			await reading;
		}
	});

	test("a saved content change refuses a frontmatter continuation", async () => {
		const fixture = await create_file_fixture("rich_text", `---\nsummary: ${"x".repeat(100_000)}\n---\n\nBody\n`);
		await turn_off_collaboration(fixture);
		const first = page(await read_saved(fixture, "frontmatter.summary"));
		expect(first.continueCursor).not.toBeNull();
		await replace_text(fixture, "---\nsummary: changed\n---\n\nBody\n");
		expect(await read_saved(fixture, "frontmatter.summary", first.continueCursor)).toEqual({
			_nay: { message: "File changed. Start a new read." },
		});
	});

	test("a draft content change refuses an owner-path continuation", async () => {
		const fixture = await create_file_fixture("rich_text", "---\nsummary: saved\n---\n\nBody\n");
		const draft = `---\nsummary: ${"x".repeat(100_000)}\n---\n\nBody\n`;
		await create_pending_proposal({ fixture, texts: { staged: draft, unstaged: draft } });
		const first = page(await read_path(fixture, "frontmatter.summary"));
		expect(first.sourceKind).toBe("pending");
		expect(first.continueCursor).not.toBeNull();
		const changed = "---\nsummary: changed draft\n---\n\nBody\n";
		await create_pending_proposal({ fixture, texts: { staged: changed, unstaged: changed } });
		expect(await read_path(fixture, "frontmatter.summary", first.continueCursor)).toEqual({
			_nay: { message: "File changed. Start a new read." },
		});
	});

	test("metadata-only pages skip file text and survive an unrelated content edit", async () => {
		const fixture = await create_file_fixture("rich_text", "---\nsummary: saved\n---\n\nBody\n");
		await turn_off_collaboration(fixture);
		// JSON expands this valid 32 KiB string, so the full read needs several pages.
		const value = "\0".repeat(32 * 1024);
		expect(
			await fixture.asUser.mutation(api.files_metadata.set_entries, {
				membershipId: fixture.db.membershipId,
				fileNodeId: fixture.nodeId,
				metadataYaml: files_metadata_stringify_entries_yaml([{ key: "description", value }]),
			}),
		).toEqual({ _yay: null });
		const source = await fixture.asUser.query(internal.files_metadata.get_field_read_source, {
			membershipId: fixture.db.membershipId,
			target: { kind: "saved", id: fixture.nodeId },
			metadataOnly: true,
		});
		expect(source?.textRead).toBeNull();
		const getUrl = vi.spyOn(R2.prototype, "getUrl");
		getUrl.mockClear();
		const first = page(await read_saved(fixture, "metadata.description"));
		expect(first.continueCursor).not.toBeNull();
		expect(getUrl, "Metadata-only reads do not load the file snapshot").not.toHaveBeenCalled();
		await replace_text(fixture, "---\nsummary: unrelated change\n---\n\nBody\n");
		getUrl.mockClear();
		const pages = await all_pages((cursor) => read_saved(fixture, "metadata.description", cursor), first);
		expect(full_values(pages), "Content changes do not invalidate an unchanged metadata map").toEqual([value]);
		expect(getUrl).not.toHaveBeenCalled();
	});

	test("a metadata map change refuses its continuation", async () => {
		const fixture = await create_file_fixture("rich_text");
		expect(
			await fixture.asUser.mutation(api.files_metadata.set_entries, {
				membershipId: fixture.db.membershipId,
				fileNodeId: fixture.nodeId,
				metadataYaml: files_metadata_stringify_entries_yaml([{ key: "description", value: "\0".repeat(32 * 1024) }]),
			}),
		).toEqual({ _yay: null });
		const first = page(await read_saved(fixture, "metadata.description"));
		expect(first.continueCursor).not.toBeNull();
		expect(
			await fixture.asUser.mutation(api.files_metadata.set_entries, {
				membershipId: fixture.db.membershipId,
				fileNodeId: fixture.nodeId,
				metadataYaml: "description: changed",
			}),
		).toEqual({ _yay: null });
		expect(await read_saved(fixture, "metadata.description", first.continueCursor)).toEqual({
			_nay: { message: "File changed. Start a new read." },
		});
	});

	test("a native restore keeps the owner's old frontmatter while saved reads use the restored source", async () => {
		const fixture = await create_file_fixture("rich_text", "---\nsummary: saved snapshot\n---\n\nBody\n");
		const draft = "---\nsummary: owner draft\n---\n\nBody\n";
		const pending = await create_pending_proposal({ fixture, texts: { staged: draft, unstaged: draft } });
		const before = (await fixture.t.run((ctx) => ctx.db.get("files_nodes", fixture.nodeId)))!;
		expect(page(await read_path(fixture, "frontmatter.summary")).sourceKind).toBe("pending");
		expect(
			(
				await fixture.asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.nodeId,
					snapshotId: fixture.snapshotId,
					sessionId: "metadata-restore",
				})
			)._nay,
		).toBeUndefined();
		expect(await fixture.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		expect((await fixture.t.run((ctx) => ctx.db.get("files_nodes", fixture.nodeId)))?.pendingContentVersion).toBe(
			before.pendingContentVersion + 1,
		);
		const restored = page(await read_path(fixture, "frontmatter.summary"));
		expect(restored.sourceKind).toBe("pending");
		expect(full_values([restored])).toEqual(["owner draft"]);
		expect(full_values([page(await read_saved(fixture, "frontmatter.summary"))])).toEqual(["saved snapshot"]);
		expect(await fixture.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test("a retained draft stays private and current access loss blocks every read", async () => {
		const savedText = "---\nsummary: saved snapshot\n---\n\nSaved body\n";
		const fixture = await create_file_fixture("rich_text", savedText);
		const member = await fixture.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "retained_draft_owner" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.db.organizationId,
				workspaceId: fixture.db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
				displayName: "",
				sortDisplayName: "",
			});
			await access_control_db_ensure_role_assignment(ctx, {
				...fixture.scope,
				userId,
				role: "member",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const draftText = "---\nsummary: owner draft\n---\n\nownerneedle Ω\n";
		const pending = await create_pending_proposal({
			fixture,
			userId: member.userId,
			texts: { staged: draftText, unstaged: draftText },
		});
		expect(
			(
				await fixture.asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.nodeId,
					snapshotId: fixture.snapshotId,
					sessionId: "retained-draft-access",
				})
			)._nay,
		).toBeUndefined();
		const reader = {
			...fixture,
			db: { ...fixture.db, ...member },
			scope: { ...fixture.scope, userId: member.userId },
			asUser: fixture.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId }),
		};
		const readArgs = {
			...reader.scope,
			subject: { kind: "user" as const, userId: member.userId, plugin: null },
			path: "/restore.md",
		};
		const searchArgs = {
			...reader.scope,
			subject: readArgs.subject,
			query: "ownerneedle",
			numItems: 10,
			cursor: null,
		};
		const metadataArgs = {
			...reader.scope,
			plan: { op: "eq" as const, fieldPath: "frontmatter.summary", value: "owner draft" },
		};
		const content = await fixture.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, readArgs);
		expect(content?.content).toBe(draftText);
		expect(full_values([page(await read_path(reader, "frontmatter.summary"))])).toEqual(["owner draft"]);
		expect((await text_search_files_all_pages(fixture.t, searchArgs)).items.map((item) => item.path)).toEqual([
			readArgs.path,
		]);
		expect((await test_meta_search(fixture.t, metadataArgs)).items.map((item) => item.path)).toEqual([readArgs.path]);
		// A member without this draft still reads the saved version.
		expect(
			(await fixture.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				...readArgs,
				userId: fixture.db.userId,
				subject: { kind: "user", userId: fixture.db.userId, plugin: null },
			}))?.content,
		).toBe(savedText);
		expect(full_values([page(await read_path(fixture, "frontmatter.summary"))])).toEqual(["saved snapshot"]);
		expect(
			(await text_search_files_all_pages(fixture.t, {
				...searchArgs,
				userId: fixture.db.userId,
				subject: { kind: "user", userId: fixture.db.userId, plugin: null },
			})).items,
		).toEqual([]);
		expect((await test_meta_search(fixture.t, { ...metadataArgs, userId: fixture.db.userId })).items).toEqual([]);
		expect(
			(
				await fixture.asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.nodeId,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await fixture.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, readArgs),
		).toBeNull();
		expect(await read_path(reader, "frontmatter.summary")).toEqual({ _nay: { message: "Permission denied" } });
		expect((await text_search_files_all_pages(fixture.t, searchArgs)).items).toEqual([]);
		expect((await test_meta_search(fixture.t, metadataArgs)).items).toEqual([]);
		expect(await fixture.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test("a ready Copy replacement is visible to its owner while the table stays saved", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture("rich_text", "---\nsummary: saved\n---\n\nBody\n");
		const sourceId = await test_create_saved_text_file(fixture.t, {
			membershipId: fixture.db.membershipId,
			path: "/replacement.md",
			textContent: "---\nsummary: replacement\n---\n\nBody\n",
		});
		await prepare_agent_replacement(fixture, sourceId);
		const replacement = page(await read_path(fixture, "frontmatter.summary"));
		expect(replacement.sourceKind).toBe("pending");
		expect(full_values([replacement])).toEqual(["replacement"]);
		expect(full_values([page(await read_saved(fixture, "frontmatter.summary"))])).toEqual(["saved"]);
	});

	test("an unfinished Copy stays unreadable until its normal preparation is sealed", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture("rich_text", "---\nsummary: copied\n---\n\nBody\n");
		const copy = await start_agent_copy({ fixture, targetName: "preparing.md" });
		expect(copy.item.preparation).not.toBeNull();
		expect(await read_path(fixture, "frontmatter.summary", null, "/preparing.md")).toEqual({
			_nay: { message: "Not found" },
		});
		expect(full_values([page(await read_saved(fixture, "frontmatter.summary"))])).toEqual(["copied"]);
		await fixture.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		const ready = page(await read_path(fixture, "frontmatter.summary", null, "/preparing.md"));
		expect(ready.sourceKind).toBe("pending");
		expect(full_values([ready])).toEqual(["copied"]);
	});

	test("removing a normal file share refuses a viewer's next page", async () => {
		const fixture = await create_file_fixture("rich_text", `---\nsummary: ${"x".repeat(100_000)}\n---\n\nBody\n`);
		const viewer = await fixture.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "metadata_full_reader" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: fixture.db.organizationId,
				workspaceId: fixture.db.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
				displayName: "",
				sortDisplayName: "",
			});
			await access_control_db_ensure_role_assignment(ctx, {
				...fixture.scope,
				userId,
				role: "viewer",
				now: Date.now(),
			});
			return { userId, membershipId };
		});
		const asViewer = fixture.t.withIdentity({ issuer: "https://clerk.test", external_id: viewer.userId });
		expect(
			(
				await fixture.asUser.mutation(api.files_sharing.restrict_node, {
					membershipId: fixture.db.membershipId,
					nodeId: fixture.nodeId,
				})
			)._nay,
		).toBeUndefined();
		const grant = {
			membershipId: fixture.db.membershipId,
			nodeId: fixture.nodeId,
			principal: { kind: "user" as const, userId: viewer.userId },
			level: "read" as const,
		};
		expect((await fixture.asUser.mutation(api.files_sharing.set_node_share_grant, grant))._nay).toBeUndefined();
		const args = {
			membershipId: viewer.membershipId,
			target: { kind: "saved" as const, id: fixture.nodeId },
			field: "frontmatter.summary",
			cursor: null,
		};
		const first = page(await asViewer.action(api.files_metadata_node.get_full_field_values, args));
		expect(first.continueCursor).not.toBeNull();
		expect(
			(
				await fixture.asUser.mutation(api.files_sharing.remove_node_share_grant, {
					membershipId: grant.membershipId,
					nodeId: grant.nodeId,
					principal: grant.principal,
				})
			)._nay,
		).toBeUndefined();
		expect(
			await asViewer.action(api.files_metadata_node.get_full_field_values, {
				...args,
				cursor: first.continueCursor,
			}),
		).toEqual({ _nay: { message: "Not found" } });
	});
});
