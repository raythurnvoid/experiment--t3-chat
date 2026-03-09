import { query, mutation, internalMutation, type MutationCtx } from "./_generated/server.js";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import type { app_convex_Doc } from "../src/lib/app-convex-client.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import app_convex_schema from "./schema.ts";
import { pages_db_yjs_push_update } from "./ai_docs_temp.ts";
import { Result } from "../src/lib/errors-as-values-utils.ts";
import {
	pages_db_cancel_pending_edit_cleanup_tasks,
	pages_db_get_yjs_content_and_sequence,
	pages_db_schedule_pending_edit_cleanup,
	pages_yjs_doc_apply_array_buffer_update,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_clone,
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_markdown,
	pages_yjs_compute_diff_update_from_yjs_doc,
	pages_u8_to_array_buffer,
	pages_u8_equals,
} from "../server/pages.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

function pages_pending_edit_encode_yjs_state_update(args: { yjsDoc: YDoc }) {
	return pages_u8_to_array_buffer(encodeStateAsUpdate(args.yjsDoc));
}

function pages_pending_edit_reconstruct_branch_docs(pendingEdit: app_convex_Doc<"pages_pending_edits">) {
	return {
		baseYjsSequence: pendingEdit.baseYjsSequence,
		baseYjsDoc: pages_yjs_doc_create_from_array_buffer_update(pendingEdit.baseYjsUpdate),
		workingBranchYjsDoc: pages_yjs_doc_create_from_array_buffer_update(pendingEdit.workingBranchYjsUpdate),
		modifiedBranchYjsDoc: pages_yjs_doc_create_from_array_buffer_update(pendingEdit.modifiedBranchYjsUpdate),
	};
}

function pages_pending_edit_project_markdown_to_branch(args: { mut_yjsDoc: YDoc; markdown: string }) {
	const currentMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: args.mut_yjsDoc,
	});
	if (currentMarkdown._nay) {
		return currentMarkdown;
	}

	if (currentMarkdown._yay === args.markdown) {
		return Result({ _yay: false });
	}

	return pages_yjs_doc_update_from_markdown({
		mut_yjsDoc: args.mut_yjsDoc,
		markdown: args.markdown,
	});
}

function pages_pending_edit_docs_match_content(args: { leftYjsDoc: YDoc; rightYjsDoc: YDoc }) {
	const leftMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: args.leftYjsDoc,
	});
	if (leftMarkdown._nay) {
		return leftMarkdown;
	}

	const rightMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: args.rightYjsDoc,
	});
	if (rightMarkdown._nay) {
		return rightMarkdown;
	}

	return Result({
		_yay: leftMarkdown._yay === rightMarkdown._yay,
	});
}

function pages_pending_edit_branch_docs_have_changes(args: {
	baseYjsDoc: YDoc;
	workingBranchYjsDoc: YDoc;
	modifiedBranchYjsDoc: YDoc;
}) {
	const workingMatchesBase = pages_pending_edit_docs_match_content({
		leftYjsDoc: args.baseYjsDoc,
		rightYjsDoc: args.workingBranchYjsDoc,
	});
	if (workingMatchesBase._nay) {
		return workingMatchesBase;
	}

	const modifiedMatchesBase = pages_pending_edit_docs_match_content({
		leftYjsDoc: args.baseYjsDoc,
		rightYjsDoc: args.modifiedBranchYjsDoc,
	});
	if (modifiedMatchesBase._nay) {
		return modifiedMatchesBase;
	}

	return Result({
		_yay: !(workingMatchesBase._yay && modifiedMatchesBase._yay),
	});
}

