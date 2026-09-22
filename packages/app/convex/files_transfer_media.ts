import { Result } from "common/errors-as-values-utils.ts";
import type { Doc } from "./_generated/dataModel.js";
import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import type { files_PendingTarget, files_VisibleEntry } from "../shared/files.ts";
import {
	files_media_build_file_src,
	files_media_build_private_src,
	files_media_parse_src,
} from "../shared/files-media.ts";
import { files_pending_nodes_db_resolve_read_target } from "./files_pending_nodes.ts";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_media_dependencies_PAGE_SIZE } from "./files_media_dependencies.ts";
import {
	files_transfer_db_get_entry_version,
	files_transfer_source_versions_equal,
	type files_transfer_db_prepare_copy_item,
} from "./files_transfer.ts";

export function files_transfer_media_dependencies_equal(
	pinned: Doc<"files_media_dependencies">["dependency"],
	current: Doc<"files_media_dependencies">["dependency"],
) {
	// Publishing unchanged private media keeps its asset, but changes the version kind.
	const published =
		pinned.version.kind === "pending" &&
		current.version.kind === "asset" &&
		pinned.version.contentType === current.version.contentType &&
		pinned.version.textKind === null &&
		current.version.textKind === null;
	return (
		pinned.src === current.src &&
		pinned.target.kind === current.target.kind &&
		pinned.target.id === current.target.id &&
		pinned.assetId === current.assetId &&
		(published || files_transfer_source_versions_equal(pinned.version, current.version))
	);
}

export async function files_transfer_media_db_get_ready_media(
	ctx: QueryCtx | MutationCtx,
	entry: files_VisibleEntry,
	membership: Doc<"organizations_workspaces_users">,
) {
	if (entry.node.kind !== "file" || entry.pendingUpdate?.preparation) return null;
	const version = await files_transfer_db_get_entry_version(ctx, entry);
	if (
		!version ||
		version.textKind !== null ||
		(!version.contentType.startsWith("image/") && !version.contentType.startsWith("video/"))
	)
		return null;

	const intent = entry.pendingUpdate?.createIntent;
	const stored =
		entry.kind === "private" ? (intent?.kind === "stored" ? intent : null) : entry.pendingUpdate?.pendingReplacement;
	const assetId = stored?.assetId ?? (entry.kind === "saved" ? entry.node.assetId : null);
	if (!assetId) return null;
	const asset = await ctx.db.get("files_r2_assets", assetId);
	if (
		!asset?.r2Key ||
		asset.organizationId !== membership.organizationId ||
		asset.workspaceId !== membership.workspaceId ||
		asset.uploadRetiredAt !== undefined ||
		asset.unfinalizedExpiresAt !== undefined
	)
		return null;

	// Draft creates and saved-file replacements both need their actor's exact held asset.
	if (stored) {
		const reservation = await ctx.db
			.query("files_private_storage_reservations")
			.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", assetId))
			.first();
		if (
			asset.createdBy !== membership.userId ||
			asset.size !== stored.size ||
			!reservation ||
			reservation.organizationId !== membership.organizationId ||
			reservation.workspaceId !== membership.workspaceId ||
			reservation.userId !== membership.userId ||
			reservation.settlement.kind !== "held" ||
			reservation.byteCount !== stored.size ||
			reservation.resource.kind !== "asset" ||
			reservation.resource.r2Key !== asset.r2Key
		)
			return null;
	}
	return { assetId, version };
}

/**
 * Call immediately after prepare_copy_item in the same transaction. It owns the run's
 * current chat, work claim, and both membership-lifetime checks. This helper only reads.
 */
