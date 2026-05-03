import { query, mutation, internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { app_convex_Doc } from "../src/lib/app-convex-client.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import app_convex_schema from "./schema.ts";
import { files_db_yjs_push_update } from "./files_nodes.ts";
import { billing_event } from "../server/billing.ts";
import { billing_db_check_credits, billing_pick_billed_user_id, billing_ingest_events } from "./billing.ts";
import { composite_id, should_never_happen } from "../shared/shared-utils.ts";
import { Result } from "../src/lib/errors-as-values-utils.ts";
import { workspaces_db_get_membership_for_user } from "./workspaces.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import {
	files_db_cancel_pending_update_cleanup_tasks,
	files_db_get_pending_update,
	files_db_get_yjs_content_and_sequence,
	files_db_schedule_pending_update_cleanup,
	files_yjs_doc_apply_array_buffer_update,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_clone,
	files_yjs_doc_get_markdown,
	files_yjs_doc_update_from_markdown,
	files_yjs_compute_diff_update_from_yjs_doc,
	files_u8_to_array_buffer,
	files_u8_equals,
} from "../server/files.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

function files_pending_update_encode_yjs_state_update(args: { yjsDoc: YDoc }) {
	return files_u8_to_array_buffer(encodeStateAsUpdate(args.yjsDoc));
}

function files_pending_update_reconstruct_branch_docs(pendingUpdate: app_convex_Doc<"files_pending_updates">) {
	return {
		baseYjsSequence: pendingUpdate.baseYjsSequence,
		baseYjsDoc: files_yjs_doc_create_from_array_buffer_update(pendingUpdate.baseYjsUpdate),
		stagedBranchYjsDoc: files_yjs_doc_create_from_array_buffer_update(pendingUpdate.stagedBranchYjsUpdate),
		unstagedBranchYjsDoc: files_yjs_doc_create_from_array_buffer_update(pendingUpdate.unstagedBranchYjsUpdate),
	};
}

async function files_pending_update_upsert_last_sequence_saved(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		nodeId: app_convex_Doc<"files_pending_updates_last_sequence_saved">["nodeId"];
		lastSequenceSaved: number;
		updatedAt: number;
	},
) {
	const existingRow = await ctx.db
		.query("files_pending_updates_last_sequence_saved")
		.withIndex("by_workspace_project_user_file", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("userId", args.userId)
				.eq("nodeId", args.nodeId),
		)
		.first();

	if (!existingRow) {
		await ctx.db.insert("files_pending_updates_last_sequence_saved", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			userId: args.userId,
			nodeId: args.nodeId,
			lastSequenceSaved: args.lastSequenceSaved,
			updatedAt: args.updatedAt,
		});
		return;
	}

	await ctx.db.patch("files_pending_updates_last_sequence_saved", existingRow._id, {
		lastSequenceSaved: args.lastSequenceSaved,
		updatedAt: args.updatedAt,
	});
}

function files_pending_update_project_markdown_to_branch(args: { mut_yjsDoc: YDoc; markdown: string }) {
	const currentMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.mut_yjsDoc,
	});
	if (currentMarkdown._nay) {
		return currentMarkdown;
	}

	if (currentMarkdown._yay === args.markdown) {
		return Result({ _yay: false });
	}

	return files_yjs_doc_update_from_markdown({
		mut_yjsDoc: args.mut_yjsDoc,
		markdown: args.markdown,
	});
}

function files_pending_update_docs_match_content(args: { leftYjsDoc: YDoc; rightYjsDoc: YDoc }) {
	const leftMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.leftYjsDoc,
	});
	if (leftMarkdown._nay) {
		return leftMarkdown;
	}

	const rightMarkdown = files_yjs_doc_get_markdown({
		yjsDoc: args.rightYjsDoc,
	});
	if (rightMarkdown._nay) {
		return rightMarkdown;
	}

	return Result({
		_yay: leftMarkdown._yay === rightMarkdown._yay,
	});
}

