import type { JSONContent } from "@tiptap/core";
import {
	pages_tiptap_markdown_to_json,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_get_markdown,
} from "../../shared/pages.ts";
import { TypedEventTarget } from "@remix-run/interaction";
import { should_never_happen, XCustomEvent } from "./utils.ts";
import type { usePresenceList, usePresenceSessions, usePresenceSessionsData } from "../hooks/presence-hooks.ts";
import { objects_equal_deep } from "./object.ts";
import { editor as monaco_editor } from "monaco-editor";
import { app_convex, type app_convex_Id, app_convex_api } from "@/lib/app-convex-client.ts";

export * from "../../shared/pages.ts";

export const pages_INITIAL_CONTENT = `\
# Welcome

You can start editing your document here.
`;

export const pages_get_rich_text_initial_content = ((/* iife */) => {
	function value(): JSONContent {
		return pages_tiptap_markdown_to_json({
			markdown: pages_INITIAL_CONTENT,
		});
	}

	let cache: ReturnType<typeof value> | undefined;

	return function pages_get_initial_content(): JSONContent {
		return (cache ??= value());
	};
})();

export async function pages_fetch_page_yjs_state_and_markdown(args: {
	workspaceId: string;
	projectId: string;
	pageId: app_convex_Id<"pages">;
}) {
	const [snapshotDoc, updatesData, lastSequenceData] = await Promise.all([
		app_convex.query(app_convex_api.ai_docs_temp.yjs_get_doc_last_snapshot, args),
		app_convex
			.query(app_convex_api.ai_docs_temp.yjs_get_incremental_updates, args)
			.then((updatesData) => updatesData?.updates ?? []),
		app_convex.query(app_convex_api.ai_docs_temp.get_page_last_yjs_sequence, args),
	]);

	if (snapshotDoc == null) return null;

	// By default the API returns updates in descending order; normalize to ascending and filter
	// to only include updates that are after the snapshot.
	const filteredIncrementalUpdates = updatesData.filter((u) => u.sequence > snapshotDoc.sequence).reverse();

	const yjsDoc = pages_yjs_doc_create_from_array_buffer_update(snapshotDoc.snapshot_update, {
		additionalIncrementalArrayBufferUpdates: filteredIncrementalUpdates.map((u) => u.update),
	});
	const markdown = pages_yjs_doc_get_markdown({ yjsDoc });

	const yjsSequence = lastSequenceData?.last_sequence ?? snapshotDoc.sequence;

	return { markdown, yjsDoc, yjsSequence };
}

// #region presence store
export class pages_PresenceStore_Event extends XCustomEvent<{
	connected: { userId: string; sessionId: string };
	disconnected: { userId: string; sessionId: string };
	data_changed: {
		userId: string;
		sessionId: string;
		userData: pages_PresenceStore_UserData;
		sessionData: pages_PresenceStore_SessionData;
	};
}> {}

type pages_PresenceStore_Data = {
	sessionToken: string;
	sessions: NonNullable<ReturnType<typeof usePresenceSessions>>;
	sessionsData: NonNullable<ReturnType<typeof usePresenceSessionsData>>;
	usersAnagraphics: NonNullable<ReturnType<typeof usePresenceList>>["usersAnagraphics"];
};

type pages_PresenceStore_SessionData = {
	yjs_data?: {
		user: { name: string | null; color: string | null };
		cursor?: unknown;
		[key: string]: unknown;
	} | null;
	yjs_clientId?: number;
	color: string;
};

type pages_PresenceStore_UserData = {
	displayName: string;
};

export class pages_PresenceStore extends TypedEventTarget<pages_PresenceStore_Event["__map"]> {
	sessionIdUserIdMap = new Map<string, string>();
	sessionIds = new Set<string>();
	sessionsData = new Map<string, pages_PresenceStore_SessionData>();
	usersData = new Map<string, pages_PresenceStore_UserData>();
	localSessionId: string;
	localSessionToken: string;

	private disposed = false;

	private onSetSessionData: typeof this.setSessionData;

	constructor(args: {
		data: pages_PresenceStore_Data;
		localSessionId: string;
		onSetSessionData: (data: pages_PresenceStore_SessionData) => void;
	}) {
		super();
		this.localSessionId = args.localSessionId;
		this.localSessionToken = args.data.sessionToken;
		this.onSetSessionData = args.onSetSessionData;

		for (const session of args.data.sessions) {
			this.sessionIdUserIdMap.set(session.sessionId, session.userId);
			this.sessionIds.add(session.sessionId);

			this.usersData.set(session.userId, {
				displayName: args.data.usersAnagraphics[session.userId].displayName,
			});

			this.sessionsData.set(session.sessionId, {
				color: args.data.sessionsData[session.sessionId]?.color,
				yjs_data: args.data.sessionsData[session.sessionId]?.yjs_data,
				yjs_clientId: args.data.sessionsData[session.sessionId]?.yjs_clientId,
			});
		}

		if (!args.data.sessions.some((session) => session.sessionId === args.localSessionId)) {
			// TODO: remove this if we do not catch it for a long time
			should_never_happen("localSessionId is not in sessions");
		}
	}

