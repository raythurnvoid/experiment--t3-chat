import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import type { Doc } from "./_generated/dataModel.js";
import { playwriter_browser_db_disconnect } from "./playwriter_browser.ts";
import { files_browser_db_purge_workspace_batch } from "./files_browser.ts";
import { crypto_encrypt_secret_value } from "../server/crypto-utils.ts";
import {
	playwriter_browser_connect_schema,
	playwriter_browser_access_schema,
	playwriter_browser_control_schema,
	playwriter_browser_disconnect_schema,
	playwriter_browser_reconnect_schema,
	type PlaywriterBrowserRuntime,
} from "common/playwriter-browser.ts";

beforeEach(() => {
	vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "true");
	vi.stubEnv("AI_CHAT_PLAYWRITER_ENABLED", "true");
	vi.stubEnv("BROWSER_RUNNER_URL", "https://browser-runner.test");
	vi.stubEnv("BROWSER_RUNNER_SECRET", "test-runner-secret");
	vi.stubEnv("BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY", "test-remote-key");
	vi.stubEnv("BROWSER_PLAYWRITER_ALLOWED_VERSIONS", "0.5.0");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("No real network in this test");
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const created = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "shared-browser-chat",
	});
	if (created._nay) throw new Error(created._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const message = await asUser.mutation(api.ai_chat.thread_messages_add, {
		membershipId: db.membershipId,
		threadId: created._yay.threadId,
		messages: [
			{
				clientGeneratedMessageId: "browser-source",
				content: { id: "browser-source", role: "user", parts: [{ type: "text", text: "Read the browser" }] },
			},
		],
	});
	if (message._nay) throw new Error(message._nay.message);
	const source = {
		...db,
		threadId: created._yay.threadId,
		sourceMessageId: message._yay.ids[0]!,
		membershipLifetime: captured._yay.membershipLifetime,
	};
	return { t, db, asUser, source };
}

function runtime(
	connection: Doc<"playwriter_connections">,
	state: "connected" | "awaiting_confirmation" = "connected",
) {
	return {
		generation: Math.max(1, connection.connectionGeneration),
		state,
		targets: [{ targetId: "native-tab-private", title: "QA fixture", url: "https://example.com/page?secret=private" }],
		confirmedTargetId: state === "connected" ? "native-tab-private" : null,
		targetRevision: 1,
		inventoryRevision: 1,
		navRevision: connection.navRevision,
		controlRevision: connection.controlRevision,
		policyRevision: 0,
		selectionRevision: 0,
		agentAccess: true,
		operations: connection.operations,
		idleExpiresAt: connection.idleExpiresAt,
		totalExpiresAt: connection.totalExpiresAt!,
		sessionId: connection.sessionId,
	};
}

function completed_lease(
	connection: Doc<"playwriter_connections">,
	navRevision = connection.navRevision,
	targetRevision = connection.targetRevision,
) {
	return {
		generation: connection.connectionGeneration,
		controlRevision: connection.controlRevision,
		policyRevision: 0,
		selectionRevision: 1,
		confirmedTargetId: connection.confirmedTargetId!,
		navRevision,
		targetRevision,
	};
}

async function connection(f: Awaited<ReturnType<typeof fixture>>, ready = true) {
	const prepared = await f.t.mutation(internal.playwriter_browser.prepare_connect, {
		userId: f.db.userId,
		membershipId: f.db.membershipId,
		linkFingerprint: "a".repeat(64),
	});
	if (prepared._nay) throw new Error(prepared._nay.message);
	const doc = prepared._yay.connection;
	const encrypted = await crypto_encrypt_secret_value(
		"a".repeat(32),
		JSON.stringify(["playwriter-share", doc._id, doc.ownerId, doc.organizationId, doc.workspaceId]),
		"BROWSER_REMOTE_SECRETS_ENCRYPTION_KEY",
	);
	await f.t.mutation(internal.playwriter_browser.store_credential, {
		connectionId: doc._id,
		attemptId: doc.connectAttemptId,
		encryptedShareId: encrypted.ciphertext,
		shareNonce: encrypted.nonce,
	});
	await f.t.mutation(internal.playwriter_browser.commit_runtime, {
		connectionId: doc._id,
		attemptId: doc.connectAttemptId,
		expectedControlRevision: doc.controlRevision,
		runtime: runtime(doc, ready ? "connected" : "awaiting_confirmation"),
	});
	const saved = await f.t.run((ctx) => ctx.db.get("playwriter_connections", doc._id));
	if (!saved) throw new Error("Missing connection");
	const browserIntent = {
		webChoice: {
			provider: "playwriter" as const,
			connectionId: saved._id,
			confirmedTargetHandle: saved.confirmedTargetHandle!,
		},
		selectionRevision: 1,
		policyRevision: 0,
	};
	if (ready)
		await f.t.run((ctx) =>
			ctx.db.insert("files_browser_preferences", {
				ownerId: f.db.userId,
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				...browserIntent,
				webAgentAccess: true,
				agentBlockedHosts: [],
				syncPending: false,
				updatedAt: Date.now(),
			}),
		);
	const resource = {
		provider: "playwriter" as const,
		connectionId: saved._id,
		connectionGeneration: saved.connectionGeneration,
		targetRevision: saved.targetRevision,
		controlRevision: saved.controlRevision,
		navRevision: saved.navRevision,
		confirmedTargetHandle: saved.confirmedTargetHandle!,
	};
	return { saved, browserIntent, resource };
}

async function connect_response(f: Awaited<ReturnType<typeof fixture>>, body: unknown) {
	const input = playwriter_browser_connect_schema.parse(JSON.parse(String(body)));
	const doc = await f.t.run(async (ctx) => {
		const id = ctx.db.normalizeId("playwriter_connections", input.connectionId);
		return id ? ctx.db.get("playwriter_connections", id) : null;
	});
	if (!doc) throw new Error("Missing admitted connection");
	return Response.json({ ok: true, runtime: runtime(doc, "awaiting_confirmation") });
}

describe("remote_browser_available", () => {
	test("requires a current app user", async () => {
		const f = await fixture();
		await expect(
			f.t.query(api.playwriter_browser.remote_browser_available, { membershipId: f.db.membershipId }),
		).rejects.toThrow("Unauthenticated");
	});
	test("checks flags and a valid version allowlist", async () => {
		const f = await fixture();
		expect(
			await f.asUser.query(api.playwriter_browser.remote_browser_available, { membershipId: f.db.membershipId }),
		).toEqual({ enabled: true, hasSavedConnection: false });
		vi.stubEnv("BROWSER_PLAYWRITER_ALLOWED_VERSIONS", "not-a-version");
		expect(
			await f.asUser.query(api.playwriter_browser.remote_browser_available, { membershipId: f.db.membershipId }),
		).toEqual({ enabled: false, hasSavedConnection: false });
	});
});

describe("prepare_connect", () => {
	test("reserves one link and reuses it only for its owner and workspace", async () => {
		const f = await fixture();
		const c = await connection(f);
		const again = await f.t.mutation(internal.playwriter_browser.prepare_connect, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			linkFingerprint: "a".repeat(64),
		});
		expect(again._yay).toMatchObject({ reused: true, connection: { _id: c.saved._id } });
		const other = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, { organizationName: "other-browser-owner" }),
		);
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.prepare_connect, {
					userId: other.userId,
					membershipId: other.membershipId,
					linkFingerprint: "a".repeat(64),
				})
			)._nay?.name,
		).toBe("link_reserved");
	});
	test("refuses a second saved link in the same scope", async () => {
		const f = await fixture();
		await connection(f);
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.prepare_connect, {
					userId: f.db.userId,
					membershipId: f.db.membershipId,
					linkFingerprint: "b".repeat(64),
				})
			)._nay?.name,
		).toBe("busy");
	});
	test("enforces the UTC daily connection limit before reserving", async () => {
		const f = await fixture();
		await f.t.run((ctx) =>
			ctx.db.insert("playwriter_user_daily_use", {
				userId: f.db.userId,
				day: new Date().toISOString().slice(0, 10),
				starts: 50,
			}),
		);
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.prepare_connect, {
					userId: f.db.userId,
					membershipId: f.db.membershipId,
					linkFingerprint: "a".repeat(64),
				})
			)._nay?.name,
		).toBe("limit");
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connections").collect())).toHaveLength(0);
	});
});

describe("connect_tab", () => {
	beforeEach(() => vi.useFakeTimers());

	test.each(["disconnect", "close"] as const)("holds the user cap until %s cleanup is proved", async (operation) => {
		const f = await fixture();
		const c = await connection(f);
		const memberships = await f.t.run((ctx) => ctx.db.query("organizations_workspaces_users").collect());
		const second = memberships.find((item) => item.organizationId !== f.db.organizationId)!;
		const third = memberships.find(
			(item) => item.organizationId === f.db.organizationId && item.workspaceId !== f.db.workspaceId,
		)!;
		vi.mocked(fetch).mockImplementation(async (url, options) =>
			String(url).endsWith("/connect")
				? connect_response(f, options?.body)
				: Response.json({ ok: false, error: { code: "cleanup_unknown", message: "cleanup pending" } }, { status: 409 }),
		);
		expect(
			(
				await f.asUser.action(api.playwriter_browser.connect_tab, {
					membershipId: second._id,
					share: "b".repeat(32),
				})
			)._yay,
		).toBeTruthy();
		if (operation === "disconnect")
			expect(
				(
					await f.asUser.action(api.playwriter_browser.disconnect_connection, {
						membershipId: f.db.membershipId,
						connectionId: c.saved._id,
					})
				)._yay,
			).toBeTruthy();
		else
			expect(
				(
					await f.t.mutation(internal.playwriter_browser.retire_session, {
						source: f.source,
						browserIntent: c.browserIntent,
						resource: c.resource,
					})
				)._yay,
			).toBeTruthy();

		let started!: () => void;
		let release!: (response: Response) => void;
		const began = new Promise<void>((resolve) => {
			started = resolve;
		});
		const proof = new Promise<Response>((resolve) => {
			release = resolve;
		});
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			if (String(url).endsWith("/disconnect")) {
				started();
				return await proof;
			}
			return connect_response(f, options?.body);
		});
		const cleanup = f.t.action(internal.playwriter_browser.process_cleanups, {});
		await began;
		try {
			const refused = await f.asUser.action(api.playwriter_browser.connect_tab, {
				membershipId: third._id,
				share: "c".repeat(32),
			});
			expect(refused._nay?.name, "Connect must keep an unsettled socket in the user cap").toBe("limit");
		} finally {
			release(
				Response.json(
					{ ok: false, error: { code: "connection_forgotten", message: "connection forgotten" } },
					{ status: 410 },
				),
			);
			await cleanup;
		}
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(0);
		expect(
			(
				await f.asUser.action(api.playwriter_browser.connect_tab, {
					membershipId: third._id,
					share: "c".repeat(32),
				})
			)._yay,
			"Connect may use the slot only after cleanup proof",
		).toBeTruthy();
	});

	test("counts duplicate cleanup jobs once and keeps their scope after parent purge", async () => {
		const f = await fixture();
		const c = await connection(f);
		const memberships = await f.t.run((ctx) => ctx.db.query("organizations_workspaces_users").collect());
		const second = memberships.find((item) => item.organizationId !== f.db.organizationId)!;
		const third = memberships.find(
			(item) => item.organizationId === f.db.organizationId && item.workspaceId !== f.db.workspaceId,
		)!;
		vi.mocked(fetch).mockImplementation(async (url, options) =>
			String(url).endsWith("/connect")
				? connect_response(f, options?.body)
				: Response.json({ ok: false, error: { code: "cleanup_unknown", message: "cleanup pending" } }, { status: 409 }),
		);
		await f.asUser.action(api.playwriter_browser.disconnect_connection, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
		});
		await f.t.run((ctx) =>
			ctx.db.insert("playwriter_connection_cleanups", {
				ownerId: c.saved.ownerId,
				organizationId: c.saved.organizationId,
				workspaceId: c.saved.workspaceId,
				connectionId: c.saved._id,
				generation: c.saved.connectionGeneration,
				forgetCredential: false,
				attempts: 0,
				nextAttemptAt: Date.now(),
			}),
		);
		expect(
			(
				await f.asUser.action(api.playwriter_browser.connect_tab, {
					membershipId: second._id,
					share: "b".repeat(32),
				})
			)._yay,
			"Duplicate cleanup jobs must hold only one socket slot",
		).toBeTruthy();

		vi.mocked(fetch).mockImplementation(async (url, options) => {
			if (String(url).endsWith("/connect")) return connect_response(f, options?.body);
			const input = playwriter_browser_disconnect_schema.parse(JSON.parse(String(options?.body)));
			const code = input.generation === undefined ? "connection_forgotten" : "cleanup_unknown";
			return Response.json({ ok: false, error: { code, message: "fixed cleanup result" } }, { status: 410 });
		});
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		await f.t.run((ctx) =>
			files_browser_db_purge_workspace_batch(ctx, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				batchSize: 10,
			}),
		);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(1);
		const refused = await f.asUser.action(api.playwriter_browser.connect_tab, {
			membershipId: third._id,
			share: "c".repeat(32),
		});
		expect(refused._nay?.name, "Connect must count cleanup after its parent doc was purged").toBe("limit");

		vi.setSystemTime(Date.now() + 60_001);
		vi.mocked(fetch).mockImplementation(async (url, options) =>
			String(url).endsWith("/connect")
				? connect_response(f, options?.body)
				: Response.json(
						{ ok: false, error: { code: "connection_forgotten", message: "connection forgotten" } },
						{ status: 410 },
					),
		);
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		expect(
			(
				await f.asUser.action(api.playwriter_browser.connect_tab, {
					membershipId: third._id,
					share: "c".repeat(32),
				})
			)._yay,
		).toBeTruthy();
	});

	test("counts distinct pending sockets beyond a duplicate cleanup prefix", async () => {
		const f = await fixture();
		vi.mocked(fetch).mockImplementation(async (url, options) =>
			String(url).endsWith("/connect")
				? connect_response(f, options?.body)
				: Response.json({ ok: false, error: { code: "cleanup_unknown", message: "cleanup pending" } }, { status: 409 }),
		);
		for (let i = 0; i < 10; i++) {
			const other = await f.t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: `capacity-${i}` }),
			);
			const asOther = f.t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId });
			const opened = await asOther.action(api.playwriter_browser.connect_tab, {
				membershipId: other.membershipId,
				share: i.toString(16).padStart(32, "0"),
			});
			expect(opened._yay).toBeTruthy();
			await asOther.action(api.playwriter_browser.disconnect_connection, {
				membershipId: other.membershipId,
				connectionId: opened._yay!.connectionId,
			});
			await f.t.run((ctx) =>
				ctx.db.insert("playwriter_connection_cleanups", {
					ownerId: other.userId,
					organizationId: other.organizationId,
					workspaceId: other.workspaceId,
					connectionId: opened._yay!.connectionId,
					generation: 1,
					forgetCredential: false,
					attempts: 0,
					nextAttemptAt: Date.now(),
				}),
			);
		}
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(20);
		const refused = await f.asUser.action(api.playwriter_browser.connect_tab, {
			membershipId: f.db.membershipId,
			share: "f".repeat(32),
		});
		expect(refused._nay?.name, "Connect must count distinct pending sockets across duplicate cleanup prefixes").toBe(
			"limit",
		);
	});
});