function pages_pending_edit_branch_docs_match_existing_row(args: {
	existingPendingEdit: app_convex_Doc<"pages_pending_edits"> | null;
	baseYjsSequence: number;
	baseYjsUpdate: ArrayBuffer;
	workingBranchYjsUpdate: ArrayBuffer;
	modifiedBranchYjsUpdate: ArrayBuffer;
}) {
	if (!args.existingPendingEdit) {
		return false;
	}

	return (
		args.existingPendingEdit.baseYjsSequence === args.baseYjsSequence &&
		pages_u8_equals(new Uint8Array(args.existingPendingEdit.baseYjsUpdate), new Uint8Array(args.baseYjsUpdate)) &&
		pages_u8_equals(
			new Uint8Array(args.existingPendingEdit.workingBranchYjsUpdate),
			new Uint8Array(args.workingBranchYjsUpdate),
		) &&
		pages_u8_equals(
			new Uint8Array(args.existingPendingEdit.modifiedBranchYjsUpdate),
			new Uint8Array(args.modifiedBranchYjsUpdate),
		)
	);
}

async function pages_pending_edit_resolve_branch_docs(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		pageId: app_convex_Doc<"pages_pending_edits">["pageId"];
	},
) {
	const existingPendingEdit = await ctx.db
		.query("pages_pending_edits")
		.withIndex("by_workspace_project_user_page", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("userId", args.userId)
				.eq("pageId", args.pageId),
		)
		.first();

	if (existingPendingEdit) {
		return Result({
			_yay: {
				existingPendingEdit,
				...pages_pending_edit_reconstruct_branch_docs(existingPendingEdit),
			},
		});
	}

	const yjsContent = await pages_db_get_yjs_content_and_sequence(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		pageId: args.pageId,
	});
	if (!yjsContent) {
		return Result({
			_nay: {
				message: "Failed to resolve page Yjs content while creating pending edits",
			},
		});
	}

	const baseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(yjsContent.yjsSnapshotDoc.snapshot_update, {
		additionalIncrementalArrayBufferUpdates: yjsContent.incrementalYjsUpdatesDocs.map((update) => update.update),
	});

	return Result({
		_yay: {
			existingPendingEdit: null,
			baseYjsSequence: yjsContent.yjsSequence,
			baseYjsDoc,
			workingBranchYjsDoc: pages_yjs_doc_clone({
				yjsDoc: baseYjsDoc,
			}),
			modifiedBranchYjsDoc: pages_yjs_doc_clone({
				yjsDoc: baseYjsDoc,
			}),
		},
	});
}

