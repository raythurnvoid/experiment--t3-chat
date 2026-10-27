import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { fixture } from "./files_pending_overlay.setup.test.ts";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { test_create_saved_text_file, test_finish_file_index, test_finish_saved_scope_jobs } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test(
	"large saved frontmatter changes access before its metadata scope refresh finishes",
	{ tags: ["full-size"], timeout: 300_000 },
	async () => {
		const f = await fixture(true);
		const nodeId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/large-scope.md",
			textContent: "Body\n",
		});
		expect(
			await f.asU.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toHaveProperty("_yay");
		const text = `---\n${Array.from({ length: 5_000 }, (_, index) => `field${index}: value${index}`).join("\n")}\n---\nBody\n`;
		expect(
			await f.asU.action(api.files_nodes_content.replace_file_content, {
				membershipId: f.db.membershipId,
				nodeId,
				requestId: "large-scope",
				text,
			}),
		).toHaveProperty("_yay");
		await test_finish_file_index(f.t, nodeId);

		async function expect_scope(restricted: boolean) {
			let cursor: string | null = null;
			let count = 0;
			for (;;) {
				const page = await f.t.run((ctx) =>
					ctx.db
						.query("files_metadata_docs")
						.withIndex("by_organization_workspace_source_fileNode", (q) =>
							q
								.eq("organizationId", f.u.organizationId)
								.eq("workspaceId", f.u.workspaceId)
								.eq("sourceKind", "committed")
								.eq("fileNodeId", nodeId),
						)
						.paginate({ numItems: 256, cursor }),
				);
				for (const doc of page.page) {
					if (doc.sourceKind !== "committed") throw new Error("Expected saved metadata");
					expect(doc.restrictedScopeNodeId).toBe(restricted ? nodeId : null);
					if (doc.docKind === "field") expect(doc.isRestrictedScopeRoot).toBe(restricted);
				}
				count += page.page.length;
				if (page.isDone) break;
				cursor = page.continueCursor;
			}
			expect(count, "all 5,000 fields and values keep their scope").toBe(10_000);
		}
		const readArgs = { membershipId: f.vMember.membershipId, nodeId };
		expect(await f.asV.query(api.files_nodes_content.get_non_collaborative_file_content, readArgs)).toMatchObject({
			_yay: { text },
		});
		await expect_scope(false);
		const restricted = await f.asU
			.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId,
			})
			.catch((error: unknown) => ({ _nay: error }));
		expect(restricted, "Restrict succeeds with 10,000 metadata docs under transaction limits").toHaveProperty("_yay");
		expect(
			(await f.asV.query(api.files_nodes_content.get_non_collaborative_file_content, readArgs))._nay,
			"the member cannot read the file while old open metadata still waits for its job",
		).toBeDefined();
		await expect_scope(false);
		await test_finish_saved_scope_jobs(f.t);
		await expect_scope(true);

		expect(
			await f.asU.mutation(api.files_sharing.unrestrict_node, {
				membershipId: f.db.membershipId,
				nodeId,
			}),
			"Unrestrict succeeds with 10,000 metadata docs under transaction limits",
		).toHaveProperty("_yay");
		expect(
			await f.asV.query(api.files_nodes_content.get_non_collaborative_file_content, readArgs),
			"the member can read the file while old restricted metadata still waits for its job",
		).toMatchObject({ _yay: { text } });
		await expect_scope(true);
		await test_finish_saved_scope_jobs(f.t);
		await expect_scope(false);
	},
);