describe("commit_runtime", () => {
	test.each([false, true])("refresh keeps only a current-generation acknowledgement: newer=%s", async (newer) => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.reserve_command, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "read-1",
			operationHash: "c".repeat(64),
		});
		const running = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		await f.t.mutation(internal.playwriter_browser.finish_command, {
			connectionId: running._id,
			identity: running.unresolvedCommand!,
			result: { status: "succeeded", reason: null },
			fenced: true,
			runtime: runtime(running),
			completedLease: completed_lease(running),
		});
		vi.mocked(fetch).mockResolvedValue(
			Response.json({
				ok: true,
				runtime: { ...runtime(running), generation: running.connectionGeneration + Number(newer) },
			}),
		);
		await f.asUser.action(api.playwriter_browser.refresh_connection_status, {
			membershipId: f.db.membershipId,
			connectionId: running._id,
		});
		const saved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", running._id)))!;
		expect(saved.pendingAcknowledgement).toEqual(newer ? null : running.unresolvedCommand);
		expect(saved.connectionGeneration).toBe(running.connectionGeneration + Number(newer));
	});
	test("keeps opaque target handles and drops URL query values", async () => {
		const f = await fixture();
		const c = await connection(f);
		const publicConnection = await f.asUser.query(api.playwriter_browser.current_connection, {
			membershipId: f.db.membershipId,
		});
		expect(publicConnection?.target?.url).toBe("https://example.com");
		expect(JSON.stringify(publicConnection)).not.toContain("native-tab-private");
		expect(JSON.stringify(publicConnection)).not.toContain("encryptedShareId");
		await f.t.mutation(internal.playwriter_browser.commit_runtime, {
			connectionId: c.saved._id,
			attemptId: c.saved.connectAttemptId,
			expectedControlRevision: c.saved.controlRevision,
			runtime: runtime(c.saved),
		});
		expect(
			(await f.asUser.query(api.playwriter_browser.current_connection, { membershipId: f.db.membershipId }))?.target
				?.handle,
		).toBe(c.saved.confirmedTargetHandle);
	});
	test("a late connect cannot undo human Pause", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.prepare_control, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			operation: "pause",
		});
		expect(
			await f.t.mutation(internal.playwriter_browser.commit_runtime, {
				connectionId: c.saved._id,
				attemptId: c.saved.connectAttemptId,
				expectedControlRevision: c.saved.controlRevision,
				runtime: runtime(c.saved),
			}),
		).toBe(false);
		expect((await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))?.pauseReason).toBe("human");
	});
	test("does not adopt a receipt from a different automation session", async () => {
		const f = await fixture();
		const c = await connection(f);
		expect(
			await f.t.mutation(internal.playwriter_browser.commit_runtime, {
				connectionId: c.saved._id,
				attemptId: c.saved.connectAttemptId,
				expectedControlRevision: c.saved.controlRevision,
				runtime: { ...runtime(c.saved), sessionId: "another-session" },
			}),
		).toBe(false);
	});
	test.each(["targetRevision", "navRevision", "inventoryRevision"] as const)(
		"a delayed status cannot roll back %s in the same generation",
		async (revision) => {
			const f = await fixture();
			const c = await connection(f);
			const newer = { ...runtime(c.saved), [revision]: c.saved[revision] + 1 };
			const args = {
				connectionId: c.saved._id,
				attemptId: c.saved.connectAttemptId,
				expectedControlRevision: c.saved.controlRevision,
			};
			expect(await f.t.mutation(internal.playwriter_browser.commit_runtime, { ...args, runtime: newer })).toBe(true);
			expect(
				await f.t.mutation(internal.playwriter_browser.commit_runtime, { ...args, runtime: runtime(c.saved) }),
			).toBe(false);
			expect((await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))?.[revision]).toBe(
				newer[revision],
			);
		},
	);
});

describe("confirm_tab", () => {
	test("confirms the exact shared about:blank tab from refreshed inventory", async () => {
		const f = await fixture();
		const c = await connection(f, false);
		const targets = [{ targetId: "native-tab-private", title: "Blank tab", url: "about:blank" }];
		vi.mocked(fetch).mockImplementation(async (url, options) =>
			Response.json({
				ok: true,
				runtime: {
					...runtime(c.saved, String(url).endsWith("/status") ? "awaiting_confirmation" : "connected"),
					targets,
					...(String(url).endsWith("/agent-access")
						? ((input) => ({
								policyRevision: input.policyRevision,
								selectionRevision: input.selectionRevision,
								agentAccess: input.agentAccess,
							}))(playwriter_browser_access_schema.parse(JSON.parse(String(options?.body))))
						: {}),
				},
			}),
		);
		await f.asUser.action(api.playwriter_browser.refresh_connection_status, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
		});
		const listed = await f.asUser.query(api.playwriter_browser.current_connection, {
			membershipId: f.db.membershipId,
		});
		const handle = listed!.targets[0]!.handle;
		const confirmed = await f.asUser.action(api.playwriter_browser.confirm_tab, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			targetHandle: handle,
		});
		expect(confirmed._yay).toEqual({ connectionId: c.saved._id });
		expect(listed!.targets[0]!.url).toBe("about:blank");
		const confirmCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/confirm"))!;
		expect(JSON.parse(String(confirmCall[1]?.body))).toMatchObject({
			targetId: "native-tab-private",
			generation: c.saved.connectionGeneration,
			inventoryRevision: c.saved.inventoryRevision,
		});
		const current = await f.asUser.query(api.playwriter_browser.current_connection, {
			membershipId: f.db.membershipId,
		});
		expect(current).toMatchObject({ state: "ready", target: { handle, url: "about:blank" } });
		expect(JSON.stringify(current)).not.toContain("native-tab-private");
		expect(
			(await f.asUser.query(api.files_browser.current_browser_preferences, { membershipId: f.db.membershipId }))
				?.webChoice,
		).toEqual({ provider: "playwriter", connectionId: c.saved._id, confirmedTargetHandle: handle });
	});

	test.each(["about:blank#fragment", "chrome://newtab/", "file:///C:/private.txt", "https://blocked.example/private"])(
		"refuses an unsupported or blocked shared page: %s",
		async (url) => {
			const f = await fixture();
			const c = await connection(f, false);
			await f.t.mutation(internal.files_browser.change_browser_preferences, {
				userId: f.db.userId,
				membershipId: f.db.membershipId,
				change: { kind: "hosts", hosts: ["blocked.example"] },
			});
			vi.mocked(fetch).mockResolvedValue(
				Response.json({
					ok: true,
					runtime: {
						...runtime(c.saved, "awaiting_confirmation"),
						targets: [{ targetId: "native-tab-private", title: "Shared tab", url }],
					},
				}),
			);
			await f.asUser.action(api.playwriter_browser.refresh_connection_status, {
				membershipId: f.db.membershipId,
				connectionId: c.saved._id,
			});
			const listed = await f.asUser.query(api.playwriter_browser.current_connection, {
				membershipId: f.db.membershipId,
			});
			expect(
				(
					await f.asUser.action(api.playwriter_browser.confirm_tab, {
						membershipId: f.db.membershipId,
						connectionId: c.saved._id,
						targetHandle: listed!.targets[0]!.handle,
					})
				)._nay?.name,
			).toBe("agent_blocked_site");
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});

