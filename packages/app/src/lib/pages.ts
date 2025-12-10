import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { pages_get_tiptap_shared_extensions } from "../../shared/pages.ts";
import { TypedEventTarget } from "@remix-run/interaction";
import { should_never_happen, XCustomEvent } from "./utils.ts";
import type { usePresenceSessions, usePresenceSessionsData, usePresenceUsersData } from "../hooks/presence-hooks.ts";
import { objects_equal_deep } from "./object.ts";

export * from "../../shared/pages.ts";

export const pages_INITIAL_CONTENT = `\
# Welcome

You can start editing your document here.
`;

export const pages_get_rich_text_initial_content = ((/* iife */) => {
	function value(): JSONContent {
		const extensions = pages_get_tiptap_shared_extensions();
		const editor = new Editor({
			element: null, // Headless editor (no DOM)
			content: { type: "doc", content: [] },
			extensions: Object.values(extensions),
			enableInputRules: false,
			enablePasteRules: false,
			coreExtensionOptions: {
				delete: { async: false },
			},
		});

		try {
			if (!editor.markdown) {
				throw new Error("editor.markdown is not set");
			}

			const json = editor.markdown.parse(pages_INITIAL_CONTENT);
			return json;
		} finally {
			editor.destroy();
		}
	}

	let cache: ReturnType<typeof value> | undefined;

	return function pages_get_initial_content(): JSONContent {
		return (cache ??= value());
	};
})();

// #region PresenceStore

export class pages_PresenceStore_Event extends XCustomEvent<{
	connected: { userId: string; sessionId: string };
	disconnected: { userId: string; sessionId: string };
	data_changed: { userId: string; sessionId: string; data: pages_PresenceStore_SessionData };
}> {}

type pages_PresenceStore_Data = {
	sessionToken: string;
	sessions: NonNullable<ReturnType<typeof usePresenceSessions>>;
	sessionsData: NonNullable<ReturnType<typeof usePresenceSessionsData>>;
	usersRoomData: NonNullable<ReturnType<typeof usePresenceUsersData>>;
};

type pages_PresenceStore_SessionData = {
	yjs_data?: {
		user: { name: string | null; color: string | null };
		cursor?: unknown;
		[key: string]: unknown;
	} | null;
	yjs_clientId?: number;
	name: string;
	color: string;
};

export class pages_PresenceStore extends TypedEventTarget<pages_PresenceStore_Event["__map"]> {
	sessionIdUserIdMap = new Map<string, string>();
	sessionIds = new Set<string>();
	presenceData = new Map<string, pages_PresenceStore_SessionData>();
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

			this.presenceData.set(session.sessionId, {
				name: session.userId,
				color: args.data.sessionsData[session.sessionId]?.color,
				yjs_data: args.data.sessionsData[session.sessionId]?.yjs_data,
				yjs_clientId: args.data.sessionsData[session.sessionId]?.yjs_clientId,
			});
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
				this.presenceData.set(newSession.sessionId, {
					name: newSession.userId,
					color: newData.sessionsData[newSession.sessionId]?.color,
					yjs_data: newData.sessionsData[newSession.sessionId]?.yjs_data,
					yjs_clientId: newData.sessionsData[newSession.sessionId]?.yjs_clientId,
				});
			};

			if (isNewSession) {
				setData();
			} else {
				const oldSessionToken = this.localSessionToken;
				const oldPresenceData = this.presenceData.get(newSession.sessionId);
				if (!oldPresenceData) throw should_never_happen("oldData is undefined");

				const newPresenceData = {
					name: newData.sessionsData[newSession.sessionId]?.name,
					color: newData.sessionsData[newSession.sessionId]?.color,
					yjs_data: newData.sessionsData[newSession.sessionId]?.yjs_data,
					yjs_clientId: newData.sessionsData[newSession.sessionId]?.yjs_clientId,
				};

				if (
					objects_equal_deep(oldPresenceData, newPresenceData) === false ||
					oldSessionToken !== newData.sessionToken
				) {
					setData();
					this.dispatchEvent(
						new pages_PresenceStore_Event("data_changed", {
							detail: {
								userId: newSession.userId,
								sessionId: newSession.sessionId,
								data: newPresenceData,
							},
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
			this.presenceData.delete(disconnectedSessionId);
			this.sessionIdUserIdMap.delete(disconnectedSessionId);
			this.dispatchEvent(
				new pages_PresenceStore_Event("disconnected", { detail: { userId, sessionId: disconnectedSessionId } }),
			);
		}
	}

	setSessionData(data: Partial<pages_PresenceStore_SessionData>) {
		const currentPresenceData = this.presenceData.get(this.localSessionId);
		if (!currentPresenceData) throw should_never_happen("currentPresenceData is undefined");

		const newValue = { ...currentPresenceData, ...data };
		this.presenceData.set(this.localSessionId, newValue);

		if (this.disposed) return;

		this.onSetSessionData(newValue);
	}

	dispose() {
		this.disposed = true;
	}
}
// #endregion PresenceStore