async function pages_pending_edit_upsert_branch_docs(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		pageId: app_convex_Doc<"pages_pending_edits">["pageId"];
		existingPendingEdit: app_convex_Doc<"pages_pending_edits"> | null;
		baseYjsSequence: number;
		baseYjsDoc: YDoc;
		workingBranchYjsDoc: YDoc;
		modifiedBranchYjsDoc: YDoc;
	},
) {
	const branchDocsHaveChanges = pages_pending_edit_branch_docs_have_changes({
		baseYjsDoc: args.baseYjsDoc,
		workingBranchYjsDoc: args.workingBranchYjsDoc,
		modifiedBranchYjsDoc: args.modifiedBranchYjsDoc,
	});
	if (branchDocsHaveChanges._nay) {
		return Result({
			_nay: {
				message: "Failed to compare pending edit branches with base",
				cause: branchDocsHaveChanges._nay,
			},
		});
	}

	if (!branchDocsHaveChanges._yay) {
		if (args.existingPendingEdit) {
			await Promise.all([
				pages_db_cancel_pending_edit_cleanup_tasks(ctx, {
					pendingEditId: args.existingPendingEdit._id,
				}),
				ctx.db.delete("pages_pending_edits", args.existingPendingEdit._id),
			]);
		}

		return Result({ _yay: null });
	}

	const baseYjsUpdate = pages_pending_edit_encode_yjs_state_update({
		yjsDoc: args.baseYjsDoc,
	});
	const workingBranchYjsUpdate = pages_pending_edit_encode_yjs_state_update({
		yjsDoc: args.workingBranchYjsDoc,
	});
	const modifiedBranchYjsUpdate = pages_pending_edit_encode_yjs_state_update({
		yjsDoc: args.modifiedBranchYjsDoc,
	});

	if (
		pages_pending_edit_branch_docs_match_existing_row({
			existingPendingEdit: args.existingPendingEdit,
			baseYjsSequence: args.baseYjsSequence,
			baseYjsUpdate,
			workingBranchYjsUpdate,
			modifiedBranchYjsUpdate,
		})
	) {
		return Result({ _yay: null });
	}

	const now = Date.now();

	if (!args.existingPendingEdit) {
		const pendingEditId = await ctx.db.insert("pages_pending_edits", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			userId: args.userId,
			pageId: args.pageId,
			baseYjsSequence: args.baseYjsSequence,
			baseYjsUpdate,
			workingBranchYjsUpdate,
			modifiedBranchYjsUpdate,
			updatedAt: now,
		});
		await pages_db_schedule_pending_edit_cleanup(ctx, {
			pendingEditId,
			expectedUpdatedAt: now,
		});
	} else {
		await Promise.all([
			ctx.db.patch("pages_pending_edits", args.existingPendingEdit._id, {
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate,
				workingBranchYjsUpdate,
				modifiedBranchYjsUpdate,
				updatedAt: now,
			}),
			// Reset the pending edit expiry so active pending work stays preserved.
			pages_db_schedule_pending_edit_cleanup(ctx, {
				pendingEditId: args.existingPendingEdit._id,
				expectedUpdatedAt: now,
			}),
		]);
	}

	return Result({ _yay: null });
}

export const remove_pages_pending_edit_if_expired = internalMutation({
	args: {
		pendingEditId: v.id("pages_pending_edits"),
		expectedUpdatedAt: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Guard scheduled cleanup with `expectedUpdatedAt`: if the row changed after you
		// created the task, treat this run as stale and do not delete the newer pending state.
		const cleanupTasks = await ctx.db
			.query("pages_pending_edits_cleanup_tasks")
			.withIndex("by_pendingEditId", (q) => q.eq("pendingEditId", args.pendingEditId))
			.collect();

		const matchingCleanupTasks = cleanupTasks.filter(
			(cleanupTask) => cleanupTask.expectedUpdatedAt === args.expectedUpdatedAt,
		);
		await Promise.all(
			matchingCleanupTasks.map((cleanupTask) => ctx.db.delete("pages_pending_edits_cleanup_tasks", cleanupTask._id)),
		);

		const pendingEdit = await ctx.db.get("pages_pending_edits", args.pendingEditId);
		if (!pendingEdit) {
			return null;
		}
		if (pendingEdit.updatedAt !== args.expectedUpdatedAt) {
			return null;
		}

		await Promise.all([
			ctx.db.delete("pages_pending_edits", pendingEdit._id),
			...cleanupTasks
				.filter((cleanupTask) => cleanupTask.expectedUpdatedAt !== args.expectedUpdatedAt)
				.map((cleanupTask) => ctx.db.delete("pages_pending_edits_cleanup_tasks", cleanupTask._id)),
		]);
		return null;
	},
});