describe("resume_connection", () => {
	test("needs-human Resume keeps the observed state and revisions", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.run((ctx) => ctx.db.patch("playwriter_connections", c.saved._id, { state: "needs_human" }));
		vi.mocked(fetch).mockResolvedValue(
			Response.json({ ok: false, error: { code: "needs_human", message: "Reconnect" } }, { status: 409 }),
		);
		const refused = await f.asUser.action(api.playwriter_browser.resume_connection, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			connectionGeneration: c.saved.connectionGeneration,
			controlRevision: c.saved.controlRevision,
		});
		expect(
			await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)),
			"Unsupported Resume must not enter Recovering",
		).toMatchObject({
			state: "needs_human",
			controlRevision: c.saved.controlRevision,
		});
		expect(refused._nay?.name).toBe("needs_human");
		expect(fetch).not.toHaveBeenCalled();
	});

	test("a closed socket restores the human pause instead of leaving Recovering", async () => {
		const f = await fixture();
		const c = await connection(f);
		const paused = await f.t.mutation(internal.playwriter_browser.prepare_control, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			operation: "pause",
		});
		if (paused._nay) throw new Error(paused._nay.message);
		vi.mocked(fetch).mockResolvedValue(
			Response.json({ ok: false, error: { code: "needs_human", message: "Reconnect" } }, { status: 409 }),
		);
		const refused = await f.asUser.action(api.playwriter_browser.resume_connection, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			connectionGeneration: paused._yay.connectionGeneration,
			controlRevision: paused._yay.controlRevision,
		});
		expect(refused._nay?.name).toBe("needs_human");
		expect(
			await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)),
			"Failed Resume must restore a human recovery state",
		).toMatchObject({
			state: "needs_human",
			pauseReason: "human",
			controlRevision: paused._yay.controlRevision + 2,
		});
	});

	test("a lost successful Resume reply restores a newer Pause through retirement and Reconnect", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const c = await connection(f);
		const totalExpiresAt = Date.now() + 1_000;
		await f.t.run((ctx) => ctx.db.patch("playwriter_connections", c.saved._id, { totalExpiresAt }));
		let native: PlaywriterBrowserRuntime = { ...runtime(c.saved), totalExpiresAt };
		let humanPaused = false;
		const reconnectRequests: ReturnType<typeof playwriter_browser_reconnect_schema.parse>[] = [];
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			const route = new URL(String(url)).pathname.split("/").at(-1)!;
			if (route === "pause" || route === "resume") {
				const input = playwriter_browser_control_schema.parse(JSON.parse(String(options?.body)));
				humanPaused = route === "pause";
				native = { ...native, controlRevision: input.controlRevision, state: humanPaused ? "paused" : "connected" };
				if (route === "resume")
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.error(new Error("Resume reply lost after acceptance"));
							},
						}),
					);
			} else if (route === "disconnect") {
				playwriter_browser_disconnect_schema.parse(JSON.parse(String(options?.body)));
				native = {
					...native,
					generation: native.generation + 1,
					controlRevision: native.controlRevision + 1,
					state: "disconnected",
				};
			} else if (route === "reconnect") {
				const input = playwriter_browser_reconnect_schema.parse(JSON.parse(String(options?.body)));
				reconnectRequests.push(input);
				if (
					input.previousSessionId !== native.sessionId ||
					input.controlRevision < native.controlRevision ||
					(input.controlRevision === native.controlRevision && input.paused !== humanPaused)
				)
					return Response.json(
						{ ok: false, error: { code: "recovery_changed", message: "Recovery changed" } },
						{ status: 409 },
					);
				humanPaused = input.paused;
				native = {
					...native,
					generation: native.generation + 1,
					sessionId: input.sessionId,
					controlRevision: input.controlRevision,
					state: humanPaused ? "paused" : "connected",
					policyRevision: input.policyRevision,
					selectionRevision: input.selectionRevision,
					agentAccess: input.agentAccess,
					operations: input.operations,
					idleExpiresAt: input.idleExpiresAt,
					totalExpiresAt: input.totalExpiresAt,
				};
			} else if (route !== "status") throw new Error(`Unexpected route: ${route}`);
			return Response.json({ ok: true, runtime: native });
		});
		const args = { membershipId: f.db.membershipId, connectionId: c.saved._id };
		expect((await f.asUser.action(api.playwriter_browser.pause_connection, args))._yay).toEqual({
			connectionId: c.saved._id,
		});
		const paused = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		expect(
			(
				await f.asUser.action(api.playwriter_browser.resume_connection, {
					...args,
					connectionGeneration: paused.connectionGeneration,
					controlRevision: paused.controlRevision,
				})
			)._nay?.name,
		).toBe("transport");
		const restored = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		expect(restored.controlRevision, "Restored Pause must be newer than the accepted Resume").toBe(
			native.controlRevision + 1,
		);
		expect(restored).toMatchObject({ state: "needs_human", pauseReason: "human" });
		expect(
			await f.t.mutation(internal.playwriter_browser.commit_runtime, {
				connectionId: restored._id,
				attemptId: restored.connectAttemptId,
				expectedControlRevision: native.controlRevision,
				runtime: native,
			}),
			"The accepted old Resume reply must not replace the restored Pause",
		).toBe(false);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", restored._id))).toEqual(restored);
		vi.setSystemTime(totalExpiresAt + 1);
		await f.t.mutation(internal.playwriter_browser.sweep_connections, {});
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		const previousNativeRevision = native.controlRevision;
		expect(humanPaused).toBe(false);
		expect((await f.asUser.action(api.playwriter_browser.reconnect_connection, args))._yay).toEqual({
			connectionId: c.saved._id,
		});
		expect(reconnectRequests).toHaveLength(1);
		expect(reconnectRequests[0]).toMatchObject({ paused: true, previousSessionId: restored.sessionId });
		expect(reconnectRequests[0]!.controlRevision).toBeGreaterThan(previousNativeRevision);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", restored._id))).toMatchObject({
			active: true,
			state: "paused",
			pauseReason: "human",
			controlRevision: reconnectRequests[0]!.controlRevision,
		});
	});

	test("a failed Resume cannot replace a newer human Pause", async () => {
		const f = await fixture();
		const c = await connection(f);
		const args = { userId: f.db.userId, membershipId: f.db.membershipId, connectionId: c.saved._id };
		const paused = await f.t.mutation(internal.playwriter_browser.prepare_control, { ...args, operation: "pause" });
		if (paused._nay) throw new Error(paused._nay.message);
		vi.mocked(fetch).mockImplementation(async () => {
			const newerPause = await f.t.mutation(internal.playwriter_browser.prepare_control, {
				...args,
				operation: "pause",
			});
			if (newerPause._nay) throw new Error(newerPause._nay.message);
			return Response.json({ ok: false, error: { code: "needs_human", message: "Reconnect" } }, { status: 409 });
		});
		await f.asUser.action(api.playwriter_browser.resume_connection, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			connectionGeneration: paused._yay.connectionGeneration,
			controlRevision: paused._yay.controlRevision,
		});
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			state: "paused",
			pauseReason: "human",
			controlRevision: paused._yay.controlRevision + 2,
		});
	});

	test("an old Resume cannot clear a newer Pause", async () => {
		const f = await fixture();
		const c = await connection(f);
		const args = { userId: f.db.userId, membershipId: f.db.membershipId, connectionId: c.saved._id };
		const paused = await f.t.mutation(internal.playwriter_browser.prepare_control, { ...args, operation: "pause" });
		if (paused._nay) throw new Error(paused._nay.message);
		const observed = await f.asUser.query(api.playwriter_browser.current_connection, {
			membershipId: f.db.membershipId,
		});
		if (!observed) throw new Error("Missing paused connection");
		expect(observed).toMatchObject({
			connectionGeneration: paused._yay.connectionGeneration,
			controlRevision: paused._yay.controlRevision,
		});
		const newer = await f.t.mutation(internal.playwriter_browser.prepare_control, { ...args, operation: "pause" });
		if (newer._nay) throw new Error(newer._nay.message);
		const refused = await f.asUser.action(api.playwriter_browser.resume_connection, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			connectionGeneration: observed.connectionGeneration,
			controlRevision: observed.controlRevision,
		});
		const saved = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
		expect(saved).toMatchObject({ pauseReason: "human", controlRevision: newer._yay.controlRevision });
		expect(saved).toEqual(newer._yay);
		expect(refused._nay?.name).toBe("stale");
		expect(fetch).not.toHaveBeenCalled();
	});
	test("an old generation cannot resume after Reconnect keeps the Pause", async () => {
		const f = await fixture();
		const c = await connection(f);
		const args = { userId: f.db.userId, membershipId: f.db.membershipId, connectionId: c.saved._id };
		const paused = await f.t.mutation(internal.playwriter_browser.prepare_control, { ...args, operation: "pause" });
		if (paused._nay) throw new Error(paused._nay.message);
		const reconnecting = await f.t.mutation(internal.playwriter_browser.prepare_control, {
			...args,
			operation: "reconnect",
		});
		if (reconnecting._nay) throw new Error(reconnecting._nay.message);
		expect(reconnecting._yay.pauseReason).toBe("human");
		expect(
			await f.t.mutation(internal.playwriter_browser.commit_runtime, {
				connectionId: c.saved._id,
				attemptId: reconnecting._yay.connectAttemptId,
				expectedControlRevision: reconnecting._yay.controlRevision,
				runtime: { ...runtime(reconnecting._yay), generation: paused._yay.connectionGeneration + 1 },
			}),
		).toBe(true);
		const before = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
		expect(before).toMatchObject({ pauseReason: "human", state: "paused" });
		const refused = await f.asUser.action(api.playwriter_browser.resume_connection, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			connectionGeneration: paused._yay.connectionGeneration,
			controlRevision: paused._yay.controlRevision,
		});
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toEqual(before);
		expect(refused._nay?.name).toBe("stale");
		expect(fetch).not.toHaveBeenCalled();
	});
	test("the observed generation and Pause can resume", async () => {
		const f = await fixture();
		const c = await connection(f);
		const paused = await f.t.mutation(internal.playwriter_browser.prepare_control, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			operation: "pause",
		});
		if (paused._nay) throw new Error(paused._nay.message);
		vi.mocked(fetch).mockResolvedValue(
			Response.json({
				ok: true,
				runtime: { ...runtime(paused._yay), controlRevision: paused._yay.controlRevision + 1 },
			}),
		);
		expect(
			(
				await f.asUser.action(api.playwriter_browser.resume_connection, {
					membershipId: f.db.membershipId,
					connectionId: c.saved._id,
					connectionGeneration: paused._yay.connectionGeneration,
					controlRevision: paused._yay.controlRevision,
				})
			)._yay,
		).toEqual({ connectionId: c.saved._id });
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			pauseReason: null,
			state: "ready",
			controlRevision: paused._yay.controlRevision + 1,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]?.body))).toMatchObject({
			generation: paused._yay.connectionGeneration,
			controlRevision: paused._yay.controlRevision + 1,
		});
	});
});

