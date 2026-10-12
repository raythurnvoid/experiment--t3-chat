// Fixtures shared by the plugins test files.
import { R2 } from "@convex-dev/r2";
import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { vi } from "vitest";

import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { plugins_ai_review } from "./plugins.ts";
import * as activities from "./activities_db.ts";
import { test_convex } from "./setup.test.ts";
import { type plugins_Capability } from "../shared/plugins.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";

export type ReviewVerdict = {
	verdict: "passed" | "rejected" | "flagged" | "incomplete";
	findings: Array<{ message: string; evidence: Array<{ path: string; quote: string }> }>;
};
export type ReviewInput = { system: string; prompt: string; abortSignal?: AbortSignal };
// Script provider replies; the real SDK runs the loop and the production tools.
export const review_model = {
	submit: vi.fn<(input: ReviewInput) => Promise<ReviewVerdict>>(),
};
export const review_provider = vi.fn<typeof plugins_ai_review.model.doGenerate>();

export function model_reply(content: Awaited<ReturnType<typeof plugins_ai_review.model.doGenerate>>["content"]) {
	return {
		content,
		finishReason: content.some((part) => part.type === "tool-call")
			? { unified: "tool-calls" as const, raw: "tool_calls" }
			: { unified: "stop" as const, raw: "stop" },
		usage: {
			inputTokens: { total: 1000, noCache: 1000, cacheRead: undefined, cacheWrite: undefined },
			outputTokens: { total: 10, text: 10, reasoning: undefined },
		},
		warnings: [],
	};
}