	sync(newData: pages_PresenceStore_Data) {
		if (this.disposed) return;

		for (const newSession of newData.sessions) {
			let isNewSession = false;

			if (this.sessionIds.has(newSession.sessionId) === false) {
				isNewSession = true;
				this.sessionIdUserIdMap.set(newSession.sessionId, newSession.userId);
				this.sessionIds.add(newSession.sessionId);
				this.dispatchEvent(
					new pages_PresenceStore_Event("connected", {
						detail: { userId: newSession.userId, sessionId: newSession.sessionId },
					}),
				);
			}

			const setData = () => {
				this.localSessionToken = newData.sessionToken;
				this.sessionsData.set(newSession.sessionId, {
					color: newData.sessionsData[newSession.sessionId]?.color,
					yjs_data: newData.sessionsData[newSession.sessionId]?.yjs_data,
					yjs_clientId: newData.sessionsData[newSession.sessionId]?.yjs_clientId,
				});
				this.usersData.set(newSession.userId, {
					displayName: newData.usersAnagraphics[newSession.userId].displayName,
				});
			};

			if (isNewSession) {
				setData();
			} else {
				const oldSessionData = this.sessionsData.get(newSession.sessionId);
				const oldUserData = this.usersData.get(newSession.userId);

				if (!oldSessionData || !oldUserData)
					throw should_never_happen("[pages_PresenceStore.sync] old data missing", {
						localSessionId: this.localSessionId,
						localSessionToken: this.localSessionToken,
						newSession,
						oldSessionData,
						oldUserData,
					});

				const newSessionData = {
					color: newData.sessionsData[newSession.sessionId]?.color,
					yjs_data: newData.sessionsData[newSession.sessionId]?.yjs_data,
					yjs_clientId: newData.sessionsData[newSession.sessionId]?.yjs_clientId,
				};

				const newUserData = {
					displayName: newData.usersAnagraphics[newSession.userId].displayName,
				};

				if (
					objects_equal_deep(oldSessionData, newSessionData) === false ||
					objects_equal_deep(oldUserData, newUserData) === false
				) {
					setData();
					this.dispatchEvent(
						new pages_PresenceStore_Event("data_changed", {
							detail: {
								userId: newSession.userId,
								sessionId: newSession.sessionId,
								sessionData: newSessionData,
								userData: newUserData,
							} as pages_PresenceStore_Event["__map"]["data_changed"]["detail"],
						}),
					);
				}
			}
		}

		const disconnectedSessions = this.sessionIds.difference(
			new Set(newData.sessions.map((session) => session.sessionId)),
		);

		for (const disconnectedSessionId of disconnectedSessions) {
			const userId = this.sessionIdUserIdMap.get(disconnectedSessionId);
			if (!userId) throw should_never_happen("userId is undefined");

			this.sessionIds.delete(disconnectedSessionId);
			this.sessionsData.delete(disconnectedSessionId);
			this.sessionIdUserIdMap.delete(disconnectedSessionId);
			this.dispatchEvent(
				new pages_PresenceStore_Event("disconnected", { detail: { userId, sessionId: disconnectedSessionId } }),
			);
		}
	}

	setSessionData(data: Partial<pages_PresenceStore_SessionData>) {
		const currentPresenceData = this.sessionsData.get(this.localSessionId);
		if (!currentPresenceData) {
			if (this.disposed) return;
			throw should_never_happen("currentPresenceData is undefined");
		}

		const newValue = { ...currentPresenceData, ...data };
		this.sessionsData.set(this.localSessionId, newValue);

		if (this.disposed) return;

		this.onSetSessionData(newValue);
	}

	getPresenceData() {
		const userId = this.sessionIdUserIdMap.get(this.localSessionId);
		if (!userId) return null;
		const userData = this.usersData.get(userId);
		if (!userData) return null;
		const sessionData = this.sessionsData.get(this.localSessionId);
		if (!sessionData) return null;

		return {
			userId,
			sessionId: this.localSessionId,
			userData,
			sessionData,
		};
	}

	dispose() {
		this.disposed = true;
	}
}
// #endregion PresenceStore

// #region monaco
export function pages_monaco_create_editor_model(markdown: string) {
	const model = monaco_editor.createModel(markdown, "markdown");
	model.setEOL(monaco_editor.EndOfLineSequence.LF);
	return model;
}
// #endregion monaco