function files_pending_update_branch_docs_have_changes(args: {
	baseYjsDoc: YDoc;
	stagedBranchYjsDoc: YDoc;
	unstagedBranchYjsDoc: YDoc;
}) {
	const stagedMatchesBase = files_pending_update_docs_match_content({
		leftYjsDoc: args.baseYjsDoc,
		rightYjsDoc: args.stagedBranchYjsDoc,
	});
	if (stagedMatchesBase._nay) {
		return stagedMatchesBase;
	}

	const unstagedMatchesBase = files_pending_update_docs_match_content({
		leftYjsDoc: args.baseYjsDoc,
		rightYjsDoc: args.unstagedBranchYjsDoc,
	});
	if (unstagedMatchesBase._nay) {
		return unstagedMatchesBase;
	}

	return Result({
		_yay: !(stagedMatchesBase._yay && unstagedMatchesBase._yay),
	});
}

function files_pending_update_branch_docs_match_existing_row(args: {
	existingPendingUpdate: app_convex_Doc<"files_pending_updates"> | null;
	baseYjsSequence: number;
	baseYjsUpdate: ArrayBuffer;
	stagedBranchYjsUpdate: ArrayBuffer;
	unstagedBranchYjsUpdate: ArrayBuffer;
}) {
	if (!args.existingPendingUpdate) {
		return false;
	}

	return (
		args.existingPendingUpdate.baseYjsSequence === args.baseYjsSequence &&
		files_u8_equals(new Uint8Array(args.existingPendingUpdate.baseYjsUpdate), new Uint8Array(args.baseYjsUpdate)) &&
		files_u8_equals(
			new Uint8Array(args.existingPendingUpdate.stagedBranchYjsUpdate),
			new Uint8Array(args.stagedBranchYjsUpdate),
		) &&
		files_u8_equals(
			new Uint8Array(args.existingPendingUpdate.unstagedBranchYjsUpdate),
			new Uint8Array(args.unstagedBranchYjsUpdate),
		)
	);
}

async function files_pending_update_resolve_branch_docs(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		nodeId: app_convex_Doc<"files_pending_updates">["nodeId"];
		pendingUpdateId?: app_convex_Doc<"files_pending_updates">["_id"];
	},
) {
	const existingPendingUpdate = await files_db_get_pending_update(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		userId: args.userId,
		nodeId: args.nodeId,
		pendingUpdateId: args.pendingUpdateId,
	});

	if (existingPendingUpdate) {
		return Result({
			_yay: {
				existingPendingUpdate,
				...files_pending_update_reconstruct_branch_docs(existingPendingUpdate),
			},
		});
	}

	const yjsContent = await files_db_get_yjs_content_and_sequence(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		nodeId: args.nodeId,
	});
	if (!yjsContent) {
		return Result({
			_nay: {
				message: "Failed to resolve file Yjs content while creating pending updates",
			},
		});
	}

	const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsContent.yjsSnapshotDoc.snapshotUpdate, {
		additionalIncrementalArrayBufferUpdates: yjsContent.incrementalYjsUpdatesDocs.map((update) => update.update),
	});

	return Result({
		_yay: {
			existingPendingUpdate: null,
			baseYjsSequence: yjsContent.yjsSequence,
			baseYjsDoc,
			stagedBranchYjsDoc: files_yjs_doc_clone({
				yjsDoc: baseYjsDoc,
			}),
			unstagedBranchYjsDoc: files_yjs_doc_clone({
				yjsDoc: baseYjsDoc,
			}),
		},
	});
}