// Each test file calls this in `beforeEach`.
export function mock_plugins_review() {
	vi.spyOn(plugins_ai_review, "count_input_tokens").mockResolvedValue(1_000);
	review_model.submit.mockReset().mockResolvedValue({ verdict: "passed", findings: [] });
	vi.spyOn(plugins_ai_review.model, "doGenerate").mockImplementation(review_provider);
	const streamingModel = wrapLanguageModel({
		model: plugins_ai_review.model,
		middleware: simulateStreamingMiddleware(),
	});
	vi.spyOn(plugins_ai_review.model, "doStream").mockImplementation((options) => streamingModel.doStream(options));
	review_provider.mockReset().mockImplementation(async (options) => {
		const input = {
			system: options.prompt
				.filter((message) => message.role === "system")
				.map((message) => message.content)
				.join("\n"),
			prompt: JSON.stringify(options.prompt),
			abortSignal: options.abortSignal,
		};
		// Invalid submissions stop in these fixtures. Repair tests script further calls explicitly.
		if (
			options.prompt.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "tool-call" && part.toolName === "submit_review"),
			)
		) {
			return model_reply([{ type: "text", text: "Unable to complete this review." }]);
		}
		const submitting = options.prompt.some((message) => message.role === "tool");
		return model_reply([
			{
				type: "tool-call",
				toolCallId: `review-${review_provider.mock.calls.length}`,
				toolName: submitting ? "submit_review" : "bash",
				input: JSON.stringify(
					submitting
						? await review_model.submit(input)
						: { command: 'for file in $(find . -type f); do cat "$file"; done' },
				),
			},
		]);
	});
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey?: string) => ({
		key: customKey ?? "test-upload-key",
		url: customKey?.startsWith("organizations/GLOBAL/workspaces/PLUGINS/")
			? "https://r2.test/source-upload"
			: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.spyOn(R2.prototype, "deleteObject").mockResolvedValue(undefined);
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
}

export function user_identity(userId: Id<"users">) {
	return {
		issuer: "https://clerk.test",
		subject: `clerk-${userId}`,
		external_id: userId,
		email: "plugin-test@example.com",
	};
}

export async function insert_plugin_run(
	ctx: MutationCtx,
	args: Omit<Doc<"plugins_event_runs">, "_id" | "_creationTime"> &
		Pick<Doc<"activities">, "status" | "deadlineAt" | "errorMessage" | "updatedAt"> &
		Partial<Pick<Doc<"activities">, "startedAt" | "finishedAt">>,
) {
	const { status, deadlineAt, errorMessage, updatedAt, startedAt, finishedAt, ...run } = args;
	const version = await ctx.db.get("plugins_versions", run.pluginVersionId);
	if (!version) throw new Error("Expected plugin version");
	const runId = await ctx.db.insert("plugins_event_runs", run);
	const terminalAt = activities.activities_is_active(status) ? undefined : (finishedAt ?? updatedAt);
	await ctx.db.insert("activities", {
		organizationId: run.organizationId,
		workspaceId: run.workspaceId,
		userId: run.actorUserId,
		source: {
			kind: "plugin_run",
			id: runId,
			installationId: run.installationId,
			pluginName: version.name,
			event: run.event,
			serializationKey: run.serializationKey,
		},
		title: version.displayName,
		targets: [],
		visibility: "shared",
		feedVisible: false,
		resultKind: "plugin_result",
		status,
		deadlineAt,
		errorMessage,
		updatedAt,
		startedAt,
		finishedAt: terminalAt,
		expiresAt: terminalAt === undefined ? undefined : terminalAt + 30 * 24 * 60 * 60 * 1000,
	});
	return runId;
}

export function runner_response_headers(args: {
	kind: "invoke" | "event" | "error";
	runId?: string;
	pluginStatus?: number;
	elapsedMs?: number;
	outputBytes?: number;
	bodyBytes: number;
}) {
	const headers = new Headers({ "Content-Type": "application/json" });
	for (const [name, value] of Object.entries({
		Kind: args.kind,
		"Run-Id": args.runId,
		"Plugin-Status": args.pluginStatus,
		"Elapsed-Ms": args.elapsedMs,
		"Output-Bytes": args.outputBytes,
		"Body-Bytes": args.bodyBytes,
	})) {
		if (value !== undefined) headers.set(`X-Bonobo-Runner-${name}`, String(value));
	}
	return headers;
}

export function runner_success_response(args: {
	kind: "invoke" | "event";
	runId: string;
	pluginStatus: number;
	elapsedMs: number;
	output: string;
}) {
	const outputBytes = new TextEncoder().encode(args.output).byteLength;
	const body = JSON.stringify(
		args.kind === "invoke"
			? { runId: args.runId, pluginStatus: args.pluginStatus, output: args.output }
			: { _yay: { pluginRunId: args.runId, pluginStatus: args.pluginStatus, elapsedMs: args.elapsedMs, outputBytes } },
	);
	return new Response(body, {
		status: 200,
		headers: runner_response_headers({ ...args, outputBytes, bodyBytes: new TextEncoder().encode(body).byteLength }),
	});
}

export const media_configuration_yaml = "triggers:\n  files.upload.completed:\n    folders:\n      - /\n";
export const media_event_filters = [
	{
		field: "source.path" as const,
		operator: "pathIsUnderAny" as const,
		configurationPath: ["triggers", "files.upload.completed", "folders"],
	},
];

export async function register_media_plugin(args: {
	t: ReturnType<typeof test_convex>;
	userId: Id<"users">;
	repositoryId?: Id<"plugins_publisher_repositories">;
	name?: string;
	displayName?: string;
	version?: string;
	contentTypes?: string[];
	events?: Doc<"plugins_versions">["events"];
	configurable?: boolean;
	artifactHash?: string;
	sourceRepositoryUrl?: string;
	sourceOwner?: string;
	sourceRepo?: string;
	sourceCommitSha?: string;
	outboundOrigins?: string[];
	uiOutboundOrigins?: string[];
	capabilities?: plugins_Capability[];
	pages?: Doc<"plugins_versions">["pages"];
	endpoints?: Doc<"plugins_versions">["endpoints"];
	mcpServers?: Doc<"plugins_versions">["mcpServers"];
	mcpServersFingerprint?: string;
	skills?: Doc<"plugins_versions">["skills"];
	secrets?: Array<{ name: string; description: string; optional: boolean }>;
	sourceFiles?: Array<{ path: string; rawText: string }>;
}) {
	const { t, userId } = args;

	const name = args.name ?? "media";
	const version = args.version ?? "0.1.0";
	const sourceRepositoryUrl = args.sourceRepositoryUrl ?? `https://github.com/bonobo/${name}-plugin`;
	const sourceOwner = args.sourceOwner ?? "bonobo";
	const sourceRepo = args.sourceRepo ?? `${name}-plugin`;
	const repositoryId =
		args.repositoryId ??
		(await t.run(async (ctx) => {
			const existing = await ctx.db
				.query("plugins_publisher_repositories")
				.withIndex("by_ownerUser_repositoryUrl", (q) =>
					q.eq("ownerUserId", userId).eq("repositoryUrl", sourceRepositoryUrl),
				)
				.first();
			return (
				existing?._id ??
				(await ctx.db.insert("plugins_publisher_repositories", {
					ownerUserId: userId,
					repositoryUrl: sourceRepositoryUrl,
					owner: sourceOwner,
					repo: sourceRepo,
				}))
			);
		}));
	const registered = await t.action(internal.plugins.register_plugin_version, {
		repositoryId,
		name,
		displayName: args.displayName ?? "Media",
		version,
		description: "Image and video markdown generation",
		reviewStatus: "passed",
		reviewId: null,
		artifactHash: args.artifactHash ?? `sha256:${"a".repeat(64)}`,
		sourceRepositoryUrl,
		sourceOwner,
		sourceRepo,
		sourceCommitSha: args.sourceCommitSha ?? "1234567890abcdef1234567890abcdef12345678",
		manifestR2Key: `plugins/${name}/manifest.json`,
		backendEntrypointFile: {
			entry: "dist/backend/worker.js",
			moduleName: "plugin.js",
			r2Key: `plugins/${name}/backend/worker.js`,
			sha256: `sha256:${"b".repeat(64)}`,
			compatibilityDate: "2026-07-01",
			compatibilityFlags: ["nodejs_compat"],
		},
		configuration:
			args.configurable === false
				? null
				: {
						description: "Choose which upload folders start this plugin.",
						defaultYaml: media_configuration_yaml,
					},
		mounts: [],
		events: args.events ?? [
			{
				type: "files.upload.completed",
				contentTypes: args.contentTypes ?? ["image/png", "video/mp4"],
				filters: args.configurable === false ? [] : media_event_filters,
			},
		],
		pages: args.pages ?? [],
		fileViews: [],
		endpoints: args.endpoints ?? [],
		capabilities: args.capabilities ?? ["plugin.secrets.read", "outbound.fetch"],
		outboundOrigins: args.outboundOrigins ?? [],
		uiOutboundOrigins: args.uiOutboundOrigins ?? [],
		mcpServers: args.mcpServers ?? [],
		mcpServersFingerprint: args.mcpServersFingerprint ?? "mcp-servers-hash",
		skills: args.skills ?? [],
		secrets: args.secrets ?? [],
		userWritableCollections: null,
		files: [
			{
				path: "dist/backend/worker.js",
				sha256: `sha256:${"b".repeat(64)}`,
				bytes: 128,
				contentType: "application/javascript",
				r2Key: `plugins/${name}/backend/worker.js`,
			},
		],
		createdBy: userId,
		sourceFiles: args.sourceFiles ?? [{ path: "dist/backend/worker.js", rawText: `export const plugin = '${name}';` }],
	});
	if (registered._nay) {
		throw new Error(registered._nay.message);
	}
	return { ...registered._yay, repositoryId };
}

export const media_plugin_consent: {
	acceptedCapabilities: plugins_Capability[];
	acceptedOutboundOrigins: string[];
	acceptedUiOutboundOrigins: string[];
	acceptedMcpServersFingerprint: string;
	acceptedSkillNames: string[];
	serviceAccountGrants: Array<{ resource: { kind: "workspace" }; level: "manage" }>;
} = {
	acceptedCapabilities: ["plugin.secrets.read", "outbound.fetch"],
	acceptedOutboundOrigins: [],
	acceptedUiOutboundOrigins: [],
	acceptedMcpServersFingerprint: "mcp-servers-hash",
	acceptedSkillNames: [],
	// File runtime fixtures explicitly authorize their test account's content operations.
	serviceAccountGrants: [{ resource: { kind: "workspace" }, level: "manage" }],
};

export async function sha256_text(value: string) {
	return `sha256:${await crypto_sha256_hex(value)}`;
}

/**
 * Workpool executor items come due immediately (no settle delay), so runs enqueued by a test
 * that never executes them can fire mid-way through a later test and consume its single-use
 * mocked fetch Response. Drain them here, inside this test's own mock window; the drained
 * executors fail against the default fetch stub, which is fine after the test's assertions.
 */
export async function drain_scheduled_work(t: ReturnType<typeof test_convex>) {
	for (let i = 0; i < 20; i++) {
		// Scheduled functions arm through real timers; yield a macrotask so due timers fire
		// before waiting on the in-flight batch.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await t.finishInProgressScheduledFunctions();
	}
}

export async function drain_plugin_registry_delete(args: {
	t: ReturnType<typeof test_convex>;
	pluginName: string;
	testBatchSize?: number;
}) {
	const { t, pluginName, testBatchSize } = args;

	for (let step = 0; step < 1_000; step += 1) {
		const result = await t.mutation(internal.plugins.hard_delete_plugin_from_registry, {
			pluginName,
			_test_batchSize: testBatchSize,
		});
		if (result.done) return;
		if (result.deleted === 0) {
			throw new Error(`Hard delete of plugin "${pluginName}" is waiting for active work`);
		}
	}
	throw new Error(`Hard delete of plugin "${pluginName}" did not finish`);
}
