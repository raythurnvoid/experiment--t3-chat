import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const app_convex_schema = defineSchema({
	threads: defineTable({
		title: v.string(),
		archived: v.boolean(),
		/** timestamp in milliseconds */
		last_message_at: v.number(),
		workspace_id: v.string(),
		created_by: v.string(),
		updated_by: v.string(),
		/** timestamp in milliseconds */
		updated_at: v.number(),
		external_id: v.union(v.string(), v.null()),
		project_id: v.string(),
		starred: v.optional(v.boolean()),
		// Note: Convex automatically provides _id and _creationTime fields
		// so we don't need separate id and createdAt fields
	})
		.index("by_workspace", ["workspace_id"])
		.index("by_last_message", ["last_message_at"])
		.index("by_archived", ["archived"])
		.index("by_workspace_and_archived", ["workspace_id", "archived"]),

	messages: defineTable({
		parent_id: v.union(v.id("messages"), v.null()),
		thread_id: v.id("threads"),
		created_by: v.string(),
		/** timestamp in milliseconds */
		created_at: v.number(),
		updated_by: v.string(),
		/** timestamp in milliseconds */
		updated_at: v.number(),
		format: v.string(),
		height: v.number(),

		content: v.union(
			// Assistant message content
			v.object({
				role: v.literal("assistant"),
				content: v.array(
					v.union(
						// Text content part
						v.object({
							type: v.literal("text"),
							text: v.string(),
						}),
						// Reasoning content part
						v.object({
							type: v.literal("reasoning"),
							text: v.string(),
						}),
						// Source content part
						v.object({
							type: v.literal("source"),
							sourceType: v.literal("url"),
							id: v.string(),
							url: v.string(),
							title: v.optional(v.string()),
						}),
						// Tool call content part
						v.object({
							type: v.literal("tool-call"),
							toolCallId: v.string(),
							toolName: v.string(),
							args: v.record(v.string(), v.any()),
							argsText: v.optional(v.string()),
							result: v.optional(v.any()),
							isError: v.optional(v.literal(true)),
						}),
						// File content part
						v.object({
							type: v.literal("file"),
							data: v.string(),
							mimeType: v.string(),
						}),
					),
				),
				metadata: v.object({
					unstable_state: v.any(),
					unstable_annotations: v.array(v.any()),
					unstable_data: v.array(v.any()),
					steps: v.array(
						v.union(
							// Started step
							v.object({
								state: v.literal("started"),
								messageId: v.string(),
							}),
							// Finished step
							v.object({
								state: v.literal("finished"),
								messageId: v.string(),
								finishReason: v.union(
									v.literal("stop"),
									v.literal("length"),
									v.literal("content-filter"),
									v.literal("tool-calls"),
									v.literal("error"),
									v.literal("other"),
									v.literal("unknown"),
								),
								usage: v.optional(
									v.object({
										promptTokens: v.number(),
										completionTokens: v.number(),
									}),
								),
								isContinued: v.boolean(),
							}),
						),
					),
					custom: v.record(v.string(), v.any()),
				}),
				status: v.optional(
					v.object({
						type: v.union(
							v.literal("running"),
							v.literal("requires-action"),
							v.literal("complete"),
							v.literal("incomplete"),
						),
						reason: v.optional(v.string()),
						error: v.optional(v.any()),
					}),
				),
			}),
			// User message content
			v.object({
				role: v.literal("user"),
				content: v.array(
					v.union(
						// Text content part
						v.object({
							type: v.literal("text"),
							text: v.string(),
						}),
						// Image content part
						v.object({
							type: v.literal("image"),
							image: v.string(),
						}),
						// File content part
						v.object({
							type: v.literal("file"),
							data: v.string(),
							mimeType: v.string(),
						}),
					),
				),
				metadata: v.object({
					custom: v.record(v.string(), v.any()),
				}),
				status: v.optional(
					v.object({
						type: v.union(
							v.literal("running"),
							v.literal("requires-action"),
							v.literal("complete"),
							v.literal("incomplete"),
						),
						reason: v.optional(v.string()),
						error: v.optional(v.any()),
					}),
				),
			}),
			// System message content
			v.object({
				role: v.literal("system"),
				content: v.array(
					v.union(
						// Text content part
						v.object({
							type: v.literal("text"),
							text: v.string(),
						}),
					),
				),
				metadata: v.object({
					custom: v.record(v.string(), v.any()),
				}),
				status: v.optional(
					v.object({
						type: v.union(
							v.literal("running"),
							v.literal("requires-action"),
							v.literal("complete"),
							v.literal("incomplete"),
						),
						reason: v.optional(v.string()),
						error: v.optional(v.any()),
					}),
				),
			}),
		),
	})
		.index("by_thread", ["thread_id"])
		.index("by_parent", ["parent_id"])
		.index("by_thread_and_parent", ["thread_id", "parent_id"])
		.index("by_updated_at", ["updated_at"]),

	// Table to persist Yjs documents mirrored from Liveblocks with enhanced metadata
	docs_yjs: defineTable({
		/** Base64-encoded Yjs document state from Liveblocks */
		yjs_document_state: v.string(),
		/** Plain text content extracted from the editor for search and display */
		text_content: v.optional(v.string()),
		/** Document version - always 0 for now until versioning is implemented */
		version: v.number(),

		/** Document title for display in tree */
		title: v.string(),
		/** Whether document is archived */
		is_archived: v.boolean(),
		/** Workspace ID extracted from roomId */
		workspace_id: v.string(),
		/** Project ID extracted from roomId */
		project_id: v.string(),
		/** Document ID generated client side */
		doc_id: v.string(),
		/** Created by user ID */
		created_by: v.string(),
		/** Updated by user ID */
		updated_by: v.string(),
		/** timestamp in milliseconds when document was created */
		created_at: v.number(),
		/** timestamp in milliseconds when document was last updated */
		updated_at: v.number(),
	})
		.index("by_workspace_project", ["workspace_id", "project_id"])
		.index("by_doc_id", ["doc_id"]),

	file_tree: defineTable({
		workspace_id: v.string(),
		project_id: v.string(),
		/** "root" for root items */
		parent_id: v.string(),
		child_id: v.string(),
		name: v.string(),
	})
		.index("by_workspace_project", ["workspace_id", "project_id"])
		.index("by_parent", ["parent_id"])
		.index("by_child", ["child_id"])
		.index("by_parent_and_name", ["parent_id", "name"]),
});

export default app_convex_schema;

export { app_convex_schema };