describe("reconnect_connection", () => {
	test("keeps the saved link after a status transport failure", async () => {
		const f = await fixture();
		const c = await connection(f);
		const routes: string[] = [];
		let failed = false;
		vi.mocked(fetch).mockImplementation(async (url) => {
			const route = new URL(String(url)).pathname.split("/").at(-1)!;
			routes.push(route);
			if (route === "status") {
				if (!failed) {
					failed = true;
					throw new Error("Status request was lost");
				}
				return Response.json({ ok: true, runtime: runtime(c.saved) });
			}
			const current = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
			if (!current) throw new Error("Missing saved connection");
			return Response.json({ ok: true, runtime: runtime(current) });
		});
		const args = { membershipId: f.db.membershipId, connectionId: c.saved._id };
		expect((await f.asUser.action(api.playwriter_browser.reconnect_connection, args))._nay?.name).toBe("transport");
		expect(
			await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)),
			"A lost status reply must keep the saved link and retry state",
		).toMatchObject({
			active: true,
			state: "offline",
			encryptedShareId: c.saved.encryptedShareId,
			shareNonce: c.saved.shareNonce,
			idleExpiresAt: c.saved.idleExpiresAt,
		});
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(0);
		expect(await f.t.run((ctx) => ctx.db.query("files_browser_preferences").collect())).toMatchObject([
			{ webChoice: c.browserIntent.webChoice },
		]);
		expect((await f.asUser.action(api.playwriter_browser.reconnect_connection, args))._yay).toEqual({
			connectionId: c.saved._id,
		});
		expect(routes).toEqual(["status", "status", "recover"]);
	});
	test("a late status error cannot mark a resumed connection offline", async () => {
		const f = await fixture();
		const c = await connection(f);
		const pending = Promise.withResolvers<Response>();
		vi.mocked(fetch).mockImplementation(async (url) => {
			const route = new URL(String(url)).pathname.split("/").at(-1)!;
			if (route === "status") return pending.promise;
			const current = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
			if (!current) throw new Error("Missing saved connection");
			return Response.json({
				ok: true,
				runtime: { ...runtime(current), state: route === "pause" ? "paused" : "connected" },
			});
		});
		const args = { membershipId: f.db.membershipId, connectionId: c.saved._id };
		const old = f.asUser.action(api.playwriter_browser.reconnect_connection, args);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		expect((await f.asUser.action(api.playwriter_browser.pause_connection, args))._yay).toEqual({
			connectionId: c.saved._id,
		});
		const paused = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
		if (!paused) throw new Error("Missing paused connection");
		expect(
			(
				await f.asUser.action(api.playwriter_browser.resume_connection, {
					...args,
					connectionGeneration: paused.connectionGeneration,
					controlRevision: paused.controlRevision,
				})
			)._yay,
		).toEqual({ connectionId: c.saved._id });
		const resumed = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
		expect(resumed).toMatchObject({ state: "ready", pauseReason: null });
		pending.reject(new Error("Old status request was lost"));
		expect((await old)._nay?.name).toBe("stale");
		expect(
			await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)),
			"The old error must not change the resumed connection",
		).toEqual(resumed);
	});

	test("a late status failure cannot forget a newer successful Reconnect", async () => {
		const f = await fixture();
		const c = await connection(f);
		const pending = Promise.withResolvers<Response>();
		let statusCalls = 0;
		vi.mocked(fetch).mockImplementation(async (url) => {
			if (String(url).endsWith("/status") && ++statusCalls === 1) return pending.promise;
			return Response.json({
				ok: true,
				runtime: { ...runtime(c.saved), generation: c.saved.connectionGeneration + 1 },
			});
		});
		const args = { membershipId: f.db.membershipId, connectionId: c.saved._id };
		const old = f.asUser.action(api.playwriter_browser.reconnect_connection, args);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		expect((await f.asUser.action(api.playwriter_browser.reconnect_connection, args))._yay).toEqual({
			connectionId: c.saved._id,
		});
		const saved = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
		pending.resolve(
			Response.json({ ok: false, error: { code: "dial_failed", message: "dial failed" } }, { status: 503 }),
		);
		expect((await old)._nay?.name).toBe("stale");
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toEqual(saved);
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(0);
	});

	test.each(["pause", "disconnect"] as const)(
		"%s during the status read stops the old Reconnect",
		async (operation) => {
			const f = await fixture();
			const c = await connection(f);
			const pending = Promise.withResolvers<Response>();
			const routes: string[] = [];
			vi.mocked(fetch).mockImplementation(async (url) => {
				const route = new URL(String(url)).pathname.split("/").at(-1)!;
				routes.push(route);
				if (route === "status") return pending.promise;
				return Response.json({
					ok: true,
					runtime: {
						...runtime(c.saved),
						state: operation === "pause" ? "paused" : "disconnected",
						controlRevision: c.saved.controlRevision + 1,
						generation: c.saved.connectionGeneration + (operation === "disconnect" ? 1 : 0),
					},
				});
			});
			const args = { membershipId: f.db.membershipId, connectionId: c.saved._id };
			const old = f.asUser.action(api.playwriter_browser.reconnect_connection, args);
			await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
			const controlled =
				operation === "pause"
					? await f.asUser.action(api.playwriter_browser.pause_connection, args)
					: await f.asUser.action(api.playwriter_browser.disconnect_connection, args);
			expect(controlled._yay).toEqual({ connectionId: c.saved._id });
			const saved = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
			pending.resolve(Response.json({ ok: true, runtime: runtime(c.saved) }));
			expect((await old)._nay?.name).toBe("stale");
			// Disconnect also schedules its own cleanup.
			expect(routes.slice(0, 2)).toEqual(["status", operation]);
			expect(routes).not.toContain("recover");
			expect(routes).not.toContain("reconnect");
			const current = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
			if (operation === "pause") expect(current).toEqual(saved);
			else
				expect(current).toMatchObject({
					active: false,
					encryptedShareId: null,
					connectAttemptId: saved?.connectAttemptId,
					controlRevision: saved?.controlRevision,
				});
		},
	);

	test.each(["missing", "different_live"] as const)(
		"retires only its prepared attempt when status is %s",
		async (reason) => {
			const f = await fixture();
			const c = await connection(f);
			vi.mocked(fetch).mockResolvedValue(
				reason === "missing"
					? Response.json({ ok: false, error: { code: "not_connected", message: "not connected" } }, { status: 404 })
					: Response.json({ ok: true, runtime: { ...runtime(c.saved), sessionId: "another-live-session" } }),
			);
			expect(
				(
					await f.asUser.action(api.playwriter_browser.reconnect_connection, {
						membershipId: f.db.membershipId,
						connectionId: c.saved._id,
					})
				)._nay?.name,
			).toBe("connect_again");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
				active: false,
				state: "closing",
				encryptedShareId: null,
				pauseReason: "connect_again",
			});
			expect((await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect()))[0]).toMatchObject({
				connectionId: c.saved._id,
				forgetCredential: true,
			});
		},
	);

	test.each(["not_sent", "reply_lost"] as const)("keeps the reserved new session after %s", async (failure) => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.retire_session, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
		});
		const retired = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		let native: PlaywriterBrowserRuntime = {
			...runtime(retired),
			state: "disconnected",
			generation: retired.connectionGeneration + 1,
		};
		let failed = false;
		const sent: ReturnType<typeof playwriter_browser_connect_schema.parse>[] = [];
		const routes: string[] = [];
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			const route = new URL(String(url)).pathname.split("/").at(-1)!;
			routes.push(route);
			if (route === "status" || route === "disconnect") return Response.json({ ok: true, runtime: native });
			const schema = route === "reconnect" ? playwriter_browser_reconnect_schema : playwriter_browser_connect_schema;
			const input = schema.parse(JSON.parse(String(options?.body)));
			sent.push(input);
			if (route === "recover" && input.sessionId !== native.sessionId)
				return Response.json(
					{ ok: false, error: { code: "recovery_changed", message: "recovery changed" } },
					{ status: 409 },
				);
			if (!failed && failure === "not_sent") {
				failed = true;
				throw new Error("Lost request before the runner");
			}
			native = {
				...native,
				generation: native.generation + 1,
				state: "connected",
				sessionId: input.sessionId,
				controlRevision: input.controlRevision,
				operations: input.operations,
				idleExpiresAt: input.idleExpiresAt,
				totalExpiresAt: input.totalExpiresAt,
			};
			if (!failed) {
				failed = true;
				throw new Error("Lost reply after the runner accepted it");
			}
			return Response.json({ ok: true, runtime: native });
		});
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		const args = { membershipId: f.db.membershipId, connectionId: c.saved._id };
		expect((await f.asUser.action(api.playwriter_browser.reconnect_connection, args))._nay?.name).toBe("transport");
		const reserved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		expect(reserved.sessionId).not.toBe(retired.sessionId);
		expect((await f.asUser.action(api.playwriter_browser.reconnect_connection, args))._yay).toEqual({
			connectionId: c.saved._id,
		});
		expect(sent).toHaveLength(2);
		for (const input of sent) {
			expect(input).toMatchObject({
				sessionId: reserved.sessionId,
				operations: reserved.operations,
				idleExpiresAt: reserved.idleExpiresAt,
				totalExpiresAt: reserved.totalExpiresAt,
			});
		}
		expect(routes.filter((route) => route === "status")).toHaveLength(2);
		expect(routes.filter((route) => route === "reconnect")).toHaveLength(failure === "not_sent" ? 2 : 1);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			state: "ready",
			sessionId: reserved.sessionId,
			operations: reserved.operations,
			totalExpiresAt: reserved.totalExpiresAt,
		});
	});

	test.each(["agent_close", "operations", "total"] as const)(
		"starts a fresh trusted session after %s",
		async (reason) => {
			const f = await fixture();
			const c = await connection(f);
			const args = { membershipId: f.db.membershipId, connectionId: c.saved._id };
			if (reason === "agent_close") {
				await f.t.mutation(internal.playwriter_browser.retire_session, {
					source: f.source,
					browserIntent: c.browserIntent,
					resource: c.resource,
				});
				expect((await f.asUser.action(api.playwriter_browser.reconnect_connection, args))._nay?.name).toBe("busy");
				expect(fetch).not.toHaveBeenCalled();
				vi.mocked(fetch).mockResolvedValueOnce(
					Response.json({ ok: true, runtime: { ...runtime(c.saved), generation: c.saved.connectionGeneration + 1 } }),
				);
				await f.t.action(internal.playwriter_browser.process_cleanups, {});
				vi.mocked(fetch).mockClear();
			} else {
				if (reason === "operations") {
					await f.t.mutation(internal.playwriter_browser.prepare_control, {
						...args,
						userId: f.db.userId,
						operation: "pause",
					});
					await f.t.run(async (ctx) => {
						const preference = (await ctx.db.query("files_browser_preferences").collect())[0]!;
						await ctx.db.patch("files_browser_preferences", preference._id, {
							webAgentAccess: false,
							policyRevision: 1,
						});
					});
				}
				await f.t.run((ctx) =>
					ctx.db.patch(
						"playwriter_connections",
						c.saved._id,
						reason === "operations" ? { operations: 120 } : { totalExpiresAt: Date.now() - 1 },
					),
				);
			}
			const previous = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
			vi.mocked(fetch).mockImplementation(async (url, options) => {
				if (String(url).endsWith("/status"))
					return Response.json({
						ok: true,
						runtime: { ...runtime(previous), state: reason === "agent_close" ? "disconnected" : "connected" },
					});
				const schema = String(url).endsWith("/reconnect")
					? playwriter_browser_reconnect_schema
					: playwriter_browser_connect_schema;
				const input = schema.parse(JSON.parse(String(options?.body)));
				// Same-session recovery must refuse a reset of the old budget.
				if (
					String(url).endsWith("/recover") &&
					(input.sessionId !== previous.sessionId ||
						input.operations < previous.operations ||
						input.totalExpiresAt > previous.totalExpiresAt!)
				)
					return Response.json(
						{ ok: false, error: { code: "recovery_changed", message: "recovery changed" } },
						{ status: 409 },
					);
				return Response.json({
					ok: true,
					runtime: {
						...runtime(previous),
						generation: previous.connectionGeneration + 1,
						state: input.paused ? "paused" : "connected",
						controlRevision: input.controlRevision,
						policyRevision: input.policyRevision,
						selectionRevision: input.selectionRevision,
						agentAccess: input.agentAccess,
						sessionId: input.sessionId,
						operations: input.operations,
						idleExpiresAt: input.idleExpiresAt,
						totalExpiresAt: input.totalExpiresAt,
					},
				});
			});
			const reconnected = await f.asUser.action(api.playwriter_browser.reconnect_connection, args);
			expect(reconnected._yay).toEqual({ connectionId: c.saved._id });
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe("https://browser-runner.test/internal/playwriter/reconnect");
			const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
			expect(sent).toMatchObject({
				previousSessionId: previous.sessionId,
				expectedTargetId: previous.confirmedTargetId,
				controlRevision: previous.controlRevision,
				operations: 0,
				paused: reason === "operations",
				agentAccess: reason !== "operations",
			});
			expect(sent.sessionId).not.toBe(previous.sessionId);
			expect(sent.totalExpiresAt).toBeGreaterThan(previous.totalExpiresAt!);
			const saved = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
			expect(saved).toMatchObject({
				active: true,
				state: reason === "operations" ? "paused" : "ready",
				pauseReason: previous.pauseReason === "human" ? "human" : null,
				connectionGeneration: previous.connectionGeneration + 1,
				sessionId: sent.sessionId,
				operations: 0,
				confirmedTargetHandle: previous.confirmedTargetHandle,
			});
			expect((await f.t.run((ctx) => ctx.db.query("playwriter_user_daily_use").collect()))[0]?.starts).toBe(2);
		},
	);

	test("counts other unsettled sockets before starting a new session", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.retire_session, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
		});
		vi.mocked(fetch).mockResolvedValue(
			Response.json({
				ok: true,
				runtime: {
					...runtime(c.saved),
					state: "disconnected",
					generation: c.saved.connectionGeneration + 1,
				},
			}),
		);
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		const memberships = await f.t.run((ctx) => ctx.db.query("organizations_workspaces_users").collect());
		const second = memberships.find((item) => item.organizationId !== f.db.organizationId)!;
		const third = memberships.find(
			(item) => item.organizationId === f.db.organizationId && item.workspaceId !== f.db.workspaceId,
		)!;
		let proved = false;
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			if (String(url).endsWith("/connect")) return connect_response(f, options?.body);
			if (String(url).endsWith("/disconnect"))
				return Response.json(
					{
						ok: false,
						error: {
							code: proved ? "connection_forgotten" : "cleanup_unknown",
							message: "fixed cleanup result",
						},
					},
					{ status: 410 },
				);
			if (String(url).endsWith("/status"))
				return Response.json({
					ok: true,
					runtime: {
						...runtime(c.saved),
						state: "disconnected",
						generation: c.saved.connectionGeneration + 1,
					},
				});
			const input = playwriter_browser_reconnect_schema.parse(JSON.parse(String(options?.body)));
			return Response.json({
				ok: true,
				runtime: {
					...runtime(c.saved),
					generation: c.saved.connectionGeneration + 2,
					controlRevision: input.controlRevision,
					policyRevision: input.policyRevision,
					selectionRevision: input.selectionRevision,
					agentAccess: input.agentAccess,
					sessionId: input.sessionId,
					operations: input.operations,
					idleExpiresAt: input.idleExpiresAt,
					totalExpiresAt: input.totalExpiresAt,
				},
			});
		});
		const other = await f.asUser.action(api.playwriter_browser.connect_tab, {
			membershipId: second._id,
			share: "b".repeat(32),
		});
		expect(other._yay).toBeTruthy();
		expect(
			(
				await f.asUser.action(api.playwriter_browser.connect_tab, {
					membershipId: third._id,
					share: "c".repeat(32),
				})
			)._yay,
		).toBeTruthy();
		await f.asUser.action(api.playwriter_browser.disconnect_connection, {
			membershipId: second._id,
			connectionId: other._yay!.connectionId,
		});
		const args = { membershipId: f.db.membershipId, connectionId: c.saved._id };
		const refused = await f.asUser.action(api.playwriter_browser.reconnect_connection, args);
		expect(refused._nay?.name, "Reconnect must count other unsettled sockets").toBe("limit");
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			active: false,
			sessionId: c.saved.sessionId,
			totalExpiresAt: c.saved.totalExpiresAt,
		});
		proved = true;
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		expect((await f.asUser.action(api.playwriter_browser.reconnect_connection, args))._yay).toEqual({
			connectionId: c.saved._id,
		});
	});

	test("replaces a capped session without counting its slot twice", async () => {
		const f = await fixture();
		const c = await connection(f);
		const other = await f.t.run((ctx) =>
			test_mocks_fill_db_with.membership(ctx, {
				userId: f.db.userId,
				organizationName: "personal",
				workspaceName: "home",
				plan: null,
			}),
		);
		const reserved = await f.t.mutation(internal.playwriter_browser.prepare_connect, {
			userId: f.db.userId,
			membershipId: other.membershipId,
			linkFingerprint: "b".repeat(64),
		});
		expect(reserved._yay).toBeTruthy();
		await f.t.run((ctx) => ctx.db.patch("playwriter_connections", c.saved._id, { operations: 119 }));
		await f.t.mutation(internal.playwriter_browser.reserve_command, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "last-read",
			operationHash: "c".repeat(64),
		});
		const running = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		expect(running.operations).toBe(120);
		expect(
			await f.t.mutation(internal.playwriter_browser.finish_command, {
				connectionId: running._id,
				identity: running.unresolvedCommand!,
				result: { status: "succeeded", reason: null },
				fenced: true,
				runtime: { ...runtime(running), selectionRevision: c.browserIntent.selectionRevision },
				completedLease: completed_lease(running),
			}),
		).toBe(true);
		const previous = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		expect(previous).toMatchObject({ active: true, operations: 120, unresolvedCommand: null });
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			if (String(url).endsWith("/status")) return Response.json({ ok: true, runtime: runtime(previous) });
			const input = playwriter_browser_reconnect_schema.parse(JSON.parse(String(options?.body)));
			return Response.json({
				ok: true,
				runtime: {
					...runtime(previous),
					generation: previous.connectionGeneration + 1,
					controlRevision: input.controlRevision,
					policyRevision: input.policyRevision,
					selectionRevision: input.selectionRevision,
					agentAccess: input.agentAccess,
					sessionId: input.sessionId,
					operations: input.operations,
					idleExpiresAt: input.idleExpiresAt,
					totalExpiresAt: input.totalExpiresAt,
				},
			});
		});
		const result = await f.asUser.action(api.playwriter_browser.reconnect_connection, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
		});
		expect(result._yay, "Reconnect must replace its slot at the user cap").toEqual({ connectionId: c.saved._id });
		expect(fetch).toHaveBeenCalledTimes(2);
		const sent = playwriter_browser_reconnect_schema.parse(
			JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body)),
		);
		expect(sent).toMatchObject({ previousSessionId: previous.sessionId, operations: 0 });
		expect(sent.sessionId).not.toBe(previous.sessionId);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("playwriter_connections")
					.withIndex("by_active", (q) => q.eq("active", true))
					.collect(),
			),
		).toHaveLength(2);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", reserved._yay!.connection._id))).toEqual(
			reserved._yay!.connection,
		);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			idleExpiresAt: previous.idleExpiresAt,
			confirmedTargetHandle: previous.confirmedTargetHandle,
		});
		const memberships = await f.t.run((ctx) => ctx.db.query("organizations_workspaces_users").collect());
		const third = memberships.find(
			(item) => item.organizationId === f.db.organizationId && item.workspaceId !== f.db.workspaceId,
		)!;
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.prepare_connect, {
					userId: f.db.userId,
					membershipId: third._id,
					linkFingerprint: "d".repeat(64),
				})
			)._nay?.name,
		).toBe("limit");
	});

	test("bounds the runner idle deadline and keeps the saved-link reconnect window", async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const f = await fixture();
		const c = await connection(f);
		for (const minute of [8, 16, 24, 32, 40, 48, 51]) {
			clock.mockReturnValue(now + minute * 60_000);
			await f.t.mutation(internal.playwriter_browser.reserve_command, {
				source: f.source,
				browserIntent: c.browserIntent,
				resource: c.resource,
				toolCallId: `read-${minute}`,
				operationHash: "c".repeat(64),
			});
			const running = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
			expect(
				await f.t.mutation(internal.playwriter_browser.finish_command, {
					connectionId: running._id,
					identity: running.unresolvedCommand!,
					result: { status: "succeeded", reason: null },
					fenced: true,
					runtime: {
						...runtime(running),
						selectionRevision: c.browserIntent.selectionRevision,
						idleExpiresAt: Math.min(running.idleExpiresAt, running.totalExpiresAt!),
					},
					completedLease: completed_lease(running),
				}),
			).toBe(true);
		}
		const previous = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		expect(previous.idleExpiresAt).toBe(now + 61 * 60_000);
		expect(previous.totalExpiresAt).toBe(now + 60 * 60_000);
		let native: PlaywriterBrowserRuntime = { ...runtime(previous), idleExpiresAt: previous.totalExpiresAt! };
		const sent: ReturnType<typeof playwriter_browser_connect_schema.parse>[] = [];
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			if (String(url).endsWith("/status")) return Response.json({ ok: true, runtime: native });
			const schema = String(url).endsWith("/reconnect")
				? playwriter_browser_reconnect_schema
				: playwriter_browser_connect_schema;
			const input = schema.parse(JSON.parse(String(options?.body)));
			sent.push(input);
			if (input.idleExpiresAt > input.totalExpiresAt)
				return Response.json({ ok: false, error: { code: "expired", message: "expired" } }, { status: 409 });
			native = {
				...native,
				generation: native.generation + 1,
				sessionId: input.sessionId,
				operations: input.operations,
				idleExpiresAt: input.idleExpiresAt,
				totalExpiresAt: input.totalExpiresAt,
				controlRevision: input.controlRevision,
				policyRevision: input.policyRevision,
				selectionRevision: input.selectionRevision,
				agentAccess: input.agentAccess,
			};
			return Response.json({ ok: true, runtime: native });
		});
		clock.mockReturnValue(now + 52 * 60_000);
		const recovered = await f.t.action(internal.playwriter_browser.recover_for_source, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
		});
		expect(recovered._yay, "Recovery must bound only the runner idle deadline").toBeNull();
		expect(sent[0]).toMatchObject({
			sessionId: previous.sessionId,
			operations: previous.operations,
			idleExpiresAt: previous.totalExpiresAt,
			totalExpiresAt: previous.totalExpiresAt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			idleExpiresAt: previous.idleExpiresAt,
			totalExpiresAt: previous.totalExpiresAt,
			encryptedShareId: previous.encryptedShareId,
		});
		clock.mockReturnValue(now + 60 * 60_000 + 1000);
		const reconnected = await f.asUser.action(api.playwriter_browser.reconnect_connection, {
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
		});
		expect(reconnected._yay, "Human Reconnect must keep the saved-link window after total expiry").toEqual({
			connectionId: c.saved._id,
		});
		expect(sent[1]).toMatchObject({ operations: 0, idleExpiresAt: previous.idleExpiresAt });
		expect(sent[1]!.sessionId).not.toBe(previous.sessionId);
		expect(sent[1]!.totalExpiresAt).toBeGreaterThan(previous.totalExpiresAt!);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			idleExpiresAt: previous.idleExpiresAt,
			encryptedShareId: previous.encryptedShareId,
		});
	});

	test("same-session Reconnect keeps its budget, human Pause, and agent access Off", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.prepare_control, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			connectionId: c.saved._id,
			operation: "pause",
		});
		await f.t.run(async (ctx) => {
			await ctx.db.patch("playwriter_connections", c.saved._id, { operations: 7 });
			const preference = (await ctx.db.query("files_browser_preferences").collect())[0]!;
			await ctx.db.patch("files_browser_preferences", preference._id, { webAgentAccess: false, policyRevision: 1 });
		});
		const previous = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		vi.mocked(fetch).mockImplementation(async () =>
			Response.json({
				ok: true,
				runtime: {
					...runtime(previous),
					generation: previous.connectionGeneration + 1,
					state: "paused",
					agentAccess: false,
				},
			}),
		);
		expect(
			(
				await f.asUser.action(api.playwriter_browser.reconnect_connection, {
					membershipId: f.db.membershipId,
					connectionId: c.saved._id,
				})
			)._yay,
		).toEqual({ connectionId: c.saved._id });
		expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe("https://browser-runner.test/internal/playwriter/recover");
		const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
		expect(sent).toMatchObject({
			sessionId: previous.sessionId,
			operations: 7,
			totalExpiresAt: previous.totalExpiresAt,
			paused: true,
			agentAccess: false,
		});
		expect(sent).not.toHaveProperty("previousSessionId");
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			state: "paused",
			pauseReason: "human",
			sessionId: previous.sessionId,
			operations: 7,
			totalExpiresAt: previous.totalExpiresAt,
		});
	});
});

