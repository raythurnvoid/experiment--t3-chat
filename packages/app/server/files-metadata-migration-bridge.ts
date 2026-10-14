// Push A only. Mirror old metadata sources in their own write transaction.
import type { Doc, Id, TableNames } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { convex_error } from "./convex-utils.ts";
import { files_metadata_maps_db_delete, files_metadata_maps_db_write } from "./files-metadata-maps.ts";

async function mirror_proposal(
	db: MutationCtx["db"],
	proposal: Doc<"files_pending_updates"> | null,
	id: Id<"files_pending_updates">,
) {
	if (proposal?.createIntent && proposal.target.kind === "private") {
		await files_metadata_maps_db_write(db, {
			organizationId: proposal.organizationId,
			workspaceId: proposal.workspaceId,
			owner: { kind: "pending", id },
			entries: proposal.createIntent.metadata,
		});
	} else await files_metadata_maps_db_delete(db, { kind: "pending", id });
}

async function mirror_capture(
	db: MutationCtx["db"],
	item: Doc<"files_transfer_items"> | null,
	id: Id<"files_transfer_items">,
) {
	if (!item?.capture) return await files_metadata_maps_db_delete(db, { kind: "capture", id });
	const run = await db.get("files_transfer_runs", item.runId);
	if (!run || run.organizationId !== item.organizationId || run.workspaceId !== item.workspaceId)
		throw convex_error({ message: "Capture metadata has no exact transfer run" });
	await files_metadata_maps_db_write(db, {
		organizationId: item.organizationId,
		workspaceId: item.workspaceId,
		owner: { kind: "capture", id },
		entries: item.capture.metadata,
	});
}

async function mirror_allocation(db: MutationCtx["db"], node: Doc<"files_nodes">) {
	if (!node.publishedFromPrivateNodeId) return;
	const privateNode = await db.get("files_pending_nodes", node.publishedFromPrivateNodeId);
	if (
		!privateNode ||
		privateNode.organizationId !== node.organizationId ||
		privateNode.workspaceId !== node.workspaceId
	)
		throw convex_error({ message: "Allocated metadata has no exact private source" });
	const proposal = await db
		.query("files_pending_updates")
		.withIndex("by_organization_workspace_user_target", (q) =>
			q
				.eq("organizationId", privateNode.organizationId)
				.eq("workspaceId", privateNode.workspaceId)
				.eq("userId", privateNode.userId)
				.eq("target.kind", "private")
				.eq("target.id", privateNode._id),
		)
		.unique();
	if (!proposal?.createIntent) throw convex_error({ message: "Allocated metadata has no full private map" });
	await files_metadata_maps_db_write(db, {
		organizationId: node.organizationId,
		workspaceId: node.workspaceId,
		owner: { kind: "saved", id: node._id },
		entries: proposal.createIntent.metadata,
	});
}

export function files_metadata_migration_db_wrap(ctx: MutationCtx) {
	const source = ctx.db;
	return {
		db: new Proxy(source, {
			get(target, property) {
				const method = Reflect.get(target, property) as unknown;
				if (typeof method !== "function") return method;
				if (property !== "insert" && property !== "patch" && property !== "replace" && property !== "delete")
					return method.bind(target);
				return async (...args: unknown[]) => {
					const table = args[0] as TableNames;
					const watched =
						table === "files_pending_updates" || table === "files_transfer_items" || table === "files_nodes";
					if (!watched) return await Reflect.apply(method, target, args);
					const before = property === "insert" ? null : await target.get(table, args[1] as Id<typeof table>);
					const result = (await Reflect.apply(method, target, args)) as string | undefined;
					const id = (property === "insert" ? result : args[1]) as Id<typeof table>;
					const after = property === "delete" ? null : await target.get(table, id);
					if (table === "files_pending_updates") {
						const old = before as Doc<"files_pending_updates"> | null;
						const next = after as Doc<"files_pending_updates"> | null;
						if (
							property === "insert" ||
							property === "delete" ||
							old?.target.kind !== next?.target.kind ||
							JSON.stringify(old?.createIntent?.metadata) !== JSON.stringify(next?.createIntent?.metadata)
						)
							await mirror_proposal(source, next, id as Id<"files_pending_updates">);
					} else if (table === "files_transfer_items") {
						const old = before as Doc<"files_transfer_items"> | null;
						const next = after as Doc<"files_transfer_items"> | null;
						if (
							property === "insert" ||
							property === "delete" ||
							JSON.stringify(old?.capture?.metadata) !== JSON.stringify(next?.capture?.metadata)
						)
							await mirror_capture(source, next, id as Id<"files_transfer_items">);
					} else if (property === "insert" && after) await mirror_allocation(source, after as Doc<"files_nodes">);
					else if (property === "delete")
						await files_metadata_maps_db_delete(source, { kind: "saved", id: id as Id<"files_nodes"> });
					return result;
				};
			},
		}),
	};
}