async function files_pending_update_upsert_branch_docs(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		nodeId: app_convex_Doc<"files_pending_updates">["nodeId"];
		existingPendingUpdate: app_convex_Doc<"files_pending_updates"> | null;
		baseYjsSequence: number;
		baseYjsDoc: YDoc;
		stagedBranchYjsDoc: YDoc;
		unstagedBranchYjsDoc: YDoc;
	},
) {
	const branchDocsHaveChanges = files_pending_update_branch_docs_have_changes({
		baseYjsDoc: args.baseYjsDoc,
		stagedBranchYjsDoc: args.stagedBranchYjsDoc,
		unstagedBranchYjsDoc: args.unstagedBranchYjsDoc,
	});
	if (branchDocsHaveChanges._nay) {
		return Result({
			_nay: {
				message: "Failed to compare pending update branches with base",
				cause: branchDocsHaveChanges._nay,
			},
		});
	}

	if (!branchDocsHaveChanges._yay) {
		if (args.existingPendingUpdate) {
			await Promise.all([
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: args.existingPendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", args.existingPendingUpdate._id),
			]);
		}

		return Result({ _yay: null });
	}

	const baseYjsUpdate = files_pending_update_encode_yjs_state_update({
		yjsDoc: args.baseYjsDoc,
	});
	const stagedBranchYjsUpdate = files_pending_update_encode_yjs_state_update({
		yjsDoc: args.stagedBranchYjsDoc,
	});
	const unstagedBranchYjsUpdate = files_pending_update_encode_yjs_state_update({
		yjsDoc: args.unstagedBranchYjsDoc,
	});

	if (
		files_pending_update_branch_docs_match_existing_row({
			existingPendingUpdate: args.existingPendingUpdate,
			baseYjsSequence: args.baseYjsSequence,
			baseYjsUpdate,
			stagedBranchYjsUpdate,
			unstagedBranchYjsUpdate,
		})
	) {
		return Result({ _yay: null });
	}

	const now = Date.now();

	if (!args.existingPendingUpdate) {
		const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			userId: args.userId,
			nodeId: args.nodeId,
			baseYjsSequence: args.baseYjsSequence,
			baseYjsUpdate,
			stagedBranchYjsUpdate,
			unstagedBranchYjsUpdate,
			updatedAt: now,
		});
		await files_db_schedule_pending_update_cleanup(ctx, {
			pendingUpdateId,
			expectedUpdatedAt: now,
		});
	} else {
		await Promise.all([
			ctx.db.patch("files_pending_updates", args.existingPendingUpdate._id, {
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate,
				stagedBranchYjsUpdate,
				unstagedBranchYjsUpdate,
				updatedAt: now,
			}),
			// Reset the pending update expiry so active pending work stays preserved.
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: args.existingPendingUpdate._id,
				expectedUpdatedAt: now,
			}),
		]);
	}

	return Result({ _yay: null });
}

async function files_pending_update_upsert_updates(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		nodeId: app_convex_Doc<"files_pending_updates">["nodeId"];
		pendingUpdateId?: app_convex_Doc<"files_pending_updates">["_id"];
		stagedMarkdown?: string;
		unstagedMarkdown: string;
	},
) {
	const file = await ctx.db.get("files_nodes", args.nodeId);
	if (!file || file.workspaceId !== args.workspaceId || file.projectId !== args.projectId) {
		return Result({ _nay: { message: "Not found" } });
	}

	const branchDocsResult = await files_pending_update_resolve_branch_docs(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		userId: args.userId,
		nodeId: file._id,
		pendingUpdateId: args.pendingUpdateId,
	});
	if (branchDocsResult._nay) {
		return branchDocsResult;
	}

	const { existingPendingUpdate, baseYjsSequence, baseYjsDoc, stagedBranchYjsDoc, unstagedBranchYjsDoc } =
		branchDocsResult._yay;

	if (args.stagedMarkdown !== undefined) {
		const stagedBranchProjection = files_pending_update_project_markdown_to_branch({
			mut_yjsDoc: stagedBranchYjsDoc,
			markdown: args.stagedMarkdown,
		});
		if (stagedBranchProjection._nay) {
			return Result({
				_nay: {
					message: "Failed to project staged markdown into pending branch",
					cause: stagedBranchProjection._nay,
				},
			});
		}
	}

	const unstagedBranchProjection = files_pending_update_project_markdown_to_branch({
		mut_yjsDoc: unstagedBranchYjsDoc,
		markdown: args.unstagedMarkdown,
	});
	if (unstagedBranchProjection._nay) {
		return Result({
			_nay: {
				message: "Failed to project unstaged markdown into pending branch",
				cause: unstagedBranchProjection._nay.cause,
			},
		});
	}

	return await files_pending_update_upsert_branch_docs(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		userId: args.userId,
		nodeId: file._id,
		existingPendingUpdate,
		baseYjsSequence,
		baseYjsDoc,
		stagedBranchYjsDoc,
		unstagedBranchYjsDoc,
	});
}