describe("recover_for_source", () => {
	test("automatic recovery keeps the same session and budgets", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.run((ctx) => ctx.db.patch("playwriter_connections", c.saved._id, { operations: 7 }));
		const previous = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		vi.mocked(fetch).mockResolvedValue(
			Response.json({ ok: true, runtime: { ...runtime(previous), generation: previous.connectionGeneration + 1 } }),
		);
		expect(
			(
				await f.t.action(internal.playwriter_browser.recover_for_source, {
					source: f.source,
					browserIntent: c.browserIntent,
					resource: c.resource,
				})
			)._yay,
		).toBeNull();
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://browser-runner.test/internal/playwriter/recover");
		const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
		expect(sent).toMatchObject({
			sessionId: previous.sessionId,
			operations: 7,
			idleExpiresAt: previous.idleExpiresAt,
			totalExpiresAt: previous.totalExpiresAt,
		});
		expect(sent).not.toHaveProperty("previousSessionId");
	});
});

describe("pause_connection", () => {
	test.each(["reconnect", "expire"] as const)(
		"a stale Pause leaves a cleaned retired session unchanged before %s",
		async (next) => {
			const f = await fixture();
			const c = await connection(f);
			const retired = await f.t.mutation(internal.playwriter_browser.retire_session, {
				source: f.source,
				browserIntent: c.browserIntent,
				resource: c.resource,
			});
			if (retired._nay) throw new Error(retired._nay.message);
			let native: PlaywriterBrowserRuntime = {
				...runtime(c.saved),
				state: "disconnected",
				generation: c.saved.connectionGeneration + 1,
				controlRevision: c.saved.controlRevision + 1,
			};
			vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: true, runtime: native }));
			await f.t.action(internal.playwriter_browser.process_cleanups, {});
			expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toEqual([]);
			const previous = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
			vi.mocked(fetch).mockClear();
			const refused = await f.asUser.action(api.playwriter_browser.pause_connection, {
				membershipId: f.db.membershipId,
				connectionId: c.saved._id,
			});
			expect(
				await f.t.run((ctx) => ctx.db.get("playwriter_connections", previous._id)),
				"A stale Pause must not change a retired session",
			).toEqual(previous);
			expect(refused._nay).toEqual({ name: "needs_human", message: "Reconnect the browser before pausing." });
			expect(fetch).not.toHaveBeenCalled();
			if (next === "reconnect") {
				const sent: ReturnType<typeof playwriter_browser_reconnect_schema.parse>[] = [];
				const checkedGeneration = native.generation;
				vi.mocked(fetch).mockImplementation(async (url, options) => {
					if (String(url).endsWith("/status")) return Response.json({ ok: true, runtime: native });
					const input = playwriter_browser_reconnect_schema.parse(JSON.parse(String(options?.body)));
					sent.push(input);
					if (
						input.paused ||
						input.previousSessionId !== native.sessionId ||
						input.controlRevision !== native.controlRevision
					)
						return Response.json(
							{ ok: false, error: { code: "recovery_changed", message: "Recovery changed" } },
							{ status: 409 },
						);
					native = {
						...native,
						state: "connected",
						generation: native.generation + 1,
						sessionId: input.sessionId,
						controlRevision: input.controlRevision,
						policyRevision: input.policyRevision,
						selectionRevision: input.selectionRevision,
						agentAccess: input.agentAccess,
						operations: input.operations,
						idleExpiresAt: input.idleExpiresAt,
						totalExpiresAt: input.totalExpiresAt,
					};
					return Response.json({ ok: true, runtime: native });
				});
				expect(
					(
						await f.asUser.action(api.playwriter_browser.reconnect_connection, {
							membershipId: f.db.membershipId,
							connectionId: c.saved._id,
						})
					)._yay,
				).toEqual({ connectionId: c.saved._id });
				expect(sent).toHaveLength(1);
				expect(sent[0]).toMatchObject({
					previousSessionId: previous.sessionId,
					paused: false,
					controlRevision: previous.controlRevision,
				});
				expect(sent[0]!.sessionId).not.toBe(previous.sessionId);
				expect(
					await f.t.run((ctx) => ctx.db.get("playwriter_connections", previous._id)),
					"Connected Reconnect must clear the old session reason",
				).toMatchObject({
					active: true,
					state: "ready",
					pauseReason: null,
					connectionGeneration: checkedGeneration + 1,
					sessionId: sent[0]!.sessionId,
				});
			} else {
				await f.t.run((ctx) => ctx.db.patch("playwriter_connections", previous._id, { idleExpiresAt: Date.now() - 1 }));
				await f.t.mutation(internal.playwriter_browser.sweep_connections, {});
				expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", previous._id))).toMatchObject({
					active: false,
					encryptedShareId: null,
					shareNonce: null,
				});
			}
		},
	);

	test("pauses while flags are off without an observed Resume lease", async () => {
		const f = await fixture();
		const c = await connection(f);
		vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "false");
		vi.stubEnv("AI_CHAT_PLAYWRITER_ENABLED", "false");
		vi.mocked(fetch).mockResolvedValue(
			Response.json({
				ok: true,
				runtime: { ...runtime(c.saved), state: "paused", controlRevision: c.saved.controlRevision + 1 },
			}),
		);
		expect(
			(
				await f.asUser.action(api.playwriter_browser.pause_connection, {
					membershipId: f.db.membershipId,
					connectionId: c.saved._id,
				})
			)._yay,
		).toEqual({ connectionId: c.saved._id });
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			pauseReason: "human",
			state: "paused",
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("disconnect_connection", () => {
	test("forgets credentials at once even with flags off and a failed runner", async () => {
		const f = await fixture();
		const c = await connection(f);
		vi.stubEnv("AI_CHAT_BROWSER_ENABLED", "false");
		expect(
			(
				await f.asUser.action(api.playwriter_browser.disconnect_connection, {
					membershipId: f.db.membershipId,
					connectionId: c.saved._id,
				})
			)._yay,
		).toBeTruthy();
		const saved = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
		expect(saved).toMatchObject({ encryptedShareId: null, shareNonce: null, linkFingerprint: null, active: false });
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(1);
	});
	test("repeated cleanup does not create duplicate jobs", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.run(async (ctx) => {
			await playwriter_browser_db_disconnect(ctx, c.saved, "disconnected");
			const current = await ctx.db.get("playwriter_connections", c.saved._id);
			await playwriter_browser_db_disconnect(ctx, current!, "disconnected");
		});
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(1);
	});
});

