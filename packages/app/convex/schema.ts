import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { vWorkId } from "@convex-dev/workpool";
import type { ai_chat_UiMessage } from "../src/lib/ai-chat.ts";
import { ai_chat_MODE_IDS, ai_chat_MODEL_IDS } from "../shared/ai-chat.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { plugins_CAPABILITIES } from "../shared/plugins.ts";

const plugins_capability_validator = v.union(...plugins_CAPABILITIES.map((capability) => v.literal(capability)));

const files_nodes_write_policy_writer_validator = v.union(
	v.object({ kind: v.literal("user"), userId: v.id("users") }),
	v.object({
		kind: v.literal("service_account"),
		serviceAccountId: v.id("access_control_service_accounts"),
	}),
);

/**
 * One node's local write protection. Null means editable. Copied once as a folder default;
 * never merged with a parent rule. A writer rule lists every person or plugin account that may
 * edit. The write doors keep at least one entry in the list, with no duplicates.
 */
const files_nodes_write_policy_validator = v.union(
	v.null(),
	v.object({ mode: v.literal("read_only") }),
	v.object({
		mode: v.literal("writer"),
		writers: v.array(files_nodes_write_policy_writer_validator),
	}),
);

/**
 * The full list of permissions. Users build roles out of these, but can never add a new one.
 **/
const access_control_permission_validator = v.union(
	v.literal("organization.update"),
	v.literal("organization.members.manage"),
	v.literal("organization.roles.manage"),
	v.literal("organization.billing.manage"),
	v.literal("organization.integrations_policy.manage"),
	v.literal("workspace.create"),
	v.literal("workspace.update"),
	v.literal("workspace.delete"),
	v.literal("workspace.members.manage"),
	v.literal("content.read"),
	v.literal("content.write"),
	v.literal("content.permissions.manage"),
	v.literal("workspace.channels.manage"),
	v.literal("workspace.service_accounts.manage"),
	v.literal("workspace.browser.use"),
	v.literal("workspace.mcp.use"),
);

const access_control_grant_permission_validator = v.union(
	access_control_permission_validator,
	v.literal("workspace.plugins.manage"),
	v.literal("plugin.run_as"),
);

const plugins_management_access_validator = v.union(v.literal("owner"), v.literal("selected"), v.literal("workspace"));

/**
 * A role you can give to someone: the name of a system role, or the id of a custom role.
 *
 * Owner cannot be given this way. The only source of ownership is `organizations.ownerUserId`, so
 * an owner has no role assignment doc.
 */
const access_control_role_ref_validator = v.union(
	v.literal("admin"),
	v.literal("member"),
	v.literal("viewer"),
	v.id("access_control_roles"),
);

/**
 * The run generation a write belongs to. Stop raises the run's generation, so every door that
 * checks this refuses the old generation inside the write's own transaction.
 */
export const ai_chat_run_fence_validator = v.object({
	runId: v.id("ai_chat_runs"),
	generation: v.number(),
});

export const ai_chat_workspaces_source_validator = v.object({
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	userId: v.id("users"),
	threadId: v.id("ai_chat_threads"),
	membershipId: v.id("organizations_workspaces_users"),
	membershipLifetime: v.number(),
	/**
	 * Set on the source of a tool call in a run. Missing for work that no run owns, such as a
	 * background job or a human read.
	 */
	run: v.optional(v.union(ai_chat_run_fence_validator, v.null())),
});

/**
 * The browser policy as it was when the user sent the message. Every agent browser door checks it.
 */
export const browser_intent_validator = v.object({
	policyRevision: v.number(),
});

export const ai_chat_browser_source_validator = v.object({
	...ai_chat_workspaces_source_validator.fields,
	sourceMessageId: v.id("ai_chat_threads_messages_aisdk_5"),
});

export const ai_chat_browser_resource_validator = v.union(
	v.object({
		provider: v.literal("cloud"),
		mode: v.union(v.literal("file"), v.literal("web")),
		sessionId: v.id("files_browser_sessions"),
		controlGen: v.number(),
		loadGen: v.number(),
		navGen: v.number(),
		tabId: v.union(v.string(), v.null()),
		tabGen: v.union(v.number(), v.null()),
	}),
	v.object({
		provider: v.literal("playwriter"),
		connectionId: v.id("playwriter_connections"),
		connectionGeneration: v.number(),
		targetRevision: v.number(),
		controlRevision: v.number(),
		navRevision: v.number(),
		confirmedTargetHandle: v.string(),
	}),
);

export const ai_chat_browser_result_validator = v.object({
	status: v.union(
		v.literal("succeeded"),
		v.literal("errored"),
		v.literal("cancelled"),
		v.literal("unknown"),
		v.literal("not_started"),
	),
	reason: v.union(v.string(), v.null()),
});

const playwriter_command_identity_validator = v.object({
	generation: v.number(),
	commandId: v.string(),
	operationHash: v.string(),
	source: v.object({ chatId: v.string(), sourceMessageId: v.string(), toolCallId: v.string() }),
	deadline: v.number(),
	receiptResolutionDeadline: v.number(),
	invocationId: v.id("ai_chat_browser_invocations"),
});

/**
 * Which MCP server a doc is about: a server a plugin declares, or a server a member added. Every doc
 * that names an MCP server keeps it in one `target` field, and indexes use its nested paths.
 */
export const plugins_mcp_target_validator = v.union(
	v.object({
		kind: v.literal("plugin"),
		installationId: v.id("plugins_workspace_installations"),
		/** The manifest server id. */
		serverId: v.string(),
	}),
	v.object({
		kind: v.literal("custom"),
		customServerId: v.id("mcp_custom_servers"),
	}),
);

/**
 * A value encrypted with `MCP_SECRETS_ENCRYPTION_KEY`. The doc that holds it names the additional
 * data, so a value copied to another doc fails to decrypt.
 */
const plugins_mcp_encrypted_value_validator = v.object({
	ciphertext: v.bytes(),
	nonce: v.bytes(),
	keyId: v.literal("v1"),
});

const plugins_mcp_oauth_client_kind_validator = v.union(v.literal("cimd"), v.literal("dcr"));

const plugins_mcp_oauth_token_endpoint_auth_method_validator = v.union(
	v.literal("none"),
	v.literal("client_secret_basic"),
	v.literal("client_secret_post"),
);

const organizations_integration_policy_mode_validator = v.union(v.literal("allow_all"), v.literal("allowlist"));

/**
 * A tool result too large to keep inline points at its stored full text. `ai_chat_tool_output_ref_schema`
 * in `shared/ai-chat-files.ts` is the Zod twin. The ref grants nothing: reads check an owner doc.
 */
const ai_chat_tool_output_ref_validator = v.object({
	outputId: v.id("ai_chat_output_objects"),
	/**
	 * Where Bash reads the full text: `/tool-output/<outputId>.txt`.
	 */
	path: v.string(),
	storedBytes: v.number(),
	/**
	 * The bytes the producer returned, before the cuts named in `cutBy`.
	 */
	sourceBytes: v.number(),
	/**
	 * Cuts that ran before the store saw the text. Those bytes are not in the stored text.
	 */
	cutBy: v.array(v.union(v.literal("mcp_binary_omitted"), v.literal("mcp_structured_dropped"))),
});

export const ai_chat_bash_result_validator = v.object({
	title: v.string(),
	output: v.string(),
	stdout: v.string(),
	stderr: v.string(),
	metadata: v.object({
		command: v.string(),
		cwd: v.string(),
		nextCwd: v.string(),
		exitCode: v.number(),
		stdoutTruncated: v.boolean(),
		stderrTruncated: v.boolean(),
		stdoutLength: v.number(),
		stderrLength: v.number(),
		pathIndexTruncated: v.boolean(),
		observedPaths: v.array(
			v.object({ workspace: v.union(v.literal("current"), v.literal("personal")), path: v.string() }),
		),
		observedPathsTruncated: v.boolean(),
		/**
		 * The jobs `wait` stopped polling for because their finish wakes the agent. The Bash tool
		 * ends the turn when this is present.
		 */
		waitingForJobs: v.optional(v.array(v.number())),
		/**
		 * The jobs this call launched. The chat keeps the call's tool card loading until they end.
		 */
		launchedJobNumbers: v.optional(v.array(v.number())),
		/**
		 * Set when the full output was stored. `output` then holds only its head and tail.
		 */
		output: v.optional(ai_chat_tool_output_ref_validator),
	}),
});

/**
 * The model a job wakeup runs with: the model of the chat call that armed the job.
 */
export const ai_chat_model_id_validator = v.union(...ai_chat_MODEL_IDS.map((modelId) => v.literal(modelId)));

/**
 * What a billed provider request was for.
 */
export const ai_model_call_purpose_validator = v.union(
	v.literal("chat_step"),
	v.literal("title"),
	v.literal("inline_ai"),
	v.literal("compaction"),
);

/**
 * One charge of a provider request. `queued` waits for the Polar pool; the other states are final.
 * `target_gone` means the payer's user doc or anonymous snapshot no longer existed, so nothing was
 * billed.
 */
const ai_model_call_charge_validator = v.object({
	amountCents: v.number(),
	externalId: v.string(),
	state: v.union(
		v.literal("skipped_zero"),
		v.literal("queued"),
		v.literal("delivered"),
		v.literal("delivery_failed"),
		v.literal("debited"),
		v.literal("target_gone"),
	),
});

/**
 * The one agent run in progress on a thread: a `/api/chat` request streaming, or a
 * `run_job_wakeup` action. A thread has at most one. The run clears it at its end; `expiresAt`
 * covers a run whose action was killed.
 */
export const ai_chat_thread_active_run_validator = v.object({
	kind: v.union(v.literal("chat"), v.literal("job_wakeup")),
	expiresAt: v.number(),
	runId: v.id("ai_chat_runs"),
	generation: v.number(),
});

/**
 * Saved content approved for capture or replacement. Compaction may change a snapshot asset
 * without changing the document's sequence or lineage.
 */
export const files_content_version_validator = v.union(
	v.object({
		kind: v.literal("asset"),
		assetId: v.id("files_r2_assets"),
		contentType: v.string(),
		textKind: v.union(v.literal("plain_text"), v.literal("rich_text"), v.null()),
		collaborationEnabled: v.union(v.literal(false), v.null()),
	}),
	v.object({
		kind: v.literal("yjs"),
		lastSequenceId: v.id("files_yjs_docs_last_sequences"),
		lineageGeneration: v.number(),
		sequence: v.number(),
		contentType: v.string(),
		textKind: v.union(v.literal("plain_text"), v.literal("rich_text")),
		collaborationEnabled: v.literal(true),
	}),
);

export const file_quote_validator = v.object({ fileNodeId: v.union(v.string(), v.null()), text: v.string() });

export const files_pending_target_validator = v.union(
	v.object({ kind: v.literal("saved"), id: v.id("files_nodes") }),
	v.object({ kind: v.literal("private"), id: v.id("files_pending_nodes") }),
);

export const files_pending_parent_validator = v.union(
	...files_pending_target_validator.members,
	v.object({ kind: v.literal("root") }),
);

/**
 * The three sealed Yjs states of one pending-update operation batch: the base the edit started
 * from, the staged content, and the unstaged content.
 *
 * Each state carries its own digest. The commit compares the stored digest with the one the caller
 * staged, so a state that changed in between is refused instead of committed.
 */
export const files_pending_updates_state_family_validator = v.object({
	operationBatchId: v.id("files_pending_update_operation_batches"),
	baseStateId: v.id("files_pending_update_yjs_states"),
	stagedStateId: v.id("files_pending_update_yjs_states"),
	unstagedStateId: v.id("files_pending_update_yjs_states"),
	baseStateDigest: v.string(),
	stagedStateDigest: v.string(),
	unstagedStateDigest: v.string(),
});

/**
 * The head of a running job's output, for `jobs -o N`. The worker keeps up to 32 KiB per stream
 * and flushes it into the job row on its 5-second poll tick when new bytes arrived.
 */
export const ai_chat_bash_job_live_output_validator = v.object({
	stdout: v.string(),
	stderr: v.string(),
	stdoutTruncated: v.boolean(),
	stderrTruncated: v.boolean(),
});

/**
 * A saved Bash interpreter state. It mirrors the engine's `InterpreterStateSnapshot` field by
 * field; `server/bash-utils.ts` compares the two types so a drift fails the type check. That check
 * has limits, named where it lives.
 * `env` is a pair list, not an object: Convex rejects object keys with non-ASCII characters, and
 * the env map holds associative-array keys. The cwd is not here; the shell row owns it.
 */
export const bash_shell_state_validator = v.object({
	env: v.array(v.object({ name: v.string(), value: v.string() })),
	arrays: v.array(
		v.object({
			name: v.string(),
			kind: v.union(v.literal("indexed"), v.literal("associative")),
			elements: v.array(v.object({ key: v.string(), value: v.string() })),
		}),
	),
	options: v.record(v.string(), v.boolean()),
	shoptOptions: v.record(v.string(), v.boolean()),
	readonlyVars: v.array(v.string()),
	associativeArrays: v.array(v.string()),
	namerefs: v.array(v.string()),
	boundNamerefs: v.array(v.string()),
	invalidNamerefs: v.array(v.string()),
	integerVars: v.array(v.string()),
	lowercaseVars: v.array(v.string()),
	uppercaseVars: v.array(v.string()),
	exportedVars: v.array(v.string()),
	declaredVars: v.array(v.string()),
	functions: v.array(v.object({ name: v.string(), text: v.string() })),
	previousDir: v.string(),
	directoryStack: v.array(v.string()),
	lastExitCode: v.number(),
	lastArg: v.string(),
	/**
	 * What `$!` reads. Optional because almost no stored state has it: a call drops it from the
	 * snapshot it saves, and so does the copy a job starts from. Only a job paused mid-script keeps it,
	 * so its next run can answer `$!`.
	 */
	lastBackgroundPid: v.optional(v.number()),
	openFileDescriptors: v.array(v.number()),
});

export const files_transfer_scope_validator = v.object({
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	membershipId: v.id("organizations_workspaces_users"),
	membershipLifetime: v.number(),
});

export const files_transfer_conflict_policy_validator = v.object({
	file: v.union(v.literal("ask"), v.literal("replace"), v.literal("skip"), v.literal("error")),
	folder: v.union(
		v.literal("ask"),
		v.literal("merge"),
		v.literal("replace_empty"),
		v.literal("skip"),
		v.literal("error"),
	),
});

export const files_transfer_source_version_validator = v.union(
	...files_content_version_validator.members,
	v.object({
		kind: v.literal("pending"),
		pendingUpdateId: v.id("files_pending_updates"),
		revision: v.number(),
		privateVersion: v.union(v.object({ creationGeneration: v.number(), structuralRevision: v.number() }), v.null()),
		savedVersion: v.union(files_content_version_validator, v.null()),
		contentType: v.string(),
		textKind: v.union(v.literal("plain_text"), v.literal("rich_text"), v.null()),
		collaborationEnabled: v.union(v.boolean(), v.null()),
	}),
);

export const files_media_dependency_validator = v.object({
	src: v.string(),
	target: files_pending_target_validator,
	assetId: v.id("files_r2_assets"),
	version: files_transfer_source_version_validator,
});

export const files_media_validation_versions_validator = v.object({
	versions: v.array(v.object({ id: v.id("files_media_validation_versions"), revision: v.number() })),
	pendingVersions: v.array(v.object({ id: v.id("files_pending_review_versions"), revision: v.number() })),
});

export const files_metadata_entries_validator = v.array(
	v.object({ key: v.string(), value: v.union(v.string(), v.number(), v.boolean()) }),
);

/**
 * The ordered saved clauses. Check fields, duplicates and count with `files_sort_is_valid`.
 */
export const files_sort_validator = v.array(
	v.object({ field: v.string(), direction: v.union(v.literal("asc"), v.literal("desc")) }),
);

const files_sort_key_validator = v.array(v.union(v.string(), v.number(), v.null()));

export const files_sort_row_key_validator = v.object({
	parts: v.array(v.union(files_sort_key_validator, v.null())),
	nameKey: v.array(v.string()),
});

export const files_table_filter_validator = v.union(
	v.object({ kind: v.literal("name"), field: v.literal("name"), op: v.literal("starts_with"), value: v.string() }),
	v.object({ kind: v.literal("extension"), field: v.literal("extension"), op: v.literal("is"), value: v.string() }),
	v.object({ kind: v.literal("extension"), field: v.literal("extension"), op: v.literal("missing") }),
	v.object({
		kind: v.literal("date"),
		field: v.union(v.literal("updated"), v.literal("created")),
		op: v.union(v.literal("on"), v.literal("before"), v.literal("after")),
		start: v.number(),
		end: v.number(),
	}),
	v.object({
		kind: v.literal("size"),
		field: v.literal("size"),
		op: v.union(v.literal("is"), v.literal("at_least"), v.literal("at_most")),
		value: v.number(),
	}),
	v.object({ kind: v.literal("size"), field: v.literal("size"), op: v.literal("missing") }),
	v.object({
		kind: v.literal("text"),
		field: v.string(),
		op: v.union(v.literal("is"), v.literal("starts_with")),
		value: v.string(),
	}),
	v.object({ kind: v.literal("text"), field: v.string(), op: v.literal("present") }),
);

const files_pending_create_intent_validator = v.union(
	v.object({ kind: v.literal("folder"), metadata: files_metadata_entries_validator }),
	v.object({
		kind: v.literal("text"),
		contentType: v.string(),
		textKind: v.union(v.literal("plain_text"), v.literal("rich_text")),
		collaborationEnabled: v.boolean(),
		metadata: files_metadata_entries_validator,
	}),
	v.object({
		kind: v.literal("stored"),
		assetId: v.id("files_r2_assets"),
		size: v.number(),
		contentType: v.string(),
		metadata: files_metadata_entries_validator,
	}),
);

// Saved indexes also cover read-only mounts. Pending indexes always belong to a real owner and tenant.
const files_committed_index_fields = {
	organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
	workspaceId: v.union(
		v.id("organizations_workspaces"),
		v.id("plugins_volumes"),
		v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
		v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
	),
	sourceKind: v.literal("committed"),
	fileNodeId: v.id("files_nodes"),
	yjsSequence: v.optional(v.number()),
};

const files_pending_index_fields = {
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	sourceKind: v.literal("pending"),
	target: files_pending_target_validator,
	userId: v.id("users"),
	pendingUpdateId: v.id("files_pending_updates"),
	proposalRevision: v.number(),
};

const files_metadata_index_fields = {
	path: v.string(),
	treePath: v.string(),
	archiveOperationId: v.optional(v.string()),
	fieldPath: v.string(),
	/**
	 * Preserve the user's metadata map order. Frontmatter leaves this unset.
	 */
	entryIndex: v.optional(v.number()),
	docKind: v.union(v.literal("field"), v.literal("value")),
	valueKind: v.optional(
		v.union(v.literal("string"), v.literal("number"), v.literal("boolean"), v.literal("maybe_date")),
	),
	stringValue: v.optional(v.string()),
	numberValue: v.optional(v.number()),
	booleanValue: v.optional(v.boolean()),
};

/**
 * Sort fields of a committed `field` doc, so the folder table can list the children of one folder
 * that have one key, ordered by its value. Value docs and pending docs never carry them.
 */
const files_metadata_committed_sort_fields = {
	/** The node's parent folder. */
	parentId: v.optional(v.union(v.id("files_nodes"), v.literal("root"))),
	nodeKind: v.optional(v.union(v.literal("folder"), v.literal("file"))),
	/** Copy of the node's flag. See `files_nodes.isRestrictedScopeRoot`. */
	isRestrictedScopeRoot: v.optional(v.boolean()),
	name: v.optional(v.string()),
	/** `files_sort_text_key(name)`. */
	sortName: v.optional(v.string()),
	/**
	 * `files_sort_value_of(values).sortValue`. Unset when the key has no plain value, such as a
	 * frontmatter map, so the row sorts as missing.
	 */
	sortValue: v.optional(v.string()),
	/**
	 * The value the user typed, shown in table cells. Set together with `sortValue`.
	 */
	sortDisplayValue: v.optional(v.union(v.string(), v.number(), v.boolean())),
};

const files_text_chunk_fields = {
	chunkIndex: v.number(),
	textChunk: v.string(),
	/** Character offsets in the full text content. */
	startIndex: v.number(),
	endIndex: v.number(),
	/** 1-based text line range covered by this chunk. */
	lineStart: v.number(),
	lineEnd: v.number(),
	chunkFlags: v.number(),
};

const files_plain_text_chunk_fields = {
	...files_text_chunk_fields,
	/** Linked exact text chunk for exact reads and integrity checks. */
	textChunkId: v.id("files_text_chunks"),
	/** Effective path, used to filter search before pagination. */
	path: v.string(),
	archiveOperationId: v.optional(v.string()),
	plainTextChunk: v.string(),
	hasChunkAbove: v.boolean(),
	hasChunkBelow: v.boolean(),
};

export const files_browser_session_control_validator = v.union(
	v.literal("starting"),
	v.literal("ready"),
	v.literal("human"),
	v.literal("pausing"),
	v.literal("closing"),
	v.literal("closed"),
);

export const files_browser_session_source_kind_validator = v.union(
	v.literal("saved"),
	v.literal("proposed"),
	v.literal("draft"),
);

const files_browser_session_shared_fields = {
	ownerId: v.id("users"),
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	/**
	 * Who pays for this session's browser time. Frozen at start, so a later ownership transfer or
	 * billing mode change does not move a running session to another payer.
	 */
	billedUserId: v.id("users"),
	/**
	 * `pending` until the runner's usage receipt is billed. A settled doc is always closed.
	 */
	billing: v.union(
		v.object({ state: v.literal("pending") }),
		v.object({
			state: v.literal("settled"),
			billedMs: v.number(),
			amountCents: v.number(),
			settledAt: v.number(),
		}),
	),
	navigationGeneration: v.number(),
	loadGen: v.number(),
	controlGen: v.number(),
	control: files_browser_session_control_validator,
	runnerSessionId: v.optional(v.string()),
	idleUntil: v.optional(v.number()),
	totalUntil: v.optional(v.number()),
	startingExpiresAt: v.optional(v.number()),
	closedAt: v.optional(v.number()),
	createdAt: v.number(),
	updatedAt: v.number(),
};

const files_subtree_op_shared_fields = {
	organizationId: v.id("organizations"),
	workspaceId: v.id("organizations_workspaces"),
	userId: v.id("users"),
	/**
	 * A `queued` op waits for `blockedByOpId`. It has written nothing and has no step scheduled.
	 */
	status: v.union(v.literal("running"), v.literal("queued")),
	blockedByOpId: v.union(v.id("files_subtree_ops"), v.null()),
	rootNodeIds: v.array(v.id("files_nodes")),
	/**
	 * Where readers see the roots now: the `treePath` of each root, or, for a restore, at most 64 folder
	 * paths that hold its roots (up to `/`). A new op overlaps this op when one of its paths starts with
	 * one of these, or the other way around.
	 */
	treePaths: v.array(v.string()),
};

export const files_pending_prepared_state_family_validator = v.object({
	operationBatchId: v.id("files_pending_update_operation_batches"),
	baseStateId: v.id("files_pending_update_yjs_states"),
	stagedStateId: v.id("files_pending_update_yjs_states"),
	unstagedStateId: v.id("files_pending_update_yjs_states"),
	baseStateDigest: v.string(),
	stagedStateDigest: v.string(),
	unstagedStateDigest: v.string(),
});

const files_pending_prepared_content_fields = {
	membershipId: v.id("organizations_workspaces_users"),
	pendingUpdateId: v.id("files_pending_updates"),
	reviewedRevision: v.number(),
	billedUserId: v.id("users"),
	operationBatchIds: v.array(v.id("files_pending_update_operation_batches")),
};

// Large texts and Yjs states stay in owned batch docs, so review items stay bounded.
export const files_pending_prepared_content_validator = v.union(
	v.object({
		...files_pending_prepared_content_fields,
		kind: v.literal("saved_yjs"),
		nodeId: v.id("files_nodes"),
		baseYjsSequence: v.number(),
		baseLineageGeneration: v.number(),
		expectedYjsLastSequenceId: v.id("files_yjs_docs_last_sequences"),
		trustedStageId: v.optional(v.id("files_yjs_trusted_update_stages")),
		partial: v.optional(
			v.object({
				...files_pending_prepared_state_family_validator.fields,
				unstagedTextInputId: v.id("files_pending_update_text_inputs"),
				unstagedTextChanged: v.boolean(),
			}),
		),
	}),
	v.object({
		...files_pending_prepared_content_fields,
		kind: v.literal("saved_asset"),
		nodeId: v.id("files_nodes"),
		unchanged: v.optional(v.literal(true)),
		publish: v.union(
			v.object({
				textInputId: v.id("files_pending_update_text_inputs"),
				textSize: v.number(),
				versionSnapshotAssetId: v.id("files_r2_assets"),
			}),
			v.null(),
		),
		partial: v.optional(files_pending_prepared_state_family_validator),
	}),
	v.object({
		...files_pending_prepared_content_fields,
		kind: v.literal("private"),
		privateNodeId: v.id("files_pending_nodes"),
		creationGeneration: v.number(),
		structuralRevision: v.number(),
		operationBatchId: v.optional(v.id("files_pending_update_operation_batches")),
		prepared: v.optional(
			v.object({
				textInputId: v.id("files_pending_update_text_inputs"),
				contentAssetId: v.id("files_r2_assets"),
				yjsSnapshotAssetId: v.optional(v.id("files_r2_assets")),
			}),
		),
		partial: v.optional(
			v.object({
				family: files_pending_prepared_state_family_validator,
				unstagedTextInputId: v.id("files_pending_update_text_inputs"),
			}),
		),
	}),
	v.object({
		...files_pending_prepared_content_fields,
		kind: v.literal("replacement"),
		nodeId: v.id("files_nodes"),
		stagedAssetId: v.id("files_r2_assets"),
		expectedYjsLastSequence: v.optional(
			v.object({ id: v.id("files_yjs_docs_last_sequences"), lastSequence: v.number() }),
		),
		backup: v.optional(v.object({ assetId: v.id("files_r2_assets"), size: v.number() })),
		contentAssetId: v.id("files_r2_assets"),
		contentSize: v.number(),
		contentType: v.string(),
		yjsRootKind: v.optional(v.union(v.literal("rich_text"), v.literal("plain_text"))),
		nonCollaborative: v.optional(v.boolean()),
		yjsSnapshot: v.optional(v.object({ assetId: v.id("files_r2_assets"), size: v.number() })),
		textInputId: v.optional(v.id("files_pending_update_text_inputs")),
	}),
);