export const upsert_pages_pending_edit_updates = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		workingMarkdown: v.optional(v.string()),
		modifiedMarkdown: v.string(),
	},
	returns: v_result({
		_yay: v.null(),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const branchDocsResult = await pages_pending_edit_resolve_branch_docs(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			userId: user.id,
			pageId: args.pageId,
		});
		if (branchDocsResult._nay) {
			return branchDocsResult;
		}

		const {
			existingPendingEdit,
			baseYjsSequence,
			baseYjsDoc,
			workingBranchYjsDoc,
			modifiedBranchYjsDoc,
		} = branchDocsResult._yay;

		if (args.workingMarkdown !== undefined) {
			const workingBranchProjection = pages_pending_edit_project_markdown_to_branch({
				mut_yjsDoc: workingBranchYjsDoc,
				markdown: args.workingMarkdown,
			});
			if (workingBranchProjection._nay) {
				return Result({
					_nay: {
						message: "Failed to project working markdown into pending branch",
						cause: workingBranchProjection._nay,
					},
				});
			}
		}

		const modifiedBranchProjection = pages_pending_edit_project_markdown_to_branch({
			mut_yjsDoc: modifiedBranchYjsDoc,
			markdown: args.modifiedMarkdown,
		});
		if (modifiedBranchProjection._nay) {
			return Result({
				_nay: {
					message: "Failed to project modified markdown into pending branch",
					cause: modifiedBranchProjection._nay.cause,
				},
			});
		}

		return await pages_pending_edit_upsert_branch_docs(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			userId: user.id,
			pageId: args.pageId,
			existingPendingEdit,
			baseYjsSequence,
			baseYjsDoc,
			workingBranchYjsDoc,
			modifiedBranchYjsDoc,
		});
	},
});

export const persist_pages_pending_edit_rebased_state = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		baseYjsSequence: v.number(),
		baseYjsUpdate: v.bytes(),
		workingBranchYjsUpdate: v.bytes(),
		modifiedBranchYjsUpdate: v.bytes(),
	},
	returns: v_result({
		_yay: v.object({
			pendingEdit: v.union(doc(app_convex_schema, "pages_pending_edits"), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const [existingPendingEdit, yjsContent] = await Promise.all([
			ctx.db
				.query("pages_pending_edits")
				.withIndex("by_workspace_project_user_page", (q) =>
					q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId)
						.eq("userId", user.id)
						.eq("pageId", args.pageId),
				)
				.first(),
			pages_db_get_yjs_content_and_sequence(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
			}),
		]);
		if (!yjsContent) {
			return Result({
				_nay: {
					message: "Failed to resolve page Yjs content while persisting pending edits",
				},
			});
		}

		const latestBaseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(yjsContent.yjsSnapshotDoc.snapshot_update, {
			additionalIncrementalArrayBufferUpdates: yjsContent.incrementalYjsUpdatesDocs.map((update) => update.update),
		});
		const latestBaseYjsUpdate = pages_pending_edit_encode_yjs_state_update({
			yjsDoc: latestBaseYjsDoc,
		});
		if (
			args.baseYjsSequence !== yjsContent.yjsSequence ||
			!pages_u8_equals(new Uint8Array(args.baseYjsUpdate), new Uint8Array(latestBaseYjsUpdate))
		) {
			return Result({
				_nay: {
					message: "Pending edit base is stale and must be rebuilt from the latest live page state",
				},
			});
		}

		const baseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.baseYjsUpdate);
		const workingBranchYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.workingBranchYjsUpdate);
		const modifiedBranchYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.modifiedBranchYjsUpdate);

		const branchDocsHaveChanges = pages_pending_edit_branch_docs_have_changes({
			baseYjsDoc,
			workingBranchYjsDoc,
			modifiedBranchYjsDoc,
		});
		if (branchDocsHaveChanges._nay) {
			return Result({
				_nay: {
					message: "Failed to compare rebased pending edit branches with base",
					cause: branchDocsHaveChanges._nay,
				},
			});
		}

		if (!branchDocsHaveChanges._yay) {
			if (existingPendingEdit) {
				await Promise.all([
					pages_db_cancel_pending_edit_cleanup_tasks(ctx, {
						pendingEditId: existingPendingEdit._id,
					}),
					ctx.db.delete("pages_pending_edits", existingPendingEdit._id),
				]);
			}

			return Result({
				_yay: {
					pendingEdit: null,
				},
			});
		}

		if (
			pages_pending_edit_branch_docs_match_existing_row({
				existingPendingEdit,
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate: args.baseYjsUpdate,
				workingBranchYjsUpdate: args.workingBranchYjsUpdate,
				modifiedBranchYjsUpdate: args.modifiedBranchYjsUpdate,
			})
		) {
			return Result({
				_yay: {
					pendingEdit: existingPendingEdit,
				},
			});
		}

		const now = Date.now();
		let pendingEditId = existingPendingEdit?._id ?? null;

		if (!existingPendingEdit) {
			pendingEditId = await ctx.db.insert("pages_pending_edits", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				userId: user.id,
				pageId: args.pageId,
				baseYjsSequence: args.baseYjsSequence,
				baseYjsUpdate: args.baseYjsUpdate,
				workingBranchYjsUpdate: args.workingBranchYjsUpdate,
				modifiedBranchYjsUpdate: args.modifiedBranchYjsUpdate,
				updatedAt: now,
			});
		} else {
			await Promise.all([
				ctx.db.patch("pages_pending_edits", existingPendingEdit._id, {
					baseYjsSequence: args.baseYjsSequence,
					baseYjsUpdate: args.baseYjsUpdate,
					workingBranchYjsUpdate: args.workingBranchYjsUpdate,
					modifiedBranchYjsUpdate: args.modifiedBranchYjsUpdate,
					updatedAt: now,
				}),
				// Refresh the expiry window from this latest row version because rebasing
				// changes the authoritative pending snapshot.
				pages_db_schedule_pending_edit_cleanup(ctx, {
					pendingEditId: existingPendingEdit._id,
					expectedUpdatedAt: now,
				}),
			]);
		}
		const schedulePendingEditCleanupPromise =
			pendingEditId && !existingPendingEdit
				? // Reset the pending edit expiry on rebase.
					pages_db_schedule_pending_edit_cleanup(ctx, {
						pendingEditId,
						expectedUpdatedAt: now,
					})
				: null;

		const [, nextPendingEdit] = await Promise.all([
			schedulePendingEditCleanupPromise,
			pendingEditId ? ctx.db.get("pages_pending_edits", pendingEditId) : Promise.resolve(null),
		]);
		if (!nextPendingEdit) {
			return Result({
				_nay: {
					message: "Failed to read persisted rebased pending edit row",
				},
			});
		}

		return Result({
			_yay: {
				pendingEdit: nextPendingEdit,
			},
		});
	},
});