describe("process_cleanups", () => {
	test.each([true, false])("the authenticated forgotten-scope proof completes cleanup: forget %s", async (forget) => {
		const f = await fixture();
		const c = await connection(f);
		if (forget) await f.t.run((ctx) => playwriter_browser_db_disconnect(ctx, c.saved, "connect_again"));
		else
			await f.t.mutation(internal.playwriter_browser.retire_session, {
				source: f.source,
				browserIntent: c.browserIntent,
				resource: c.resource,
			});
		vi.mocked(fetch).mockResolvedValue(
			Response.json(
				{
					ok: false,
					error: { code: "connection_forgotten", message: "connection forgotten" },
				},
				{ status: 409 },
			),
		);
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://browser-runner.test/internal/playwriter/disconnect");
		expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer test-runner-secret" });
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(0);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject(
			forget ? { state: "closed", active: false } : { state: "offline", active: false },
		);
	});

	test("a normal runtime reply cannot prove credential Forget", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.run((ctx) => playwriter_browser_db_disconnect(ctx, c.saved, "connect_again"));
		vi.mocked(fetch).mockResolvedValue(
			Response.json({
				ok: true,
				runtime: { ...runtime(c.saved), state: "disconnected", generation: c.saved.connectionGeneration + 1 },
			}),
		);
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		expect((await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect()))[0]).toMatchObject({
			forgetCredential: true,
			attempts: 1,
		});
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			state: "closing",
		});
	});

	test.each(["not_connected", "stale_generation", "cleanup_unknown"] as const)(
		"%s is not cleanup proof",
		async (code) => {
			const f = await fixture();
			const c = await connection(f);
			await f.t.run((ctx) => playwriter_browser_db_disconnect(ctx, c.saved, "connect_again"));
			vi.mocked(fetch).mockResolvedValue(
				Response.json({ ok: false, error: { code, message: "fixed refusal" } }, { status: 409 }),
			);
			await f.t.action(internal.playwriter_browser.process_cleanups, {});
			expect((await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect()))[0]).toMatchObject({
				attempts: 1,
			});
			expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
				state: "closing",
			});
		},
	);

	test.each([0, 1, 2])(
		"an exact-generation cleanup needs a strictly newer returned generation: %s",
		async (generation) => {
			const f = await fixture();
			const c = await connection(f);
			await f.t.mutation(internal.playwriter_browser.retire_session, {
				source: f.source,
				browserIntent: c.browserIntent,
				resource: c.resource,
			});
			vi.mocked(fetch).mockResolvedValue(
				Response.json({ ok: true, runtime: { ...runtime(c.saved), state: "disconnected", generation } }),
			);
			await f.t.action(internal.playwriter_browser.process_cleanups, {});
			expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(
				generation > c.saved.connectionGeneration ? 0 : 1,
			);
		},
	);

	test.each(["succeeds", "fails"] as const)(
		"an old retirement reply that %s leaves a Forget queued",
		async (oldResult) => {
			// Fake timers keep scheduled cleanup runs from starting. This test starts each run itself.
			vi.useFakeTimers();
			const f = await fixture();
			const member = await f.t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			expect(
				await f.asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: f.db.organizationId,
					workspaceId: f.db.workspaceId,
					userIdToAdd: member.userId,
				}),
			).toEqual({ _yay: null });
			const membership = await f.t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", f.db.workspaceId).eq("userId", member.userId).eq("active", true),
					)
					.first(),
			);
			if (!membership) throw new Error("Expected invited membership");
			const c = await connection({ ...f, db: { ...f.db, userId: member.userId, membershipId: membership._id } });

			// The budget sweep retires the session with an exact-generation cleanup job.
			await f.t.run((ctx) => ctx.db.patch("playwriter_connections", c.saved._id, { operations: 120 }));
			await f.t.mutation(internal.playwriter_browser.sweep_connections, {});
			expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toMatchObject([
				{ forgetCredential: false, generation: c.saved.connectionGeneration },
			]);

			// Hold the old Disconnect reply while the owner removes the member.
			const oldReply = Promise.withResolvers<Response>();
			const oldRequestSent = Promise.withResolvers<void>();
			vi.mocked(fetch).mockClear();
			vi.mocked(fetch).mockImplementationOnce(() => {
				oldRequestSent.resolve();
				return oldReply.promise;
			});
			const oldRun = f.t.action(internal.playwriter_browser.process_cleanups, {});
			await oldRequestSent.promise;
			expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toMatchObject({
				generation: c.saved.connectionGeneration,
			});
			expect(
				await f.asUser.mutation(api.organizations.remove_user_from_organization, {
					organizationId: f.db.organizationId,
					userIdToRemove: member.userId,
				}),
			).toEqual({ _yay: null });
			oldReply.resolve(
				oldResult === "succeeds"
					? Response.json({
							ok: true,
							runtime: { ...runtime(c.saved), state: "disconnected", generation: c.saved.connectionGeneration + 1 },
						})
					: Response.json({ ok: false, error: { code: "not_connected", message: "not connected" } }, { status: 404 }),
			);
			await oldRun;
			expect(
				await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect()),
				"An old retirement reply must not finish or delay an upgraded Forget job",
			).toMatchObject([{ forgetCredential: true, attempts: 0 }]);
			expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
				state: "closing",
			});

			// The next cleanup run sends generationless Forget, and only its fixed reply completes the job.
			vi.mocked(fetch).mockResolvedValue(
				Response.json(
					{ ok: false, error: { code: "connection_forgotten", message: "connection forgotten" } },
					{ status: 410 },
				),
			);
			await f.t.action(internal.playwriter_browser.process_cleanups, {});
			const forget = playwriter_browser_disconnect_schema.parse(
				JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body)),
			);
			expect(forget).not.toHaveProperty("generation");
			expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toEqual([]);
			expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
				state: "closed",
				active: false,
			});
		},
	);
});

describe("get_remote_lease", () => {
	test("an archived chat cannot acquire browser authority", async () => {
		const f = await fixture();
		const c = await connection(f);
		expect(
			(
				await f.t.query(internal.playwriter_browser.get_remote_lease, {
					source: f.source,
					browserIntent: c.browserIntent,
				})
			)._yay,
		).toEqual(c.resource);
		await f.t.run((ctx) => ctx.db.patch("ai_chat_threads", f.source.threadId, { archived: true }));
		expect(
			(
				await f.t.query(internal.playwriter_browser.get_remote_lease, {
					source: f.source,
					browserIntent: c.browserIntent,
				})
			)._nay,
		).toBeTruthy();
	});
	test("rejects an old saved browser choice", async () => {
		const f = await fixture();
		const c = await connection(f);
		expect(
			(
				await f.t.query(internal.playwriter_browser.get_remote_lease, {
					source: f.source,
					browserIntent: { ...c.browserIntent, selectionRevision: 0 },
				})
			)._nay?.name,
		).toBe("browser_intent_changed");
	});
});