export const remove_file_pending_update_if_expired = internalMutation({
	args: {
		pendingUpdateId: v.id("files_pending_updates"),
		expectedUpdatedAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Guard scheduled cleanup with `expectedUpdatedAt`: if the row changed after you
		// created the task, treat this run as stale and do not delete the newer pending state.
		const cleanupTasks = await ctx.db
			.query("files_pending_updates_cleanup_tasks")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", args.pendingUpdateId))
			.collect();

		const matchingCleanupTasks = cleanupTasks.filter(
			(cleanupTask) => cleanupTask.expectedUpdatedAt === args.expectedUpdatedAt,
		);
		await Promise.all(
			matchingCleanupTasks.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
		);

		const pendingUpdate = await ctx.db.get("files_pending_updates", args.pendingUpdateId);
		if (!pendingUpdate) {
			return null;
		}
		if (pendingUpdate.updatedAt !== args.expectedUpdatedAt) {
			return null;
		}

		await Promise.all([
			ctx.db.delete("files_pending_updates", pendingUpdate._id),
			...cleanupTasks
				.filter((cleanupTask) => cleanupTask.expectedUpdatedAt !== args.expectedUpdatedAt)
				.map((cleanupTask) => ctx.db.delete("files_pending_updates_cleanup_tasks", cleanupTask._id)),
		]);
		return null;
	},
});

export const upsert_file_pending_update = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		stagedMarkdown: v.optional(v.string()),
		unstagedMarkdown: v.string(),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		return await files_pending_update_upsert_updates(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
			stagedMarkdown: args.stagedMarkdown,
			unstagedMarkdown: args.unstagedMarkdown,
		});
	},
});

export const upsert_file_pending_update_internal = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		stagedMarkdown: v.optional(v.string()),
		unstagedMarkdown: v.string(),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		return await files_pending_update_upsert_updates(ctx, args);
	},
});