export async function files_transfer_media_db_map_refs(
	ctx: QueryCtx | MutationCtx,
	args: {
		prepared: Pick<
			NonNullable<Awaited<ReturnType<typeof files_transfer_db_prepare_copy_item>>["_yay"]>,
			"run" | "item" | "sourceMembership" | "destinationMembership"
		>;
		refs: string[];
		validateOnly?: boolean;
	},
) {
	if (args.refs.length > files_media_dependencies_PAGE_SIZE)
		return Result({ _nay: { message: "Invalid media selection page" } });
	const { run, sourceMembership, destinationMembership } = args.prepared;
	const sourceReader = await files_visible_db_create_reader(ctx, {
		...run.sourceScope,
		userId: run.userId,
		readLimit: 4096,
	});
	const destinationReader = await files_visible_db_create_reader(ctx, {
		...run.destinationScope,
		userId: run.userId,
		readLimit: 4096,
	});
	const referencePairs: [string, string][] = [];
	const mediaDependencies: Doc<"files_media_dependencies">["dependency"][] = [];

	// Resolve in order: the reader shares parent-resolution state between references.
	for (const src of new Set(args.refs)) {
		const parsed = files_media_parse_src(src);
		if (parsed.kind !== "file" && parsed.kind !== "private") continue;
		const fileId = parsed.kind === "file" ? ctx.db.normalizeId("files_nodes", parsed.fileNodeId) : null;
		const privateId =
			parsed.kind === "private" ? ctx.db.normalizeId("files_pending_nodes", parsed.privateNodeId) : null;
		if (!fileId && !privateId) return Result({ _nay: { message: "A linked media file is not available" } });
		const original: files_PendingTarget = fileId ? { kind: "saved", id: fileId } : { kind: "private", id: privateId! };
		const target = await files_pending_nodes_db_resolve_read_target(ctx, { ...run.sourceScope, target: original });
		const source = target ? await sourceReader.resolveTarget(target) : null;
		// Never consult selected names or explain a missing selection before source access succeeds.
		if (!source || source.node.kind !== "file")
			return Result({ _nay: { message: "A linked media file is not available" } });

		if (run.sourceScope.workspaceId === run.destinationScope.workspaceId) {
			const ready = await files_transfer_media_db_get_ready_media(ctx, source, sourceMembership);
			if (!ready) return Result({ _nay: { message: "A linked media file is not available" } });
			const sourceSetPin = args.validateOnly ? undefined : args.prepared.item.capture?.mediaSourceSet;
			const sourceSet = sourceSetPin ? await ctx.db.get("files_media_dependency_sets", sourceSetPin.setId) : null;
			if (
				sourceSetPin &&
				(!sourceSet?.sealed || sourceSet.generation !== sourceSetPin.generation || sourceSet.owner.kind === "cleanup")
			)
				return Result({ _nay: { message: "The copied document's media selection changed. Try again." } });
			const inherited = sourceSet
				? await ctx.db
						.query("files_media_dependencies")
						.withIndex("by_set_src", (q) => q.eq("setId", sourceSet._id).eq("dependency.src", src))
						.first()
				: null;
			if (
				inherited &&
				!files_transfer_media_dependencies_equal(inherited.dependency, { ...inherited.dependency, ...ready })
			)
				return Result({
					_nay: { message: "The copied media changed while this document was being copied. Try again." },
				});
			// A same-workspace copy keeps the original ref and its exact Save requirement.
			referencePairs.push([src, src]);
			mediaDependencies.push(inherited?.dependency ?? { src, target: original, ...ready });
			continue;
		}

		const aliases = [original];
		if (target!.kind !== original.kind || target!.id !== original.id) aliases.push(target!);
		if (source.kind === "saved" && source.node.publishedFromPrivateNodeId && original.kind !== "private")
			aliases.push({ kind: "private", id: source.node.publishedFromPrivateNodeId });
		const selected = await Promise.all(
			aliases.map((alias) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_source", (q) =>
						q.eq("runId", run._id).eq("source.kind", alias.kind).eq("source.id", alias.id),
					)
					.first(),
			),
		);
		const mediaItem = selected.find((candidate) => candidate !== null);
		// These errors remain in job history after access to the linked file may be removed.
		if (!mediaItem) return Result({ _nay: { message: "Select the linked image or video files with this document" } });
		if (mediaItem.state !== "completed" || !mediaItem.outputTarget)
			return Result({ _nay: { message: "A selected image or video file has not finished copying" } });

		const output = await files_pending_nodes_db_resolve_read_target(ctx, {
			...run.destinationScope,
			target: mediaItem.outputTarget,
		});
		const destination = output ? await destinationReader.resolveTarget(output) : null;
		const ready = destination
			? await files_transfer_media_db_get_ready_media(ctx, destination, destinationMembership)
			: null;
		if (!ready) return Result({ _nay: { message: "A copied media file is no longer ready or readable" } });
		// Saving unchanged media keeps its asset; a later replacement must not become this copy's output.
		if (ready.assetId !== mediaItem.outputMediaAssetId)
			return Result({ _nay: { message: "The copied media changed while this document was being copied. Try again." } });
		const destinationSrc =
			mediaItem.outputTarget.kind === "private"
				? files_media_build_private_src(mediaItem.outputTarget.id)
				: files_media_build_file_src(mediaItem.outputTarget.id);
		referencePairs.push([src, destinationSrc]);
		mediaDependencies.push({ src: destinationSrc, target: mediaItem.outputTarget, ...ready });
	}
	return Result({ _yay: { referencePairs, mediaDependencies } });
}