describe("reserve_command", () => {
	test("returns the current capped version policy for a new command", async () => {
		const f = await fixture();
		const c = await connection(f);
		const versions = Array.from({ length: 17 }, (_, index) => `0.6.${index}`);
		vi.stubEnv("BROWSER_PLAYWRITER_ALLOWED_VERSIONS", ["invalid", "1.2.3-" + "a".repeat(33), ...versions].join(", "));
		const reserved = await f.t.mutation(internal.playwriter_browser.reserve_command, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "current-policy-read",
			operationHash: "c".repeat(64),
		});
		expect(reserved._yay?.invocation.isNew).toBe(true);
		expect(reserved._yay, "A new claim must return the current capped version policy").toMatchObject({
			allowedVersions: versions.slice(0, 16),
		});
	});
	test("keeps a finished exact receipt usable after version removal", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const c = await connection(f);
		const args = {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "finished-read",
			operationHash: "c".repeat(64),
		};
		await f.t.mutation(internal.playwriter_browser.reserve_command, args);
		const saved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		expect(
			await f.t.mutation(internal.playwriter_browser.finish_command, {
				connectionId: saved._id,
				identity: saved.unresolvedCommand!,
				result: { status: "succeeded", reason: null },
				runtime: runtime(saved),
				completedLease: completed_lease(saved),
				fenced: true,
			}),
		).toBe(true);
		vi.stubEnv("BROWSER_PLAYWRITER_ALLOWED_VERSIONS", "");
		const duplicate = await f.t.mutation(internal.playwriter_browser.reserve_command, args);
		expect(duplicate._yay?.invocation).toMatchObject({
			isNew: false,
			status: "finished",
			result: { status: "succeeded" },
		});
		expect((await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))?.operations).toBe(1);
		expect(
			(await f.t.mutation(internal.playwriter_browser.reserve_command, { ...args, toolCallId: "new-read" }))._nay?.name,
		).toBe("unavailable");
		vi.mocked(fetch).mockImplementation(async () =>
			Response.json(
				{ ok: false, error: { code: "connection_forgotten", message: "connection forgotten" } },
				{ status: 410 },
			),
		);
		expect(
			(
				await f.asUser.action(api.playwriter_browser.disconnect_connection, {
					membershipId: f.db.membershipId,
					connectionId: c.saved._id,
				})
			)._yay,
		).toBeTruthy();
		await f.t.action(internal.playwriter_browser.process_cleanups, {});
		expect(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect())).toHaveLength(0);
		expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).endsWith("/disconnect"))).toBe(true);
	});
	test("an exact retry shares one durable identity and operation charge", async () => {
		const f = await fixture();
		const c = await connection(f);
		const args = {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "read-1",
			operationHash: "c".repeat(64),
		};
		const first = await f.t.mutation(internal.playwriter_browser.reserve_command, args);
		const second = await f.t.mutation(internal.playwriter_browser.reserve_command, args);
		expect(first._yay?.invocation.isNew).toBe(true);
		expect(second._yay?.invocation.isNew).toBe(false);
		expect(second._yay?.invocation.commandId).toBe(first._yay?.invocation.commandId);
		expect((await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))?.operations).toBe(1);
		expect(
			(await f.t.mutation(internal.playwriter_browser.reserve_command, { ...args, operationHash: "d".repeat(64) }))._nay
				?.name,
		).toBe("invocation_changed");
	});
	test("one unresolved command blocks another call", async () => {
		const f = await fixture();
		const c = await connection(f);
		const args = {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "read-1",
			operationHash: "c".repeat(64),
		};
		await f.t.mutation(internal.playwriter_browser.reserve_command, args);
		expect(
			(await f.t.mutation(internal.playwriter_browser.reserve_command, { ...args, toolCallId: "read-2" }))._nay,
		).toBeTruthy();
	});
	test("session cap refuses the next operation", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.run((ctx) => ctx.db.patch("playwriter_connections", c.saved._id, { operations: 120 }));
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.reserve_command, {
					source: f.source,
					browserIntent: c.browserIntent,
					resource: c.resource,
					toolCallId: "read-1",
					operationHash: "c".repeat(64),
				})
			)._nay?.name,
		).toBe("limit");
	});
});

describe("finish_command", () => {
	test.each(["cross_document_click", "push_state_click", "enter_submit"])(
		"a proven %s keeps the connection usable",
		async (action) => {
			const f = await fixture();
			const c = await connection(f);
			const reserved = await f.t.mutation(internal.playwriter_browser.reserve_command, {
				source: f.source,
				browserIntent: c.browserIntent,
				resource: c.resource,
				toolCallId: action,
				operationHash: "c".repeat(64),
			});
			if (reserved._nay) throw new Error(reserved._nay.message);
			const running = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
			const navRevision = running.navRevision + 1;
			expect(
				await f.t.mutation(internal.playwriter_browser.finish_command, {
					connectionId: running._id,
					identity: running.unresolvedCommand!,
					result: { status: "succeeded", reason: null },
					runtime: { ...runtime(running), navRevision },
					completedLease: completed_lease(running, navRevision),
					fenced: true,
				}),
			).toBe(true);
			const saved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
			expect(saved).toMatchObject({
				state: "ready",
				unresolvedCommand: null,
				navRevision,
				connectionGeneration: running.connectionGeneration,
			});
			expect(
				await f.t.run((ctx) => ctx.db.get("ai_chat_browser_invocations", reserved._yay.invocation.invocationId)),
			).toMatchObject({
				status: "finished",
				result: { status: "succeeded" },
				resource: { navRevision },
			});
			expect(
				(
					await f.t.mutation(internal.playwriter_browser.reserve_command, {
						source: f.source,
						browserIntent: c.browserIntent,
						resource: { ...c.resource, navRevision },
						toolCallId: `${action}-fresh-read`,
						operationHash: "d".repeat(64),
					})
				)._yay?.invocation.isNew,
			).toBe(true);
		},
	);
	test.each(["stored", "returned"] as const)(
		"an old settled receipt cannot restore an ack after %s generation changes",
		async (changed) => {
			const f = await fixture();
			const c = await connection(f);
			await f.t.mutation(internal.playwriter_browser.reserve_command, {
				source: f.source,
				browserIntent: c.browserIntent,
				resource: c.resource,
				toolCallId: "read-1",
				operationHash: "c".repeat(64),
			});
			const running = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
			if (changed === "stored")
				await f.t.mutation(internal.playwriter_browser.commit_runtime, {
					connectionId: running._id,
					attemptId: running.connectAttemptId,
					expectedControlRevision: running.controlRevision,
					runtime: { ...runtime(running), generation: running.connectionGeneration + 1 },
				});
			expect(
				await f.t.mutation(internal.playwriter_browser.finish_command, {
					connectionId: running._id,
					identity: running.unresolvedCommand!,
					result: { status: "unknown", reason: "outcome_unknown" },
					fenced: true,
					runtime: { ...runtime(running), generation: running.connectionGeneration + Number(changed === "returned") },
					completedLease: null,
				}),
			).toBe(true);
			const saved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", running._id)))!;
			expect(saved.pendingAcknowledgement).toBeNull();
			expect(saved.unresolvedCommand).toBeNull();
			expect(saved.connectionGeneration).toBe(running.connectionGeneration + Number(changed === "stored"));
		},
	);
	test("records the command's navigation without rolling back a newer status", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.reserve_command, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "navigate",
			operationHash: "c".repeat(64),
		});
		const saved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		await f.t.mutation(internal.playwriter_browser.commit_runtime, {
			connectionId: saved._id,
			attemptId: saved.connectAttemptId,
			expectedControlRevision: saved.controlRevision,
			runtime: { ...runtime(saved), navRevision: 2, targetRevision: 3 },
		});
		expect(
			await f.t.mutation(internal.playwriter_browser.finish_command, {
				connectionId: saved._id,
				identity: saved.unresolvedCommand!,
				result: { status: "succeeded", reason: null },
				fenced: true,
				runtime: { ...runtime(saved), navRevision: 2, targetRevision: 3 },
				completedLease: completed_lease(saved, 1, 2),
			}),
		).toBe(true);
		const receipt = await f.t.run((ctx) =>
			ctx.db.get("ai_chat_browser_invocations", saved.unresolvedCommand!.invocationId),
		);
		expect(receipt?.resource).toMatchObject({ navRevision: 1, targetRevision: 2 });
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", saved._id))).toMatchObject({
			navRevision: 2,
			targetRevision: 3,
		});
	});
	test("an unknown result needs proof that old dispatch stopped", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.reserve_command, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "read-1",
			operationHash: "c".repeat(64),
		});
		const saved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		const args = {
			connectionId: saved._id,
			identity: saved.unresolvedCommand!,
			result: { status: "unknown" as const, reason: "lost_reply" },
			runtime: null,
			completedLease: null,
			fenced: false,
		};
		expect(await f.t.mutation(internal.playwriter_browser.finish_command, args)).toBe(false);
		expect((await f.t.run((ctx) => ctx.db.get("playwriter_connections", saved._id)))?.unresolvedCommand).toBeTruthy();
		expect(await f.t.mutation(internal.playwriter_browser.finish_command, { ...args, fenced: true })).toBe(true);
	});
	test("safe receipt settles after its source was deleted", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.reserve_command, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "read-1",
			operationHash: "c".repeat(64),
		});
		const saved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		await f.t.run((ctx) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", f.source.sourceMessageId));
		expect(
			await f.t.mutation(internal.playwriter_browser.finish_command, {
				connectionId: saved._id,
				identity: saved.unresolvedCommand!,
				result: { status: "succeeded", reason: null },
				runtime: runtime(saved),
				completedLease: completed_lease(saved),
				fenced: true,
			}),
		).toBe(true);
		const invocation = await f.t.run((ctx) =>
			ctx.db.get("ai_chat_browser_invocations", saved.unresolvedCommand!.invocationId),
		);
		expect(invocation?.result).toEqual({ status: "succeeded", reason: null });
		expect(JSON.stringify(invocation)).not.toContain("native-tab-private");
	});
});

describe("resolve_command", () => {
	test("a closed dispatch generation settles unknown and allows both recovery doors", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.reserve_command, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "unknown-act",
			operationHash: "c".repeat(64),
		});
		const running = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		const slot = running.unresolvedCommand!;
		vi.mocked(fetch).mockImplementation(async () =>
			Response.json({
				ok: true,
				status: "unknown",
				completedLease: null,
				runtime: { ...runtime(running), state: "needs_human", generation: slot.generation + 1 },
				result: { ok: false, reason: "outcome_unknown", inputSent: true, cleanup: "unknown" },
			}),
		);
		await f.t.action(internal.playwriter_browser.resolve_command, {
			connectionId: running._id,
			commandId: slot.commandId,
			generation: slot.generation,
		});
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", running._id))).toMatchObject({
			unresolvedCommand: null,
			pendingAcknowledgement: null,
			state: "offline",
		});
		expect(await f.t.run((ctx) => ctx.db.get("ai_chat_browser_invocations", slot.invocationId))).toMatchObject({
			status: "finished",
			result: { status: "unknown" },
		});
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.prepare_source_recovery, {
					source: f.source,
					browserIntent: c.browserIntent,
					resource: c.resource,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.prepare_control, {
					userId: f.db.userId,
					membershipId: f.db.membershipId,
					connectionId: running._id,
					operation: "reconnect",
				})
			)._nay,
		).toBeUndefined();
	});
	test("clears an unknown navigation command after proven cleanup", async () => {
		const f = await fixture();
		const c = await connection(f);
		await f.t.mutation(internal.playwriter_browser.reserve_command, {
			source: f.source,
			browserIntent: c.browserIntent,
			resource: c.resource,
			toolCallId: "read-1",
			operationHash: "c".repeat(64),
		});
		const saved = (await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)))!;
		vi.mocked(fetch).mockImplementation(async () =>
			Response.json({
				ok: true,
				status: "unknown",
				runtime: { ...runtime(saved), selectionRevision: 1, navRevision: saved.navRevision + 1 },
				completedLease: null,
				result: { ok: false, reason: "outcome_unknown", inputSent: true, cleanup: "complete" },
			}),
		);
		await f.t.action(internal.playwriter_browser.resolve_command, {
			connectionId: saved._id,
			commandId: saved.unresolvedCommand!.commandId,
			generation: saved.connectionGeneration,
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", saved._id))).toMatchObject({
			unresolvedCommand: null,
			navRevision: saved.navRevision + 1,
		});
		expect(
			await f.t.run((ctx) => ctx.db.get("ai_chat_browser_invocations", saved.unresolvedCommand!.invocationId)),
		).toMatchObject({ status: "finished", result: { status: "unknown", reason: "outcome_unknown" } });
	});
});