export const persist_file_pending_update_rebased_state = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
		baseYjsSequence: v.number(),
		baseYjsUpdate: v.bytes(),
		stagedBranchYjsUpdate: v.bytes(),
		unstagedBranchYjsUpdate: v.bytes(),
	},
	returns: v_result({
		_yay: v.object({
			pendingUpdate: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const [existingPendingUpdate, yjsContent] = await Promise.all([
			files_db_get_pending_update(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				pendingUpdateId: args.pendingUpdateId,
			}),
			files_db_get_yjs_content_and_sequence(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
			}),
		]);
		if (!yjsContent) {
			return Result({
				_nay: {
					message: "Failed to resolve file Yjs content while persisting pending updates",
				},
			});
		}

		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsContent.yjsSnapshotDoc.snapshotUpdate, {
			additionalIncrementalArrayBufferUpdates: yjsContent.incrementalYjsUpdatesDocs.map((update) => update.update),
		});
		const latestBaseYjsUpdate = files_pending_update_encode_yjs_state_update({
			yjsDoc: latestBaseYjsDoc,
		});
		if (
			args.baseYjsSequence !== yjsContent.yjsSequence ||
			!files_u8_equals(new Uint8Array(args.baseYjsUpdate), new Uint8Array(latestBaseYjsUpdate))
		) {
			return Result({
				_nay: {
					message: "Pending update base is stale and must be rebuilt from the latest live file state",
				},
			});
		}

		const baseYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.baseYjsUpdate);
		const stagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.stagedBranchYjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_create_from_array_buffer_update(args.unstagedBranchYjsUpdate);

		const branchDocsHaveChanges = files_pending_update_branch_docs_have_changes({
			baseYjsDoc,
			stagedBranchYjsDoc,
			unstagedBranchYjsDoc,
		});
		if (branchDocsHaveChanges._nay) {
			return Result({
				_nay: {
					message: "Failed to compare rebased pending update branches with base",
					cause: branchDocsHaveChanges._nay,
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		if (!branchDocsHaveChanges._yay) {
			if (existingPendingUpdate) {
				await Promise.all([
					files_db_cancel_pending_update_cleanup_tasks(ctx, {
						pendingUpdateId: existingPendingUpdate._id,
					}),
					ctx.db.delete("files_pending_updates", existingPendingUpdate._id),
				]);
			}

			return Result({
				_yay: {
					pendingUpdate: null,
				},
			});
		}

		if (
			files_pending_update_branch_docs_match_existing_row({
				existingPendingUpdate,
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate: args.baseYjsUpdate,
				stagedBranchYjsUpdate: args.stagedBranchYjsUpdate,
				unstagedBranchYjsUpdate: args.unstagedBranchYjsUpdate,
			})
		) {
			return Result({
				_yay: {
					pendingUpdate: existingPendingUpdate,
				},
			});
		}

		const now = Date.now();
		let pendingUpdateId = existingPendingUpdate?._id ?? null;

		if (!existingPendingUpdate) {
			pendingUpdateId = await ctx.db.insert("files_pending_updates", {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				userId: userAuth.id,
				nodeId: args.nodeId,
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate: args.baseYjsUpdate,
				stagedBranchYjsUpdate: args.stagedBranchYjsUpdate,
				unstagedBranchYjsUpdate: args.unstagedBranchYjsUpdate,
				updatedAt: now,
			});
		} else {
			await Promise.all([
				ctx.db.patch("files_pending_updates", existingPendingUpdate._id, {
					baseYjsSequence: args.baseYjsSequence,
					baseYjsUpdate: args.baseYjsUpdate,
					stagedBranchYjsUpdate: args.stagedBranchYjsUpdate,
					unstagedBranchYjsUpdate: args.unstagedBranchYjsUpdate,
					updatedAt: now,
				}),
				// Refresh the expiry window from this latest row version because rebasing
				// changes the authoritative pending snapshot.
				files_db_schedule_pending_update_cleanup(ctx, {
					pendingUpdateId: existingPendingUpdate._id,
					expectedUpdatedAt: now,
				}),
			]);
		}
		const schedulePendingUpdateCleanupPromise =
			pendingUpdateId && !existingPendingUpdate
				? // Reset the pending update expiry on rebase.
					files_db_schedule_pending_update_cleanup(ctx, {
						pendingUpdateId,
						expectedUpdatedAt: now,
					})
				: null;

		const [, nextPendingUpdate] = await Promise.all([
			schedulePendingUpdateCleanupPromise,
			pendingUpdateId ? ctx.db.get("files_pending_updates", pendingUpdateId) : Promise.resolve(null),
		]);
		if (!nextPendingUpdate) {
			return Result({
				_nay: {
					message: "Failed to read persisted rebased pending update row",
				},
			});
		}

		return Result({
			_yay: {
				pendingUpdate: nextPendingUpdate,
			},
		});
	},
});

export const get_file_pending_update = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		return await files_db_get_pending_update(ctx, {
			workspaceId: membership.workspaceId,
			projectId: membership.projectId,
			userId: userAuth.id,
			nodeId: args.nodeId,
			pendingUpdateId: args.pendingUpdateId,
		});
	},
});

export const get_file_pending_update_internal = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v.union(doc(app_convex_schema, "files_pending_updates"), v.null()),
	handler: async (ctx, args) => {
		return await files_db_get_pending_update(ctx, args);
	},
});