const app_convex_schema = defineSchema({
	// #region ai
	ai_chat_threads: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),

		/**
		 * Necessary to link the optimistic update to the persisted thread
		 **/
		clientGeneratedId: v.string(),
		title: v.union(v.string(), v.null()),
		archived: v.boolean(),
		starred: v.optional(v.boolean()),

		/**
		 * Keep this stored value. It does not track the AI SDK major version.
		 * The messages table name below has the same `aisdk_5` in it.
		 */
		runtime: v.literal("aisdk_5"),

		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		/**
		 * timestamp in milliseconds
		 **/
		updatedAt: v.number(),
		/**
		 * timestamp in milliseconds
		 **/
		lastMessageAt: v.optional(v.number()),
		/**
		 * Read cursor, timestamp in milliseconds.
		 * The thread is unread while `lastMessageAt > readAt`.
		 **/
		readAt: v.optional(v.number()),
		/**
		 * The last background job number handed out in this thread. Job numbers are never reused,
		 * so this only grows. Missing means no job was ever started.
		 **/
		bashJobCounter: v.optional(v.number()),
		/**
		 * Unused. It once counted job wakeups in a row to end the chain; every finish
		 * now posts and wakes with no cap. The field stays so old docs still read.
		 **/
		bashJobWakeupCount: v.optional(v.number()),
		activeRun: v.optional(ai_chat_thread_active_run_validator),
		/**
		 * Set by Delete chat. From then on every thread door treats the chat as not found, and a
		 * scheduled drain deletes its data in small passes. The thread doc is deleted last.
		 **/
		deletingAt: v.optional(v.number()),
		/**
		 * Set on a branch copy until its messages are copied. Every thread door treats the chat as
		 * not found meanwhile, like `deletingAt`.
		 **/
		copyingAt: v.optional(v.number()),
		/**
		 * Owner docs of stored tool outputs in this thread. A new stored output is refused at 10,000.
		 **/
		outputOwnerCount: v.optional(v.number()),
		/**
		 * The newest message node. The chat shows the branch that ends below it when no branch is picked.
		 **/
		newestNodeId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
	})
		.index("by_organization_workspace_archived_lastMessageAt", [
			"organizationId",
			"workspaceId",
			"archived",
			"lastMessageAt",
		])
		.index("by_organization_workspace_createdBy_archived_lastMessageAt", [
			"organizationId",
			"workspaceId",
			"createdBy",
			"archived",
			"lastMessageAt",
		])
		.index("by_createdBy", ["createdBy"]),

	/**
	 * One agent run execution on a thread: a `/api/chat` request or one `run_job_wakeup` action.
	 * The doc id is the run id. Each run answers one trigger node with one reply node. Each run ends
	 * its own doc. The `end expired chat runs` cron ends a doc whose lease passed without a run end.
	 * Thread deletion deletes these docs.
	 */
	ai_chat_runs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		threadId: v.id("ai_chat_threads"),
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		membershipLifetime: v.number(),
		kind: ai_chat_thread_active_run_validator.fields.kind,
		/**
		 * `stopping` after Stop: only the run's `finish` may still write for the old generation.
		 */
		status: v.union(v.literal("running"), v.literal("stopping"), v.literal("ended")),
		/**
		 * Stop raises it. Fenced doors refuse a write that carries an older generation.
		 */
		generation: v.number(),
		/**
		 * The node the run answers: a user message or a job finish message.
		 */
		triggerId: v.id("ai_chat_threads_messages_aisdk_5"),
		/**
		 * The run's reply node. Its parent is the trigger and never changes.
		 */
		replyId: v.id("ai_chat_threads_messages_aisdk_5"),
		modeId: v.union(...ai_chat_MODE_IDS.map((modeId) => v.literal(modeId))),
		modelId: ai_chat_model_id_validator,
		/**
		 * The last step save. The durable runs of phase F watch it.
		 */
		heartbeatAt: v.number(),
		/**
		 * When Stop was asked, for audits.
		 */
		stopRequestedAt: v.union(v.number(), v.null()),
		/**
		 * Steps saved so far. A resumed run of phase F reads it once as its step offset. Today each
		 * run is one model stream that starts at step 0.
		 */
		completedSteps: v.number(),
		leaseExpiresAt: v.number(),
		endedAt: v.union(v.number(), v.null()),
		/**
		 * The browser state of this turn, for the Bash `browser` command. `bindings` are the exact
		 * browser leases the agent learned in this run. A human change revokes the whole turn, and a
		 * turn allows 20 browser operations. Missing until the first `browser` command.
		 */
		browser: v.optional(
			v.object({
				bindings: v.array(ai_chat_browser_resource_validator),
				revoked: v.boolean(),
				operations: v.number(),
			}),
		),
	})
		.index("by_thread_status", ["threadId", "status"])
		.index("by_status_leaseExpiresAt", ["status", "leaseExpiresAt"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * One model call of a run, saved as its own doc, so a long reply never has to fit in one
	 * message doc. The step's usage save plans the doc before any tool of the step runs. The step's
	 * end completes it. Thread deletion deletes these docs.
	 */
	ai_chat_run_steps: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		threadId: v.id("ai_chat_threads"),
		/**
		 * The reply node the step belongs to.
		 */
		messageId: v.id("ai_chat_threads_messages_aisdk_5"),
		runId: v.id("ai_chat_runs"),
		generation: v.number(),
		stepIndex: v.number(),
		/**
		 * The provider request of the step. Null for a step saved at Stop before its request finished.
		 */
		modelCallId: v.union(v.string(), v.null()),
		/**
		 * `partial`: Stop or an error ended the step early, and it keeps what arrived.
		 */
		status: v.union(v.literal("tools_running"), v.literal("done"), v.literal("partial")),
		/**
		 * The tool calls of the step, saved before the tools start. `opKey` names one operation for
		 * receipts and stored outputs. A large input keeps only its size and hash here; the finished
		 * step's parts hold it in full.
		 */
		toolCalls: v.array(
			v.object({
				providerToolCallId: v.string(),
				opKey: v.string(),
				toolName: v.string(),
				input: v.union(
					v.object({ kind: v.literal("inline"), value: v.any() }),
					v.object({ kind: v.literal("omitted"), bytes: v.number(), sha256: v.string() }),
				),
			}),
		),
		/**
		 * The step's UI message parts, starting with its `step-start` part. Empty while tools run.
		 */
		parts: v.array(v.any()),
		finishReason: v.union(v.string(), v.null()),
		bytes: v.number(),
	})
		.index("by_message_stepIndex", ["messageId", "stepIndex"])
		.index("by_thread", ["threadId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * A job finish waiting for the run that streams on its branch. The run claims it at a step
	 * boundary and shows it inside that step. The step commit deletes the doc. A doc still waiting
	 * when the run ends becomes a finish message under the run's reply.
	 */
	ai_chat_run_inbox: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		threadId: v.id("ai_chat_threads"),
		invocationId: v.id("ai_chat_bash_invocations"),
		text: v.string(),
		state: v.union(v.literal("waiting"), v.literal("claimed")),
		claim: v.union(v.object({ runId: v.id("ai_chat_runs"), generation: v.number(), stepIndex: v.number() }), v.null()),
	})
		.index("by_thread_state", ["threadId", "state"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * A model-written summary of a chat branch up to `tailNodeId`. The history walk for the model
	 * shows the summary in place of that node and everything older, so a long chat fits the model.
	 * The summary covers the older summary it read too, so the walk stops there. The messages the UI
	 * shows do not change. Thread deletion deletes these docs.
	 */
	ai_chat_compactions: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		threadId: v.id("ai_chat_threads"),
		runId: v.id("ai_chat_runs"),
		/**
		 * The oldest message the summary call read. Kept for audits only.
		 */
		headNodeId: v.id("ai_chat_threads_messages_aisdk_5"),
		tailNodeId: v.id("ai_chat_threads_messages_aisdk_5"),
		summary: v.string(),
		bytes: v.number(),
	})
		.index("by_thread_tailNode", ["threadId", "tailNodeId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * One tool operation with an effect but no receipt of its own (`edit_file`, metadata writes,
	 * `execute_code`). The same `opKey` never applies twice.
	 */
	ai_chat_tool_receipts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		threadId: v.id("ai_chat_threads"),
		opKey: v.string(),
		runId: v.id("ai_chat_runs"),
		generation: v.number(),
		toolName: v.string(),
		/**
		 * SHA-256 of the canonical JSON of the tool name and its input. A different input under the
		 * same `opKey` is refused.
		 */
		inputHash: v.string(),
		status: v.union(v.literal("started"), v.literal("finished")),
		/**
		 * The saved result of a finished operation. Null while started.
		 */
		result: v.any(),
	})
		.index("by_thread_opKey", ["threadId", "opKey"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * The full text of one tool result that was too large to keep inline, stored in R2. The doc is
	 * also the quota hold: it holds its bytes and one object on the three chat output counters from
	 * the reservation until its R2 deletion job settles. Owner docs decide who may read it.
	 */
	ai_chat_output_objects: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		/**
		 * The thread whose run reserved it. Delete chat releases its reservation or upload.
		 */
		threadId: v.id("ai_chat_threads"),
		/**
		 * `chat-outputs/<organizationId>/<workspaceId>/<objectId>`. Null while reserved.
		 */
		r2Key: v.union(v.string(), v.null()),
		/**
		 * The stored size and the bytes held after the reservation. Null while reserved.
		 */
		byteCount: v.union(v.number(), v.null()),
		sha256: v.union(v.string(), v.null()),
		contentType: v.union(v.literal("text/plain; charset=utf-8"), v.literal("application/json"), v.null()),
		ownerCount: v.number(),
		quotaIds: v.object({
			workspaceBytes: v.id("quotas"),
			userBytes: v.id("quotas"),
			workspaceObjects: v.id("quotas"),
		}),
		state: v.union(
			v.object({
				kind: v.literal("reserved"),
				runId: v.id("ai_chat_runs"),
				opKey: v.string(),
				/**
				 * The largest size the tool can store. Held until the upload shrinks it to the real size.
				 */
				reservedBytes: v.number(),
			}),
			v.object({
				kind: v.literal("uploading"),
				runId: v.id("ai_chat_runs"),
				opKey: v.string(),
				attemptId: v.string(),
				/**
				 * The signed PUT can still land until then, so a failed upload deletes again after it.
				 */
				putMayArriveUntil: v.number(),
			}),
			v.object({ kind: v.literal("ready") }),
			v.object({ kind: v.literal("deleting") }),
		),
		createdAt: v.number(),
	})
		.index("by_organization_workspace_state", ["organizationId", "workspaceId", "state.kind"])
		.index("by_thread_state", ["threadId", "state.kind"])
		.index("by_run_state", ["state.runId", "state.kind"])
		.index("by_state_putMayArriveUntil", ["state.kind", "state.putMayArriveUntil"])
		.index("by_workspaceBytesQuota", ["quotaIds.workspaceBytes"])
		.index("by_userBytesQuota", ["quotaIds.userBytes"])
		.index("by_workspaceObjectsQuota", ["quotaIds.workspaceObjects"]),

	/**
	 * One thread's right to read one stored output. A running tool attaches a `pending` owner; the
	 * reply save of the same run commits it. Run end removes the pending owners it left. Removing
	 * the last owner starts the object's deletion.
	 */
	ai_chat_output_owners: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		objectId: v.id("ai_chat_output_objects"),
		/**
		 * `sha256(runId:modelCallId:toolCallId)`: one tool call of one provider request of one run.
		 */
		opKey: v.string(),
		runId: v.id("ai_chat_runs"),
		state: v.union(v.literal("pending"), v.literal("committed")),
	})
		.index("by_thread_object", ["threadId", "objectId"])
		.index("by_thread", ["threadId"])
		.index("by_run_state", ["runId", "state"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * One branch copy in progress. `thread_branch` creates the hidden target thread and this doc.
	 * Small steps first write the message ids from the anchor up to the root into pages, then copy
	 * the messages root first with their committed output owners, then publish the target. Publish
	 * deletes this doc. An aborted copy stays until the target's drain deletes it.
	 */
	ai_chat_thread_copies: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		sourceThreadId: v.id("ai_chat_threads"),
		targetThreadId: v.id("ai_chat_threads"),
		/**
		 * The creator and membership captured at the start. Every step checks them again.
		 */
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		membershipLifetime: v.number(),
		state: v.union(
			v.object({
				kind: v.literal("building"),
				/**
				 * The next message to add while walking up. null when the root was added.
				 */
				nextMessageId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
				pageCount: v.number(),
			}),
			v.object({
				kind: v.literal("copying"),
				/**
				 * Pages hold anchor-first ids, so copying walks from the last id of the last page down.
				 */
				page: v.number(),
				index: v.number(),
				/**
				 * The copy of the last copied message: the parent of the next copy.
				 */
				parentId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
			}),
			v.object({ kind: v.literal("aborted") }),
		),
		expiresAt: v.number(),
	})
		.index("by_source", ["sourceThreadId"])
		.index("by_target", ["targetThreadId"])
		.index("by_state_expiresAt", ["state.kind", "expiresAt"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * Message ids of one branch copy, anchor first, at most 1,000 per page. Convex caps arrays at
	 * 8,192 items, so one list cannot hold a long chat.
	 */
	ai_chat_thread_copy_pages: defineTable({
		copyId: v.id("ai_chat_thread_copies"),
		page: v.number(),
		messageIds: v.array(v.id("ai_chat_threads_messages_aisdk_5")),
	}).index("by_copy_page", ["copyId", "page"]),

	/**
	 * One named Bash shell of a creator-private thread.
	 * A thread has at most 10 shells. `state: null` means a fresh interpreter.
	 */
	ai_chat_bash_shells: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		name: v.string(),
		cwd: v.string(),
		cwdTarget: v.union(files_pending_target_validator, v.null()),
		state: v.union(bash_shell_state_validator, v.null()),
		/**
		 * Running totals over the transcript entries, so a trim never scans them.
		 */
		transcriptBytes: v.number(),
		transcriptEntries: v.number(),
		/**
		 * The next transcript entry sequence number.
		 */
		transcriptSeq: v.number(),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_thread_name", ["threadId", "name"])
		.index("by_cwdTarget", ["cwdTarget.kind", "cwdTarget.id"])
		.index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"]),

	/**
	 * One transcript entry of a shell: a call or a job, with its command and output. A transcript
	 * is up to 1 MiB, the same as one Convex document, so it cannot be one document.
	 */
	ai_chat_bash_shell_transcripts: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		shellId: v.id("ai_chat_bash_shells"),
		seq: v.number(),
		text: v.string(),
		/**
		 * UTF-8 bytes of `text`, measured with TextEncoder. Never a character count.
		 */
		bytes: v.number(),
	})
		.index("by_shell_seq", ["shellId", "seq"])
		.index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"]),

	/**
	 * Exact browser calls keep a safe receipt. Page data stays in the current turn.
	 */
	ai_chat_browser_invocations: defineTable({
		...ai_chat_browser_source_validator.fields,
		toolCallId: v.string(),
		operationHash: v.string(),
		mode: v.union(v.literal("file"), v.literal("web")),
		operationKind: v.union(v.literal("run"), v.literal("management")),
		runnerSessionId: v.union(v.string(), v.null()),
		openingSessionId: v.union(v.id("files_browser_sessions"), v.null()),
		browserIntent: browser_intent_validator,
		resource: v.union(ai_chat_browser_resource_validator, v.null()),
		commandId: v.string(),
		status: v.union(v.literal("running"), v.literal("interrupted"), v.literal("finished")),
		deadlineAt: v.number(),
		receiptResolutionDeadline: v.number(),
		createdAt: v.number(),
		finishedAt: v.optional(v.number()),
		resultExpiresAt: v.optional(v.number()),
		result: v.optional(ai_chat_browser_result_validator),
	})
		.index("by_thread_toolCall", ["threadId", "toolCallId"])
		.index("by_commandId", ["commandId"])
		.index("by_openingSession", ["openingSessionId"])
		.index("by_deadlineAt", ["deadlineAt"])
		.index("by_status_deadlineAt", ["status", "deadlineAt"])
		.index("by_resultExpiresAt", ["resultExpiresAt"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user", ["userId"]),

	ai_chat_bash_invocations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		toolCallId: v.string(),
		commandHash: v.string(),
		membershipId: v.id("organizations_workspaces_users"),
		membershipLifetime: v.number(),
		browserIntent: v.optional(browser_intent_validator),
		sourceMessageId: v.optional(v.id("ai_chat_threads_messages_aisdk_5")),
		/**
		 * The run and generation of a foreground call. Its writes are refused after Stop. Null on a
		 * background job: a job keeps running after its launching run ends.
		 */
		run: v.union(ai_chat_run_fence_validator, v.null()),
		/**
		 * The reply node whose tool call started this job, or its parent job's origin. The job's
		 * finish belongs to that branch. Null on a foreground call.
		 */
		originReplyId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
		status: v.union(v.literal("running"), v.literal("interrupted"), v.literal("finished")),
		deadlineAt: v.number(),
		transferDeadlineAt: v.number(),
		finishedAt: v.optional(v.number()),
		/**
		 * When a background job stored its system finish message in the thread. Both the settle and a
		 * late worker result try to write. A settle during a run still stores the message; it only
		 * skips the wake run. This is what keeps them to one message. Missing means no finish message was
		 * stored. It cannot live inside `job`: the wake runs after the patch that empties `job`, and
		 * it holds the copy from before that patch, so a nested write would store `script` and
		 * `shellState` again.
		 */
		wakeNotifiedAt: v.optional(v.number()),
		resultExpiresAt: v.optional(v.number()),
		result: v.optional(ai_chat_bash_result_validator),
		/**
		 * Present on a background job row (`cmd &`), missing on a foreground call. `script` and
		 * `shellState` become `null` once the job ends, by the finish or by the settle: a patched document
		 * is validated again, so a required field cannot be removed, only emptied.
		 */
		job: v.optional(
			v.object({
				jobNumber: v.number(),
				shellId: v.id("ai_chat_bash_shells"),
				/**
				 * The call or job that launched this job.
				 */
				parentInvocationId: v.id("ai_chat_bash_invocations"),
				commandNumber: v.number(),
				script: v.union(v.string(), v.null()),
				/**
				 * Present after a pause: the statements the next run continues with. `script` keeps
				 * the whole script for the finish entry. Dropped when the job ends.
				 */
				resumeScript: v.optional(v.string()),
				/**
				 * Present after a pause: the command count the next run continues from. A launch and
				 * a file transfer are stored under a synthetic id made of this row and the command
				 * number, so a run that started counting at 0 again would find the earlier run's row
				 * and do nothing. Dropped when the job ends.
				 */
				resumeCommandNumber: v.optional(v.number()),
				/**
				 * Present after a pause: the jobs the earlier runs started. `wait` with no arguments
				 * waits for these, so a continuation would otherwise wait for nothing. Dropped when
				 * the job ends.
				 */
				resumeLaunchedJobNumbers: v.optional(v.array(v.number())),
				/**
				 * The cwd the next run starts in: the live cwd at the `&`, which can differ from the
				 * call's starting cwd, and after a pause the cwd the paused run ended in.
				 */
				startCwd: v.string(),
				startCwdTarget: v.union(files_pending_target_validator, v.null()),
				/**
				 * The state the next run seeds: a copy of the shell state at the `&`, and after a
				 * pause the snapshot the paused run ended with.
				 */
				shellState: v.union(bash_shell_state_validator, v.null()),
				allowDbFilesMkdir: v.boolean(),
				workId: v.union(vWorkId, v.null()),
				workerGeneration: v.number(),
				// Only durable Copy waiting is excluded from the shell lifetime.
				excludedCopyWaitMs: v.optional(v.number()),
				copy: v.optional(
					v.union(
						v.object({
							phase: v.literal("admitting"),
							commandNumber: v.number(),
							lastArg: v.string(),
							sourceScope: files_transfer_scope_validator,
							destinationScope: files_transfer_scope_validator,
							sourceWorkspace: v.union(v.literal("current"), v.literal("personal")),
							destinationWorkspace: v.union(v.literal("current"), v.literal("personal")),
							targetParent: files_pending_parent_validator,
							targetPath: v.string(),
							targetName: v.union(v.string(), v.null()),
							missingParentNames: v.array(v.string()),
							conflictPolicy: files_transfer_conflict_policy_validator,
							expectedArgCount: v.number(),
							expectedSourceCount: v.number(),
							pageCount: v.number(),
							argsCount: v.number(),
							sourcesCount: v.number(),
							sealed: v.boolean(),
							admissionDeadlineAt: v.number(),
							runId: v.union(v.id("files_transfer_runs"), v.null()),
						}),
						v.object({
							phase: v.literal("waiting"),
							commandNumber: v.number(),
							lastArg: v.string(),
							runId: v.id("files_transfer_runs"),
							waitStartedAt: v.number(),
						}),
						v.object({
							phase: v.literal("delivering"),
							commandNumber: v.number(),
							lastArg: v.string(),
							// Null when Copy admission refused before a transfer run existed.
							runId: v.union(v.id("files_transfer_runs"), v.null()),
							workId: vWorkId,
							result: v.object({ stdout: v.string(), stderr: v.string(), exitCode: v.number() }),
						}),
					),
				),
				watchdogId: v.union(v.id("_scheduled_functions"), v.null()),
				stopRequestedAt: v.union(v.number(), v.null()),
				/**
				 * Present only while the job runs and after its first flush. The settle that ends
				 * the job drops it: the result and the transcript carry the full output.
				 */
				liveOutput: v.optional(ai_chat_bash_job_live_output_validator),
				/**
				 * The model this job's wake run prefers: the launch set `wakeOnJobFinish`
				 * or a later `wait` armed it. Missing uses the default model. The finish
				 * message does not need this.
				 */
				wakeAgent: v.optional(v.object({ modelId: ai_chat_model_id_validator })),
				/**
				 * The run of the chat call that started this job, or of its parent job. Present only
				 * when that call could browse. The job's `browser` commands use this run's browser
				 * state, so they refuse once the run ends or is stopped.
				 */
				browserRun: v.optional(ai_chat_run_fence_validator),
			}),
		),
	})
		.index("by_thread_toolCall", ["threadId", "toolCallId"])
		.index("by_resultExpiresAt", ["resultExpiresAt"])
		// The user-deletion drain. Foreground rows have no `job`, so they sort first under a bare
		// `userId` prefix; query with `.gt("job.jobNumber", undefined)` to skip them.
		.index("by_user_job", ["userId", "job.jobNumber"])
		.index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"]),

	ai_chat_bash_job_copy_pages: defineTable({
		invocationId: v.id("ai_chat_bash_invocations"),
		commandNumber: v.number(),
		page: v.number(),
		args: v.array(v.string()),
		sources: v.array(files_pending_target_validator),
	}).index("by_invocation_command_page", ["invocationId", "commandNumber", "page"]),

	ai_chat_bash_invocation_transfers: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		threadId: v.id("ai_chat_threads"),
		invocationId: v.id("ai_chat_bash_invocations"),
		commandNumber: v.number(),
		runId: v.id("files_transfer_runs"),
		activityId: v.id("activities"),
	})
		.index("by_invocation_commandNumber", ["invocationId", "commandNumber"])
		.index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"]),

	/**
	 * Unread leftover. The old stderr job notes used one cursor per user and thread so member B's
	 * call could not hide member A's notes. Code no longer reads these docs. User deletion still
	 * deletes them.
	 */
	ai_chat_bash_job_notice_cursors: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		userId: v.id("users"),
		noticeAt: v.number(),
	})
		.index("by_user_thread", ["userId", "threadId"])
		.index("by_user", ["userId"])
		.index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"]),

	/**
	 * Each doc should be compatible with {@link ai_chat_UiMessage}.
	 *
	 * Keep this table name. It is stored data. It does not track the AI SDK major version.
	 * We removed the version from the TypeScript type names on purpose.
	 */
	ai_chat_threads_messages_aisdk_5: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),

		/**
		 * Root messages have `parentId: null`.
		 */
		parentId: v.union(v.id("ai_chat_threads_messages_aisdk_5"), v.null()),
		threadId: v.id("ai_chat_threads"),

		/**
		 * Necessary to link the optimistic update to the persisted message.
		 */
		clientGeneratedMessageId: v.string(),

		/**
		 * One {@link ai_chat_UiMessage}.
		 **/
		content: v.record(v.string(), v.any()),

		createdBy: v.id("users"),
		/** timestamp in milliseconds */
		updatedAt: v.number(),
		/**
		 * Set only on job finish messages: the invocation whose finish wrote this doc.
		 **/
		jobFinishInvocationId: v.optional(v.id("ai_chat_bash_invocations")),
		/**
		 * `streaming` while the reply node's run writes its steps. User and finish messages are
		 * `done` from the start.
		 */
		status: v.union(v.literal("streaming"), v.literal("done"), v.literal("stopped"), v.literal("failed")),
		/**
		 * The run of a reply node. A reply node keeps its parts in `ai_chat_run_steps`, and its
		 * `content` holds only the id, role and metadata. Null on user and finish messages.
		 */
		runId: v.union(v.id("ai_chat_runs"), v.null()),
		/**
		 * Raised by every step or status write of a reply node, so a client cache can tell a stale copy.
		 */
		version: v.number(),
		/**
		 * True on a job finish message that no run answered yet. The wake picks it later.
		 */
		wakePending: v.boolean(),
		/**
		 * The stored size of the node: its content, plus its steps for a reply node. History pages
		 * use it to stay within the model context and memory.
		 */
		bytes: v.number(),
	})
		.index("by_organization_workspace_thread", ["organizationId", "workspaceId", "threadId"])
		.index("by_thread_parent", ["threadId", "parentId"])
		.index("by_thread_wakePending", ["threadId", "wakePending"])
		.index("by_organization_workspace_thread_clientGeneratedMessageId", [
			"organizationId",
			"workspaceId",
			"threadId",
			"clientGeneratedMessageId",
		]),

	ai_chat_files: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		path: v.string(),
		kind: v.union(v.literal("file"), v.literal("directory"), v.literal("symlink")),
		/**
		 * POSIX mode bits from the scratch
		 * fs stat (e.g. 0o100644 file, 0o40755 directory),
		 * reapplied on hydrate
		 **/
		mode: v.number(),
		size: v.number(),
		/**
		 * Last-modified timestamp in milliseconds
		 * from the scratch fs stat, reapplied on hydrate
		 **/
		mtime: v.number(),
		/** Symlink target path,
		 * only present when kind is "symlink"
		 **/
		symlinkTargetPath: v.optional(v.string()),
	})
		.index("by_thread_path", ["threadId", "path"])
		.index("by_organization_workspace_thread_path", ["organizationId", "workspaceId", "threadId", "path"]),

	ai_chat_files_content: defineTable({
		organizationId: v.string(),
		workspaceId: v.string(),
		threadId: v.id("ai_chat_threads"),
		fileNodeId: v.id("ai_chat_files"),
		bytes: v.bytes(),
	})
		.index("by_fileNode", ["fileNodeId"])
		.index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"])
		.index("by_thread_fileNode", ["threadId", "fileNodeId"]),

	// #endregion ai

	// #region ai code read budgets
	ai_chat_code_read_budgets: defineTable({
		threadId: v.id("ai_chat_threads"),
		userId: v.id("users"),
		remainingReadBytes: v.number(),
		expiresAt: v.number(),
	})
		.index("by_expiresAt", ["expiresAt"])
		.index("by_thread", ["threadId"])
		.index("by_user", ["userId"]),
	// #endregion ai code read budgets

	// #region public api
	public_api_grants: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.union(v.id("ai_chat_threads"), v.null()),
		principalKey: v.string(),
		tokenHash: v.string(),
		agentSource: v.union(ai_chat_workspaces_source_validator, v.null()),
		codeReadBudgetId: v.union(v.id("ai_chat_code_read_budgets"), v.null()),
		scopes: v.array(v.union(v.literal("files:list"), v.literal("files:read"), v.literal("files:download"))),
		remainingReadBytes: v.number(),
		pathPrefix: v.union(v.string(), v.null()),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"])
		.index("by_thread", ["threadId"]),

	api_credentials: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		serviceAccountId: v.union(v.id("access_control_service_accounts"), v.null()),
		name: v.string(),
		keyId: v.string(),
		obfuscatedValue: v.string(),
		secretHash: v.string(),
		scopes: v.array(
			v.union(
				v.literal("files:list"),
				v.literal("files:read"),
				v.literal("files:write"),
				v.literal("files:permissions"),
				v.literal("files:download"),
				v.literal("plugin_data:read"),
				v.literal("plugin_data:write"),
			),
		),
		createdAt: v.number(),
		revokedAt: v.union(v.number(), v.null()),
		lastUsedAt: v.union(v.number(), v.null()),
	})
		.index("by_keyId", ["keyId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_organization_workspace_user_revokedAt", ["organizationId", "workspaceId", "userId", "revokedAt"])
		.index("by_user", ["userId"]),

	/**
	 * In-flight `/api/v1/files/write` staging doc. Created with the asset docs before any R2 write,
	 * deleted atomically by the publish mutation. A surviving stage marks an unpublished write whose
	 * R2 objects and asset docs are safe to delete; publication deletes the stage first, so cleanup
	 * can never remove a published output. No `files_nodes` doc exists until publication.
	 */
	public_api_file_write_stages: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/** Authoring user: the credential owner, or the plugin run's actorUserId. */
		userId: v.id("users"),
		/**
		 * Present only for plugin_run writes. Failure cleanup settles the linked started call.
		 */
		runId: v.optional(v.id("plugins_event_runs")),
		callId: v.optional(v.id("plugins_event_run_calls")),
		/**
		 * Present only for user_api_key writes. Publication revalidates the credential.
		 */
		credentialId: v.optional(v.id("api_credentials")),
		/**
		 * Present only for plugin_service writes; publication revalidates the sealed grant.
		 */
		grantId: v.optional(v.id("plugin_service_grants")),
		/**
		 * Trusted own-file service preconditions, checked again with publication and its receipt.
		 */
		externalFileWrite: v.optional(
			v.object({
				writerId: v.id("plugins_external_file_writers"),
				writerGeneration: v.number(),
				operationId: v.string(),
				sequence: v.number(),
				contentHash: v.string(),
				expectedNodeId: v.union(v.id("files_nodes"), v.null()),
				expectedContentRevision: v.union(v.string(), v.null()),
				expectedReaderRevision: v.union(v.number(), v.null()),
				serviceSecretHash: v.string(),
				tokenHash: v.string(),
				contentType: v.string(),
				nonCollaborative: v.boolean(),
				requestReadOnly: v.boolean(),
			}),
		),
		/**
		 * Normalized absolute target path. Parents are resolved again at publication.
		 */
		path: v.string(),
		/**
		 * Invoke-only immediate parent identity, checked again at publication.
		 */
		expectedParentNodeId: v.optional(v.id("files_nodes")),
		overwrite: v.union(v.literal("replace"), v.literal("fail")),
		/**
		 * The type and document shape a created file gets. Settled at staging, so the publish
		 * mutation writes the same values the route built its content objects with.
		 */
		contentType: v.string(),
		yjsRootKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		/**
		 * Staged content. On publish it becomes the file's first version snapshot and the `node.assetId` target.
		 */
		contentSnapshotAssetId: v.id("files_r2_assets"),
		/**
		 * Stages older than this are crashed writes. The cleanup cron deletes them and their assets.
		 */
		expiresAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_expiresAt", ["expiresAt"])
		.index("by_run", ["runId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),
	// #endregion public api

	// #region value store
	value_store: defineTable({
		value: v.string(),
		/**
		 * Copied here so reads need only this doc. Null means no expiry.
		 */
		expiresAt: v.union(v.number(), v.null()),
		metadataId: v.union(v.id("value_store_metadata"), v.null()),
	}),
	/**
	 * Only expiring values have metadata, so cleanup scans small docs.
	 */
	value_store_metadata: defineTable({
		valueId: v.id("value_store"),
		expiresAt: v.number(),
	}).index("by_expiresAt", ["expiresAt"]),
	// #endregion value store

	// #region files
	// Null workspace covers organization-wide access changes without per-workspace writes.
	files_media_validation_versions: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.union(v.id("organizations_workspaces"), v.null()),
		revision: v.number(),
	}).index("by_organization_workspace", ["organizationId", "workspaceId"]),

	// A set owns its mapping docs, not the referenced media assets.
	files_media_dependency_sets: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		owner: v.union(
			v.object({ kind: v.literal("capture"), itemId: v.id("files_transfer_items") }),
			v.object({ kind: v.literal("proposal"), pendingUpdateId: v.id("files_pending_updates") }),
			v.object({ kind: v.literal("cleanup") }),
		),
		generation: v.number(),
		expectedCount: v.number(),
		count: v.number(),
		sealed: v.boolean(),
		captureProof: v.optional(
			v.object({
				attempt: v.number(),
				workId: vWorkId,
				sourceTextDigest: v.string(),
				textDigest: v.union(v.string(), v.null()),
				validatedCount: v.number(),
				...files_media_validation_versions_validator.fields,
			}),
		),
	})
		.index("by_owner_kind", ["owner.kind"])
		.index("by_owner_pendingUpdate", ["owner.pendingUpdateId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user", ["userId"]),

	files_media_dependencies: defineTable({
		setId: v.id("files_media_dependency_sets"),
		order: v.number(),
		sourceSrc: v.string(),
		dependency: files_media_dependency_validator,
	})
		.index("by_set_order", ["setId", "order"])
		.index("by_set_sourceSrc", ["setId", "sourceSrc"])
		.index("by_set_src", ["setId", "dependency.src"])
		.index("by_target", ["dependency.target.kind", "dependency.target.id"]),

	/** A paged review must see the same owner's proposal set at its final fence. */
	files_pending_review_versions: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		revision: v.number(),
	})
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"]),

	files_pending_holds: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		pendingUpdateId: v.id("files_pending_updates"),
		target: files_pending_target_validator,
		privateGeneration: v.union(v.number(), v.null()),
		producer: v.union(
			v.object({ kind: v.literal("files_transfer_run"), id: v.id("files_transfer_runs") }),
			v.object({ kind: v.literal("files_pending_update_run"), id: v.id("files_pending_update_runs") }),
		),
		role: v.union(
			v.literal("source"),
			v.literal("destination_parent"),
			v.literal("preparing_output"),
			v.literal("output"),
			v.literal("review"),
		),
	})
		.index("by_pendingUpdate", ["pendingUpdateId"])
		.index("by_target_role", ["target.kind", "target.id", "role"])
		.index("by_producer_pendingUpdate_role", ["producer.kind", "producer.id", "pendingUpdateId", "role"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user", ["userId"]),

	files_pending_update_runs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		requestId: v.string(),
		requestHash: v.string(),
		kind: v.union(v.literal("accept"), v.literal("discard")),
		step: v.union(v.literal("uploading"), v.literal("planning"), v.literal("running"), v.literal("finished")),
		expectedItemCount: v.number(),
		itemCount: v.number(),
		unitCount: v.number(),
		finishedUnitCount: v.number(),
		plannedItemCount: v.number(),
		plan: v.object({
			phase: v.union(
				v.literal("classify"),
				v.literal("atomic"),
				v.literal("copy_units"),
				v.literal("dependencies"),
				v.literal("ready"),
			),
			cursor: v.union(v.string(), v.null()),
			itemId: v.union(v.id("files_pending_update_run_items"), v.null()),
			dependencyCursor: v.union(v.string(), v.null()),
			atomicItemCount: v.number(),
		}),
		reviewVersion: v.number(),
		revalidateRemaining: v.boolean(),
		fence: v.number(),
		planningAttempts: v.number(),
		outputReviewUntil: v.optional(v.number()),
		needsReviewIds: v.array(v.id("files_pending_updates")),
		updatedAt: v.number(),
	})
		.index("by_user_requestId", ["userId", "requestId"])
		.index("by_step_updatedAt", ["step", "updatedAt"])
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	files_pending_update_run_items: defineTable({
		runId: v.id("files_pending_update_runs"),
		order: v.number(),
		pendingUpdateId: v.id("files_pending_updates"),
		reviewedRevision: v.number(),
		selectedContentStateId: v.union(v.id("files_pending_update_yjs_states"), v.null()),
		planKind: v.union(v.literal("copy"), v.literal("atomic"), v.null()),
		privateVersion: v.union(v.object({ creationGeneration: v.number(), structuralRevision: v.number() }), v.null()),
		mediaDependencySet: v.union(
			v.object({ setId: v.id("files_media_dependency_sets"), generation: v.number() }),
			v.null(),
		),
		target: files_pending_target_validator,
		unitId: v.union(v.id("files_pending_update_run_units"), v.null()),
		billedUserId: v.union(v.id("users"), v.null()),
		prepared: v.union(files_pending_prepared_content_validator, v.null()),
		expectedPath: v.union(v.string(), v.null()),
		expectedDestinationParentPath: v.union(v.string(), v.null()),
	})
		.index("by_run_order", ["runId", "order"])
		.index("by_run_pendingUpdate", ["runId", "pendingUpdateId"])
		.index("by_run_planKind_order", ["runId", "planKind", "order"])
		.index("by_run_target", ["runId", "target.kind", "target.id"])
		.index("by_unit_order", ["unitId", "order"])
		.index("by_unit_targetKind_order", ["unitId", "target.kind", "order"])
		.index("by_target", ["target.kind", "target.id"]),

	files_pending_update_run_units: defineTable({
		runId: v.id("files_pending_update_runs"),
		order: v.number(),
		kind: v.union(v.literal("copy"), v.literal("atomic")),
		remainingPrerequisiteCount: v.number(),
		dependentsSettled: v.boolean(),
		deleteLast: v.boolean(),
		itemCount: v.number(),
		status: v.union(
			v.literal("waiting"),
			v.literal("queued"),
			v.literal("preparing"),
			v.literal("completed"),
			v.literal("blocked"),
			v.literal("failed"),
			v.literal("canceled"),
		),
		attemptCount: v.number(),
		workId: v.union(vWorkId, v.null()),
		attemptFence: v.number(),
		attemptDeadlineAt: v.union(v.number(), v.null()),
		validatedReviewVersion: v.union(v.number(), v.null()),
		errorCode: v.union(v.string(), v.null()),
		errorMessage: v.union(v.string(), v.null()),
		finishedAt: v.union(v.number(), v.null()),
		privateDiscardRoots: v.array(
			v.object({
				privateNodeId: v.id("files_pending_nodes"),
				creationGeneration: v.number(),
				structuralRevision: v.number(),
				pendingUpdateId: v.id("files_pending_updates"),
				reviewedRevision: v.number(),
			}),
		),
	})
		.index("by_run_order", ["runId", "order"])
		.index("by_run_status_deleteLast_order", ["runId", "status", "deleteLast", "order"])
		.index("by_run_status_dependentsSettled_order", ["runId", "status", "dependentsSettled", "order"]),

	files_pending_update_run_dependencies: defineTable({
		runId: v.id("files_pending_update_runs"),
		unitId: v.id("files_pending_update_run_units"),
		requiredUnitId: v.id("files_pending_update_run_units"),
		kind: v.union(v.literal("parent"), v.literal("media")),
		settled: v.boolean(),
	})
		.index("by_run", ["runId"])
		.index("by_unit_required_kind", ["unitId", "requiredUnitId", "kind"])
		.index("by_required_settled", ["requiredUnitId", "settled"]),

	/**
	 * One file a chat tool is creating: a generated picture, a file a browser run emitted, or a file
	 * a code run emitted. One doc per file, not per call.
	 *
	 * The doc holds no file bytes. It ties one attempt's retries and its unfinished cleanup
	 * together. Once the file is committed the doc only stops a lost reply from creating a second
	 * file, and the file owns its own lifetime.
	 */
	files_ingestion_receipts: defineTable({
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		requestId: v.string(),
		path: v.string(),
		contentType: v.string(),
		size: v.number(),
		digest: v.string(),
		content: v.union(
			v.object({ kind: v.literal("stored") }),
			v.object({
				kind: v.literal("text"),
				textKind: v.union(v.literal("plain_text"), v.literal("rich_text")),
			}),
		),
		threadId: v.optional(v.id("ai_chat_threads")),
		state: v.union(
			v.object({
				kind: v.literal("preparing"),
				attemptId: v.string(),
				prepared: v.union(
					v.object({
						kind: v.literal("stored"),
						assetId: v.id("files_r2_assets"),
						r2Key: v.string(),
						putMayArriveUntil: v.number(),
					}),
					v.object({
						kind: v.literal("text"),
						privateNodeId: v.id("files_pending_nodes"),
						pendingUpdateId: v.id("files_pending_updates"),
						operationBatchId: v.id("files_pending_update_operation_batches"),
						expectedRevision: v.number(),
						createdNodes: v.array(
							v.object({
								privateNodeId: v.id("files_pending_nodes"),
								pendingUpdateId: v.id("files_pending_updates"),
								revision: v.number(),
								creationGeneration: v.number(),
								structuralRevision: v.number(),
							}),
						),
					}),
				),
			}),
			v.object({ kind: v.literal("completed"), target: files_pending_target_validator }),
			v.object({ kind: v.literal("aborted") }),
		),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_organization_workspace_user_request", ["organizationId", "workspaceId", "userId", "requestId"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_thread_state", ["threadId", "state.kind"]),

	files_pending_nodes: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		kind: v.union(v.literal("file"), v.literal("folder")),
		name: v.string(),
		parent: files_pending_parent_validator,
		structuralRevision: v.number(),
		creationGeneration: v.number(),
		state: v.union(v.literal("active"), v.literal("published"), v.literal("discarded")),
		closedAt: v.union(v.number(), v.null()),
	})
		.index("by_organization_workspace_user_parent_state_name", [
			"organizationId",
			"workspaceId",
			"userId",
			"parent.kind",
			"parent.id",
			"state",
			"name",
		])
		.index("by_organization_workspace_user_state", ["organizationId", "workspaceId", "userId", "state"])
		.index("by_state_closedAt", ["state", "closedAt"])
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	files_pending_node_publish_receipts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		privateNodeId: v.id("files_pending_nodes"),
		creationGeneration: v.number(),
		structuralRevision: v.number(),
		proposalRevision: v.number(),
		savedNodeId: v.id("files_nodes"),
		copiedWritePolicy: v.optional(files_nodes_write_policy_validator),
		copiedPath: v.optional(v.string()),
		createdAt: v.number(),
	})
		.index("by_privateNode", ["privateNodeId"])
		.index("by_savedNode", ["savedNodeId"])
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * Physical cleanup continues after a private Discard has closed the target. Each task owns exactly
	 * one scheduled job. The job runs at `nextAttemptAt`.
	 */
	files_pending_node_cleanup_tasks: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		privateNodeId: v.id("files_pending_nodes"),
		nextAttemptAt: v.number(),
		scheduledFunctionId: v.id("_scheduled_functions"),
	})
		.index("by_privateNode", ["privateNodeId"])
		.index("by_nextAttemptAt", ["nextAttemptAt"])
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	files_pending_updates: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: files_pending_target_validator,
		/** Changes whenever the proposal's reviewed content or intent changes. */
		revision: v.number(),
		/**
		 * Initial type and metadata. A text draft is ready only with its sealed `content` group.
		 */
		createIntent: v.optional(files_pending_create_intent_validator),
		/** A reserved target is not ready until its worker seals `createIntent` and its content. */
		preparation: v.optional(v.object({ transferItemId: v.id("files_transfer_items"), creationGeneration: v.number() })),
		/**
		 * The three sealed branches share one base. Structural-only proposals have no content.
		 * A private new file has no saved sequence or asset to use as its base.
		 */
		content: v.optional(
			v.object({
				base: v.union(
					v.object({ kind: v.literal("new") }),
					v.object({ kind: v.literal("yjs"), sequence: v.number(), lineageGeneration: v.number() }),
					v.object({ kind: v.literal("asset"), assetId: v.id("files_r2_assets") }),
				),
				baseStateId: v.id("files_pending_update_yjs_states"),
				stagedStateId: v.id("files_pending_update_yjs_states"),
				unstagedStateId: v.id("files_pending_update_yjs_states"),
			}),
		),
		/**
		 * A toggle or restore kept these branches on their old base. Preparation rebuilds them
		 * before another content write. Marking alone keeps the proposal's current expiry.
		 */
		contentNeedsRebase: v.optional(v.literal(true)),
		/**
		 * Shape of preserved branches before a restore changes the file's shape.
		 */
		contentRebaseRootKind: v.optional(v.union(v.literal("plain_text"), v.literal("rich_text"))),
		/**
		 * Pending move or rename proposal. Ids are authoritative. `fromPath` is display and conflict metadata only.
		 */
		pendingMove: v.optional(
			v.object({
				destParent: files_pending_parent_validator,
				destName: v.string(),
				fromPath: v.string(),
				/**
				 * `mv -f` structural replacement: the active file node that owned the destination
				 * path at proposal time. The owner's view hides it. Accept requires this same
				 * target and content version. A later occupant needs a new review.
				 */
				replacesTarget: v.optional(files_pending_target_validator),
				replacesContentVersion: v.optional(v.union(files_content_version_validator, v.null())),
			}),
		),
		/**
		 * Pending delete proposal (`rm`): accepting archives the node (a folder archives its
		 * whole subtree, computed at accept time). The node id is authoritative; `fromPath` is
		 * display metadata only. Setting this clears `pendingMove` — a delete supersedes a move.
		 */
		pendingArchive: v.optional(
			v.object({
				fromPath: v.string(),
			}),
		),
		/**
		 * Copy provenance for the destination node of a pending copy (`cp`). Display metadata only.
		 */
		copiedFrom: v.optional(
			v.object({
				target: files_pending_target_validator,
				path: v.string(),
				/**
				 * Protection read from the source when the copy target was first made. A retry
				 * reuses the target and never overwrites these with later source rules.
				 */
				sourceWritePolicy: v.optional(files_nodes_write_policy_validator),
				sourceNewChildWritePolicy: v.optional(files_nodes_write_policy_validator),
			}),
		),
		mediaDependencySetId: v.optional(v.id("files_media_dependency_sets")),
		/**
		 * Whole-file replacement proposal (`cp` onto an app path). Accepting replaces the whole
		 * content state of the destination node with the staged asset: its bytes, its content
		 * type, its document shape, and its collaboration mode. The destination keeps its node id,
		 * name, permissions, and history. A doc with this field carries no Yjs content group.
		 */
		pendingReplacement: v.optional(
			v.object({
				/**
				 * The staged copy of the source content. The asset is already published under its
				 * final R2 key, so the unfinalized-asset sweeper leaves it alone while the proposal
				 * waits. Discard and expiry hand the key to the deletion ledger.
				 */
				assetId: v.id("files_r2_assets"),
				size: v.number(),
				contentType: v.string(),
				/**
				 * Absent for stored bytes: accepting turns the destination into a stored file.
				 */
				yjsRootKind: v.optional(v.union(v.literal("rich_text"), v.literal("plain_text"))),
				/**
				 * Text only. Absent means the destination becomes collaborative when accepted.
				 */
				nonCollaborative: v.optional(v.boolean()),
				/**
				 * The destination's content asset when the proposal was made. Accept refuses when
				 * another save changed the destination since, so a copy never overwrites text the
				 * reviewer never saw.
				 */
				baseAssetId: v.id("files_r2_assets"),
				/** Bind replacement to saved edits even before their asset is materialized. */
				baseContentVersion: files_content_version_validator,
			}),
		),
		/**
		 * Chat threads that touched this proposal (contributor set, deduped). Agent writes append
		 * their thread id; client-driven writes preserve the array. Unset for client-only docs.
		 */
		threadIds: v.optional(v.array(v.id("ai_chat_threads"))),
		size: v.number(),
		updatedAt: v.number(),
		/**
		 * The draft may expire after this time, if its owner is also inactive.
		 * Each edit sets it to 4 hours after `updatedAt`. A finished Copy or review, or an expiry
		 * retry, can move it later. It never moves earlier.
		 */
		expiresAt: v.number(),
	})
		.index("by_organization_workspace_user_target", [
			"organizationId",
			"workspaceId",
			"userId",
			"target.kind",
			"target.id",
		])
		.index("by_organization_workspace_user_expiresAt", ["organizationId", "workspaceId", "userId", "expiresAt"])
		.index("by_user_target", ["userId", "target.kind", "target.id"])
		.index("by_target", ["target.kind", "target.id"])
		.index("by_user_pendingMove_destParent_destName", [
			"userId",
			"pendingMove.destParent.kind",
			"pendingMove.destParent.id",
			"pendingMove.destName",
		])
		.index("by_copiedFrom_target", ["copiedFrom.target.kind", "copiedFrom.target.id"])
		.index("by_organization_workspace_user_targetKind_updatedAt", [
			"organizationId",
			"workspaceId",
			"userId",
			"target.kind",
			"updatedAt",
		])
		.index("by_pendingMove_destParent", ["pendingMove.destParent.kind", "pendingMove.destParent.id"]),

	files_pending_updates_last_sequence_saved: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		fileNodeId: v.id("files_nodes"),
		lastSequenceSaved: v.number(),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_user_fileNode", ["organizationId", "workspaceId", "userId", "fileNodeId"])
		.index("by_organization_workspace_fileNode_user", ["organizationId", "workspaceId", "fileNodeId", "userId"])
		.index("by_user_fileNode", ["userId", "fileNodeId"]),

	/**
	 * One expiry check per owner and workspace. Its scheduled job removes the owner's due drafts.
	 * `nextCheckAt` is never later than the earliest draft `expiresAt`, except while the owner is
	 * active. Then it waits until 4 hours after the owner's last heartbeat.
	 */
	files_pending_update_expiry_checks: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		nextCheckAt: v.number(),
		scheduledFunctionId: v.id("_scheduled_functions"),
	})
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"])
		.index("by_nextCheckAt", ["nextCheckAt"]),

	/**
	 * Metadata for one paged pending-update Yjs state (one role: base, staged, or unstaged).
	 * The state bytes live in `files_pending_update_yjs_state_pages`; a full state can be larger
	 * than one Convex value, so it never travels or stores as a single value. The owner union says
	 * who is responsible for deleting the family: an active canonical state belongs to its pending
	 * update doc, a temporary state to an operation batch (expiry-swept), and a retired state to a
	 * durable cleanup task.
	 */
	files_pending_update_yjs_states: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: files_pending_target_validator,
		owner: v.union(
			v.object({ kind: v.literal("transfer_capture"), itemId: v.id("files_transfer_items") }),
			v.object({
				kind: v.literal("active"),
				pendingUpdateId: v.id("files_pending_updates"),
				role: v.union(v.literal("base"), v.literal("staged"), v.literal("unstaged")),
			}),
			v.object({
				kind: v.literal("temporary"),
				operationBatchId: v.id("files_pending_update_operation_batches"),
				phase: v.union(v.literal("input"), v.literal("output")),
				role: v.union(v.literal("base"), v.literal("staged"), v.literal("unstaged")),
				expiresAt: v.number(),
			}),
			v.object({
				kind: v.literal("retired"),
				cleanupTaskId: v.id("files_pending_update_state_cleanup_tasks"),
			}),
		),
		/**
		 * Lineage generation of the live document this state was built against. Absent for a
		 * state built for a file with collaboration off, which has no Yjs document and no lineage.
		 */
		lineageGeneration: v.optional(v.number()),
		/** True once every page is written and the totals below describe the complete state. */
		sealed: v.boolean(),
		pageCount: v.number(),
		totalBytes: v.number(),
		/** Digest of the whole state bytes, so a reassembled state can be checked for torn pages. */
		digest: v.string(),
	})
		.index("by_organization_workspace_target", ["organizationId", "workspaceId", "target.kind", "target.id"])
		.index("by_user", ["userId"])
		.index("by_owner_pendingUpdate", ["owner.pendingUpdateId"])
		.index("by_owner_operationBatch", ["owner.operationBatchId"])
		.index("by_owner_cleanupTask", ["owner.cleanupTaskId"])
		.index("by_owner_transferItem", ["owner.itemId"])
		// Only the `temporary` owner variant has `expiresAt`, and Convex sorts docs without the
		// field BEFORE every number on this index. A TTL sweep must bound the range from below
		// (`q.gte("owner.expiresAt", 0)`), or it would also return every active and retired state.
		.index("by_owner_expiresAt", ["owner.expiresAt"]),

	/**
	 * One bounded page of a paged pending-update Yjs state. Pages are non-empty, at most
	 * `files_MAX_YJS_WIRE_BYTES`, and contiguous by `pageIndex` starting at 0.
	 */
	files_pending_update_yjs_state_pages: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		stateId: v.id("files_pending_update_yjs_states"),
		pageIndex: v.number(),
		bytes: v.bytes(),
	})
		.index("by_state_pageIndex", ["stateId", "pageIndex"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * Durable cleanup task for a retired pending-state family. The final commit of a rebase
	 * re-owns the previous states to a task doc instead of deleting their pages inline, and a
	 * bounded scheduled continuation drains the pages, states, and then the task itself.
	 */
	files_pending_update_state_cleanup_tasks: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		createdAt: v.number(),
	}).index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * One in-flight pending-state operation (upsert or rebase) for one user and file. Input and
	 * output states and text inputs hang off the batch. One active batch is allowed per
	 * user/node; a new batch-create by the same user takes over a batch idle past two minutes,
	 * and abandoned batches expire after 30 minutes so the sweeper deletes the family.
	 */
	files_pending_update_operation_batches: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		/**
		 * Only agent edits carry source chat authority. Human review uses its own new batch.
		 */
		agentSource: v.optional(ai_chat_workspaces_source_validator),
		target: files_pending_target_validator,
		expectedPendingUpdateId: v.union(v.id("files_pending_updates"), v.null()),
		expectedRevision: v.union(v.number(), v.null()),
		expectedPrivateVersion: v.union(
			v.object({ creationGeneration: v.number(), structuralRevision: v.number() }),
			v.null(),
		),
		/**
		 * Only internal Save preparation sets this. Ordinary edit batches cannot use Save headroom.
		 */
		publication: v.optional(
			v.union(
				v.object({
					kind: v.literal("assets"),
					contentAssetId: v.id("files_r2_assets"),
					yjsSnapshotAssetId: v.optional(v.id("files_r2_assets")),
					backupAssetId: v.optional(v.id("files_r2_assets")),
				}),
				v.object({ kind: v.literal("update"), trustedStageId: v.id("files_yjs_trusted_update_stages") }),
				v.object({ kind: v.literal("review") }),
			),
		),
		/**
		 * Assigned with a new private file. Only this batch may seal its first content.
		 */
		initialCreation: v.optional(v.literal(true)),
		expiresAt: v.number(),
		updatedAt: v.number(),
		/**
		 * When the batch last staged or sealed something. A new batch-create by the same user
		 * takes over a batch idle past the takeover window, so a crashed client does not lock
		 * the user out for the full TTL.
		 */
		lastActivityAt: v.number(),
	})
		.index("by_organization_workspace_user_target", [
			"organizationId",
			"workspaceId",
			"userId",
			"target.kind",
			"target.id",
		])
		.index("by_user", ["userId"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_agentThread_expiresAt", ["agentSource.threadId", "expiresAt"]),

	/**
	 * One staged text value (staged or unstaged content) for a pending-state operation batch, so
	 * no registered call has to carry two large values at once. Consumed by the batch's commit;
	 * expired leftovers are swept with the batch.
	 */
	files_pending_update_text_inputs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: files_pending_target_validator,
		operationBatchId: v.id("files_pending_update_operation_batches"),
		role: v.union(v.literal("staged"), v.literal("unstaged")),
		text: v.string(),
		mediaValidation: v.optional(
			v.object({
				setId: v.id("files_media_dependency_sets"),
				setGeneration: v.number(),
				pendingUpdateId: v.id("files_pending_updates"),
				reviewedRevision: v.number(),
				textDigest: v.string(),
				reviewSelectionDigest: v.string(),
				reviewRunId: v.union(v.id("files_pending_update_runs"), v.null()),
				...files_media_validation_versions_validator.fields,
				totalCount: v.number(),
				validatedCount: v.number(),
			}),
		),
		expiresAt: v.number(),
	})
		.index("by_operationBatch", ["operationBatchId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user", ["userId"])
		.index("by_expiresAt", ["expiresAt"]),

	/**
	 * Indexed metadata docs for a file. Field docs support existence search for presence-only
	 * metadata. Value docs support string, number, boolean, and maybe_date search. Arrays insert one
	 * value doc for each primitive item. Date-like strings also insert a maybe_date companion whose
	 * epoch-millisecond timestamp uses numberValue for range search.
	 *
	 * Two field prefixes write here, and `fieldPath` says which one owns a doc:
	 * - `frontmatter.*` docs are extracted from a Markdown file's own YAML frontmatter, so a content
	 *   save deletes and rewrites them.
	 * - `metadata.*` docs are the file metadata a user or an agent wrote next to the file. They work
	 *   for every file kind, including binary uploads, and a content save never touches them.
	 *
	 * Pending docs are user-scoped. Query code filters out other users' pending docs
	 * and hides stale committed docs for files the acting user is editing. Only frontmatter docs are
	 * ever pending, because file metadata is written straight to committed.
	 */
	files_metadata_docs: defineTable(
		v.union(
			v.object({
				...files_committed_index_fields,
				...files_metadata_index_fields,
				...files_metadata_committed_sort_fields,
			}),
			v.object({ ...files_pending_index_fields, ...files_metadata_index_fields }),
		),
	)
		.index("by_organization_workspace_source_fileNode_fieldPath", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"fieldPath",
		])
		.index("by_organization_workspace_fileNode_fieldPath", ["organizationId", "workspaceId", "fileNodeId", "fieldPath"])
		.index("by_organization_workspace_target_fieldPath", [
			"organizationId",
			"workspaceId",
			"target.kind",
			"target.id",
			"fieldPath",
		])
		.index("by_pendingUpdate_fieldPath", ["pendingUpdateId", "fieldPath"])
		.index("by_org_workspace_archive_docKind_fieldPath_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"docKind",
			"fieldPath",
			"treePath",
		])
		.index("by_org_workspace_archive_docKind_fieldPath_string_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"docKind",
			"fieldPath",
			"valueKind",
			"stringValue",
			"treePath",
		])
		.index("by_org_workspace_archive_docKind_fieldPath_number_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"docKind",
			"fieldPath",
			"valueKind",
			"numberValue",
			"treePath",
		])
		.index("by_org_workspace_archive_docKind_fieldPath_boolean_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"docKind",
			"fieldPath",
			"valueKind",
			"booleanValue",
			"treePath",
		])
		// Distinct fields on direct children, split by `isRestrictedScopeRoot`. Committed field docs only.
		.index("by_org_ws_source_archive_docKind_parent_restricted_field", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"archiveOperationId",
			"docKind",
			"parentId",
			"isRestrictedScopeRoot",
			"fieldPath",
		])
		// The children of one folder that have one key, by value. Committed field docs only.
		.index("by_org_ws_source_archive_docKind_field_parent_restricted_sort", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"archiveOperationId",
			"docKind",
			"fieldPath",
			"parentId",
			"isRestrictedScopeRoot",
			"nodeKind",
			"sortValue",
			"sortName",
			"name",
		]),

	files_nodes: defineTable({
		// Tenant
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.id("plugins_volumes"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		// Tree identity
		/**
		 * The private draft node this saved file was published from.
		 *
		 * Keeps old private links valid after publication receipts expire. A publish receipt is
		 * deleted after a week, so this link is the only way left to turn an old private node id
		 * into the saved file it became.
		 */
		publishedFromPrivateNodeId: v.optional(v.id("files_pending_nodes")),
		/**
		 * "root" for root items, otherwise the parent folder id.
		 */
		parentId: v.union(v.id("files_nodes"), v.literal("root")),
		kind: v.union(v.literal("folder"), v.literal("file")),
		name: v.string(),
		/**
		 * `files_sort_text_key(name)`: the alphabetical key the folder table sorts by. Indexes put the
		 * raw `name` right after it, so names with the same key still have one fixed order.
		 */
		sortName: v.string(),
		/** Materialized absolute path used for path resolution */
		path: v.string(),
		/**
		 * Materialized subtree scan key used only for ordered tree range queries.
		 *
		 * Files and root use their canonical `path`. Non-root folders use `path + "/"`, so a range like
		 * `treePath >= "/docs/" && treePath < "/docs0"` returns `/docs` first
		 * followed by descendants, while excluding sibling-prefix paths such as `/docs-archive`.
		 */
		treePath: v.string(),
		/**
		 * Absolute path segment count. Root is 0.
		 */
		pathDepth: v.number(),
		/**
		 * Lowercase file extension without the dot. Folders and extensionless files use null.
		 */
		lowercaseExtension: v.union(v.string(), v.null()),
		// Content
		/**
		 * File content type. Folders store null.
		 *
		 * Store lowercase media types with optional semicolon parameters, e.g. `text/markdown;charset=utf-8`.
		 */
		contentType: v.union(v.string(), v.null()),
		assetId: v.union(v.id("files_r2_assets"), v.null()),
		/**
		 * Byte size of the `assetId` asset, copied here so the folder table can sort by size. Every
		 * write that changes `assetId` sets it too. Null for folders and for files whose bytes are not
		 * known yet.
		 */
		contentByteSize: v.union(v.number(), v.null()),
		/**
		 * Shape of this file's text: `rich_text` is the ProseMirror document Markdown files use,
		 * `plain_text` is a flat text document. Folders, stored blobs, and read-only mounts have no
		 * editable text and store null.
		 *
		 * A collaborative file stores this beside its Yjs pointers, and the two are always written
		 * together. A non-collaborative file has no Yjs pointers but still stores this field,
		 * because the shape decides which chunker runs, whether frontmatter is indexed, which
		 * editor opens. So this field, not the Yjs pointers, is what
		 * marks a node as an editable text file.
		 */
		textKind: v.union(v.literal("rich_text"), v.literal("plain_text"), v.null()),
		/**
		 * True for collaborative text, false for whole-text saves, null for non-text nodes.
		 * Keep this preference when live Yjs pointers are cleared, so replacing content preserves it.
		 */
		collaborationEnabled: v.union(v.boolean(), v.null()),
		/**
		 * Current compacted Yjs snapshot, or null without a live document.
		 */
		yjsSnapshotId: v.union(v.id("files_yjs_snapshots"), v.null()),
		/**
		 * Current Yjs sequence doc, or null without a live document.
		 */
		yjsLastSequenceId: v.union(v.id("files_yjs_docs_last_sequences"), v.null()),
		/**
		 * Content counts are kept separately so materialization does not invalidate node queries.
		 * Null for folders and until the file's stats are linked in the creation mutation.
		 */
		statsId: v.union(v.id("file_stats"), v.null()),
		// Content status
		/**
		 * Byte size of the last materialization that produced text over
		 * `files_MAX_TEXT_CONTENT_BYTES`. While set, the committed content stays at the last
		 * sequence that fit. Search and downloads serve that older text. Bash reads still rebuild
		 * the newest text from the Yjs log, so they and the committed readers disagree. Cleared by
		 * the next materialization that fits.
		 */
		contentTooLargeByteSize: v.union(v.number(), v.null()),
		/**
		 * Timestamp of the last materialization that refused because the Yjs document's shape did
		 * not match the node's `textKind`. While set, readers report a shape mismatch instead
		 * of content and the Yjs writers refuse more updates. Cleared by the next materialization
		 * that succeeds.
		 */
		contentShapeMismatchAt: v.union(v.number(), v.null()),
		/**
		 * Byte size of the last reconstructed Yjs state over
		 * `files_MAX_YJS_RECONSTRUCTED_STATE_BYTES`. While set, materialization does not advance,
		 * readers report the failure, and the Yjs writers refuse more updates until the operator
		 * repair rebuilds the state. Cleared by the next materialization that succeeds.
		 */
		contentYjsStateTooLargeByteSize: v.union(v.number(), v.null()),
		/**
		 * Frontmatter field count of the last materialization that refused because the count was
		 * over `files_metadata_MAX_FRONTMATTER_FIELDS`. While set, the committed content stays at
		 * the last sequence that fit. Cleared when the user reduces the metadata and a later
		 * materialization succeeds.
		 */
		contentFrontmatterTooLargeFieldCount: v.union(v.number(), v.null()),
		/**
		 * Frontmatter index-document count of the last materialization that refused because the
		 * count was over `files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS`. Same lifecycle as
		 * `contentFrontmatterTooLargeFieldCount`.
		 */
		contentFrontmatterTooLargeIndexDocumentCount: v.union(v.number(), v.null()),
		// Access and protection
		/**
		 * The nearest restricted folder above this node, or this node itself when it is the restricted
		 * one. Null means normal workspace access.
		 *
		 * A node is restricted exactly when `restrictedScopeNodeId === _id`. Permission grants are
		 * stored only on that node, so a restricted folder and everything inside it share one pointer.
		 *
		 * `files_sharing.ts` sets and clears it; creates and moves copy it from the new parent, so it
		 * stays right without walking up the tree. When a folder's scope changes, an op writes it to the
		 * items inside. See `files_subtree_ops_db_start_rebuild`.
		 */
		restrictedScopeNodeId: v.union(v.id("files_nodes"), v.null()),
		/**
		 * True exactly when `restrictedScopeNodeId === _id`. Stored so the folder table indexes can
		 * split the children every folder reader may read from the restricted ones, which need their
		 * own access check. The restrict and unrestrict writers set it together with
		 * `restrictedScopeNodeId`, on this node and on its committed metadata field docs.
		 */
		isRestrictedScopeRoot: v.boolean(),
		writePolicy: files_nodes_write_policy_validator,
		/**
		 * Starting protection copied once to brand-new files and subfolders.
		 * Only folders use it; files store null. Absent on docs written before the local model.
		 */
		newChildWritePolicy: v.optional(files_nodes_write_policy_validator),
		// Lifecycle and authorship
		/**
		 * Archive operation UUID, or null for an active node.
		 */
		archiveOperationId: v.union(v.string(), v.null()),
		/**
		 * Created by user ID. SYSTEM writes read-only external content.
		 */
		createdBy: v.union(v.id("users"), v.literal(users_SYSTEM_AUTHOR)),
		/**
		 * Updated by user ID. SYSTEM writes read-only external content.
		 */
		updatedBy: v.union(v.id("users"), v.literal(users_SYSTEM_AUTHOR)),
		/** timestamp in milliseconds when document was last updated */
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_parent_name_archiveOperation", [
			"organizationId",
			"workspaceId",
			"parentId",
			"name",
			"archiveOperationId",
		])
		// The subtree op walks page children with this index. It has no `archiveOperationId`, so an archive
		// stamp does not move a child inside it. Convex adds `_creationTime` at the end.
		.index("by_organization_workspace_parent_name", ["organizationId", "workspaceId", "parentId", "name"])
		.index("by_organization_workspace_parent_archiveOperation_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"name",
		])
		// The Files tree and folder table page one folder at a time with this index: folders first, then files,
		// each by name. `"file"` sorts before `"folder"`, so a reader pages one kind at a time.
		.index("by_organization_workspace_parent_archiveOperation_kind_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"kind",
			"name",
		])
		// The archived view pages one kind of one folder's archived children. `kind` sits before
		// `archiveOperationId`, so the archived range never reads the other kind.
		.index("by_organization_workspace_parent_kind_archiveOperation_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"kind",
			"archiveOperationId",
			"name",
		])
		// The public files list pages one folder's direct files with one extension.
		.index("by_org_ws_parent_archive_kind_ext_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"kind",
			"lowercaseExtension",
			"name",
		])
		// The folder table sort indexes. Each one pages one kind of one folder's children, and only the
		// readable ones (`isRestrictedScopeRoot: false`) or only the restricted ones. `sortName, name`
		// at the end breaks ties by name. The created sort uses `_creationTime`, which Convex appends.
		.index("by_org_ws_parent_archive_restricted_kind_sortName_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"isRestrictedScopeRoot",
			"kind",
			"sortName",
			"name",
		])
		.index("by_org_ws_parent_archive_restricted_kind", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"isRestrictedScopeRoot",
			"kind",
		])
		.index("by_org_ws_parent_archive_restricted_kind_updatedAt_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"isRestrictedScopeRoot",
			"kind",
			"updatedAt",
			"sortName",
			"name",
		])
		.index("by_org_ws_parent_archive_restricted_kind_ext_sortName_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"isRestrictedScopeRoot",
			"kind",
			"lowercaseExtension",
			"sortName",
			"name",
		])
		.index("by_org_ws_parent_archive_restricted_kind_size_sortName_name", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"isRestrictedScopeRoot",
			"kind",
			"contentByteSize",
			"sortName",
			"name",
		])
		.index("by_organization_workspace_parent_archiveOperation_updatedAt", [
			"organizationId",
			"workspaceId",
			"parentId",
			"archiveOperationId",
			"updatedAt",
		])
		.index("by_organization_workspace_path_archiveOperation", [
			"organizationId",
			"workspaceId",
			"path",
			"archiveOperationId",
		])
		.index("by_organization_workspace_archiveOperation", ["organizationId", "workspaceId", "archiveOperationId"])
		.index("by_organization_workspace_treePath", ["organizationId", "workspaceId", "treePath"])
		// A move finds the restricted folders inside the folder it moves, without reading the rest.
		.index("by_organization_workspace_isRestrictedScopeRoot_treePath", [
			"organizationId",
			"workspaceId",
			"isRestrictedScopeRoot",
			"treePath",
		])
		.index("by_organization_workspace_archiveOperation_treePath", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"treePath",
		])
		.index("by_organization_workspace_archiveOperation_kind_treePath", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"kind",
			"treePath",
		])
		.index("by_organization_workspace_archive_kind_lowercaseExtension_tree", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"kind",
			"lowercaseExtension",
			"treePath",
		])
		.index("by_organization_workspace_archiveOperation_updatedAt", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"updatedAt",
		])
		.index("by_organization_workspace_asset", ["organizationId", "workspaceId", "assetId"])
		.index("by_organization_workspace_publishedFromPrivateNode", [
			"organizationId",
			"workspaceId",
			"publishedFromPrivateNodeId",
		])
		.searchIndex("search_path", {
			searchField: "path",
			filterFields: ["organizationId", "workspaceId", "archiveOperationId", "kind", "parentId"],
		}),

	/**
	 * Per-FILE content stats (`wc`), kept off the file node so updating them does not invalidate the
	 * file-tree / path-resolution queries that read the node. One row per file node; computed at
	 * materialization from the full text (exact). Byte size is NOT duplicated here — it lives on
	 * the content asset (`files_r2_assets.size`, per-version). Folders have no row.
	 */
	file_stats: defineTable({
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.id("plugins_volumes"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		fileNodeId: v.id("files_nodes"),
		/** Newline count (`wc -l`). -1 means the content cannot be processed (stored blob/binary, not editable text). */
		lineCount: v.number(),
		/** Whitespace-delimited word count (`wc -w`). -1 means cannot be processed. */
		wordCount: v.number(),
		/** Unicode code-point count (`wc -m`, not UTF-16 units). -1 means cannot be processed. */
		charCount: v.number(),
	}).index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"]),

	/**
	 * The saved sort of one folder's table, shared by every member. One row per folder at most, and no
	 * row means Name, A to Z. It is keyed by folder id, so rename, move, archive, and restore keep it.
	 * A copied folder does not copy it.
	 *
	 * A table and not a node field, because the workspace root has no node, and because a sort change
	 * then does not re-run every tree page that holds the folder row.
	 */
	files_folder_sorts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/** The folder, or "root" for the workspace root. */
		folderId: v.union(v.id("files_nodes"), v.literal("root")),
		sort: files_sort_validator,
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	}).index("by_organization_workspace_folder", ["organizationId", "workspaceId", "folderId"]),

	/**
	 * Updater sort docs: one per committed file node whose updater is a real user, so the folder table
	 * can sort a folder's children by the updater's name. Each doc copies the node's parent, kind, name,
	 * archive id and restricted-root flag, like `files_metadata_committed_sort_fields`. SYSTEM-authored
	 * nodes have no doc.
	 */
	files_updated_by_docs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		/** The node's `updatedBy`. */
		userId: v.id("users"),
		/** Copy of the node's field. Unset while the node is active. */
		archiveOperationId: v.optional(v.string()),
		/** The node's parent folder. */
		parentId: v.union(v.id("files_nodes"), v.literal("root")),
		nodeKind: v.union(v.literal("folder"), v.literal("file")),
		/** Copy of the node's flag. See `files_nodes.isRestrictedScopeRoot`. */
		isRestrictedScopeRoot: v.boolean(),
		name: v.string(),
		/** `files_sort_text_key(name)`. */
		sortName: v.string(),
		/**
		 * `files_sort_text_key(files_table_updated_by_text(displayName))`. Always set. A name change
		 * updates it later, in batches.
		 */
		sortUserName: v.string(),
	})
		.index("by_fileNode", ["fileNodeId"])
		.index("by_user_sort", ["userId", "sortUserName", "fileNodeId"])
		// The children of one folder by updater name. The workspace purge uses its tenant prefix.
		.index("by_org_ws_archive_parent_restricted_kind_sort", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"parentId",
			"isRestrictedScopeRoot",
			"nodeKind",
			"sortUserName",
			"sortName",
			"name",
		]),

	/**
	 * "Anyone with the link can view" for one file. At most one doc per file. Turning the link off
	 * deletes the doc, and turning it on again makes a new token, so an old link never works again.
	 * Lifecycle events that change who can see the file delete the doc too (`files_share_links_db.ts`).
	 */
	files_share_links: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.id("files_nodes"),
		/**
		 * 32 random bytes as hex. Stored as plain text so a manager can copy the link again. Never log it.
		 */
		token: v.string(),
		/**
		 * The file's live restricted scope when the link was turned on. The view refuses when it differs.
		 */
		restrictedScopeNodeId: v.union(v.id("files_nodes"), v.null()),
		/**
		 * The file's ancestors from its parent up to the workspace root, from the live walk. A reparent
		 * deletes this doc before they can go stale. Never returned to a visitor or by `list_workspace_links`.
		 */
		ancestorNodeIds: v.array(v.id("files_nodes")),
		/**
		 * Display and audit data only. The link does not depend on this user's membership.
		 */
		createdBy: v.id("users"),
		createdAt: v.number(),
	})
		.index("by_token", ["token"])
		.index("by_organization_workspace_node", ["organizationId", "workspaceId", "nodeId"]),

	/** Exact text chunks for committed Yjs materializations and per-user pending updates. */
	files_text_chunks: defineTable(
		v.union(
			v.object({ ...files_committed_index_fields, ...files_text_chunk_fields }),
			v.object({ ...files_pending_index_fields, ...files_text_chunk_fields }),
		),
	)
		.index("by_organization_workspace_source_fileNode_yjsSeq_chunk", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"yjsSequence",
			"chunkIndex",
		])
		.index("by_organization_workspace_source_fileNode_lineEnd_chunk", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"lineEnd",
			"chunkIndex",
		])
		.index("by_organization_workspace_source_fileNode_endIndex_chunk", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"endIndex",
			"chunkIndex",
		])
		.index("by_organization_workspace_fileNode_chunkIndex", [
			"organizationId",
			"workspaceId",
			"fileNodeId",
			"chunkIndex",
		])
		.index("by_pendingUpdate_chunkIndex", ["pendingUpdateId", "chunkIndex"])
		.index("by_organization_workspace_target_chunkIndex", [
			"organizationId",
			"workspaceId",
			"target.kind",
			"target.id",
			"chunkIndex",
		])
		.index("by_pendingUpdate_lineEnd_chunkIndex", ["pendingUpdateId", "lineEnd", "chunkIndex"])
		.index("by_pendingUpdate_endIndex_chunkIndex", ["pendingUpdateId", "endIndex", "chunkIndex"]),

	/**
	 * Unified plain-text search docs. Pending docs are user-scoped; committed docs are global within
	 * the organization/workspace and suppressed at query time for files the acting user is editing.
	 * Search result display fields are duplicated here so full-text hits do not hydrate linked docs.
	 */
	files_plain_text_chunks: defineTable(
		v.union(
			v.object({ ...files_committed_index_fields, ...files_plain_text_chunk_fields }),
			v.object({ ...files_pending_index_fields, ...files_plain_text_chunk_fields }),
		),
	)
		.searchIndex("search_by_plainTextChunk", {
			searchField: "plainTextChunk",
			filterFields: ["organizationId", "workspaceId", "archiveOperationId"],
		})
		.index("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", [
			"organizationId",
			"workspaceId",
			"sourceKind",
			"fileNodeId",
			"yjsSequence",
			"chunkIndex",
		])
		.index("by_organization_workspace_fileNode_chunkIndex", [
			"organizationId",
			"workspaceId",
			"fileNodeId",
			"chunkIndex",
		])
		.index("by_pendingUpdate_chunkIndex", ["pendingUpdateId", "chunkIndex"])
		.index("by_organization_workspace_target_chunkIndex", [
			"organizationId",
			"workspaceId",
			"target.kind",
			"target.id",
			"chunkIndex",
		]),

	files_yjs_snapshots: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		sequence: v.number(),
		/** Current R2 asset for the compacted Yjs update. */
		assetId: v.id("files_r2_assets"),
		createdBy: v.id("users"),
		updatedBy: v.string(),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_fileNode_sequence", ["organizationId", "workspaceId", "fileNodeId", "sequence"])
		.index("by_asset", ["assetId"]),

	files_yjs_updates: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		sequence: v.number(),
		update: v.bytes(),
		origin: v.union(
			v.object({
				type: v.literal("USER_EDIT"),
				/**
				 * Even though sessions are destroyed when users disconnect, this
				 * is usedful to differentiate between local and remote edits.
				 */
				sessionId: v.string(),
			}),
			v.object({
				type: v.literal("USER_SNAPSHOT_RESTORE"),
				snapshotId: v.id("files_snapshots"),
			}),
			v.object({
				type: v.literal("USER_AI_EDIT"),
			}),
		),
		createdBy: v.id("users"),
		createdAt: v.number(),
	}).index("by_organization_workspace_fileNode_sequence", ["organizationId", "workspaceId", "fileNodeId", "sequence"]),

	files_yjs_docs_last_sequences: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		lastSequence: v.number(),
		/** Count of not-yet-materialized `files_yjs_updates` docs for this file. */
		unmaterializedUpdateCount: v.number(),
		/**
		 * Total `update` bytes of not-yet-materialized `files_yjs_updates` docs for this file.
		 * Same lifecycle as `unmaterializedUpdateCount`.
		 */
		unmaterializedUpdateBytes: v.number(),
		/**
		 * Bumped by the operator Yjs repair when it replaces the document's history. Pending
		 * proposals record the generation they were built against, so a repair makes them visibly
		 * stale instead of merging onto a rebuilt document.
		 */
		lineageGeneration: v.number(),
	}).index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"]),

	/**
	 * One server-built Yjs update staged ahead of its commit mutation (pending Accept, public
	 * fill, snapshot restore), so the commit call carries only ids and one bounded text value.
	 * Consumed on commit; abandoned stages expire after 30 minutes and the sweeper deletes them.
	 */
	files_yjs_trusted_update_stages: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		fileNodeId: v.id("files_nodes"),
		kind: v.union(v.literal("pending_accept"), v.literal("public_fill"), v.literal("snapshot_restore")),
		update: v.bytes(),
		expiresAt: v.number(),
	})
		.index("by_organization_workspace_user_fileNode", ["organizationId", "workspaceId", "userId", "fileNodeId"])
		.index("by_user", ["userId"])
		.index("by_expiresAt", ["expiresAt"]),

	files_content_materialization_jobs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		jobId: vWorkId,
		targetSequence: v.number(),
	})
		.index("by_fileNode", ["fileNodeId"])
		.index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"]),

	/**
	 * Retired Yjs history and its snapshot asset. Remaining old history blocks a fresh document;
	 * asset cleanup continues separately after that history is gone.
	 */
	files_yjs_cleanup_tasks: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		throughSequence: v.number(),
		supersededYjsAssetId: v.id("files_r2_assets"),
		putMayArriveUntil: v.union(v.number(), v.null()),
		historyPending: v.boolean(),
	}).index("by_organization_workspace_fileNode_historyPending", [
		"organizationId",
		"workspaceId",
		"fileNodeId",
		"historyPending",
	]),

	files_snapshots: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		fileNodeId: v.id("files_nodes"),
		assetId: v.id("files_r2_assets"),
		/**
		 * The content type of this version. A version records what the file was when it was
		 * saved, so restoring it brings the type back together with the bytes.
		 */
		contentType: v.string(),
		/**
		 * The document shape of this version. Null for stored bytes.
		 */
		yjsRootKind: v.union(v.literal("rich_text"), v.literal("plain_text"), v.null()),
		/**
		 * True only for text saved with collaboration on.
		 */
		collaborationEnabled: v.boolean(),
		createdBy: v.id("users"),
		/**
		 * Use -1 for snapshots that were never archived, 0 for snapshots that were
		 * unarchived, and > 0 for the archive timestamp in milliseconds.
		 */
		archivedAt: v.number(),
	})
		.index("by_organization_workspace_fileNode_archivedAt", [
			"organizationId",
			"workspaceId",
			"fileNodeId",
			"archivedAt",
		])
		.index("by_asset", ["assetId"]),

	/**
	 * A live storage hold becomes a receipt after Save or confirmed deletion. Retain it while a
	 * producer or cleanup retry can still refer to the resource. Ownership transfers keep the hold.
	 */
	files_private_storage_reservations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		resource: v.union(
			v.object({ kind: v.literal("asset"), id: v.id("files_r2_assets"), r2Key: v.string() }),
			v.object({ kind: v.literal("state"), id: v.id("files_pending_update_yjs_states") }),
			v.object({ kind: v.literal("text_input"), id: v.id("files_pending_update_text_inputs") }),
			v.object({ kind: v.literal("trusted_stage"), id: v.id("files_yjs_trusted_update_stages") }),
			v.object({ kind: v.literal("node"), id: v.id("files_pending_nodes") }),
		),
		byteCount: v.number(),
		publicationBatchId: v.optional(v.id("files_pending_update_operation_batches")),
		/**
		 * The node quota for a private node. The user's byte quota for every payload.
		 */
		userQuotaId: v.id("quotas"),
		workspaceQuotaId: v.union(v.id("quotas"), v.null()),
		createdAt: v.number(),
		settlement: v.union(
			v.object({ kind: v.literal("held") }),
			v.object({ kind: v.literal("saved"), savedNodeId: v.id("files_nodes"), settledAt: v.number() }),
			v.object({
				kind: v.literal("deleted"),
				settledAt: v.number(),
				proof: v.union(
					v.object({ kind: v.literal("database") }),
					v.object({ kind: v.literal("r2"), jobId: v.id("files_r2_object_deletion_jobs"), generation: v.number() }),
				),
			}),
		),
	})
		.index("by_resource", ["resource.kind", "resource.id"])
		.index("by_r2_key", ["resource.r2Key"])
		.index("by_organization_workspace_settlement", ["organizationId", "workspaceId", "settlement.kind"])
		.index("by_organization_workspace_settlement_resource", [
			"organizationId",
			"workspaceId",
			"settlement.kind",
			"resource.kind",
		])
		.index("by_user_settlement", ["userId", "settlement.kind"])
		.index("by_user_settlement_resource", ["userId", "settlement.kind", "resource.kind"])
		.index("by_userQuota_settlement", ["userQuotaId", "settlement.kind"])
		.index("by_workspaceQuota_settlement", ["workspaceQuotaId", "settlement.kind"])
		.index("by_workspaceQuota_settlement_publicationBatch", [
			"workspaceQuotaId",
			"settlement.kind",
			"publicationBatchId",
		]),

	/**
	 * One shared cloud browser per mode and owner/organization/workspace.
	 * `file` shows one HTML file from Files; `web` is an open web browser with no
	 * file. The runner owns control, leases, and deadlines, and this doc mirrors what the UI may
	 * show. `runnerSessionId` stays server-only: links carry this doc id. A `starting` doc that
	 * never commits expires fast. Closed docs are swept 7 days after their browser time is billed.
	 */
	files_browser_sessions: defineTable(
		v.union(
			v.object({
				...files_browser_session_shared_fields,
				mode: v.literal("file"),
				targetKind: v.union(v.literal("saved"), v.literal("private")),
				nodeId: v.string(),
				path: v.string(),
				navigationClientId: v.string(),
				sourceKind: files_browser_session_source_kind_validator,
				sourceVersion: v.string(),
				sourceHash: v.string(),
			}),
			v.object({
				...files_browser_session_shared_fields,
				// Each web tab has its own navigation generation.
				mode: v.literal("web"),
				/**
				 * The "Agent can use this browser" switch. The runner owns it; this mirrors it.
				 */
				agentAccess: v.boolean(),
				tabId: v.union(v.string(), v.null()),
				tabGen: v.number(),
				viewedTabId: v.union(v.string(), v.null()),
				viewGen: v.number(),
				tabCount: v.number(),
				tabs: v.array(v.object({ tabId: v.string(), tabGen: v.number(), navGen: v.number() })),
				policyRevision: v.number(),
			}),
		),
	)
		.index("by_owner_organization_workspace", ["ownerId", "organizationId", "workspaceId"])
		.index("by_owner", ["ownerId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_billing_state_updatedAt", ["billing.state", "updatedAt"])
		.index("by_startingExpiresAt", ["startingExpiresAt"]),

	/**
	 * Saved agent browser policy survives browser and cookie cleanup.
	 */
	files_browser_preferences: defineTable({
		ownerId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		webAgentAccess: v.boolean(),
		policyRevision: v.number(),
		agentBlockedHosts: v.array(v.string()),
		syncPending: v.boolean(),
		updatedAt: v.number(),
	})
		.index("by_owner_organization_workspace", ["ownerId", "organizationId", "workspaceId"])
		.index("by_owner", ["ownerId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_syncPending_updatedAt", ["syncPending", "updatedAt"]),

	/**
	 * One shared browser connection for an owner and workspace.
	 * Only encrypted share credentials and bounded state are saved. Active and state indexes
	 * find live capacity and saved links due for expiry without scanning closed connections.
	 */
	playwriter_connections: defineTable({
		ownerId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		membershipId: v.id("organizations_workspaces_users"),
		membershipLifetime: v.number(),
		encryptedShareId: v.union(v.bytes(), v.null()),
		shareNonce: v.union(v.bytes(), v.null()),
		linkFingerprint: v.union(v.string(), v.null()),
		state: v.union(
			v.literal("connecting"),
			v.literal("needs_confirmation"),
			v.literal("ready"),
			v.literal("running"),
			v.literal("paused"),
			v.literal("recovering"),
			v.literal("offline"),
			v.literal("closing"),
			v.literal("closed"),
			v.literal("limit_reached"),
			v.literal("needs_human"),
		),
		connectionGeneration: v.number(),
		controlRevision: v.number(),
		targetRevision: v.number(),
		navRevision: v.number(),
		inventoryRevision: v.number(),
		confirmedTargetId: v.union(v.string(), v.null()),
		confirmedTargetHandle: v.union(v.string(), v.null()),
		targets: v.array(v.object({ targetId: v.string(), handle: v.string(), title: v.string(), url: v.string() })),
		pauseReason: v.union(v.string(), v.null()),
		connectAttemptId: v.string(),
		sessionId: v.string(),
		operations: v.number(),
		idleExpiresAt: v.number(),
		totalExpiresAt: v.union(v.number(), v.null()),
		unresolvedCommand: v.union(playwriter_command_identity_validator, v.null()),
		pendingAcknowledgement: v.union(playwriter_command_identity_validator, v.null()),
		createdAt: v.number(),
		updatedAt: v.number(),
		active: v.boolean(),
	})
		.index("by_owner_organization_workspace", ["ownerId", "organizationId", "workspaceId"])
		.index("by_linkFingerprint", ["linkFingerprint"])
		.index("by_active", ["active"])
		.index("by_active_state_idleExpiresAt", ["active", "state", "idleExpiresAt"])
		.index("by_owner_organization_state", ["ownerId", "organizationId", "state"])
		.index("by_owner_organization_workspace_active", ["ownerId", "organizationId", "workspaceId", "active"])
		.index("by_owner", ["ownerId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * Retry an exact socket close or credential Forget after its source is removed.
	 * Due-time and connection indexes keep retries bounded and prevent early slot release.
	 */
	playwriter_connection_cleanups: defineTable({
		ownerId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		// The copied ID survives deletion of its connection doc.
		connectionId: v.string(),
		generation: v.number(),
		forgetCredential: v.boolean(),
		attempts: v.number(),
		nextAttemptAt: v.number(),
	})
		.index("by_nextAttemptAt", ["nextAttemptAt"])
		.index("by_connectionId", ["connectionId"]),

	/**
	 * Count one user's connection starts by UTC date. The date index removes old counters.
	 */
	playwriter_user_daily_use: defineTable({
		userId: v.id("users"),
		day: v.string(),
		starts: v.number(),
	})
		.index("by_user_day", ["userId", "day"])
		.index("by_day", ["day"]),

	/**
	 * One explicit editor-draft capture: unsaved Monaco/Diff bytes uploaded for a browser load.
	 * Consumed once by start, then deleted with its blob. Unclaimed captures expire in minutes.
	 */
	files_browser_draft_captures: defineTable({
		ownerId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		nodeId: v.string(),
		storageId: v.optional(v.id("_storage")),
		revision: v.number(),
		basisKind: v.string(),
		basisVersion: v.string(),
		navigationGeneration: v.number(),
		byteSize: v.number(),
		hash: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_expiresAt", ["expiresAt"])
		.index("by_owner", ["ownerId"]),

	/**
	 * Daily browser-use counters per workspace for file mode. The day key makes the window
	 * self-resetting: a new UTC day starts a new doc, and the expiry sweep deletes docs older than
	 * two days. This brakes start/end and capture loops. Browser time is billed per minute.
	 */
	files_browser_daily_use: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		day: v.string(),
		starts: v.number(),
		captures: v.number(),
		updatedAt: v.number(),
	}).index("by_workspace_day", ["workspaceId", "day"]),

	/**
	 * Daily web browser starts per user, across all workspaces. A loop brake, not a cost brake:
	 * only a start that really opened a browser counts, and reattaching is free. Swept after two
	 * days like the workspace counters.
	 */
	files_browser_user_daily_use: defineTable({
		userId: v.id("users"),
		day: v.string(),
		webStarts: v.number(),
		updatedAt: v.number(),
	})
		.index("by_user_day", ["userId", "day"])
		.index("by_day", ["day"]),

	/**
	 * The saved web browser profile of one user in one workspace: the key half that Convex holds.
	 * The runner stores the saved cookies encrypted, and opening them needs this `profileKey` plus
	 * the runner's own secret. So deleting this doc makes the saved cookies unreadable at once.
	 * Every deletion writes a `files_browser_profile_wipes` doc in the same transaction, so the
	 * runner also deletes the bytes. `profileKey` never leaves internal functions.
	 */
	files_browser_profiles: defineTable({
		userId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/**
		 * 32 random bytes.
		 */
		profileKey: v.bytes(),
		createdAt: v.number(),
		/**
		 * The last web browser start. The hourly sweep deletes profiles unused for 90 days.
		 */
		lastUsedAt: v.number(),
	})
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_lastUsedAt", ["lastUsedAt"]),

	/**
	 * One runner wipe still to do for a deleted `files_browser_profiles` doc. The wipe job asks the
	 * runner to delete the stored bytes and deletes this doc when the runner confirms. Failures
	 * retry with backoff and never give up; the runner's own 100-day timer is the last backstop.
	 * These docs outlive user and workspace deletion on purpose: they are how the bytes get deleted.
	 */
	files_browser_profile_wipes: defineTable({
		/**
		 * The deleted profile doc's id, as a string.
		 */
		profileId: v.string(),
		ownerId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		createdAt: v.number(),
		attempts: v.number(),
		nextAttemptAt: v.number(),
	}).index("by_nextAttemptAt", ["nextAttemptAt"]),

	/**
	 * One human browser download saved to Files. A second save of the same download returns this
	 * node and does not create another one. The runner keeps at most 20 downloads per session, so a
	 * session has few of these docs. They are deleted with their session doc.
	 */
	files_browser_download_saves: defineTable({
		sessionId: v.id("files_browser_sessions"),
		/**
		 * The runner's random id for the download.
		 */
		downloadId: v.string(),
		nodeId: v.id("files_nodes"),
		createdAt: v.number(),
		/**
		 * When the runner uploaded the bytes to the node's asset. `null` while no push worked yet: a
		 * later save then signs a new upload URL for the same asset and asks the runner to push again.
		 */
		pushedAt: v.union(v.number(), v.null()),
	}).index("by_session_download", ["sessionId", "downloadId"]),

	files_r2_assets: defineTable({
		organizationId: v.union(v.id("organizations"), v.literal(organizations_GLOBAL_ORGANIZATION_ID)),
		workspaceId: v.union(
			v.id("organizations_workspaces"),
			v.id("plugins_volumes"),
			v.literal(organizations_GLOBAL_GITHUB_WORKSPACE_ID),
			v.literal(organizations_GLOBAL_PLUGINS_WORKSPACE_ID),
		),
		kind: v.union(
			v.literal("upload"),
			v.literal("channel_upload"),
			v.literal("content"),
			v.literal("yjs_snapshot"),
			v.literal("content_snapshot"),
		),
		r2Bucket: v.string(),
		/**
		 * The final R2 key. Usually set after R2 confirms the file exists.
		 * Volume writes set it before PUT; their unfinalized deadline still guards unfinished writes.
		 **/
		r2Key: v.optional(v.string()),
		size: v.number(),
		etag: v.optional(v.string()),
		/**
		 * Only trusted operator imports may skip upload billing and the stored-file counter.
		 */
		uploadBillingExempt: v.optional(v.literal(true)),
		/**
		 * Upload processing state. Undefined means not started. A work id means running.
		 * Null means finished.
		 **/
		processingWorkId: v.optional(v.union(vWorkId, v.null())),
		/**
		 * When to check an unfinished asset again. New assets get a 24-hour deadline. Clear it only
		 * after a node or snapshot uses the R2 file, or cleanup confirms the file is deleted. The
		 * hourly cleanup in r2.ts checks assets after this time.
		 **/
		unfinalizedExpiresAt: v.optional(v.number()),
		/**
		 * When the signed upload URL stops working. Cleanup uses this time because the URL can
		 * create the R2 object again after a delete until the URL expires.
		 */
		uploadUrlExpiresAt: v.optional(v.number()),
		/** Latest time an in-flight transfer write may arrive, including the cleanup margin. */
		putMayArriveUntil: v.optional(v.number()),
		/**
		 * Cleanup has retired this pending attempt. A late event cannot publish it.
		 */
		uploadRetiredAt: v.optional(v.number()),
		/**
		 * Created by user ID. SYSTEM writes read-only external content.
		 */
		createdBy: v.union(v.id("users"), v.literal(users_SYSTEM_AUTHOR)),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_unfinalizedExpiresAt", ["unfinalizedExpiresAt"]),

	/**
	 * Each doc asks the scheduled worker to delete one exact R2 key. The worker retries until R2
	 * confirms deletion.
	 *
	 * Increase `generation` when new bytes may have reached the key. A delete
	 * started for an older generation cannot remove the newer job.
	 */
	files_r2_object_deletion_jobs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		r2Key: v.string(),
		reason: v.union(
			v.literal("failed_create"),
			v.literal("read_only_create"),
			v.literal("read_only_stage"),
			v.literal("read_only_snapshot_restore"),
			v.literal("read_only_yjs_repair"),
			v.literal("untracked_asset_event"),
			v.literal("discarded_replacement"),
			v.literal("chat_output"),
		),
		assetId: v.optional(v.id("files_r2_assets")),
		privateStorageReservationId: v.optional(v.id("files_private_storage_reservations")),
		/**
		 * The stored tool output this job deletes. The final delete releases its quota hold.
		 */
		chatOutputObjectId: v.optional(v.id("ai_chat_output_objects")),
		generation: v.number(),
		lastR2EventId: v.optional(v.string()),
		/**
		 * The last time another upload may reach this key. Before this time, keep the job after a
		 * successful delete and delete again later. Leave it empty when no later upload can arrive.
		 */
		putMayArriveUntil: v.optional(v.number()),
		/**
		 * Failed deletes in the current generation.
		 */
		failureCount: v.number(),
		nextAttemptAt: v.number(),
	})
		.index("by_r2_key", ["r2Key"])
		.index("by_next_attempt_at", ["nextAttemptAt"]),

	/**
	 * Operational status for read-only external mounts (v1: GitHub repo mirrors). This table's own
	 * scope is not a file scope, so no reserved-literal union applies. Content lives in immutable
	 * per-commit roots `/<name>/<commitSha>/...` in GLOBAL/GITHUB: sync ingests a fresh root, finalize
	 * flips `lastCommitSha`, and orphan roots are GC'd.
	 */
	github_mounts: defineTable({
		/** Mount name exposed as `/.mounts/<name>`. */
		name: v.string(),
		owner: v.string(),
		repo: v.string(),
		defaultBranch: v.union(v.string(), v.null()),
		/** Branch name to sync (v1: branch only). */
		ref: v.string(),
		/**
		 * Active-root pointer AND mount-visibility gate: the mount serves `/<name>/<lastCommitSha>/...`;
		 * null means not mounted (never synced, or wiped).
		 */
		lastCommitSha: v.union(v.string(), v.null()),
		lastTreeSha: v.union(v.string(), v.null()),
		lastSyncedAt: v.union(v.number(), v.null()),
		status: v.union(v.literal("idle"), v.literal("running"), v.literal("error")),
		startedAt: v.union(v.number(), v.null()),
		producerFinishedAt: v.union(v.number(), v.null()),
		finishedAt: v.union(v.number(), v.null()),
		lastError: v.union(v.string(), v.null()),
		enqueuedCount: v.optional(v.number()),
		completedCount: v.optional(v.number()),
		failedCount: v.optional(v.number()),
		skippedCount: v.optional(v.number()),
		compressedBytesRead: v.optional(v.number()),
		acceptedUncompressedBytes: v.optional(v.number()),
		/**
		 * App-generated id for the active sync run. A stale async write must match this id before it writes.
		 */
		syncRunId: v.optional(v.string()),
		lockedAt: v.optional(v.number()),
		/**
		 * Commit SHA learned at metadata-fetch time for the active sync. Finalize promotes it to
		 * `lastCommitSha` on success or clears it on materialization failure.
		 */
		pendingCommitSha: v.optional(v.string()),
		/**
		 * Tree SHA learned at metadata-fetch time for the active sync. Kept on the mount doc so the
		 * last finishing worker can close the run without carrying per-file job metadata.
		 */
		pendingTreeSha: v.optional(v.string()),
	}).index("by_name", ["name"]),
	// #endregion files

	// #region files transfer
	/**
	 * Saved Paste and agent proposal work. The idle clipboard stays in its browser tab.
	 */
	files_transfer_runs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		// Activity stays in the workspace that started the transfer. Files keep their own scopes.
		sourceScope: files_transfer_scope_validator,
		destinationScope: files_transfer_scope_validator,
		requestId: v.string(),
		requestHash: v.string(),
		kind: v.union(v.literal("move"), v.literal("copy")),
		bashJob: v.optional(v.object({ invocationId: v.id("ai_chat_bash_invocations"), commandNumber: v.number() })),
		sourceView: v.union(v.literal("saved"), v.literal("draft")),
		publication: v.union(v.literal("saved"), v.literal("proposal")),
		origin: v.union(
			v.object({ kind: v.literal("clipboard") }),
			v.object({ kind: v.literal("agent"), threadId: v.id("ai_chat_threads") }),
		),
		targetParent: files_pending_parent_validator,
		targetPath: v.string(),
		targetName: v.union(v.string(), v.null()),
		missingParentNames: v.array(v.string()),
		preparedParent: v.union(files_pending_parent_validator, v.null()),
		// The Activity holds the deadline. This flag stops a synchronous run from extending it.
		fixedDeadline: v.boolean(),
		outputReviewUntil: v.optional(v.number()),
		conflictPolicy: files_transfer_conflict_policy_validator,
		step: v.union(
			v.literal("uploading"),
			v.literal("select"),
			v.literal("normalize"),
			v.literal("discover"),
			v.literal("plan"),
			v.literal("reserve"),
			v.literal("apply"),
			v.literal("retry"),
		),
		// Copy admission pages. Move and manifest retries do not upload a selection.
		selection: v.optional(v.object({ expectedCount: v.number(), count: v.number(), cursor: v.number() })),
		planCursor: v.union(v.number(), v.null()),
		reserveCursor: v.union(v.number(), v.null()),
		retryOf: v.union(v.id("files_transfer_runs"), v.null()),
		retryCursor: v.union(v.number(), v.null()),
		revision: v.number(),
		inFlight: v.number(),
		applyToRemaining: v.object({
			file: v.union(v.literal("keep_both"), v.literal("replace"), v.literal("skip"), v.null()),
			folder: v.union(v.literal("keep_both"), v.literal("merge"), v.literal("skip"), v.null()),
		}),
	})
		.index("by_user_workspace_request", ["userId", "workspaceId", "requestId"])
		.index("by_targetParent", ["targetParent.kind", "targetParent.id"])
		.index("by_preparedParent", ["preparedParent.kind", "preparedParent.id"])
		.index("by_retryOf", ["retryOf", "step"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_sourceScope_workspace", ["sourceScope.workspaceId"])
		.index("by_destinationScope_workspace", ["destinationScope.workspaceId"])
		.index("by_user", ["userId"]),

	// Input order stays exact for page replay, including repeated sources.
	files_transfer_selection_items: defineTable({
		runId: v.id("files_transfer_runs"),
		order: v.number(),
		source: files_pending_target_validator,
		path: v.union(v.string(), v.null()),
		kind: v.union(v.literal("file"), v.literal("folder"), v.null()),
	})
		.index("by_run_order", ["runId", "order"])
		.index("by_run_source_order", ["runId", "source.kind", "source.id", "order"])
		.index("by_run_path", ["runId", "path"]),

	/**
	 * One doc per source in a run. Tracks attempts, temporary assets, and the resulting node.
	 */
	files_transfer_items: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		runId: v.id("files_transfer_runs"),
		source: files_pending_target_validator,
		sourceParent: files_pending_parent_validator,
		sourceName: v.string(),
		sourcePath: v.string(),
		targetName: v.string(),
		plannedPath: v.union(v.string(), v.null()),
		kind: v.union(v.literal("folder"), v.literal("file")),
		parentItemId: v.union(v.id("files_transfer_items"), v.null()),
		order: v.number(),
		discoveryDone: v.boolean(),
		discoveryCursor: v.union(v.string(), v.null()),
		state: v.union(
			v.literal("pending"),
			v.literal("waiting_media"),
			v.literal("blocked"),
			v.literal("copying"),
			v.literal("conflict"),
			v.literal("completed"),
			v.literal("skipped"),
			v.literal("failed"),
			v.literal("canceled"),
		),
		conflictKind: v.union(
			v.literal("name_conflict"),
			v.literal("source_changed"),
			v.literal("destination_changed"),
			v.null(),
		),
		choice: v.union(v.literal("keep_both"), v.literal("skip"), v.literal("merge"), v.literal("replace"), v.null()),
		conflictTarget: v.union(files_pending_target_validator, v.null()),
		conflictVersion: v.union(files_transfer_source_version_validator, v.null()),
		preparation: v.union(
			v.object({
				privateNodeId: v.id("files_pending_nodes"),
				pendingUpdateId: v.id("files_pending_updates"),
				creationGeneration: v.number(),
				structuralRevision: v.number(),
				proposalRevision: v.number(),
			}),
			v.null(),
		),
		outcome: v.union(v.literal("copied"), v.literal("moved"), v.literal("merged"), v.literal("unchanged"), v.null()),
		cancelReason: v.union(
			v.literal("stop"),
			v.literal("timeout"),
			v.literal("proposal_discard"),
			v.literal("proposal_expiry"),
			v.null(),
		),
		errorCode: v.union(v.string(), v.null()),
		attempt: v.number(),
		workId: v.union(vWorkId, v.null()),
		attemptExpiresAt: v.union(v.number(), v.null()),
		/**
		 * Unpublished assets for the current attempt, handed to the deletion ledger on discard.
		 */
		stagedAssetIds: v.array(v.id("files_r2_assets")),
		/**
		 * The first source read and its independent content. Retries keep the same capture.
		 * An artifact owns finalized assets until publication or durable cleanup takes them.
		 */
		capture: v.union(
			v.null(),
			v.object({
				sourceVersion: files_transfer_source_version_validator,
				sourceAssetId: v.union(v.id("files_r2_assets"), v.null()),
				mediaDependencySetId: v.optional(v.id("files_media_dependency_sets")),
				mediaSourceSet: v.optional(v.object({ setId: v.id("files_media_dependency_sets"), generation: v.number() })),
				sourceStateId: v.union(v.id("files_pending_update_yjs_states"), v.null()),
				sourceYjsSnapshot: v.union(
					v.null(),
					v.object({
						snapshotId: v.id("files_yjs_snapshots"),
						assetId: v.id("files_r2_assets"),
						sequence: v.number(),
					}),
				),
				metadata: files_metadata_entries_validator,
				artifact: v.union(
					v.null(),
					v.object({
						contentAssetId: v.id("files_r2_assets"),
						yjsSnapshotAssetId: v.union(v.id("files_r2_assets"), v.null()),
						textStateId: v.union(v.id("files_pending_update_yjs_states"), v.null()),
					}),
				),
			}),
		),
		/**
		 * Payer pinned at the first successful billing check; retries keep it.
		 */
		billedUserId: v.union(v.id("users"), v.null()),
		outputTarget: v.union(files_pending_target_validator, v.null()),
		/**
		 * Copied image/video asset identity, kept on completed retries. This does not own the asset.
		 */
		outputMediaAssetId: v.optional(v.id("files_r2_assets")),
		outputProposal: v.optional(
			v.object({
				pendingUpdateId: v.id("files_pending_updates"),
				privateGeneration: v.union(v.number(), v.null()),
				replacementAssetId: v.union(v.id("files_r2_assets"), v.null()),
			}),
		),
		outputName: v.union(v.string(), v.null()),
		outputPath: v.union(v.string(), v.null()),
		/**
		 * The policy this run wrote on the produced node. Its children may be created inside it
		 * while the node's current policy still equals this value, even when it is a lock.
		 * Merged or private targets store nothing: the run did not write that policy.
		 */
		outputWritePolicy: v.optional(files_nodes_write_policy_validator),
		errorMessage: v.union(v.string(), v.null()),
	})
		.index("by_run_source", ["runId", "source.kind", "source.id"])
		.index("by_source", ["source.kind", "source.id"])
		.index("by_sourceParent", ["sourceParent.kind", "sourceParent.id"])
		.index("by_preparation_privateNode", ["preparation.privateNodeId"])
		.index("by_outputTarget", ["outputTarget.kind", "outputTarget.id"])
		.index("by_outputProposal_pendingUpdate", ["outputProposal.pendingUpdateId"])
		.index("by_run_order", ["runId", "order"])
		.index("by_run_state_order", ["runId", "state", "order"])
		.index("by_run_work", ["runId", "workId"])
		.index("by_attemptExpiresAt", ["attemptExpiresAt"])
		.index("by_run_parentItem", ["runId", "parentItemId"])
		.index("by_run_parentItem_plannedPath", ["runId", "parentItemId", "plannedPath", "order"])
		.index("by_run_discoveryDone_order", ["runId", "discoveryDone", "order"])
		.index("by_parentItem", ["parentItemId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	// #endregion files transfer

	// #region files write policy runs
	/**
	 * One "Apply to contents" job. It sets a protection rule on every item inside a folder, a few
	 * items per step. The Activity keeps the membership, the status, and the progress.
	 */
	files_write_policy_runs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		folderId: v.id("files_nodes"),
		/**
		 * The folder's `treePath` when the job started. A step stops the job if the folder moved.
		 */
		folderTreePath: v.string(),
		/**
		 * The rule the person confirmed. Later edits to the folder do not change a running job.
		 */
		writePolicy: files_nodes_write_policy_validator,
		/**
		 * Where the next step starts. null means just after the folder itself. `inclusive` is true only
		 * after a skipped hidden folder, when the bound is the first path after its contents.
		 */
		cursor: v.union(v.object({ treePath: v.string(), inclusive: v.boolean() }), v.null()),
		/**
		 * Counts from steps that ended at the check limit, not shown in the Activity yet. They are shown
		 * with the next full 50 or at the end. Otherwise a step that counted fewer than 50 would show
		 * exactly how many hidden items it passed. Absent until the first such step.
		 */
		unpublishedProgress: v.optional(v.object({ completed: v.number(), skipped: v.number(), blocked: v.number() })),
	})
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),
	// #endregion files write policy runs

	// #region files archive runs
	/**
	 * One archive or restore that is too big for one mutation. Each step changes a batch of nodes and
	 * their side docs together. The Activity keeps the membership, the status, and the progress.
	 */
	files_archive_runs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		kind: v.union(v.literal("archive"), v.literal("restore")),
		/**
		 * Archive: the operation id this job writes. Restore: the operation id this job brings back.
		 */
		archiveOperationId: v.string(),
		/**
		 * Archive: the named items. The job stamps them first. Restore: the items that land at the workspace root
		 * because their parent was archived by another operation when the check ran.
		 */
		rootNodeIds: v.array(v.id("files_nodes")),
		/**
		 * Restore discovers every top root before checking overlaps. `check` walks everything before
		 * `apply` changes the nodes.
		 */
		phase: v.union(v.literal("discover"), v.literal("check"), v.literal("apply")),
		/**
		 * Where the walk goes on. During restore discovery, `treePath` holds the page cursor.
		 * During check it holds the last tree path. It is "" at the start of either walk.
		 */
		checkCursor: v.object({ rootIndex: v.number(), treePath: v.string() }),
		/**
		 * Restore discovery: at most 64 paths that hold every top item found so far. The op gets them for
		 * its overlap checks when discovery ends.
		 */
		discoverTreePaths: v.array(v.string()),
		/**
		 * Archive: how many named items the apply phase has handled. The walk inside them starts only
		 * after all of them left the tree.
		 */
		applyRootIndex: v.number(),
		/**
		 * False once the Activity finished. The busy checks read only active runs.
		 */
		active: v.boolean(),
		/**
		 * Restore: items the person chose to skip stay archived under this new operation id.
		 */
		skipOperationId: v.union(v.string(), v.null()),
		/**
		 * Restore: the name clash the job waits on. `revision` changes with every new clash.
		 */
		conflict: v.union(v.object({ nodeId: v.id("files_nodes"), occupantId: v.id("files_nodes") }), v.null()),
		choice: v.union(
			v.object({
				nodeId: v.id("files_nodes"),
				occupantId: v.id("files_nodes"),
				choice: v.union(v.literal("keep_both"), v.literal("skip"), v.literal("replace")),
			}),
			v.null(),
		),
		applyToRemaining: v.object({
			file: v.union(v.null(), v.literal("keep_both"), v.literal("skip"), v.literal("replace")),
			folder: v.union(v.null(), v.literal("keep_both"), v.literal("skip")),
		}),
		revision: v.number(),
		/**
		 * Accepting an agent's delete. Each step removes the person's own proposals on the nodes it
		 * archives. `reviewedPendingUpdateIds` is the review selection when a review job started it.
		 */
		pendingUpdateCleanup: v.union(
			v.object({ reviewedPendingUpdateIds: v.union(v.array(v.id("files_pending_updates")), v.null()) }),
			v.null(),
		),
		/**
		 * Restore: the id of the first job of the same Unarchive request, so Cancel can end them all.
		 * Each job waits for the job before it. Null on the first job and on archive jobs.
		 */
		requestFirstRunId: v.union(v.id("files_archive_runs"), v.null()),
		/**
		 * Archive: the named item the check is on. A refusal found inside it sets `discovered` back to
		 * `discoveredBefore` plus one, so the refused item counts once with nothing inside it.
		 */
		checkNamedItem: v.union(
			v.object({ nodeId: v.id("files_nodes"), discoveredBefore: v.number(), isRefused: v.boolean() }),
			v.null(),
		),
		/**
		 * Archive: the named items the job leaves out, with everything inside them, and why. Like `rm`,
		 * the job archives the other named items. At most one per named item, so at most 500.
		 */
		refusedItems: v.array(
			v.object({
				nodeId: v.id("files_nodes"),
				refusal: v.object({ name: v.union(v.string(), v.null()), message: v.string() }),
			}),
		),
	})
		.index("by_organization_workspace_active_kind", ["organizationId", "workspaceId", "active", "kind"])
		.index("by_requestFirstRun_active", ["requestFirstRunId", "active"])
		.index("by_organization_workspace_archiveOperation_active", [
			"organizationId",
			"workspaceId",
			"archiveOperationId",
			"active",
		])
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),
	// #endregion files archive runs

	// #region files subtree ops
	/**
	 * One change to a folder and everything inside it that goes on after the request: move, archive,
	 * restore, restrict, or copy. The request writes what people must see now, like the moved folder
	 * itself. Steps then fix the stored copies inside, like each child's `path`.
	 *
	 * Every new op reads the ops of its workspace to find overlaps. So a step never writes this doc.
	 * Step state lives on `files_subtree_op_walks`, `files_subtree_op_nodes`, and the kind's run doc.
	 * The last step deletes the op.
	 */
	files_subtree_ops: defineTable(
		v.union(
			v.object({
				...files_subtree_op_shared_fields,
				kind: v.literal("move"),
				/**
				 * The `treePath` of each root before the move. Children keep it until a step rewrites them,
				 * so the op is busy on these paths too.
				 */
				oldTreePaths: v.array(v.string()),
			}),
			v.object({
				...files_subtree_op_shared_fields,
				kind: v.union(v.literal("archive"), v.literal("restore")),
				archiveRunId: v.id("files_archive_runs"),
			}),
			v.object({ ...files_subtree_op_shared_fields, kind: v.literal("scope") }),
			v.object({
				...files_subtree_op_shared_fields,
				kind: v.literal("copy"),
				transferRunId: v.id("files_transfer_runs"),
				/**
				 * The copy reads these folders, so a change inside them waits too.
				 */
				sourceTreePaths: v.array(v.string()),
			}),
		),
	)
		.index("by_organization_workspace_kind", ["organizationId", "workspaceId", "kind"])
		.index("by_blockedByOp", ["blockedByOpId"])
		.index("by_archiveRun", ["archiveRunId"])
		.index("by_transferRun", ["transferRunId"])
		.index("by_user", ["userId"]),

	/**
	 * The step state of one op. Only steps write it, so a step does not conflict with a new op.
	 */
	files_subtree_op_walks: defineTable({
		opId: v.id("files_subtree_ops"),
		/**
		 * Each scheduled step carries this number, and a step runs only when the numbers match. So a
		 * step that recover scheduled again does nothing when the old one ran after all.
		 */
		step: v.number(),
		/**
		 * A walk is done only after one full pass writes nothing. A child that got a name before the
		 * cursor during a pass is then still found.
		 */
		passWrote: v.boolean(),
		/**
		 * The next free `sequence` for the op's queue rows.
		 */
		sequence: v.number(),
		updatedAt: v.number(),
	}).index("by_op", ["opId"]),

	/**
	 * The nodes an op still has to walk. The step takes the row with the highest `sequence` first. The
	 * folders found on one page get the next numbers, the first folder the highest. So the walk goes
	 * into the first folder of a page before its siblings, and the queue holds about one page per level.
	 *
	 * While `nodeDone` is false, the step first handles the node itself: the archive check checks a named
	 * item, and the restore lands a top item. Then it walks the node's children in the order of the
	 * `by_organization_workspace_parent_name` index.
	 */
	files_subtree_op_nodes: defineTable({
		opId: v.id("files_subtree_ops"),
		sequence: v.number(),
		nodeId: v.id("files_nodes"),
		nodeDone: v.boolean(),
		/**
		 * Where the next page of children starts. Null starts from the first child. `after` starts
		 * after the child with this name and creation time. `tie` pages through the children that share
		 * one name and one creation time, because only `pageCursor` can tell them apart.
		 */
		cursor: v.union(
			v.null(),
			v.object({ mode: v.literal("after"), name: v.string(), creationTime: v.number() }),
			v.object({
				mode: v.literal("tie"),
				name: v.string(),
				creationTime: v.number(),
				pageCursor: v.union(v.string(), v.null()),
			}),
		),
		/**
		 * Children of the page already read that a step did not reach, at most one page. The next step
		 * takes them first, before it reads the next page.
		 */
		pending: v.array(v.id("files_nodes")),
	}).index("by_op_sequence", ["opId", "sequence"]),
	// #endregion files subtree ops

	// #region plugins core
	plugins_publisher_repositories: defineTable({
		ownerUserId: v.id("users"),
		repositoryUrl: v.string(),
		owner: v.string(),
		repo: v.string(),
		/**
		 * Last publish_version outcome after authorization. It outlives the toast, so first-publish
		 * rejections stay visible.
		 */
		lastPublishAttempt: v.optional(
			v.object({
				at: v.number(),
				/**
				 * Plugin read from the validated manifest. Null when publishing failed before that point.
				 */
				pluginName: v.union(v.string(), v.null()),
				status: v.union(v.literal("succeeded"), v.literal("rejected"), v.literal("flagged"), v.literal("failed")),
				message: v.string(),
				commitSha: v.union(v.string(), v.null()),
				/**
				 * The build this attempt was about. Null before the manifest could be read and hashed.
				 */
				artifactHash: v.union(v.string(), v.null()),
				/**
				 * The review that decided this attempt. Set only when a review reached a verdict, so an
				 * operational failure — provider, budget, or source-fetch — leaves it null and cannot be
				 * mistaken for a verdict nobody produced.
				 */
				reviewId: v.union(v.id("plugins_version_reviews"), v.null()),
			}),
		),
	})
		.index("by_ownerUser_repositoryUrl", ["ownerUserId", "repositoryUrl"])
		.index("by_repositoryUrl", ["repositoryUrl"])
		.index("by_lastPublishAttempt_pluginName", ["lastPublishAttempt.pluginName"])
		.index("by_lastPublishAttempt_reviewId", ["lastPublishAttempt.reviewId"]),

	/**
	 * Publisher secrets scoped to one claimed repository. Runtime resolution also matches the
	 * claim owner to the immutable version creator, so a later claimant cannot supply secrets.
	 */
	plugins_publisher_repository_secrets: defineTable({
		ownerUserId: v.id("users"),
		repositoryId: v.id("plugins_publisher_repositories"),
		name: v.string(),
		ciphertext: v.bytes(),
		nonce: v.bytes(),
		valuePreview: v.string(),
		updatedAt: v.number(),
		lastUsedAt: v.optional(v.number()),
	})
		.index("by_repository_name", ["repositoryId", "name"])
		.index("by_ownerUser", ["ownerUserId"]),

	plugins_versions: defineTable({
		name: v.string(),
		displayName: v.string(),
		version: v.string(),
		description: v.string(),
		reviewStatus: v.union(v.literal("pending"), v.literal("passed"), v.literal("rejected"), v.literal("flagged")),
		/**
		 * The review that decided this version. Null only for a version that has not reached review.
		 */
		reviewId: v.union(v.id("plugins_version_reviews"), v.null()),
		/**
		 * True only on the version that most recently became ready for this name.
		 * Ready order stands in for version order.
		 **/
		isLatest: v.boolean(),
		artifactHash: v.string(),
		sourceRepositoryUrl: v.string(),
		sourceOwner: v.string(),
		sourceRepo: v.string(),
		sourceCommitSha: v.string(),
		manifestR2Key: v.string(),
		/**
		 * Pointer to the executable dist among `files`,
		 * plus Worker isolate config;
		 * null = no server-side code.
		 **/
		backendEntrypointFile: v.union(
			v.object({
				entry: v.string(),
				moduleName: v.string(),
				r2Key: v.string(),
				sha256: v.string(),
				compatibilityDate: v.string(),
				compatibilityFlags: v.array(v.string()),
			}),
			v.null(),
		),
		/**
		 * The plugin-owned YAML editor shown for each installation. Null means the plugin has no settings.
		 */
		configuration: v.union(
			v.object({
				description: v.string(),
				defaultYaml: v.string(),
			}),
			v.null(),
		),
		/**
		 * Mount folders declared by this version.
		 */
		mounts: v.array(
			v.object({
				id: v.string(),
				description: v.string(),
				configurationPath: v.array(v.string()),
			}),
		),
		/**
		 * Secret names the manifest declares, so the details page can report which required
		 * secrets are still missing. Optional because versions published before this field
		 * exist without it; read as `version.secrets ?? []`.
		 */
		secrets: v.optional(
			v.array(
				v.object({
					name: v.string(),
					description: v.string(),
					optional: v.boolean(),
				}),
			),
		),
		events: v.array(
			v.object({
				type: v.union(
					v.literal("files.upload.completed"),
					v.literal("users.account.deleted"),
					v.literal("schedule.interval.elapsed"),
				),
				// Empty for an event that carries no file. The manifest validator decides which events
				// may leave it empty.
				contentTypes: v.array(v.string()),
				filters: v.array(
					v.object({
						field: v.literal("source.path"),
						operator: v.literal("pathIsUnderAny"),
						configurationPath: v.array(v.string()),
					}),
				),
				schedule: v.optional(v.object({ configurationPath: v.array(v.string()) })),
			}),
		),
		/**
		 * UI pages declared in the manifest. An empty array means this version has no frontend page.
		 */
		pages: v.array(
			v.object({
				id: v.string(),
				title: v.string(),
				entry: v.string(),
				navItem: v.union(v.object({ label: v.string(), icon: v.union(v.string(), v.null()) }), v.null()),
			}),
		),
		/**
		 * File views declared in the manifest. An empty array means this version opens no file content types.
		 */
		fileViews: v.array(
			v.object({
				id: v.string(),
				title: v.string(),
				entry: v.string(),
				contentTypes: v.array(v.string()),
			}),
		),
		/**
		 * Backend endpoints the invoke door may run, normalized to `[]` when the manifest declares
		 * none. `serialization` is normalized to `"installation"` when the manifest omits it.
		 *
		 * Every stored version has been backfilled. The field stays optional on purpose: a reader
		 * treats an absent value as "no endpoint restriction", which is the safe direction, and
		 * tightening the validator would reject any version written by an older publish path.
		 */
		endpoints: v.optional(
			v.array(
				v.object({
					id: v.string(),
					path: v.string(),
					serialization: v.union(v.literal("installation"), v.literal("caller-key")),
				}),
			),
		),
		/**
		 * The collections a member-identity writer may write. Null means the manifest declared no
		 * list, so every collection stays user-writable; `[]` means nothing is.
		 *
		 * Every stored version has been backfilled. The field stays optional on purpose: readers
		 * treat absent the same as null, which is the documented "no list declared" case.
		 */
		userWritableCollections: v.optional(v.union(v.array(v.string()), v.null())),
		capabilities: v.array(plugins_capability_validator),
		/**
		 * Exact https origins the plugin's code declares it calls; consented at install.
		 **/
		outboundOrigins: v.array(v.string()),
		/**
		 * Exact https origins the plugin's pages and file views may call from the browser; consented at install.
		 *
		 * The asset response builds its `connect-src` from this list, and an asset request carries only
		 * a plugin version and a path. So this has to live on the immutable version: the response cannot
		 * know which installation is looking at it.
		 */
		uiOutboundOrigins: v.array(v.string()),
		/**
		 * Remote MCP servers from the manifest, stored as declared. Each header value is the value of the
		 * named secret. An empty array means the chat agent gets no tools from this plugin.
		 */
		mcpServers: v.array(
			v.object({
				id: v.string(),
				title: v.string(),
				transport: v.literal("http"),
				url: v.string(),
				headers: v.array(v.object({ name: v.string(), secret: v.string() })),
				auth: v.union(
					v.object({ kind: v.literal("none") }),
					v.object({ kind: v.literal("secret_headers") }),
					v.object({
						kind: v.literal("oauth"),
						issuer: v.string(),
						resource: v.union(v.string(), v.null()),
						scopes: v.array(v.string()),
					}),
				),
				/**
				 * The tools the agent may call. Null means every tool the server lists.
				 */
				tools: v.union(v.array(v.string()), v.null()),
			}),
		),
		/**
		 * SHA-256 of `mcpServers`, computed once at publish. Install compares it with the value the
		 * member accepted, so any server change needs a new accept.
		 */
		mcpServersFingerprint: v.string(),
		/**
		 * Skills listed in the chat skill catalog. `description` comes from the skill's frontmatter,
		 * which the publish checked.
		 */
		skills: v.array(v.object({ name: v.string(), path: v.string(), description: v.string() })),
		files: v.array(
			v.object({
				path: v.string(),
				sha256: v.string(),
				bytes: v.number(),
				contentType: v.string(),
				r2Key: v.string(),
			}),
		),
		/** Publication visibility for the `/<pluginVersionId>/...` source tree in GLOBAL/PLUGINS. */
		sourceStatus: v.union(v.literal("preparing"), v.literal("failed"), v.literal("ready")),
		sourceLastError: v.union(v.string(), v.null()),
		createdBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_isLatest_name", ["isLatest", "name"])
		.index("by_name", ["name"])
		.index("by_name_reviewStatus_sourceStatus", ["name", "reviewStatus", "sourceStatus"])
		.index("by_name_sourceStatus", ["name", "sourceStatus"])
		.index("by_name_sourceStatus_updatedAt", ["name", "sourceStatus", "updatedAt"])
		.index("by_name_version", ["name", "version"])
		.index("by_name_version_artifactHash", ["name", "version", "artifactHash"])
		.index("by_reviewId", ["reviewId"])
		.index("by_reviewId_sourceStatus", ["reviewId", "sourceStatus"])
		.index("by_sourceRepositoryUrl", ["sourceRepositoryUrl"])
		.index("by_sourceRepositoryUrl_createdBy_sourceStatus", ["sourceRepositoryUrl", "createdBy", "sourceStatus"])
		.index("by_sourceRepositoryUrl_createdBy_sourceStatus_updatedAt", [
			"sourceRepositoryUrl",
			"createdBy",
			"sourceStatus",
			"updatedAt",
		]),

	plugins_version_reviews: defineTable({
		/**
		 * Null after the creator is deleted while a registered version still points at this review.
		 */
		createdBy: v.union(v.id("users"), v.null()),
		/**
		 * The exact build this verdict was first produced for. Kept for release traceability only. It is
		 * no longer what the cache is keyed on, because it changes with the version number, and a
		 * release that only bumps the version reviews identical content.
		 */
		artifactHash: v.string(),
		/**
		 * What was actually reviewed: every security-relevant manifest field and file hash, with the
		 * version number removed. Two releases of the same content share this value.
		 */
		reviewSubjectHash: v.string(),
		/**
		 * Which review policy produced this verdict. Reuse compares this value with `reviewSubjectHash`.
		 * The model name is not part of that check. Updating the model does not change
		 * `plugins_REVIEW_POLICY_VERSION`, so a saved pass for the same content is still reused.
		 * Bump that version when the prompts, the mechanical severities, the tool behavior, the provider
		 * options, the file classifier, or the required coverage change. Old verdicts then stop being
		 * reused instead of authorizing a publish under a policy that no longer exists.
		 */
		reviewPolicyVersion: v.string(),
		pluginName: v.string(),
		version: v.string(),
		status: v.union(v.literal("passed"), v.literal("rejected"), v.literal("flagged")),
		/**
		 * Mechanical findings that rejected this version. A non-empty array means `status: "rejected"`.
		 */
		mechanicalFindings: v.array(v.string()),
		/**
		 * Mechanical findings the publisher should see that block nothing. A normal vendored or
		 * bundled dependency trips these, so rejecting on them would fail plugins nobody can fix.
		 */
		mechanicalAdvisoryFindings: v.array(v.string()),
		aiFindings: v.array(v.string()),
		/**
		 * Which file the reviewer held responsible for each subject the manifest declares. Empty when no
		 * model ran, such as a mechanical rejection or an artifact with no reviewable text.
		 *
		 * A review only passes when every typed capability or origin subject has an entry naming a file
		 * and exact byte range the reviewer really read. Entries for secret reads and dynamic loads are
		 * kept too; the host cannot require them because it learns about them only from plugin code.
		 */
		capabilityMap: v.array(
			v.object({
				subject: v.string(),
				path: v.string(),
				evidence: v.string(),
				startByte: v.number(),
				endByte: v.number(),
			}),
		),
		/**
		 * Which model ran this review. This is a record only. Reuse does not read it.
		 */
		model: v.string(),
		/**
		 * Artifact hash of the previous passed
		 * version when the AI review was diff-based.
		 **/
		diffBaseArtifactHash: v.optional(v.string()),
		/**
		 * Time the first terminal verdict for this exact artifact was stored.
		 **/
		updatedAt: v.number(),
	})
		.index("by_reviewSubjectHash_reviewPolicyVersion", ["reviewSubjectHash", "reviewPolicyVersion"])
		.index("by_createdBy_pluginName", ["createdBy", "pluginName"])
		.index("by_pluginName", ["pluginName"]),

	/**
	 * Durable stop sign for one plugin name while its registry docs drain in bounded passes.
	 * A failed or lost delete pass leaves the fence in place so publishing and installs stay closed.
	 */
	plugins_registry_deletion_fences: defineTable({
		pluginName: v.string(),
		createdAt: v.number(),
	}).index("by_pluginName", ["pluginName"]),

	/**
	 * A trusted plugin source keeps its account across uninstall and reinstall.
	 */
	plugins_service_account_bindings: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		pluginName: v.string(),
		publisherUserId: v.id("users"),
		sourceRepositoryUrl: v.string(),
		serviceAccountId: v.id("access_control_service_accounts"),
	})
		.index("by_organization_workspace_pluginName_publisher_source", [
			"organizationId",
			"workspaceId",
			"pluginName",
			"publisherUserId",
			"sourceRepositoryUrl",
		])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	plugins_workspace_installations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		serviceAccountId: v.id("access_control_service_accounts"),
		pluginVersionId: v.id("plugins_versions"),
		pluginName: v.string(),
		status: v.union(v.literal("enabled"), v.literal("disabled")),
		managementAccess: plugins_management_access_validator,
		// Only scheduled installations have an assigned user and their direct consent.
		scheduledRunUserId: v.optional(v.id("users")),
		scheduledRunGrantId: v.optional(v.id("access_control_permission_grants")),
		/**
		 * User-edited installation settings shown in the plugin configuration editor.
		 * Null means the installed version does not declare configuration.
		 */
		configurationYaml: v.union(v.string(), v.null()),
		acceptedCapabilities: v.array(plugins_capability_validator),
		capabilitiesAcceptedAt: v.number(),
		acceptedOutboundOrigins: v.array(v.string()),
		outboundOriginsAcceptedAt: v.number(),
		/**
		 * The page origins this workspace agreed to. Nothing reads this to decide a request: the page's
		 * `connect-src` comes from the version. It is the record of what the install dialog showed, so
		 * an audit after an upgrade can still say what the workspace agreed to before it.
		 */
		acceptedUiOutboundOrigins: v.array(v.string()),
		/**
		 * The version's `mcpServersFingerprint` the install dialog showed. Install refuses any other
		 * value, so a changed server list always needs a new accept.
		 */
		acceptedMcpServersFingerprint: v.string(),
		/**
		 * The skill names the install dialog showed.
		 */
		acceptedSkillNames: v.array(v.string()),
		installedBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_status_updatedAt", ["organizationId", "workspaceId", "status", "updatedAt"])
		.index("by_organization_workspace_status_pluginName", ["organizationId", "workspaceId", "status", "pluginName"])
		.index("by_organization_workspace_pluginName", ["organizationId", "workspaceId", "pluginName"])
		.index("by_organization_workspace_pluginVersion", ["organizationId", "workspaceId", "pluginVersionId"])
		.index("by_pluginVersion", ["pluginVersionId"])
		.index("by_pluginName_status", ["pluginName", "status"])
		.index("by_pluginName", ["pluginName"]),

	plugins_mounts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		mountId: v.string(),
		name: v.string(),
	})
		.index("by_organization_workspace_name", ["organizationId", "workspaceId", "name"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"])
		.index("by_installation_mountId", ["installationId", "mountId"]),

	// File storage uses the volume id as its scope. Its owner is always a real workspace.
	plugins_volumes: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		mountId: v.string(),
		volumeKey: v.string(),
		publishedGenerationId: v.union(v.id("plugins_volume_generations"), v.null()),
		createdAt: v.number(),
		deleteRequestedAt: v.union(v.number(), v.null()),
		drainScheduledUntil: v.union(v.number(), v.null()),
	})
		.index("by_installation_mountId_volumeKey", ["installationId", "mountId", "volumeKey"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"])
		.index("by_drainScheduledUntil", ["drainScheduledUntil"]),

	plugins_volume_generations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		volumeId: v.id("plugins_volumes"),
		status: v.union(v.literal("staging"), v.literal("published"), v.literal("retired")),
		revision: v.string(),
		fileCount: v.number(),
		bytes: v.number(),
		createdAt: v.number(),
		lastWriteAt: v.number(),
		publishedAt: v.union(v.number(), v.null()),
		expiresAt: v.union(v.number(), v.null()),
		drainScheduledUntil: v.union(v.number(), v.null()),
	})
		.index("by_volume_status", ["volumeId", "status"])
		.index("by_status_expiresAt", ["status", "expiresAt"])
		.index("by_status_drainScheduledUntil", ["status", "drainScheduledUntil"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	plugins_volume_usage: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		fileCount: v.number(),
		bytes: v.number(),
	}).index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	plugins_workspace_installation_secrets: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		name: v.string(),
		ciphertext: v.bytes(),
		nonce: v.bytes(),
		valuePreview: v.string(),
		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	})
		.index("by_installation_name", ["installationId", "name"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * One doc per publish, created before the publish uploads anything: it lists the keys the
	 * publish is about to write, and a cleanup run is scheduled together with it. A successful
	 * publish removes it after registering the version. A doc still here past `cleanupAt` means
	 * the publish was interrupted: cleanup deletes its keys in bounded batches, keeping any key a
	 * registered `(name, version, artifactHash)` version owns.
	 */
	plugins_publish_artifact_cleanup_attempts: defineTable({
		repositoryId: v.id("plugins_publisher_repositories"),
		pluginName: v.string(),
		version: v.string(),
		artifactHash: v.string(),
		/** Fresh id embedded in every key, making one attempt's uploads impossible to share or delete from another. */
		uploadId: v.string(),
		/** At most 65 object keys: 64 manifest-capped files plus dist/bonobo.plugin.json. */
		r2Keys: v.array(v.string()),
		/** Cleanup never runs before this deadline, giving the owning publish action time to finish. */
		cleanupAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_cleanupAt", ["cleanupAt"])
		.index("by_repository_cleanupAt", ["repositoryId", "cleanupAt"])
		.index("by_pluginName_cleanupAt", ["pluginName", "cleanupAt"])
		.index("by_pluginName", ["pluginName"]),
	// #endregion plugins core

	// #region plugins runtime
	plugins_workspace_event_handlers: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		pluginName: v.string(),
		event: v.union(
			v.literal("files.upload.completed"),
			v.literal("users.account.deleted"),
			v.literal("schedule.interval.elapsed"),
		),
		/**
		 * Absent for an event that carries no file. It stays an equality component of the dispatch
		 * index: Convex indexes a missing field as `undefined`, so such an event is dispatched with
		 * `.eq("contentType", undefined)` and still reads one range instead of scanning.
		 */
		contentType: v.optional(v.string()),
		/** The owning installation's `_creationTime`, denormalized for dispatch order in the scope index. */
		installationCreatedAt: v.number(),
		updatedAt: v.number(),
		// Only the schedule handler has a due time.
		nextRunAt: v.optional(v.number()),
	})
		.index("by_scope_event_contentType_createdAt_name", [
			"organizationId",
			"workspaceId",
			"event",
			"contentType",
			"installationCreatedAt",
			"pluginName",
		])
		.index("by_event_nextRunAt", ["event", "nextRunAt"])
		.index("by_installation", ["installationId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	plugins_event_runs: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		serviceAccountId: v.id("access_control_service_accounts"),
		// The uploaded file the event fired for; plugin-written outputs are ordinary Markdown siblings.
		// Both are absent for an event that fires on something other than a file.
		assetId: v.optional(v.id("files_r2_assets")),
		fileNodeId: v.optional(v.id("files_nodes")),
		/**
		 * The uploader, invoke caller, assigned scheduled user, or deleted user.
		 */
		actorUserId: v.id("users"),
		// Scheduled runs keep the original consent and membership lifetime.
		runAsGrantId: v.optional(v.id("access_control_permission_grants")),
		runAsMembershipId: v.optional(v.id("organizations_workspaces_users")),
		runAsMembershipLifetime: v.optional(v.number()),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		event: v.union(
			v.literal("files.upload.completed"),
			v.literal("files.run.requested"),
			v.literal("users.account.deleted"),
			v.literal("ui.invoke.requested"),
			v.literal("schedule.interval.elapsed"),
		),
		eventId: v.string(),
		/**
		 * The manifest backend endpoint an invoke run targets. Only invoke runs set it.
		 */
		endpointId: v.optional(v.string()),
		/**
		 * The execution key is also stored on the Activity for its indexed busy check.
		 */
		serializationKey: v.optional(v.string()),
		scheduleIntervalMinutes: v.optional(v.number()),
		scheduleDueAt: v.optional(v.number()),
		chainRootRunId: v.optional(v.id("plugins_event_runs")),
		chainIndex: v.optional(v.number()),
		chainStartedAt: v.optional(v.number()),
		// Incoming state never requests another run. Only followUpState does that.
		chainInputState: v.optional(v.union(v.string(), v.null())),
		followUpState: v.optional(v.union(v.string(), v.null())),
		workId: v.optional(vWorkId),
		apiTokenHash: v.optional(v.string()),
		apiTokenExpiresAt: v.optional(v.number()),
		acceptedCapabilities: v.array(plugins_capability_validator),
		apiCallCount: v.number(),
		outputWriteCount: v.number(),
		runnerHttpStatus: v.optional(v.number()),
		runnerElapsedMs: v.optional(v.number()),
		pluginStatus: v.optional(v.number()),
		runnerOutputBytes: v.optional(v.number()),
		runnerOutputTruncated: v.optional(v.boolean()),
	})
		.index("by_asset_event_installation", ["assetId", "event", "installationId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_work", ["workId"])
		.index("by_apiTokenHash", ["apiTokenHash"])
		.index("by_pluginVersion", ["pluginVersionId"]),

	/**
	 * Per-run call ledger: one doc per consumed quota slot, whether a host API request or an
	 * outbound fetch. Stores only curated telemetry (route, status, byte counts, timing). Never
	 * store request or response bodies, bearer tokens, signed URLs, secret values, or raw
	 * provider/library errors.
	 */
	plugins_event_run_calls: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		runId: v.id("plugins_event_runs"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		sequence: v.number(),
		kind: v.union(v.literal("api_request"), v.literal("outbound_fetch")),
		/**
		 * Public API route for `api_request`. The literal "outbound" for `outbound_fetch`.
		 */
		route: v.string(),
		status: v.union(v.literal("started"), v.literal("succeeded"), v.literal("failed")),
		responseStatus: v.optional(v.number()),
		requestBytes: v.optional(v.number()),
		responseBytes: v.optional(v.number()),
		errorCode: v.optional(v.string()),
		errorMessage: v.union(v.string(), v.null()),
		startedAt: v.number(),
		finishedAt: v.optional(v.number()),
		elapsedMs: v.optional(v.number()),
		updatedAt: v.number(),
	})
		.index("by_run_sequence", ["runId", "sequence"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_installation", ["installationId"])
		.index("by_pluginVersion", ["pluginVersionId"]),

	/**
	 * Short-lived plugin-UI bearer sessions (`plu_` tokens, stored hashed). Every call rechecks
	 * that the installation is still enabled on the same version and that the minting user is
	 * still a member, so disabling, uninstalling, or upgrading revokes outstanding tokens on its
	 * own.
	 */
	plugins_ui_sessions: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		serviceAccountId: v.id("access_control_service_accounts"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		userId: v.id("users"),
		/**
		 * Set only for file-view sessions. It holds the file node the view was opened for. Page
		 * sessions leave it unset.
		 */
		fileNodeId: v.optional(v.id("files_nodes")),
		/**
		 * Set only for file-view sessions: the view the session was minted for. A refresh checks
		 * the view against the node's current content type, so a file whose type changed stops
		 * refreshing a view that no longer matches it.
		 */
		fileViewId: v.optional(v.string()),
		tokenHash: v.string(),
		createdAt: v.number(),
		expiresAt: v.number(),
		/**
		 * The scheduled job that deletes this doc at `expiresAt`. The deletion is what ends live
		 * plugin subscriptions, because Convex reruns queries on writes, not on wall clock. Refresh
		 * cancels this job and schedules a new one for the new expiry.
		 */
		expiryJobId: v.optional(v.id("_scheduled_functions")),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_installation", ["installationId"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"]),
	// #endregion plugins runtime

	// #region plugins data
	/**
	 * Plugin-owned document store. A plugin keeps its structured data here instead of adding tables
	 * to the core app schema, the same way installation configuration keeps plugin settings out of
	 * it. One doc is one document: an installation, a collection inside that installation, and a key
	 * inside that collection.
	 */
	plugins_data: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		/**
		 * Denormalized from the installation so a doc states its own scope without a second read.
		 */
		pluginName: v.string(),
		collection: v.string(),
		key: v.string(),
		/**
		 * The plugin's own JSON object. The app never reads inside it, so it stays a record of
		 * unknown values like the other externally-owned payloads in this schema.
		 */
		value: v.record(v.string(), v.any()),
		/**
		 * UTF-8 byte size of the canonical JSON encoding of `value`, charged to the installation total.
		 */
		byteSize: v.number(),
		/**
		 * Grows by one on every accepted write. A `versioned` document accepts revision n only when
		 * the stored revision is n - 1, so one external producer can replay a lost response safely.
		 */
		revision: v.number(),
		/**
		 * `versioned` binds the key to `producerPrincipalKey` for good. The normal interactive routes
		 * then refuse that key, so a plugin page cannot race the producer's ordered outbox.
		 */
		writeMode: v.union(v.literal("normal"), v.literal("versioned")),
		/**
		 * Set only for `versioned`: the one service principal allowed to write this key.
		 */
		producerPrincipalKey: v.optional(v.string()),
		/**
		 * `owned` binds the doc to its `createdBy`: only that member may change or delete it through
		 * any interactive writer. `shared` docs follow the normal content.write rule.
		 */
		ownership: v.union(v.literal("shared"), v.literal("owned")),
		/**
		 * Set only by the user-write door's append: the caller's idempotency key, scoped per creator.
		 */
		userWriteRequestId: v.optional(v.string()),
		/**
		 * Digest of the append request that created this doc. A replayed append with the same digest
		 * answers with the stored key; a different digest under the same request id is refused.
		 */
		userWriteRequestFingerprint: v.optional(v.string()),
		/**
		 * Original append byte size, kept so a delete can preserve the exact lost-response answer.
		 */
		userWriteResultByteSize: v.optional(v.number()),
		createdBy: v.id("users"),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
		/**
		 * The member whose per-member share holds this document's bytes and slot. Absent means the
		 * document is charged to the installation only, which is what every row written before the
		 * per-member ceilings existed looks like. A frame door or an API key charges its writer; a
		 * plugin backend charges nobody. The field moves with the document: a frame patch by another
		 * member credits the old member and charges the new one. The generation id below decides which
		 * exact counter row receives that credit after a member leaves and later rejoins.
		 */
		chargedTo: v.optional(v.id("users")),
		/**
		 * Exact member counter generation that owns this document's share. Absent legacy docs are uncharged.
		 */
		chargedToMemberUsageId: v.optional(v.id("plugins_data_member_usage")),
		/**
		 * How many of this document's current bytes a plugin backend wrote. A backend write or patch
		 * sets it to the document's new `byteSize`; a write by a member — through a frame door or an
		 * API key — sets it to 0, because the member composed the value that is now stored. The
		 * per-member ceiling then compares `usedBytes - machineBytes`, so a backend cannot fill a
		 * member's share and lock them out, and a member cannot launder their own bytes by asking the
		 * backend to touch their keys. Absent means zero.
		 */
		machineBytes: v.optional(v.number()),
		/**
		 * The private scope this document belongs to, or absent when it is visible to the whole
		 * workspace.
		 *
		 * The writer never supplies it. The write door resolves it from the key, through the longest
		 * `plugins_data_scopes` prefix that matches, so a caller cannot put a public document inside a
		 * private range or the other way round.
		 *
		 * Optional because the field arrived on a populated table, and Convex validates every existing
		 * row against the schema at push time. Absent reads back as `undefined`, which an index matches
		 * with an ordinary equality, so an unscoped read is still an index scan and not a filter.
		 */
		scopeId: v.optional(v.string()),
	})
		.index("by_installation_collection_key", ["installationId", "collection", "key"])
		/**
		 * Reads one scope's key range, and — with `scopeId` equal to `undefined` — the unscoped part of
		 * a collection. Every read door uses it so a member sees only what they may see, with
		 * `truncated` and `incomplete` computed from that same scan. Filtering a raw read afterwards
		 * would return fewer rows than the limit while the seam markers still described the raw read.
		 */
		.index("by_installation_collection_scope_key", ["installationId", "collection", "scopeId", "key"])
		/**
		 * Reads one collection in creation order. Convex appends `_creationTime` as the final sort
		 * key, so this index needs no stored timestamp field and no backfill.
		 *
		 * It must not carry `updatedAt`: an edit and a soft delete both patch the document, so an
		 * `updatedAt` order would push a three-month-old message a member just fixed a typo in to the
		 * top of everyone's catch-up read, and would make a "Message deleted" tombstone the newest
		 * item there.
		 */
		.index("by_installation_collection", ["installationId", "collection"])
		/**
		 * The same creation-order read, one scope at a time. `scopeId` sits before the implicit
		 * `_creationTime` sort key, so an equality on it keeps creation order inside the scope — and
		 * with `undefined` it reads the unscoped half of the collection.
		 */
		.index("by_installation_collection_scope", ["installationId", "collection", "scopeId"])
		/**
		 * Invalidation feed: documents in one collection (and one scope, or the unscoped half)
		 * ordered by `updatedAt`. `watch_recent` must not use this — an edit would jump to the top
		 * of a new-messages catch-up read. `watch_changes` exists for that "what changed since X"
		 * question. Soft-delete `put`s stay in the table and move here; a physical delete does not.
		 */
		.index("by_installation_collection_scope_updatedAt", ["installationId", "collection", "scopeId", "updatedAt"])
		.index("by_installation_collection_createdBy_requestId", [
			"installationId",
			"collection",
			"createdBy",
			"userWriteRequestId",
		])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Keeps an append's exact answer after its document is deleted. Without this receipt, retrying a
	 * request whose first response was lost would recreate content that another page already deleted.
	 */
	plugins_data_append_replay_receipts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		collection: v.string(),
		createdBy: v.id("users"),
		requestId: v.string(),
		requestFingerprint: v.string(),
		result: v.object({ key: v.string(), revision: v.number(), byteSize: v.number() }),
		/**
		 * The exact member counter row whose held slot this receipt owns.
		 */
		memberUsageId: v.optional(v.id("plugins_data_member_usage")),
		expiresAt: v.number(),
	})
		.index("by_installation_collection_createdBy_requestId", ["installationId", "collection", "createdBy", "requestId"])
		.index("by_createdBy", ["createdBy"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * One accounting doc per installation. The store has a byte ceiling and a slot ceiling, and
	 * neither can be answered by counting docs at write time, so the owning mutation keeps these
	 * counters in the same transaction as the document it changes. That makes this a hot doc:
	 * concurrent writes to one installation can lose an optimistic-concurrency race and retry.
	 */
	plugins_data_usage: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		/**
		 * Sum of `plugins_data.byteSize` for this installation.
		 */
		usedBytes: v.number(),
		/**
		 * Bytes promised to live reservations that no stored value has claimed yet.
		 */
		reservedBytes: v.number(),
		/**
		 * Live documents. A deleted append moves its slot to `tombstoneDocuments`.
		 */
		usedDocuments: v.number(),
		reservedDocuments: v.number(),
		/**
		 * Released reservations, revision tombstones, and deleted-append receipts inside their retry horizon.
		 */
		tombstoneDocuments: v.number(),
		/**
		 * Every collection that currently holds a document or a live reservation. It is bounded by the
		 * collection limit, so the 16-collection rule can be enforced without scanning the store.
		 */
		collectionNames: v.array(v.string()),
		updatedAt: v.number(),
	})
		.index("by_installation", ["installationId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * One accounting doc per member per installation. The installation-wide ceilings above cannot
	 * stop one member from filling the whole store, so an interactive write is also charged to a
	 * share of the installation's capacity. A row exists only while that member holds something: the
	 * credit path deletes it once every counter reaches zero, so a departed member leaves nothing.
	 *
	 * This is a second document in every accepted interactive write's transaction, which costs
	 * contention on top of the installation accounting doc. The alternative — a per-member map on
	 * that doc — wedges the installation once the map grows past what one document may hold, and
	 * cannot be ranged for a membership prune. The contention is the price of both.
	 */
	plugins_data_member_usage: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		userId: v.id("users"),
		/**
		 * Present on rows whose documents point back to this exact counter generation.
		 */
		generation: v.optional(v.literal("document_bound")),
		/**
		 * Sum of `plugins_data.byteSize` for the documents charged to this member.
		 */
		usedBytes: v.number(),
		/**
		 * Live documents plus deleted-append receipts charged to this member.
		 */
		usedDocuments: v.number(),
		/**
		 * Sum of `plugins_data.machineBytes` over the same documents. The member ceiling compares
		 * `usedBytes - machineBytes`, so bytes a plugin backend wrote never count against the member.
		 */
		machineBytes: v.number(),
		/**
		 * Every collection this member created that still exists. It is bounded by the installation's
		 * own collection limit, so the per-member collection share can be enforced without a scan.
		 * When the installation drops an empty collection, the name is removed from every member row.
		 */
		collectionNames: v.array(v.string()),
	})
		// The write path. `check_capacity` runs inside every accepted write, so this must resolve
		// exactly one document rather than range over the installation's members.
		.index("by_installation_user", ["installationId", "userId"])
		// Account deletion. `db_finalize_deleted_user` knows only the user id.
		.index("by_user", ["userId"])
		// The uninstall drain.
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"])
		// The membership prune. Removing a member from an organization removes them from every
		// workspace in it, so the prune runs once per membership and never per installation.
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"]),

	/**
	 * Capacity held for one exact document before an external side effect happens. A service that is
	 * about to create something it cannot take back reserves first, so a full store cannot refuse the
	 * write afterwards. The reservation also survives a lost HTTP response: an exact replay of the
	 * same idempotency key is answered from this row instead of reserving twice.
	 */
	plugins_data_reservations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		collection: v.string(),
		key: v.string(),
		/**
		 * The service principal that owns this reservation. It survives token rotation.
		 */
		ownerPrincipalKey: v.string(),
		maximumBytes: v.number(),
		/**
		 * Bytes still held. Storing or growing the value moves the delta from here into `usedBytes`.
		 */
		remainingBytes: v.number(),
		/**
		 * `released` keeps the doc as a retry record until `retryHorizonExpiresAt`.
		 */
		state: v.union(v.literal("live"), v.literal("released")),
		/**
		 * Unique per installation and principal. It is what makes a replay recognizable.
		 */
		idempotencyKey: v.string(),
		/**
		 * The canonical encoding of the reserve request, compared as a whole string. A replay with
		 * different fields is refused, not reserved. It is not a hash and nothing secret is in it.
		 */
		requestFingerprint: v.string(),
		/**
		 * Set when the reservation is released, and frozen so a replayed release answers the same
		 * thing twice. A reserve has no such field on purpose: a replayed reserve is answered from the
		 * live row, because an ordered write spends part of the reservation and a frozen number would
		 * promise bytes that are already gone.
		 */
		releaseResult: v.optional(
			v.object({
				releasedBytes: v.number(),
			}),
		),
		/**
		 * True only while this released retry doc owns one `tombstoneDocuments` slot.
		 */
		holdsUsageTombstoneSlot: v.boolean(),
		releasedAt: v.optional(v.number()),
		/**
		 * A live reservation past this time is released by the expiry cron.
		 */
		expiresAt: v.number(),
		/**
		 * After this time the released retry record is deleted and its slot returns.
		 */
		retryHorizonExpiresAt: v.number(),
		updatedAt: v.number(),
	})
		// `state` sits before the collection so a lookup asks the index for the one live reservation.
		// One key collects a released retry record per reserve, and they stay for a day after the
		// reservation expires, so a query that read the key's docs and filtered afterwards would have to
		// read past all of them. Past enough of them it would stop before the live one and miss it.
		.index("by_installation_state_collection_key", ["installationId", "state", "collection", "key"])
		.index("by_installation_state_collection_key_owner_holds_slot", [
			"installationId",
			"state",
			"collection",
			"key",
			"ownerPrincipalKey",
			"holdsUsageTombstoneSlot",
		])
		.index("by_installation_principal_idempotencyKey", ["installationId", "ownerPrincipalKey", "idempotencyKey"])
		// `state` comes first so the expiry cron reads only live docs. Without it, a workspace holding
		// many released retry records would fill every batch with docs that need nothing, and the live
		// ones behind them would never be reached.
		.index("by_state_expiresAt", ["state", "expiresAt"])
		.index("by_retryHorizonExpiresAt", ["retryHorizonExpiresAt"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Marks a key its producer deleted for good. The value doc is physically gone and its bytes are
	 * already back, so reads and lists treat the key as absent. The tombstone exists only to refuse
	 * writes the producer sent before the delete and that arrive after it, until its retry horizon.
	 */
	plugins_data_revision_tombstones: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		pluginName: v.string(),
		collection: v.string(),
		key: v.string(),
		/**
		 * The delete's revision. Every lower revision and every later write is refused.
		 */
		revision: v.number(),
		producerPrincipalKey: v.string(),
		deletedAt: v.number(),
		expiresAt: v.number(),
	})
		.index("by_installation_collection_key", ["installationId", "collection", "key"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * A private range inside one installation's data store: a private channel, or a direct message.
	 *
	 * The scope binds one key prefix across one or more collections, one row per collection. Every
	 * document written under that prefix carries the scope id, and only a member the scope names may
	 * read or write there. The binding lives on the server because the write door has to resolve a
	 * scope from the key alone — a caller that could name its own scope could put a private document
	 * in a public range, or the reverse.
	 *
	 * One scope spans collections because a private area is never one collection. A private channel
	 * keeps its name, its messages, its thread replies and its reactions in four of them, all under
	 * the channel's key. One scope per collection would work, but it would cost the member four
	 * scopes against their cap for one channel, and a scope they held on three of the four would
	 * leak the fourth.
	 *
	 * Who may read it is not stored here. It is stored as ordinary permission grants on
	 * `access_control_permission_grants`, with `resourceKind: "plugin_scope"` and
	 * `resourceId: "<installationId>:<scopeId>"`. Removing a member revokes those grants in the same
	 * transaction, then schedules bounded cleanup for any scope whose last grant disappeared.
	 */
	plugins_data_scopes: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		/**
		 * Minted by the plugin, unique inside one installation.
		 */
		scopeId: v.string(),
		collection: v.string(),
		keyPrefix: v.string(),
		/**
		 * The member who created the scope. They receive the first `manage` grant on it.
		 */
		createdByUserId: v.id("users"),
		createdAt: v.number(),
		/**
		 * Durable last accepted append in this collection. Optional while old rows are backfilled.
		 */
		lastAppend: v.optional(
			v.union(v.null(), v.object({ at: v.number(), key: v.string(), createdByUserId: v.id("users") })),
		),
		/**
		 * Count accepted appends in this collection. Optional while old rows are backfilled.
		 */
		appendSequence: v.optional(v.number()),
		/**
		 * Shared by every row of one scope. Increase it for each accepted membership change.
		 */
		updatedAt: v.number(),
	})
		.index("by_installation_scope", ["installationId", "scopeId"])
		// Resolves a write's key to its scope. Read `keyPrefix` downwards from the key and stop at the
		// first row the key starts with: that row is the longest matching prefix.
		.index("by_installation_collection_prefix", ["installationId", "collection", "keyPrefix"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Durable private-scope lifecycle records. One row whose `collectionName` and `keyPrefix` are both
	 * empty reserves each scope id for this installation's lifetime. Creation stops at 1,000 identity
	 * rows, so these durable records stay bounded. Real collection names and key prefixes cannot be
	 * empty, so that identity row can never fence a write.
	 *
	 * Other rows keep every released key range closed, including an empty scope: an old frame may
	 * still send private data after deletion, and that write must not become public. Scope creation
	 * refuses parent or child overlap with those real range rows, so the greatest-prefix lookup stays
	 * exact.
	 */
	plugins_data_released_scope_ranges: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		scopeId: v.string(),
		collectionName: v.string(),
		keyPrefix: v.string(),
	})
		.index("by_installation_scope", ["installationId", "scopeId"])
		.index("by_installation_collection_prefix", ["installationId", "collectionName", "keyPrefix"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * One doc binds a file or folder's reader list to a plugin-data scope. The host keeps
	 * exactly one `content.read` grant per active scope member on the node, updating them in the
	 * same mutations that change the scope's membership. An actual manual sharing change removes
	 * the binding and keeps its remaining grants. At most
	 * `MAX_ACCESS_BINDINGS_PER_SCOPE` (4) nodes per scope keep that synchronous work bounded.
	 */
	plugins_file_access_bindings: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		scopeId: v.string(),
		nodeId: v.id("files_nodes"),
		updatedAt: v.number(),
	})
		.index("by_installation_scopeId", ["installationId", "scopeId"])
		.index("by_node", ["nodeId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	// #endregion plugins data

	// #region plugins services
	plugins_service_connections: defineTable({
		registrationId: v.id("plugins_service_registrations"),
		// A terminal connection may outlive the installation that held these pins.
		pluginVersionId: v.union(v.id("plugins_versions"), v.null()),
		serviceAccountId: v.union(v.id("access_control_service_accounts"), v.null()),
		installationId: v.id("plugins_workspace_installations"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		createdAt: v.number(),
	}).index("by_installation", ["installationId"]),

	/**
	 * One output folder for an external plugin resource. Pinned nodes prevent old work from
	 * adopting a moved or replaced folder. A higher generation closes every older writer.
	 */
	plugins_external_file_writers: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		resourceKey: v.string(),
		rootNodeId: v.id("files_nodes"),
		folderNodeId: v.id("files_nodes"),
		rootPath: v.string(),
		path: v.string(),
		generation: v.number(),
		updatedAt: v.number(),
	})
		.index("by_installation_resourceKey", ["installationId", "resourceKey"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Reader sync is attached until a real human sharing change takes control of this folder.
	 * Keep a detached doc so an ensure retry cannot silently attach it again.
	 */
	plugins_external_file_bindings: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		writerId: v.id("plugins_external_file_writers"),
		nodeId: v.id("files_nodes"),
		revision: v.number(),
		detachedAt: v.union(v.number(), v.null()),
		updatedAt: v.number(),
	})
		.index("by_writer", ["writerId"])
		.index("by_node", ["nodeId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Compact results commit with the file change. They hold no file text.
	 */
	plugins_external_file_receipts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		writerId: v.id("plugins_external_file_writers"),
		operationId: v.string(),
		operation: v.union(
			v.literal("write"),
			v.literal("fence"),
			v.literal("readers"),
			v.literal("archive"),
			v.literal("rollback_readers"),
			v.literal("cancel_readers"),
		),
		fingerprint: v.string(),
		path: v.string(),
		sequence: v.number(),
		writerGeneration: v.number(),
		nodeId: v.id("files_nodes"),
		contentRevision: v.union(v.string(), v.null()),
		readerRevision: v.union(v.number(), v.null()),
		createdAt: v.number(),
	})
		.index("by_writer_operationId", ["writerId", "operationId"])
		.index("by_writer_path_writerGeneration_sequence", ["writerId", "path", "writerGeneration", "sequence"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Private proof for undoing or cancelling one reader change after its sponsor loses access.
	 */
	plugins_external_file_reader_changes: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		writerId: v.id("plugins_external_file_writers"),
		receiptId: v.id("plugins_external_file_receipts"),
		grantId: v.id("plugin_service_grants"),
		tokenHash: v.string(),
		pluginVersionId: v.id("plugins_versions"),
		serviceAccountId: v.id("access_control_service_accounts"),
		actorUserId: v.id("users"),
		previousReaders: v.array(v.object({ userId: v.id("users"), membershipLifetime: v.number() })),
		nextReaders: v.array(v.object({ userId: v.id("users"), membershipLifetime: v.number() })),
		rollbackReceiptId: v.union(v.id("plugins_external_file_receipts"), v.null()),
	})
		.index("by_receipt", ["receiptId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * Lost lifecycle responses can recover one exact credential for at most 24 hours.
	 * The old bearer only locates this receipt; it never authorizes ordinary service work.
	 */
	plugin_service_grant_requests: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		credentialHash: v.string(),
		operation: v.union(v.literal("exchange"), v.literal("renew"), v.literal("seal")),
		requestId: v.string(),
		fingerprint: v.string(),
		grantId: v.id("plugin_service_grants"),
		responseTokenHash: v.string(),
		responseAvailable: v.boolean(),
		ciphertext: v.union(v.bytes(), v.null()),
		nonce: v.union(v.bytes(), v.null()),
		expiresAt: v.number(),
		createdAt: v.number(),
	})
		.index("by_credentialHash_operation_requestId", ["credentialHash", "operation", "requestId"])
		.index("by_responseAvailable_expiresAt", ["responseAvailable", "expiresAt"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"]),

	/**
	 * One doc per plugin name that registered an outside service for the service-grant exchange.
	 * The host generates the `pse_` secret and stores only its hash; rotating writes a new hash and
	 * the old secret stops working immediately. The exchange requires the accepted capability for
	 * each registered scope, plus `plugin.service.connect`.
	 */
	plugins_service_registrations: defineTable({
		pluginName: v.string(),
		exchangeSecretHash: v.string(),
		scopes: v.array(v.union(v.literal("plugin_data:read"), v.literal("plugin_data:write"), v.literal("files:write"))),
		createdBy: v.id("users"),
		updatedAt: v.number(),
	}).index("by_pluginName", ["pluginName"]),

	/**
	 * Bearer grant for a service that acts for one installation (`psg_` tokens, stored hashed). It is
	 * bound to the installation, not to a user session, so an external worker can finish work the
	 * member started. Every call still rechecks that the installation is enabled and still accepts
	 * the matching capabilities, so uninstalling or removing a capability revokes it.
	 */
	plugin_service_grants: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		serviceAccountId: v.id("access_control_service_accounts"),
		installationId: v.id("plugins_workspace_installations"),
		pluginVersionId: v.id("plugins_versions"),
		pluginName: v.string(),
		/**
		 * The member whose plugin-page token was exchanged for this grant. Kept for audit.
		 */
		actorUserId: v.id("users"),
		tokenHash: v.string(),
		scopes: v.array(v.union(v.literal("plugin_data:read"), v.literal("plugin_data:write"), v.literal("files:write"))),
		/**
		 * Stable across token rotation, so reservations and versioned documents stay owned by the
		 * same producer after the raw token changes.
		 */
		principalKey: v.string(),
		/**
		 * `interactive` is what the grant exchange mints. `processing` comes only from the
		 * `seal-processing` route, which pins `destinationPathPrefix` below and gives the grant its
		 * recovery window. Only a `processing` grant may upload files. Both phases still resolve with
		 * the actor's live membership and permission checks: the seal bounds where a grant writes, not
		 * whether its member may still write.
		 */
		phase: v.union(v.literal("interactive"), v.literal("processing")),
		/**
		 * Absolute path prefix this grant may write under. Null means it may not write files.
		 */
		destinationPathPrefix: v.union(v.string(), v.null()),
		expiresAt: v.number(),
		revokedAt: v.optional(v.number()),
		revokedReason: v.optional(v.string()),
		updatedAt: v.number(),
	})
		.index("by_tokenHash", ["tokenHash"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_actorUser", ["actorUserId"])
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"])
		// Removing a member deletes their grants by this index, the same way it deletes their public API
		// grants and plugin UI sessions.
		.index("by_organization_workspace_actorUser", ["organizationId", "workspaceId", "actorUserId"]),

	/**
	 * One file a service upload stores in a workspace. The doc is the durable answer to a replayed
	 * create/remint/finalize call and the R2 event. It captures ownership and the actual stored size,
	 * so a later deletion of the exact canonical R2 object can find what this file charged — even
	 * after the installation is gone.
	 */
	plugin_service_storage_targets: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		/**
		 * The upload run this file belongs to, chosen by the service. One processing run reuses one
		 * key for all its files, so the same `targetKey` in a later run is a different file.
		 */
		idempotencyKey: v.string(),
		/**
		 * Stable key for this one file inside its upload run.
		 */
		targetKey: v.string(),
		/**
		 * A different request under the same run and target key is refused, not stored twice.
		 */
		requestFingerprint: v.string(),
		/**
		 * Historical targets omit these flags and behave as false. New targets always store both.
		 */
		readOnly: v.optional(v.boolean()),
		nonCollaborative: v.optional(v.boolean()),
		/**
		 * The authoritative sealed replay fence and its stable destination node id at create time.
		 */
		destinationPath: v.string(),
		destinationNodeId: v.id("files_nodes"),
		/**
		 * Logical service lifecycle under this destination. Older dev targets omit it and belong to
		 * epoch 1. The first create after an archive opens the next epoch.
		 */
		destinationEpoch: v.optional(v.number()),
		path: v.string(),
		contentType: v.string(),
		/**
		 * The size the service guessed at create time. Nothing is charged for it.
		 */
		declaredBytes: v.number(),
		/**
		 * The exact size of the winning upload. `null` until it is published.
		 */
		actualBytes: v.union(v.number(), v.null()),
		/**
		 * Confirmed bytes counted for the committed attempt. Old settled targets may include
		 * superseded attempts; that history is never used for billing.
		 */
		chargedBytes: v.number(),
		nodeId: v.id("files_nodes"),
		assetId: v.id("files_r2_assets"),
		/**
		 * `pending` until the canonical object is confirmed and settled, then `committed`. `released`
		 * means the target holds no live file any more: the upload expired, the service cancelled it
		 * before it finished, or the per-target delete archived the committed file. The bytes it already
		 * charged stay charged either way.
		 */
		state: v.union(v.literal("pending"), v.literal("committed"), v.literal("released")),
		releaseReason: v.optional(v.literal("oversized")),
		/**
		 * Set after the file leaves this service door through a member move or service destination archive.
		 */
		movedOutAt: v.optional(v.number()),
		/**
		 * Set when the service's delete route archived a committed file. It marks that actualBytes is
		 * the immutable canonical size and keeps the released target as the replay answer.
		 */
		deleteRequestedAt: v.optional(v.number()),
		/**
		 * The member whose sealed grant created this target. Kept for audit and file authorship.
		 */
		createdBy: v.id("users"),
		updatedAt: v.number(),
	})
		// Create, remint and finalize find one file by the run it belongs to and its key inside that
		// run. Two runs may reuse a target key for different files, so the run key comes first.
		.index("by_organization_workspace_installation_idempotencyKey_targetKey", [
			"organizationId",
			"workspaceId",
			"installationId",
			"idempotencyKey",
			"targetKey",
		])
		// Physical deletion settlement finds the charged target by the deleted canonical asset.
		.index("by_asset", ["assetId"])
		// A service destination archive detaches only the targets for the file nodes it archives.
		.index("by_node", ["nodeId"])
		// A restored older destination generation proves its service ownership by stable folder id.
		.index("by_org_workspace_installation_destinationPath_destinationNode", [
			"organizationId",
			"workspaceId",
			"installationId",
			"destinationPath",
			"destinationNodeId",
		])
		.index("by_organization_workspace_installation_destinationPath", [
			"organizationId",
			"workspaceId",
			"installationId",
			"destinationPath",
		])
		// Bound live cross-run cleanup to one sealed destination and target key. Released history is
		// deliberately outside the live state prefixes used by create and delete.
		.index("by_delete_group_state", [
			"organizationId",
			"workspaceId",
			"installationId",
			"destinationPath",
			"targetKey",
			"state",
			"movedOutAt",
			"deleteRequestedAt",
		])
		// The archive route finds one target under the sealed destination without scanning an
		// installation's full upload history. The stable node id then survives a folder rename.
		.index("by_organization_workspace_installation_path", ["organizationId", "workspaceId", "installationId", "path"])
		// The delete route finds targets by key inside the installation; the uninstall/workspace drain
		// uses the same index as a tenant-scope prefix.
		.index("by_organization_workspace_installation_targetKey", [
			"organizationId",
			"workspaceId",
			"installationId",
			"targetKey",
		]),

	/**
	 * Attribute late R2 events even after a superseded upload asset has been deleted.
	 */
	plugin_service_storage_attempts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		targetId: v.id("plugin_service_storage_targets"),
		assetId: v.id("files_r2_assets"),
	})
		.index("by_asset", ["assetId"])
		.index("by_target", ["targetId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	/**
	 * Close every older target generation when the service archives one sealed destination.
	 */
	plugin_service_storage_destinations: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		destinationPath: v.string(),
		currentEpoch: v.number(),
		closedEpoch: v.number(),
		closedAt: v.optional(v.number()),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_installation_destinationPath", [
			"organizationId",
			"workspaceId",
			"installationId",
			"destinationPath",
		])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	// #endregion plugins services

	// #region plugins mcp
	/**
	 * One doc per MCP server of an installed plugin version. Install and upgrade update the docs in
	 * place by server id, so the tool prefix and the health count survive an upgrade.
	 */
	plugins_mcp_servers: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		installationId: v.id("plugins_workspace_installations"),
		serverId: v.string(),
		/**
		 * Model tool names start with `mcp__<toolPrefix>__`. Unique among the workspace's plugin servers.
		 */
		toolPrefix: v.string(),
		/**
		 * SHA-256 of where the server sends data: its URL, its whole `auth` object, and its header names.
		 * The organization allowlist matches on it, so a changed destination needs the owner again.
		 */
		destinationFingerprint: v.string(),
		/**
		 * Failed tool lists in turns in a row. Only turn setup writes it.
		 */
		failures: v.number(),
		unhealthyUntil: v.union(v.number(), v.null()),
	})
		.index("by_organization_workspace_installation", ["organizationId", "workspaceId", "installationId"])
		.index("by_organization_workspace_toolPrefix", ["organizationId", "workspaceId", "toolPrefix"]),

	/**
	 * An MCP server one member added for themselves in one workspace. It holds no secret value: header
	 * parts name docs in `mcp_custom_server_secrets`.
	 */
	mcp_custom_servers: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		name: v.string(),
		/**
		 * `my-<slug>`. Plugin server ids can never be `my` or start with `my-`, so the two never clash.
		 */
		toolPrefix: v.string(),
		url: v.string(),
		headers: v.array(
			v.object({
				name: v.string(),
				parts: v.array(
					v.union(
						v.object({ kind: v.literal("text"), text: v.string() }),
						v.object({ kind: v.literal("secret"), secretName: v.string() }),
					),
				),
			}),
		),
		auth: v.union(
			v.object({ kind: v.literal("none") }),
			v.object({ kind: v.literal("headers") }),
			v.object({
				kind: v.literal("oauth"),
				issuer: v.string(),
				resource: v.string(),
				authorizationHost: v.string(),
			}),
		),
		/**
		 * SHA-256 of the URL, the auth kind, and the OAuth issuer. The organization allowlist matches on it.
		 */
		destinationFingerprint: v.string(),
		enabled: v.boolean(),
		lastTest: v.union(
			v.object({ at: v.number(), outcome: v.string(), toolCount: v.union(v.number(), v.null()) }),
			v.null(),
		),
		failures: v.number(),
		unhealthyUntil: v.union(v.number(), v.null()),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"])
		.index("by_organization_destinationFingerprint", ["organizationId", "destinationFingerprint"]),

	/**
	 * One header secret of a member's MCP server. Additional data:
	 * `custom_secret:<customServerId>:<userId>:<name>`.
	 */
	mcp_custom_server_secrets: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		customServerId: v.id("mcp_custom_servers"),
		name: v.string(),
		value: plugins_mcp_encrypted_value_validator,
		updatedAt: v.number(),
	})
		.index("by_customServer_name", ["customServerId", "name"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"]),

	/**
	 * A started OAuth sign-in, used once by its callback. It lives 10 minutes.
	 */
	plugins_mcp_oauth_pending: defineTable({
		stateHash: v.string(),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: plugins_mcp_target_validator,
		destinationFingerprint: v.string(),
		serverUrl: v.string(),
		resource: v.string(),
		issuer: v.string(),
		authorizationEndpoint: v.string(),
		tokenEndpoint: v.string(),
		revocationEndpoint: v.union(v.string(), v.null()),
		issParameterSupported: v.boolean(),
		clientId: v.string(),
		clientKind: plugins_mcp_oauth_client_kind_validator,
		tokenEndpointAuthMethod: plugins_mcp_oauth_token_endpoint_auth_method_validator,
		scopes: v.array(v.string()),
		/**
		 * The PKCE verifier. Additional data: `pending:<original stateHash>`. Claim returns that
		 * original hash for decryption, and replaces the stored hash to block callback replay.
		 */
		codeVerifier: plugins_mcp_encrypted_value_validator,
		returnPath: v.string(),
		expiresAt: v.number(),
	})
		.index("by_stateHash", ["stateHash"])
		.index("by_expiresAt", ["expiresAt"])
		.index("by_targetInstallation", ["target.installationId"])
		.index("by_targetCustomServer", ["target.customServerId"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"]),

	/**
	 * One member's OAuth tokens for one MCP server. Additional data:
	 * `grant:plugin:<installationId>:<serverId>:<userId>:<issuer>:<resource>` or
	 * `grant:custom:<customServerId>:<userId>:<issuer>:<resource>`.
	 */
	plugins_mcp_oauth_grants: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		target: plugins_mcp_target_validator,
		issuer: v.string(),
		resource: v.string(),
		tokenEndpoint: v.string(),
		revocationEndpoint: v.union(v.string(), v.null()),
		clientId: v.string(),
		clientKind: plugins_mcp_oauth_client_kind_validator,
		tokenEndpointAuthMethod: plugins_mcp_oauth_token_endpoint_auth_method_validator,
		accessToken: v.union(plugins_mcp_encrypted_value_validator, v.null()),
		refreshToken: v.union(plugins_mcp_encrypted_value_validator, v.null()),
		expiresAt: v.union(v.number(), v.null()),
		scope: v.string(),
		requestedScopes: v.array(v.string()),
		stepUpScope: v.union(v.string(), v.null()),
		connectedAt: v.number(),
		status: v.union(v.literal("connected"), v.literal("needs_reconnect")),
		/**
		 * Bumped on every token change. A refresh lease is taken only for the version it read.
		 */
		version: v.number(),
		leaseId: v.union(v.string(), v.null()),
		leaseUntil: v.union(v.number(), v.null()),
	})
		.index("by_targetInstallation_targetServerId_user", ["target.installationId", "target.serverId", "userId"])
		.index("by_targetCustomServer_user", ["target.customServerId", "userId"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"]),

	/**
	 * A client that one sign-in server registered for Press with DCR. Every workspace shares it, so it
	 * is deployment data, not tenant data. Additional data of the secret: `client:<issuer>:<clientId>`.
	 */
	plugins_mcp_oauth_clients: defineTable({
		issuer: v.string(),
		clientId: v.string(),
		clientSecret: v.union(plugins_mcp_encrypted_value_validator, v.null()),
		/**
		 * When the secret stops working, in ms. `null` means it never expires.
		 */
		clientSecretExpiresAt: v.union(v.number(), v.null()),
		tokenEndpointAuthMethod: plugins_mcp_oauth_token_endpoint_auth_method_validator,
	}).index("by_issuer", ["issuer"]),

	/**
	 * A token to revoke at its sign-in server. Deletion paths are mutations and cannot fetch, so they
	 * copy the encrypted token here. The doc is deployment cleanup, not tenant data: it has no tenant id
	 * fields, so no tenant deletion finds it. But `additionalData` holds the target and user ids as text.
	 * A daily cron deletes docs older than 1 day, so a doc stays at most about 2 days.
	 */
	plugins_mcp_oauth_revocations: defineTable({
		token: plugins_mcp_encrypted_value_validator,
		/**
		 * The grant's additional data, copied as it is.
		 */
		additionalData: v.string(),
		tokenTypeHint: v.union(v.literal("access_token"), v.literal("refresh_token")),
		revocationEndpoint: v.string(),
		/**
		 * Finds the DCR client secret in `plugins_mcp_oauth_clients`.
		 */
		issuer: v.string(),
		clientId: v.string(),
		clientKind: plugins_mcp_oauth_client_kind_validator,
		tokenEndpointAuthMethod: plugins_mcp_oauth_token_endpoint_auth_method_validator,
	}),

	/**
	 * One MCP tool call. No arguments and no output. Kept 30 days.
	 */
	plugins_mcp_calls: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		threadId: v.id("ai_chat_threads"),
		target: plugins_mcp_target_validator,
		toolName: v.string(),
		startedAt: v.number(),
		durationMs: v.number(),
		bytesIn: v.number(),
		bytesOut: v.number(),
		/**
		 * `ok`, `tool_error`, `auth_needed`, or an MCP client error code.
		 */
		outcome: v.string(),
	})
		.index("by_targetInstallation", ["target.installationId"])
		.index("by_targetCustomServer", ["target.customServerId"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_user", ["userId"])
		.index("by_startedAt", ["startedAt"])
		.index("by_thread", ["threadId"]),
	// #endregion plugins mcp

	// #region activities
	/**
	 * One lifecycle per background job. Producers update it in the same transaction as their
	 * work. Hidden plugin jobs become visible only when the plugin opts into the feed.
	 */
	activities: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.optional(v.id("organizations_workspaces_users")),
		membershipLifetime: v.optional(v.number()),
		visibility: v.union(v.literal("requester"), v.literal("shared")),
		feedVisible: v.boolean(),
		status: v.union(
			v.literal("queued"),
			v.literal("running"),
			v.literal("awaiting_input"),
			v.literal("stopping"),
			v.literal("succeeded"),
			v.literal("partial"),
			v.literal("failed"),
			v.literal("timed_out"),
			v.literal("canceled"),
		),
		/**
		 * What produced this activity. The producer owns progress and completion in the same
		 * transaction as its work.
		 */
		source: v.union(
			v.object({
				kind: v.literal("plugin_run"),
				id: v.id("plugins_event_runs"),
				installationId: v.id("plugins_workspace_installations"),
				pluginName: v.string(),
				event: v.union(
					v.literal("files.upload.completed"),
					v.literal("files.run.requested"),
					v.literal("users.account.deleted"),
					v.literal("ui.invoke.requested"),
					v.literal("schedule.interval.elapsed"),
				),
				serializationKey: v.optional(v.string()),
			}),
			v.object({
				kind: v.literal("files_transfer_run"),
				id: v.id("files_transfer_runs"),
				transferKind: v.union(v.literal("move"), v.literal("copy")),
			}),
			v.object({
				kind: v.literal("files_pending_update_run"),
				id: v.id("files_pending_update_runs"),
				operationKind: v.union(v.literal("accept"), v.literal("discard")),
			}),
			v.object({ kind: v.literal("files_write_policy_run"), id: v.id("files_write_policy_runs") }),
			v.object({
				kind: v.literal("files_archive_run"),
				id: v.id("files_archive_runs"),
				archiveKind: v.union(v.literal("archive"), v.literal("restore")),
			}),
			/**
			 * A move or restrict whose op has no run doc of its own. A restrict Activity is not in the feed.
			 */
			v.object({
				kind: v.literal("files_subtree_op"),
				id: v.id("files_subtree_ops"),
				opKind: v.union(v.literal("move"), v.literal("scope")),
			}),
			/**
			 * A background bash job (`cmd &`). The extra fields let `jobs` read this small
			 * doc instead of the invocation doc, which can hold 700 KiB.
			 */
			v.object({
				kind: v.literal("ai_chat_bash_job"),
				id: v.id("ai_chat_bash_invocations"),
				threadId: v.id("ai_chat_threads"),
				jobNumber: v.number(),
				shellName: v.string(),
				/**
				 * null when a chat call launched the job, the parent job number when a job did.
				 */
				parentJobNumber: v.union(v.number(), v.null()),
				/**
				 * The first 80 characters of the script, on one line.
				 */
				scriptPreview: v.string(),
			}),
		),
		progress: v.optional(
			v.object({
				unit: v.union(v.literal("files"), v.literal("items")),
				discovered: v.number(),
				total: v.union(v.number(), v.null()),
				completed: v.number(),
				skipped: v.number(),
				failed: v.number(),
				blocked: v.number(),
				canceled: v.number(),
			}),
		),
		resultKind: v.union(
			v.literal("saved"),
			v.literal("ready_for_review"),
			v.literal("discarded"),
			v.literal("plugin_result"),
			v.literal("bash_result"),
		),
		/**
		 * Status-neutral display text, e.g. "Video plugin · speakers.mp4".
		 */
		title: v.string(),
		errorMessage: v.union(v.string(), v.null()),
		errorCode: v.optional(v.string()),
		/**
		 * Entities the work touches, appended as the producer creates them; UIs use these to link
		 * and to decorate rows. Bounded by the producer (plugin runs: the 20-call quota).
		 */
		targets: v.array(
			v.object({
				kind: v.literal("file_node"),
				id: v.id("files_nodes"),
				path: v.string(),
				/**
				 * Per-target display text (e.g. "Writing the transcript"); "" = none, UIs fall back to the activity title.
				 */
				message: v.string(),
			}),
		),
		/**
		 * Only the producer's stop path can settle this deadline. An estimate never stops work.
		 */
		deadlineAt: v.number(),
		expectedFinishAt: v.optional(v.number()),
		startedAt: v.optional(v.number()),
		stopRequestedAt: v.optional(v.number()),
		finishedAt: v.optional(v.number()),
		expiresAt: v.optional(v.number()),
		updatedAt: v.number(),
	})
		.index("by_organization_workspace_feedVisible_finishedAt_updatedAt", [
			"organizationId",
			"workspaceId",
			"feedVisible",
			"finishedAt",
			"updatedAt",
		])
		.index("by_source_id", ["source.id"])
		.index("by_user_workspace_source_kind_status", ["userId", "workspaceId", "source.kind", "status"])
		.index("by_status_deadlineAt", ["status", "deadlineAt"])
		.index("by_status_expiresAt", ["status", "expiresAt"])
		.index("by_organization_workspace_source_event_status_updatedAt", [
			"organizationId",
			"workspaceId",
			"source.event",
			"status",
			"updatedAt",
		])
		.index("by_source_installation_updatedAt", ["source.installationId", "updatedAt"])
		.index("by_source_installation_event_updatedAt", ["source.installationId", "source.event", "updatedAt"])
		.index("by_source_installation_serializationKey_status", [
			"source.installationId",
			"source.serializationKey",
			"status",
		])
		.index("by_source_kind_event_status_deadline_organization", [
			"source.kind",
			"source.event",
			"status",
			"deadlineAt",
			"organizationId",
		])
		// Bash job doors resolve a job number through this index, so the user and thread are
		// fenced by the index itself. Rows of other source kinds have no `source.jobNumber`.
		.index("by_user_source_kind_thread_jobNumber", ["userId", "source.kind", "source.threadId", "source.jobNumber"])
		// Unread leftover of the old stderr notes. They asked which jobs ended since the cursor, so they
		// needed the finish time, not the job number: a job may live 24 hours, so job 1 can end after
		// job 20. A job that is still running has no `finishedAt`, which
		// sorts before every number, so the range leaves it out on its own.
		.index("by_user_source_kind_thread_finishedAt", ["userId", "source.kind", "source.threadId", "finishedAt"]),

	activities_user_states: defineTable({
		userId: v.id("users"),
		activityId: v.id("activities"),
		dismissedAt: v.number(),
	})
		.index("by_user_activity", ["userId", "activityId"])
		.index("by_activity", ["activityId"]),

	// #endregion activities

	// #region channels
	channels: defineTable(
		v.union(
			v.object({
				kind: v.union(v.literal("public"), v.literal("private")),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				name: v.string(),
				topic: v.string(),
				layout: v.union(v.literal("messages"), v.literal("posts")),
				resolvableThreads: v.boolean(),
				createdBy: v.id("users"),
				createdAt: v.number(),
				archivedAt: v.union(v.number(), v.null()),
			}),
			v.object({
				kind: v.literal("direct"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				/** Use membership doc ids so a re-invite cannot reopen old history. */
				directKey: v.string(),
				/** Keep the fixed list so departed people can still be shown as left. */
				participantUserIds: v.array(v.id("users")),
				createdBy: v.id("users"),
				createdAt: v.number(),
			}),
			v.object({
				kind: v.literal("file"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
				fileNodeId: v.id("files_nodes"),
				createdBy: v.id("users"),
				createdAt: v.number(),
			}),
		),
	)
		.index("by_organization_workspace_kind_name", ["organizationId", "workspaceId", "kind", "name"])
		.index("by_organization_workspace_directKey", ["organizationId", "workspaceId", "directKey"])
		.index("by_organization_workspace_fileNode", ["organizationId", "workspaceId", "fileNodeId"])
		.index("by_organization_workspace_kind_archivedAt_name", [
			"organizationId",
			"workspaceId",
			"kind",
			"archivedAt",
			"name",
		]),

	channels_activity: defineTable({
		channelId: v.id("channels"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		lastMainSequence: v.number(),
		lastChannelSequence: v.number(),
		lastMessageAt: v.number(),
		memberCount: v.number(),
	})
		.index("by_channel", ["channelId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	channels_members: defineTable({
		channelId: v.id("channels"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		/** Pin access to this membership. Account restore keeps it; re-invite does not. */
		workspaceMembershipId: v.id("organizations_workspaces_users"),
		level: v.union(v.literal("member"), v.literal("manager")),
		addedBy: v.union(v.id("users"), v.null()),
		notify: v.union(v.literal("all"), v.literal("mentions"), v.literal("none")),
		starred: v.boolean(),
		hiddenAtMainSequence: v.union(v.number(), v.null()),
		joinedAt: v.number(),
	})
		.index("by_channel_user", ["channelId", "userId"])
		.index("by_channel_level", ["channelId", "level"])
		.index("by_organization_workspace_user_channel", ["organizationId", "workspaceId", "userId", "channelId"])
		.index("by_organization_user", ["organizationId", "userId"])
		.index("by_user", ["userId"]),

	channels_read_states: defineTable({
		channelId: v.id("channels"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		/** Read mainSequence in messages layout and channelSequence in posts layout. */
		readSequence: v.number(),
		updatedAt: v.number(),
	})
		.index("by_channel_user", ["channelId", "userId"])
		.index("by_organization_user", ["organizationId", "userId"])
		.index("by_user", ["userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	channels_messages: defineTable({
		channelId: v.id("channels"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		authorUserId: v.id("users"),
		channelSequence: v.number(),
		mainSequence: v.union(v.number(), v.null()),
		threadRootId: v.union(v.id("channels_messages"), v.null()),
		threadSequence: v.union(v.number(), v.null()),
		replyTo: v.union(
			v.object({ messageId: v.id("channels_messages"), quote: v.union(v.string(), v.null()) }),
			v.null(),
		),
		body: v.string(),
		mentionUserIds: v.array(v.id("users")),
		fileMentionIds: v.array(v.id("files_nodes")),
		fileQuotes: v.array(file_quote_validator),
		attachments: v.array(
			v.union(
				v.object({ kind: v.literal("file"), fileNodeId: v.id("files_nodes") }),
				v.object({ kind: v.literal("upload"), uploadId: v.id("channels_uploads") }),
			),
		),
		hasAttachments: v.boolean(),
		clientMessageId: v.string(),
		revision: v.number(),
		editedAt: v.union(v.number(), v.null()),
		deletedAt: v.union(v.number(), v.null()),
	})
		.index("by_channel_mainSequence", ["channelId", "mainSequence"])
		.index("by_threadRoot_threadSequence", ["threadRootId", "threadSequence"])
		// The agent reads one thread's replies in a time window. Convex adds `_creationTime` at the end.
		.index("by_threadRoot", ["threadRootId"])
		.index("by_channel", ["channelId"])
		.index("by_author_clientMessageId", ["authorUserId", "clientMessageId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.searchIndex("search_body", {
			searchField: "body",
			filterFields: ["organizationId", "workspaceId", "channelId", "authorUserId", "hasAttachments"],
		}),

	channels_threads: defineTable({
		channelId: v.id("channels"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		rootMessageId: v.id("channels_messages"),
		title: v.union(v.string(), v.null()),
		/** Hide an anchored comment from others until its document mark is saved. */
		anchor: v.union(
			v.object({ kind: v.literal("text_mark"), excerpt: v.string(), confirmedAt: v.union(v.number(), v.null()) }),
			v.null(),
		),
		lastReplySequence: v.number(),
		lastActivitySequence: v.number(),
		replyCount: v.number(),
		recentReplierUserIds: v.array(v.id("users")),
		lastActivityAt: v.number(),
		isResolved: v.boolean(),
		resolvedAt: v.union(v.number(), v.null()),
		resolvedBy: v.union(v.id("users"), v.null()),
		followerSyncPending: v.boolean(),
	})
		.index("by_rootMessage", ["rootMessageId"])
		.index("by_anchor_confirmedAt", ["anchor.confirmedAt"])
		.index("by_channel_isResolved_lastActivityAt", ["channelId", "isResolved", "lastActivityAt"])
		.index("by_channel_lastActivityAt", ["channelId", "lastActivityAt"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	channels_thread_followers: defineTable({
		threadId: v.id("channels_threads"),
		rootMessageId: v.id("channels_messages"),
		channelId: v.id("channels"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		readReplySequence: v.number(),
		following: v.boolean(),
		/** Clear this only when the post is opened or its root mention is removed. */
		pendingRootMention: v.boolean(),
		threadLastActivityAt: v.number(),
		followedAt: v.number(),
	})
		.index("by_thread_user", ["threadId", "userId"])
		.index("by_thread", ["threadId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user_channel_pendingRootMention", ["userId", "channelId", "pendingRootMention"])
		.index("by_organization_workspace_user_following_threadLastActivityAt", [
			"organizationId",
			"workspaceId",
			"userId",
			"following",
			"threadLastActivityAt",
		])
		.index("by_organization_user", ["organizationId", "userId"])
		.index("by_user", ["userId"]),

	channels_reactions: defineTable({
		messageId: v.id("channels_messages"),
		channelId: v.id("channels"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		emoji: v.string(),
	})
		.index("by_message_emoji_user", ["messageId", "emoji", "userId"])
		.index("by_message", ["messageId"])
		.index("by_organization_user", ["organizationId", "userId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	channels_reaction_counts: defineTable({
		messageId: v.id("channels_messages"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		emoji: v.string(),
		count: v.number(),
	})
		.index("by_message_emoji", ["messageId", "emoji"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	channels_inbox: defineTable({
		recipientUserId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		channelId: v.id("channels"),
		messageId: v.id("channels_messages"),
		kind: v.union(v.literal("mention"), v.literal("reply")),
		mainSequence: v.union(v.number(), v.null()),
		threadRootId: v.union(v.id("channels_messages"), v.null()),
		threadSequence: v.union(v.number(), v.null()),
		createdAt: v.number(),
	})
		.index("by_recipient_organization_workspace_createdAt", [
			"recipientUserId",
			"organizationId",
			"workspaceId",
			"createdAt",
		])
		.index("by_recipient_channel_kind_threadRoot_mainSequence", [
			"recipientUserId",
			"channelId",
			"kind",
			"threadRootId",
			"mainSequence",
		])
		.index("by_message", ["messageId"])
		.index("by_recipient", ["recipientUserId"])
		.index("by_organization_recipient", ["organizationId", "recipientUserId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),

	channels_uploads: defineTable({
		channelId: v.id("channels"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		assetId: v.id("files_r2_assets"),
		uploaderUserId: v.id("users"),
		name: v.string(),
		contentType: v.string(),
		/** Attaching clears the asset's 24-hour cleanup deadline. */
		messageId: v.union(v.id("channels_messages"), v.null()),
		createdAt: v.number(),
	})
		.index("by_asset", ["assetId"])
		.index("by_channel", ["channelId"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"]),
	// #endregion channels

	// #region data deletion
	data_deletion_requests: defineTable({
		userId: v.id("users"),
		organizationId: v.optional(v.id("organizations")),
		workspaceId: v.optional(v.id("organizations_workspaces")),
		scope: v.union(v.literal("workspace"), v.literal("organization"), v.literal("user")),
		eligibleAt: v.number(),
	})
		.index("by_scope_eligibleAt", ["scope", "eligibleAt"])
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_user_scope", ["userId", "scope"])
		.index("by_organization_scope", ["organizationId", "scope"])
		.index("by_organization_workspace_scope", ["organizationId", "workspaceId", "scope"])
		.index("by_user_eligibleAt", ["userId", "eligibleAt"])
		.index("by_user", ["userId"]),
	// #endregion data deletion

	// #region access control

	/**
	 * One doc (key `"main"`) that versions the change feed below. Created with the first remote
	 * lease; writers bump `revision` in the same transaction that appends `access_control_changes`.
	 **/
	access_control_change_state: defineTable({
		key: v.literal("main"),
		revision: v.number(),
		oldestRevision: v.number(),
	}).index("by_key", ["key"]),

	/**
	 * Ordered feed of access-control events. Remote plugin hosts replay it by `revision` to refresh
	 * their cached permission, installation, and member state after a lease gap.
	 **/
	access_control_changes: defineTable({
		revision: v.number(),
		createdAt: v.number(),
		scope: v.union(
			v.object({ kind: v.literal("all") }),
			v.object({ kind: v.literal("organization"), organizationId: v.id("organizations") }),
			v.object({
				kind: v.literal("workspace"),
				organizationId: v.id("organizations"),
				workspaceId: v.id("organizations_workspaces"),
			}),
			v.object({ kind: v.literal("installation"), installationId: v.id("plugins_workspace_installations") }),
			v.object({ kind: v.literal("user"), userId: v.id("users") }),
			v.object({ kind: v.literal("service_account"), serviceAccountId: v.id("access_control_service_accounts") }),
		),
		event: v.union(
			v.object({
				kind: v.literal("refresh"),
				reason: v.union(
					v.literal("permissions"),
					v.literal("installation"),
					v.literal("account"),
					v.literal("members"),
				),
			}),
			v.object({
				kind: v.literal("member"),
				member: v.object({
					hostUserId: v.string(),
					hostMembershipId: v.union(v.string(), v.null()),
					membershipLifetime: v.number(),
					displayName: v.union(v.string(), v.null()),
					active: v.boolean(),
					canRead: v.boolean(),
					canWrite: v.boolean(),
					isOwner: v.boolean(),
				}),
			}),
			v.object({ kind: v.literal("session_revoked"), hostSessionId: v.string() }),
			v.object({
				kind: v.literal("revoked"),
				reason: v.union(v.literal("uninstalled"), v.literal("workspace_deleted"), v.literal("organization_deleted")),
			}),
		),
	})
		.index("by_revision", ["revision"])
		.index("by_createdAt", ["createdAt"]),

	/**
	 * Service identities scoped to an organization + workspace. Plugin installations act through
	 * these accounts so their file and data access is checked like a member's.
	 **/
	access_control_service_accounts: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		name: v.string(),
		createdBy: v.id("users"),
		createdAt: v.number(),
		updatedAt: v.number(),
		revokedAt: v.union(v.number(), v.null()),
	})
		.index("by_organization_workspace", ["organizationId", "workspaceId"])
		.index("by_organization_workspace_revokedAt", ["organizationId", "workspaceId", "revokedAt"]),

	/**
	 * Custom roles, which always apply to the whole organization. System roles live in code, so they
	 * have no docs here.
	 **/
	access_control_roles: defineTable({
		organizationId: v.id("organizations"),
		name: v.string(),
		/**
		 * `name` in lowercase, without spaces around it. Unique per organization, never a system role name.
		 */
		normalizedName: v.string(),
		description: v.string(),
		permissions: v.array(access_control_permission_validator),
		/** Kept even after that user is deleted: the role belongs to the organization, not to them. */
		createdBy: v.id("users"),
		createdAt: v.number(),
		updatedAt: v.number(),
	}).index("by_organization_normalizedName", ["organizationId", "normalizedName"]),

	access_control_role_assignments: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		role: access_control_role_ref_validator,
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		// `role` is left out of this key on purpose. There is one assignment per (organization,
		// workspace, user), so changing a role updates the existing doc instead of adding a second one.
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"])
		.index("by_organization_user_workspace", ["organizationId", "userId", "workspaceId"])
		.index("by_user_organization_workspace", ["userId", "organizationId", "workspaceId"])
		.index("by_organization_role_workspace_user", ["organizationId", "role", "workspaceId", "userId"]),

	access_control_permission_grants: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		/**
		 * What the grant is about. `"thread"` is never written: no code makes a thread grant, and
		 * `access_control_Resource` cannot build one. Chat threads are checked with `content.read` and
		 * `content.write` on their workspace instead. The literal stays so old docs still validate.
		 *
		 * `"plugin_scope"` is a private range of one plugin's data store — a private channel or a
		 * direct message. Its grants close a door instead of opening one: inside a scope a role gives
		 * nothing and only a grant that names the user gets in. See the `plugin_scope` branch in
		 * `access_control_db_has_permission`.
		 */
		resourceKind: v.union(
			v.literal("organization"),
			v.literal("workspace"),
			v.literal("file"),
			v.literal("thread"),
			v.literal("plugin_scope"),
			v.literal("plugin_installation"),
		),
		/**
		 * The id of the thing this grant is about, written as a string.
		 *
		 * Restricted files use their nearest restricted scope's id. Service accounts may also hold
		 * an exact grant on an unrestricted node; that grant does not cover its descendants.
		 */
		resourceId: v.string(),
		principalKind: v.union(v.literal("role"), v.literal("user"), v.literal("public"), v.literal("service_account")),
		userId: v.optional(v.id("users")),
		/**
		 * Plugin-managed file readers must belong to this exact membership lifetime.
		 * A human sharing change removes the tag when it takes over the reader list.
		 */
		externalPluginMembershipLifetime: v.optional(v.number()),
		role: v.optional(access_control_role_ref_validator),
		serviceAccountId: v.optional(v.id("access_control_service_accounts")),
		permission: access_control_grant_permission_validator,
		/**
		 * A user's own consent to scheduled runs. Other grants never carry this field.
		 */
		runAs: v.optional(
			v.object({
				membershipId: v.id("organizations_workspaces_users"),
				membershipLifetime: v.number(),
				scopes: v.array(
					v.union(
						v.literal("files:list"),
						v.literal("files:read"),
						v.literal("plugin_data:read"),
						v.literal("plugin_data:write"),
						v.literal("volumes:write"),
						v.literal("secrets:read"),
						v.literal("outbound:fetch"),
					),
				),
			}),
		),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index("by_organization_user_workspace_resource_permission", [
			"organizationId",
			"userId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		])
		.index("by_user_organization_workspace_resource_permission", [
			"userId",
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		])
		.index("by_resource_permission", ["organizationId", "workspaceId", "resourceKind", "resourceId", "permission"])
		// Count one `content.read` row per private scope without reading every permission row.
		.index("by_user_org_workspace_kind_principal_permission_resource", [
			"userId",
			"organizationId",
			"workspaceId",
			"resourceKind",
			"principalKind",
			"permission",
			"resourceId",
		])
		.index("by_organization_workspace_resource_user_permission", [
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"userId",
			"permission",
		])
		.index("by_organization_workspace_resource_role_permission", [
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"role",
			"permission",
		])
		.index("by_organization_workspace_resource_public_permission", [
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"permission",
		])
		.index("by_organization_workspace_serviceAccount", ["organizationId", "workspaceId", "serviceAccountId"])
		.index("by_org_workspace_serviceAccount_permission_resource", [
			"organizationId",
			"workspaceId",
			"serviceAccountId",
			"principalKind",
			"permission",
			"resourceKind",
			"resourceId",
		])
		.index("by_organization_workspace_resource_serviceAccount_permission", [
			"organizationId",
			"workspaceId",
			"resourceKind",
			"resourceId",
			"principalKind",
			"serviceAccountId",
			"permission",
		])
		// Finds every grant that still points at one role, so deleting a custom role can refuse.
		// `principalKind` comes first, like in the three lookups above, instead of trusting that
		// `role` is only ever set on a doc whose principal is a role.
		.index("by_organization_role_workspace_resource", [
			"organizationId",
			"principalKind",
			"role",
			"workspaceId",
			"resourceKind",
			"resourceId",
		]),
	// #endregion access control

	// #region organizations
	organizations: defineTable({
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		billingMode: v.union(v.literal("user"), v.literal("organization_owner")),
		ownerUserId: v.id("users"),
		defaultWorkspaceId: v.optional(v.id("organizations_workspaces")),
		updatedAt: v.number(),
	})
		.index("by_name", ["name"])
		.index("by_ownerUser", ["ownerUserId"]),

	organizations_workspaces: defineTable({
		organizationId: v.id("organizations"),
		name: v.string(),
		description: v.string(),
		default: v.boolean(),
		pluginInstallAccess: plugins_management_access_validator,
		/**
		 * Keep every plugin authority door closed across delayed or bounded workspace purge.
		 */
		pluginDataPurgeStartedAt: v.optional(v.number()),
		updatedAt: v.number(),
	}).index("by_organization_default", ["organizationId", "default"]),

	organizations_workspaces_users: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		updatedAt: v.optional(v.number()),
		/**
		 * `false` during account-deletion retention so memberships stay recoverable but non-effective.
		 * `true` for normal active membership.
		 */
		active: v.boolean(),
		/**
		 * `true` while organization removal drains this member's direct grants. Account recovery must
		 * not reactivate this membership. Optional while older stored memberships have no marker.
		 */
		pendingOrganizationRemoval: v.optional(v.boolean()),
	})
		.index("by_workspace_user_active", ["workspaceId", "userId", "active"])
		.index("by_user_organization_workspace_active", ["userId", "organizationId", "workspaceId", "active"])
		.index("by_active_organization_workspace_user", ["active", "organizationId", "workspaceId", "userId"])
		.index("by_active_user_organization_workspace", ["active", "userId", "organizationId", "workspaceId"]),

	/**
	 * One doc per (workspace, user). `lifetime` bumps every time the member leaves and rejoins, so
	 * remote hosts can tell a fresh membership apart from the previous one with the same user.
	 **/
	organizations_membership_lifetimes: defineTable({
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		userId: v.id("users"),
		membershipId: v.union(v.id("organizations_workspaces_users"), v.null()),
		lifetime: v.number(),
		active: v.boolean(),
	})
		.index("by_workspace_user", ["workspaceId", "userId"])
		.index("by_user", ["userId"]),

	quotas: defineTable({
		quotaName: v.union(
			v.literal("extra_organizations"),
			v.literal("extra_workspaces"),
			v.literal("active_api_credentials"),
			v.literal("stored_file_bytes"),
			v.literal("files_private_user_bytes"),
			v.literal("files_private_workspace_bytes"),
			v.literal("files_private_nodes"),
			v.literal("ai_chat_output_workspace_bytes"),
			v.literal("ai_chat_output_user_bytes"),
			v.literal("ai_chat_output_workspace_objects"),
		),
		userId: v.optional(v.id("users")),
		organizationId: v.optional(v.id("organizations")),
		workspaceId: v.optional(v.id("organizations_workspaces")),
		usedCount: v.number(),
		maxCount: v.number(),
		createdAt: v.number(),
		updatedAt: v.number(),
		/** Cleanup keeps a private quota until its last storage hold settles. */
		retiredAt: v.optional(v.number()),
	})
		.index("by_user_quotaName", ["userId", "quotaName"])
		.index("by_organization_quotaName", ["organizationId", "quotaName"])
		.index("by_workspace_quotaName", ["workspaceId", "quotaName"])
		.index("by_user_organization_workspace_quotaName", ["userId", "organizationId", "workspaceId", "quotaName"])
		.index("by_user_retiredAt", ["userId", "retiredAt"])
		.index("by_organization_retiredAt", ["organizationId", "retiredAt"])
		.index("by_workspace_retiredAt_quotaName", ["workspaceId", "retiredAt", "quotaName"]),

	/**
	 * Which plugins and which member-added MCP servers a custom organization allows. One doc per custom
	 * organization; no doc means nothing is allowed. The personal organization allows everything and
	 * never has a doc.
	 */
	organizations_integration_policies: defineTable({
		organizationId: v.id("organizations"),
		plugins: v.object({
			mode: organizations_integration_policy_mode_validator,
			allowlist: v.array(
				v.object({
					// The same key service accounts trust: a plugin name is bound to its first publisher.
					pluginName: v.string(),
					publisherUserId: v.id("users"),
					sourceRepositoryUrl: v.string(),
					// The ceiling the owner approved. An upgrade inside it installs without the owner.
					capabilities: v.array(plugins_capability_validator),
					outboundOrigins: v.array(v.string()),
					uiOutboundOrigins: v.array(v.string()),
					// The plugin's MCP servers are allowed with the plugin, pinned by where their data goes.
					mcpServers: v.array(v.object({ serverId: v.string(), destinationFingerprint: v.string(), url: v.string() })),
					addedBy: v.id("users"),
					addedAt: v.number(),
					updatedAt: v.number(),
				}),
			),
		}),
		/**
		 * Servers members add themselves. Plugin servers never appear here.
		 */
		mcpServers: v.object({
			mode: organizations_integration_policy_mode_validator,
			allowlist: v.array(
				v.object({
					destinationFingerprint: v.string(),
					url: v.string(),
					authKind: v.union(v.literal("none"), v.literal("headers"), v.literal("oauth")),
					oauthIssuer: v.union(v.string(), v.null()),
					addedBy: v.id("users"),
					addedAt: v.number(),
				}),
			),
		}),
		updatedBy: v.id("users"),
		updatedAt: v.number(),
	}).index("by_organization", ["organizationId"]),
	// #endregion organizations

	// #region billing
	/**
	 * Cached Polar meter / spend snapshot per app user.
	 * Refreshed after usage ingest, periodically when stale, and on relevant Polar webhooks.
	 */
	billing_usage_snapshots: defineTable({
		userId: v.id("users"),
		polarCustomerId: v.union(v.string(), v.null()),
		subscription: v.union(
			v.object({
				id: v.union(v.string(), v.null()),
				productId: v.string(),
				currency: v.string(),
				currentPeriodStart: v.string(),
				currentPeriodEnd: v.string(),
			}),
			v.null(),
		),
		meter: v.union(
			v.object({
				id: v.union(v.string(), v.null()),
				consumedUnits: v.number(),
				creditedUnits: v.number(),
				balance: v.number(),
				amountDueCents: v.number(),
			}),
			v.null(),
		),
		lastSyncedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_polarCustomer_currentPeriodEnd", ["polarCustomerId", "subscription.currentPeriodEnd"])
		.index("by_lastSyncedAt", ["lastSyncedAt"]),

	/**
	 * Keep one billing-owned scheduler row per user so you can cancel or replace
	 * the current Workpool job without mixing Workpool ids into unrelated tables.
	 */
	billing_cancel_polar_subscription_jobs: defineTable({
		userId: v.id("users"),
		jobId: vWorkId,
		updatedAt: v.number(),
	}).index("by_user", ["userId"]),

	/**
	 * One receipt per billed provider request: chat steps, titles and inline AI. A receipt is saved
	 * before the request is sent, so no request runs without one. Usage only moves forward. Each
	 * charge has its own Polar event id, and its state stops a second charge.
	 *
	 * Thread, workspace and account deletion keep receipts: they hold ids and token counts only.
	 * The daily cleanup deletes final receipts after 396 days.
	 */
	ai_model_call_receipts: defineTable({
		modelCallId: v.string(),
		purpose: ai_model_call_purpose_validator,
		modelId: ai_chat_model_id_validator,
		/**
		 * The model name the provider reported. For audits only; the price uses `modelId`.
		 */
		providerModelId: v.union(v.string(), v.null()),
		/**
		 * The provider's id for the request. The recovery cron uses it to look up missing usage.
		 */
		responseId: v.union(v.string(), v.null()),
		threadId: v.union(v.id("ai_chat_threads"), v.null()),
		/**
		 * The run that made the request. Null for inline AI and the title route.
		 */
		runId: v.union(v.id("ai_chat_runs"), v.null()),
		billedUserId: v.id("users"),
		actorUserId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		admittedAt: v.number(),
		usage: v.union(
			v.object({ state: v.literal("pending") }),
			v.object({
				state: v.literal("reported"),
				inputTokens: v.number(),
				outputTokens: v.number(),
				cachedInputTokens: v.union(v.number(), v.null()),
				reasoningTokens: v.union(v.number(), v.null()),
				reportedCostUsd: v.union(v.number(), v.null()),
			}),
			v.object({
				/**
				 * `missing` still waits for recovery lookups. `missing_final` ends them. A later
				 * reported save is still billed.
				 */
				state: v.union(v.literal("missing"), v.literal("missing_final")),
				reason: v.union(v.literal("no_usage"), v.literal("provider_error"), v.literal("no_finish")),
			}),
		),
		recoveryAttempts: v.number(),
		/**
		 * When the recovery cron looks at this receipt next. Null once usage is reported or final.
		 */
		nextRecoveryAt: v.union(v.number(), v.null()),
		tokens: v.union(ai_model_call_charge_validator, v.null()),
		images: v.array(v.object({ imageCallId: v.string(), charge: ai_model_call_charge_validator })),
	})
		.index("by_modelCallId", ["modelCallId"])
		.index("by_nextRecoveryAt", ["nextRecoveryAt"])
		.index("by_admittedAt", ["admittedAt"]),
	// #endregion billing

	// #region users
	users_anon_tokens: defineTable({
		userId: v.id("users"),
		/** The current refresh JWT. The refresh route only accepts a byte-equal presented token. */
		token: v.string(),
		/**
		 * The refresh JWT this row held before the last rotation. A tab that raced the rotation can
		 * still present it once and receive the current token back, so the shared localStorage copy
		 * converges instead of falling into 401 → storage clear → new anonymous user. This is the
		 * standard grace window for refresh-token rotation; Auth0's rotation docs call it the
		 * "reuse interval" (see also RFC 9700 §4.14 on rotation).
		 */
		previousToken: v.optional(v.string()),
		updatedAt: v.number(),
	}).index("by_user", ["userId"]),

	users: defineTable({
		/** Clerk user ID, null for anonymous users */
		clerkUserId: v.union(v.string(), v.null()),
		anonymousAuthToken: v.optional(v.id("users_anon_tokens")),
		defaultOrganizationId: v.optional(v.id("organizations")),
		defaultWorkspaceId: v.optional(v.id("organizations_workspaces")),
		anagraphic: v.optional(v.id("users_anagraphics")),
		deletedAt: v.optional(v.number()),
		/**
		 * Block account recovery while destructive deletion spans more than one transaction.
		 */
		deletionFinalizationStartedAt: v.optional(v.number()),
	}).index("by_clerkUser", ["clerkUserId"]),

	/**
	 * The last presence heartbeat from any visible app tab. It is kept out of `users` because it
	 * changes often, and many queries read `users`. Pending drafts do not expire while it is recent.
	 */
	users_last_active: defineTable({
		userId: v.id("users"),
		lastActiveAt: v.number(),
	}).index("by_user", ["userId"]),

	users_anagraphics: defineTable({
		userId: v.id("users"),
		/** Display name, e.g. "Anonymous user <id>" for anonymous users */
		displayName: v.string(),
		avatarUrl: v.optional(v.string()),
		/** Normalized signed-in email kept for deleted-account recovery after Clerk deletion. */
		email: v.string(),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_email", ["email"]),

	clerk_webhook_receipts: defineTable({
		eventId: v.string(),
		eventType: v.string(),
		clerkUserId: v.optional(v.string()),
		receivedAt: v.number(),
	}).index("by_event", ["eventId"]),

	notifications: defineTable({
		userId: v.id("users"),
		kind: v.literal("organization_workspace_invite"),
		/**
		 * 0 means not archived. It holds the dismiss time once the user archives it. It is mandatory
		 * so indexes can filter on it.
		 */
		archivedAt: v.number(),
		actorUserId: v.id("users"),
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		updatedAt: v.number(),
	})
		.index("by_user", ["userId"])
		.index("by_user_archivedAt", ["userId", "archivedAt"])
		.index("by_organization_user_archivedAt", ["organizationId", "userId", "archivedAt"])
		.index("by_organization_workspace_user", ["organizationId", "workspaceId", "userId"]),

	// #endregion users
});

// Shared handler contracts live with the schema to avoid Files import cycles.
export const file_content_materialization_state_validator = v.object({
	fileNode: doc(app_convex_schema, "files_nodes"),
	yjsSnapshotDoc: doc(app_convex_schema, "files_yjs_snapshots"),
	yjsLastSequenceDoc: doc(app_convex_schema, "files_yjs_docs_last_sequences"),
	yjsUpdatesDocs: v.array(doc(app_convex_schema, "files_yjs_updates")),
	asset: doc(app_convex_schema, "files_r2_assets"),
	yjsSnapshotAsset: doc(app_convex_schema, "files_r2_assets"),
});

export const file_content_materialization_header_validator = v.object({
	fileNode: doc(app_convex_schema, "files_nodes"),
	yjsSnapshotDoc: doc(app_convex_schema, "files_yjs_snapshots"),
	yjsLastSequenceDoc: doc(app_convex_schema, "files_yjs_docs_last_sequences"),
	asset: doc(app_convex_schema, "files_r2_assets"),
	yjsSnapshotAsset: doc(app_convex_schema, "files_r2_assets"),
	/**
	 * Later update reads stop here. A concurrent push belongs to the next materialization.
	 */
	throughSequence: v.number(),
});

export default app_convex_schema;

export { app_convex_schema };

// @ts-expect-error unused type
type _ = ai_chat_UiMessage;