describe("retire_session", () => {
	test("agent close keeps the credential until its old idle deadline and queues socket cleanup", async () => {
		const f = await fixture();
		const c = await connection(f);
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.retire_session, {
					source: f.source,
					browserIntent: c.browserIntent,
					resource: c.resource,
				})
			)._yay,
		).toBeTruthy();
		const saved = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
		expect(saved).toMatchObject({ active: false, pauseReason: "agent_closed", idleExpiresAt: c.saved.idleExpiresAt });
		expect(saved?.encryptedShareId).not.toBeNull();
		expect(
			(await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect()))[0]?.forgetCredential,
		).toBe(false);
		expect(
			(
				await f.t.mutation(internal.playwriter_browser.prepare_control, {
					connectionId: c.saved._id,
					userId: f.db.userId,
					membershipId: f.db.membershipId,
					operation: "reconnect",
				})
			)._nay?.name,
		).toBe("busy");
	});
});

describe("sync_policy", () => {
	test("failed cron retries do not add another retry chain", async () => {
		const f = await fixture();
		const c = await connection(f);
		vi.mocked(fetch).mockImplementation(async (url) => {
			if (new URL(String(url)).pathname.endsWith("/status"))
				return Response.json({ ok: true, runtime: runtime(c.saved) });
			return Response.json({ ok: false, error: { code: "transport", message: "Unavailable" } }, { status: 503 });
		});
		await f.asUser.action(api.files_browser.set_browser_agent_access, {
			membershipId: f.db.membershipId,
			enabled: false,
		});
		const preference = (await f.t.run((ctx) => ctx.db.query("files_browser_preferences").first()))!;
		await f.t.run((ctx) =>
			ctx.db.patch("files_browser_preferences", preference._id, { updatedAt: Date.now() - 31_000 }),
		);
		for (let pass = 1; pass <= 3; pass++) {
			await f.t.mutation(internal.files_browser.retry_browser_preferences_sync, {});
			const before = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
			expect(before.filter((job) => job.name === "files_browser:sync_browser_preferences_for_member")).toHaveLength(
				pass + 1,
			);
			const retried = await f.t.action(internal.files_browser.sync_browser_preferences_for_member, {
				preferenceId: preference._id,
				membershipId: f.db.membershipId,
			});
			expect(retried._nay?.name).toBe("transport");
			const after = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
			expect(after, "A failed retry must not schedule itself again").toEqual(before);
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_browser_preferences", preference._id))).toMatchObject({
			syncPending: true,
			webAgentAccess: false,
			policyRevision: preference.policyRevision,
		});
	});

	test("an old policy acknowledgement keeps the saved policy pending", async () => {
		const f = await fixture();
		const c = await connection(f);
		vi.mocked(fetch).mockImplementation(async () => Response.json({ ok: true, runtime: runtime(c.saved) }));
		const synced = await f.asUser.action(api.files_browser.set_browser_agent_access, {
			membershipId: f.db.membershipId,
			enabled: false,
		});
		expect(synced._nay?.name, "An old acknowledgement must not complete the current policy sync").toBe("stale_policy");
		expect(await f.t.run((ctx) => ctx.db.query("files_browser_preferences").first())).toMatchObject({
			syncPending: true,
			webAgentAccess: false,
		});
	});

	test("an offline runner cannot keep cloud intent blocked by a policy update", async () => {
		const f = await fixture();
		const c = await connection(f);
		vi.mocked(fetch).mockImplementation(async () =>
			Response.json({
				ok: true,
				runtime: { ...runtime(c.saved), state: "disconnected", generation: c.saved.connectionGeneration + 1 },
			}),
		);
		const synced = await f.asUser.action(api.files_browser.set_browser_choice, {
			membershipId: f.db.membershipId,
			webChoice: { provider: "cloud" },
		});
		expect(synced._yay).toMatchObject({ syncPending: false, webChoice: { provider: "cloud" } });
		expect(vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).pathname.split("/").at(-1))).toEqual([
			"status",
		]);
	});
	test("checks the current runner generation before updating policy", async () => {
		const f = await fixture();
		const c = await connection(f);
		const generation = c.saved.connectionGeneration + 1;
		const routes: string[] = [];
		const syncGenerations: number[] = [];
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			const route = new URL(String(url)).pathname.split("/").at(-1)!;
			routes.push(route);
			if (route === "agent-access") {
				const input = playwriter_browser_access_schema.parse(JSON.parse(String(options?.body)));
				syncGenerations.push(input.generation);
				if (input.generation !== generation)
					return Response.json({ ok: false, error: { code: "stale_policy", message: "Stale" } }, { status: 409 });
			}
			const input =
				route === "agent-access" ? playwriter_browser_access_schema.parse(JSON.parse(String(options?.body))) : null;
			return Response.json({
				ok: true,
				runtime: {
					...runtime(c.saved),
					generation,
					...(input
						? {
								policyRevision: input.policyRevision,
								selectionRevision: input.selectionRevision,
								agentAccess: input.agentAccess,
							}
						: {}),
				},
			});
		});
		const synced = await f.t.action(internal.playwriter_browser.sync_policy, {
			ownerId: f.db.userId,
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			webAgentAccess: false,
			agentBlockedHosts: [],
			selectionRevision: 1,
			policyRevision: 1,
		});
		expect(syncGenerations, "Policy sync must use the runner's checked generation").toEqual([generation]);
		expect(synced._yay).toBeNull();
		expect(routes).toEqual(["status", "agent-access"]);
	});

	test("a failed settings sync queues a retry using the saved preference", async () => {
		const f = await fixture();
		const c = await connection(f);
		vi.mocked(fetch).mockImplementation(async (url) => {
			if (new URL(String(url)).pathname.endsWith("/status"))
				return Response.json({ ok: true, runtime: runtime(c.saved) });
			return Response.json({ ok: false, error: { code: "transport", message: "Unavailable" } }, { status: 503 });
		});
		const failed = await f.asUser.action(api.files_browser.set_browser_agent_access, {
			membershipId: f.db.membershipId,
			enabled: false,
		});
		expect(failed._nay?.name).toBe("transport");
		const preference = (await f.t.run((ctx) => ctx.db.query("files_browser_preferences").first()))!;
		expect(preference.syncPending).toBe(true);
		const scheduled = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(
			scheduled.filter((job) => job.name === "files_browser:sync_browser_preferences_for_member"),
			"A failed policy sync must have a durable retry",
		).toMatchObject([{ args: [{ preferenceId: preference._id, membershipId: f.db.membershipId }] }]);
		const changedAgain = await f.t.mutation(internal.files_browser.change_browser_preferences, {
			userId: f.db.userId,
			membershipId: f.db.membershipId,
			change: { kind: "hosts", hosts: ["bank.example"] },
		});
		if (changedAgain._nay) throw new Error(changedAgain._nay.message);
		const revisions: number[] = [];
		vi.mocked(fetch).mockImplementation(async (url, options) => {
			const input = new URL(String(url)).pathname.endsWith("/agent-access")
				? playwriter_browser_access_schema.parse(JSON.parse(String(options?.body)))
				: null;
			if (input) revisions.push(input.policyRevision);
			return Response.json({
				ok: true,
				runtime: {
					...runtime(c.saved),
					...(input
						? {
								policyRevision: input.policyRevision,
								selectionRevision: input.selectionRevision,
								agentAccess: input.agentAccess,
							}
						: {}),
				},
			});
		});
		expect(
			(
				await f.t.action(internal.files_browser.sync_browser_preferences_for_member, {
					preferenceId: preference._id,
					membershipId: f.db.membershipId,
				})
			)._nay,
		).toBeUndefined();
		expect(revisions, "Retry must reload the latest policy instead of replaying the failed snapshot").toEqual([2]);
		expect(await f.t.run((ctx) => ctx.db.get("files_browser_preferences", preference._id))).toMatchObject({
			syncPending: false,
			policyRevision: 2,
			webAgentAccess: false,
		});
	});

	test("a cleared preference does not replay a delayed retry", async () => {
		const f = await fixture();
		await connection(f);
		const preference = (await f.t.run((ctx) => ctx.db.query("files_browser_preferences").first()))!;
		expect(
			(
				await f.t.action(internal.files_browser.sync_browser_preferences_for_member, {
					preferenceId: preference._id,
					membershipId: f.db.membershipId,
				})
			)._nay,
		).toBeUndefined();
		expect(fetch).not.toHaveBeenCalled();
	});

	test("the cron retries an old pending preference with its current membership", async () => {
		const f = await fixture();
		await connection(f);
		const preference = (await f.t.run((ctx) => ctx.db.query("files_browser_preferences").first()))!;
		await f.t.run((ctx) =>
			ctx.db.patch("files_browser_preferences", preference._id, { syncPending: true, updatedAt: Date.now() - 31_000 }),
		);
		await f.t.mutation(internal.files_browser.retry_browser_preferences_sync, {});
		const scheduled = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(scheduled.filter((job) => job.name === "files_browser:sync_browser_preferences_for_member")).toMatchObject([
			{ args: [{ preferenceId: preference._id, membershipId: f.db.membershipId }] },
		]);
	});
});

describe("sweep_connections", () => {
	test("retirement keeps a human Pause accepted by the active runner", async () => {
		const f = await fixture();
		const c = await connection(f);
		vi.mocked(fetch).mockImplementation(async () =>
			Response.json({
				ok: true,
				runtime: { ...runtime(c.saved), state: "paused", controlRevision: c.saved.controlRevision + 1 },
			}),
		);
		expect(
			(
				await f.asUser.action(api.playwriter_browser.pause_connection, {
					membershipId: f.db.membershipId,
					connectionId: c.saved._id,
				})
			)._yay,
		).toEqual({ connectionId: c.saved._id });
		await f.t.run((ctx) => ctx.db.patch("playwriter_connections", c.saved._id, { operations: 120 }));
		await f.t.mutation(internal.playwriter_browser.sweep_connections, {});
		expect(
			await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id)),
			"Retirement must preserve an existing human Pause",
		).toMatchObject({ active: false, state: "limit_reached", pauseReason: "human" });
	});

	test.each(["operations", "total"] as const)(
		"ends an expired %s budget and keeps the link only until its old idle deadline",
		async (budget) => {
			const f = await fixture();
			const c = await connection(f);
			await f.t.run((ctx) =>
				ctx.db.patch(
					"playwriter_connections",
					c.saved._id,
					budget === "operations" ? { operations: 120 } : { totalExpiresAt: Date.now() - 1 },
				),
			);
			await f.t.mutation(internal.playwriter_browser.sweep_connections, {});
			const saved = await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id));
			expect(saved).toMatchObject({ active: false, pauseReason: "limit", idleExpiresAt: c.saved.idleExpiresAt });
			expect(saved?.encryptedShareId).not.toBeNull();
			expect((await f.t.run((ctx) => ctx.db.query("playwriter_connection_cleanups").collect()))[0]).toMatchObject({
				forgetCredential: false,
				generation: c.saved.connectionGeneration,
			});
		},
	);
	test("flags off revoke authority and forget saved credentials", async () => {
		const f = await fixture();
		const c = await connection(f);
		vi.stubEnv("AI_CHAT_PLAYWRITER_ENABLED", "false");
		await f.t.mutation(internal.playwriter_browser.sweep_connections, {});
		expect(await f.t.run((ctx) => ctx.db.get("playwriter_connections", c.saved._id))).toMatchObject({
			active: false,
			encryptedShareId: null,
			pauseReason: "unavailable",
		});
	});
});