export const get_pages_pending_edit = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
	},
	returns: v.union(doc(app_convex_schema, "pages_pending_edits"), v.null()),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const pendingEdit = await ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("userId", user.id)
					.eq("pageId", args.pageId),
			)
			.first();
		return pendingEdit;
	},
});

export const list_pages_pending_edits = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.array(doc(app_convex_schema, "pages_pending_edits")),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const pagesPendingEdits = await ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("userId", user.id),
			)
			.order("asc")
			.collect();

		return pagesPendingEdits;
	},
});

export const save_pages_pending_edit = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
	},
	returns: v_result({
		_yay: v.object({
			newSequence: v.union(v.number(), v.null()),
		}),
	}),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const [pendingEdit, yjsContent] = await Promise.all([
			ctx.db
				.query("pages_pending_edits")
				.withIndex("by_workspace_project_user_page", (q) =>
					q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId)
						.eq("userId", user.id)
						.eq("pageId", args.pageId),
				)
				.first(),
			pages_db_get_yjs_content_and_sequence(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
			}),
		]);

		if (!pendingEdit) {
			return Result({
				_nay: {
					message: "Pending edit not found",
				},
			});
		}
		if (!yjsContent) {
			return Result({
				_nay: {
					message: "Page Yjs content not found",
				},
			});
		}

		const reconstructedBranchDocs = pages_pending_edit_reconstruct_branch_docs(pendingEdit);
		const baseYjsDoc = reconstructedBranchDocs.baseYjsDoc;
		const workingBranchYjsDoc = reconstructedBranchDocs.workingBranchYjsDoc;
		const modifiedBranchYjsDoc = reconstructedBranchDocs.modifiedBranchYjsDoc;
		const latestPageYjsDoc = pages_yjs_doc_create_from_array_buffer_update(yjsContent.yjsSnapshotDoc.snapshot_update, {
			additionalIncrementalArrayBufferUpdates: yjsContent.incrementalYjsUpdatesDocs.map((update) => update.update),
		});

		const remoteUpdateFromBase = pages_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: latestPageYjsDoc,
			yjsBeforeDoc: baseYjsDoc,
		});
		if (remoteUpdateFromBase) {
			const remoteUpdateFromBaseArrayBuffer = pages_u8_to_array_buffer(remoteUpdateFromBase);
			pages_yjs_doc_apply_array_buffer_update(workingBranchYjsDoc, remoteUpdateFromBaseArrayBuffer);
			pages_yjs_doc_apply_array_buffer_update(modifiedBranchYjsDoc, remoteUpdateFromBaseArrayBuffer);
		}

		const diffUpdateForLatestPageYjsDoc = pages_yjs_compute_diff_update_from_yjs_doc({
			yjsDoc: workingBranchYjsDoc,
			yjsBeforeDoc: latestPageYjsDoc,
		});

		let newSequence: number | null = null;
		const livePageYjsDocAfterSave = pages_yjs_doc_clone({
			yjsDoc: latestPageYjsDoc,
		});
		if (diffUpdateForLatestPageYjsDoc) {
			const result = await pages_db_yjs_push_update(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
				update: pages_u8_to_array_buffer(diffUpdateForLatestPageYjsDoc),
				sessionId: `pages_pending_edit:${user.id}`,
				userId: user.id,
				userName: user.name,
			});

			newSequence = result.newSequence;
			pages_yjs_doc_apply_array_buffer_update(
				livePageYjsDocAfterSave,
				pages_u8_to_array_buffer(diffUpdateForLatestPageYjsDoc),
			);
		}

		const modifiedMatchesSavedBase = pages_pending_edit_docs_match_content({
			leftYjsDoc: livePageYjsDocAfterSave,
			rightYjsDoc: modifiedBranchYjsDoc,
		});
		if (modifiedMatchesSavedBase._nay) {
			return Result({
				_nay: {
					message: "Failed to compare modified pending branch with saved page content",
					cause: modifiedMatchesSavedBase._nay,
				},
			});
		}

		if (modifiedMatchesSavedBase._yay) {
			await Promise.all([
				pages_db_cancel_pending_edit_cleanup_tasks(ctx, {
					pendingEditId: pendingEdit._id,
				}),
				ctx.db.delete("pages_pending_edits", pendingEdit._id),
			]);

			return Result({
				_yay: {
					newSequence,
				},
			});
		}

		const nextBaseYjsSequence = newSequence ?? yjsContent.yjsSequence;
		const nextBaseYjsUpdate = pages_pending_edit_encode_yjs_state_update({
			yjsDoc: livePageYjsDocAfterSave,
		});
		const now = Date.now();

		await Promise.all([
			ctx.db.patch("pages_pending_edits", pendingEdit._id, {
				baseYjsSequence: nextBaseYjsSequence,
				baseYjsUpdate: nextBaseYjsUpdate,
				workingBranchYjsUpdate: nextBaseYjsUpdate,
				modifiedBranchYjsUpdate: pages_pending_edit_encode_yjs_state_update({
					yjsDoc: modifiedBranchYjsDoc,
				}),
				updatedAt: now,
			}),
			// Partial saves must keep the pending edit alive. Reset the expire of the pending edit doc.
			pages_db_schedule_pending_edit_cleanup(ctx, {
				pendingEditId: pendingEdit._id,
				expectedUpdatedAt: now,
			}),
		]);

		return Result({
			_yay: {
				newSequence,
			},
		});
	},
});