export const list_files_pending_updates = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
	},
	returns: v.array(doc(app_convex_schema, "files_pending_updates")),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return [];
		}

		const filesPendingUpdates = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_workspace_project_user_file", (q) =>
				q.eq("workspaceId", membership.workspaceId).eq("projectId", membership.projectId).eq("userId", userAuth.id),
			)
			.order("asc")
			.collect();

		return filesPendingUpdates;
	},
});

export const get_file_pending_update_last_sequence_saved = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_pending_updates_last_sequence_saved"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			throw convex_error({ message: "Unauthenticated" });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		return await ctx.db
			.query("files_pending_updates_last_sequence_saved")
			.withIndex("by_workspace_project_user_file", (q) =>
				q
					.eq("workspaceId", membership.workspaceId)
					.eq("projectId", membership.projectId)
					.eq("userId", userAuth.id)
					.eq("nodeId", args.nodeId),
			)
			.first();
	},
});

export const save_file_pending_update = mutation({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
		pendingUpdateId: v.optional(v.id("files_pending_updates")),
	},
	returns: v_result({
		_yay: v.object({
			newSequence: v.union(v.number(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx).then((userAuth) => {
			if (!userAuth) {
				return null;
			}

			return ctx.db.get("users", userAuth.id);
		});
		if (!user) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const membership = await workspaces_db_get_membership_for_user(ctx, {
			userId: user._id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const [pendingUpdate, yjsContent] = await Promise.all([
			files_db_get_pending_update(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				userId: user._id,
				nodeId: args.nodeId,
				pendingUpdateId: args.pendingUpdateId,
			}),
			files_db_get_yjs_content_and_sequence(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
			}),
		]);

		if (!pendingUpdate) {
			return Result({
				_nay: {
					message: "Pending update not found",
				},
			});
		}
		if (!yjsContent) {
			return Result({
				_nay: {
					message: "File Yjs content not found",
				},
			});
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_pending_update_write", key: user._id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const reconstructedBranchDocs = files_pending_update_reconstruct_branch_docs(pendingUpdate);
		const baseYjsDoc = reconstructedBranchDocs.baseYjsDoc;
		const stagedBranchYjsDoc = reconstructedBranchDocs.stagedBranchYjsDoc;
		const unstagedBranchYjsDoc = reconstructedBranchDocs.unstagedBranchYjsDoc;
		const latestFileYjsDoc = files_yjs_doc_create_from_array_buffer_update(yjsContent.yjsSnapshotDoc.snapshotUpdate, {
			additionalIncrementalArrayBufferUpdates: yjsContent.incrementalYjsUpdatesDocs.map((update) => update.update),
		});

		const remoteUpdateFromBase = files_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: latestFileYjsDoc,
			yjsBeforeDoc: baseYjsDoc,
		});
		if (remoteUpdateFromBase) {
			const remoteUpdateFromBaseArrayBuffer = files_u8_to_array_buffer(remoteUpdateFromBase);
			files_yjs_doc_apply_array_buffer_update(stagedBranchYjsDoc, remoteUpdateFromBaseArrayBuffer);
			files_yjs_doc_apply_array_buffer_update(unstagedBranchYjsDoc, remoteUpdateFromBaseArrayBuffer);
		}

		const diffUpdateForLatestFileYjsDoc = files_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: stagedBranchYjsDoc,
			yjsBeforeDoc: latestFileYjsDoc,
		});

		let newSequence: number | null = null;
		const liveFileYjsDocAfterSave = files_yjs_doc_clone({
			yjsDoc: latestFileYjsDoc,
		});
		if (diffUpdateForLatestFileYjsDoc) {
			const workspace = await ctx.db.get("workspaces", membership.workspaceId);
			if (!workspace) {
				return Result({ _nay: { message: "Workspace not found" } });
			}
			const billedUserId = billing_pick_billed_user_id({
				userId: user._id,
				workspace,
			});
			const billedUser = await ctx.db.get("users", billedUserId);
			if (!billedUser) {
				throw should_never_happen("Billed user not found", {
					userId: user._id,
					workspaceId: workspace._id,
					billedUserId,
				});
			}

			const check = await billing_db_check_credits(ctx, {
				userId: billedUser._id,
				minimumRequiredCents: 1,
			});
			if (!check.hasCredits) {
				return Result({
					_nay: {
						message: "Insufficient funds",
					},
				});
			}
			const result = await files_db_yjs_push_update(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				nodeId: args.nodeId,
				update: files_u8_to_array_buffer(diffUpdateForLatestFileYjsDoc),
				sessionId: `files_pending_update:${user._id}`,
				userId: user._id,
			});
			if (result._nay) {
				return result;
			}

			newSequence = result._yay.newSequence;
			await billing_ingest_events(ctx, {
				billedUserEvents: [
					{
						billedUser,
						event: billing_event({
							name: "file_save",
							externalCustomerId: billedUser._id,
							externalMemberId: user._id,
							externalId: composite_id(
								"billing",
								"file_save",
								billedUser._id,
								user._id,
								membership.workspaceId,
								membership.projectId,
								args.nodeId,
								result._yay.newSequence,
							),
							metadata: {
								amount: 1,
								actorUserId: user._id,
								billedUserId: billedUser._id,
								workspaceId: membership.workspaceId,
								projectId: membership.projectId,
								nodeId: args.nodeId,
								yjsSequence: String(result._yay.newSequence),
							},
						}),
					},
				],
			});
			files_yjs_doc_apply_array_buffer_update(
				liveFileYjsDocAfterSave,
				files_u8_to_array_buffer(diffUpdateForLatestFileYjsDoc),
			);
		}

		const unstagedMatchesSavedBase = files_pending_update_docs_match_content({
			leftYjsDoc: liveFileYjsDocAfterSave,
			rightYjsDoc: unstagedBranchYjsDoc,
		});
		if (unstagedMatchesSavedBase._nay) {
			return Result({
				_nay: {
					message: "Failed to compare unstaged pending branch with saved file content",
					cause: unstagedMatchesSavedBase._nay,
				},
			});
		}

		const now = Date.now();
		const nextBaseYjsSequence = newSequence ?? yjsContent.yjsSequence;

		if (unstagedMatchesSavedBase._yay) {
			await Promise.all([
				files_pending_update_upsert_last_sequence_saved(ctx, {
					workspaceId: membership.workspaceId,
					projectId: membership.projectId,
					userId: user._id,
					nodeId: args.nodeId,
					lastSequenceSaved: nextBaseYjsSequence,
					updatedAt: now,
				}),
				files_db_cancel_pending_update_cleanup_tasks(ctx, {
					pendingUpdateId: pendingUpdate._id,
				}),
				ctx.db.delete("files_pending_updates", pendingUpdate._id),
			]);

			return Result({
				_yay: {
					newSequence,
				},
			});
		}

		const nextBaseYjsUpdate = files_pending_update_encode_yjs_state_update({
			yjsDoc: liveFileYjsDocAfterSave,
		});

		await Promise.all([
			ctx.db.patch("files_pending_updates", pendingUpdate._id, {
				baseYjsSequence: nextBaseYjsSequence,
				baseYjsUpdate: nextBaseYjsUpdate,
				stagedBranchYjsUpdate: nextBaseYjsUpdate,
				unstagedBranchYjsUpdate: files_pending_update_encode_yjs_state_update({
					yjsDoc: unstagedBranchYjsDoc,
				}),
				updatedAt: now,
			}),
			// Partial saves must keep the pending update alive. Reset the expire of the pending update doc.
			files_db_schedule_pending_update_cleanup(ctx, {
				pendingUpdateId: pendingUpdate._id,
				expectedUpdatedAt: now,
			}),
			files_pending_update_upsert_last_sequence_saved(ctx, {
				workspaceId: membership.workspaceId,
				projectId: membership.projectId,
				userId: user._id,
				nodeId: args.nodeId,
				lastSequenceSaved: nextBaseYjsSequence,
				updatedAt: now,
			}),
		]);

		return Result({
			_yay: {
				newSequence,
			},
		});
	},
});
