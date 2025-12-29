import { Editor } from "@tiptap/core";
import type { JSONContent } from "@tiptap/core";
import { pages_get_tiptap_shared_extensions } from "../../shared/pages.ts";
import { TypedEventTarget } from "@remix-run/interaction";
import { should_never_happen, XCustomEvent } from "./utils.ts";
import type { usePresenceSessions, usePresenceSessionsData, usePresenceUsersData } from "../hooks/presence-hooks.ts";
import { objects_equal_deep } from "./object.ts";
import type * as monaco_module from "monaco-editor";

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

// #region monaco editor

// Monaco requires: /^[a-z0-9\-]+$/i (no underscores)
export const pages_MONACO_THEME_NAME_DARK = "app-pages-monaco-theme-dark";

function css_color_to_hex(cssColor: string) {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}

	// Normalize via canvas
	ctx.fillStyle = "#000";
	ctx.fillStyle = cssColor;

	const normalized = ctx.fillStyle;
	// Usually: "#rrggbb" or "rgba(r, g, b, a)"
	if (typeof normalized !== "string") {
		return null;
	}

	if (normalized.startsWith("#")) {
		const hex = normalized.toLowerCase();
		if (hex.length === 7 || hex.length === 9) {
			return hex;
		}
		return null;
	}

	const rgbaMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(normalized);
	if (!rgbaMatch) {
		return null;
	}

	const r = Math.max(0, Math.min(255, Number(rgbaMatch[1])));
	const g = Math.max(0, Math.min(255, Number(rgbaMatch[2])));
	const b = Math.max(0, Math.min(255, Number(rgbaMatch[3])));
	const a = rgbaMatch[4] == null ? 1 : Math.max(0, Math.min(1, Number(rgbaMatch[4])));

	const toHex2 = (n: number) => n.toString(16).padStart(2, "0");
	const rrggbb = `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
	if (a === 1) {
		return rrggbb;
	}

	const alpha = Math.round(a * 255);
	return `${rrggbb}${toHex2(alpha)}`;
}

function hex_with_alpha(hex: string, alpha01: number) {
	// Accepts "#rrggbb" or "#rrggbbaa"
	const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
	if (!m) {
		return hex;
	}

	const clamped = Math.max(0, Math.min(1, alpha01));
	const alpha = Math.round(clamped * 255)
		.toString(16)
		.padStart(2, "0");
	return `#${m[1]}${alpha}`;
}

function css_var_to_hex(varName: string, fallbackHex: string) {
	const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
	if (!raw) {
		return fallbackHex;
	}

	const converted = css_color_to_hex(raw);
	return converted ?? fallbackHex;
}

export const pages_monaco_register_themes = ((/* iife */) => {
	const registeredMonacoInstances = new WeakSet<typeof monaco_module>();

	return function pages_monaco_register_themes(monaco: typeof monaco_module) {
		if (registeredMonacoInstances.has(monaco)) {
			return;
		}

		registeredMonacoInstances.add(monaco);

		const bg = css_var_to_hex("--color-base-1-03", "#1e1e1e");
		const gutterBg = css_var_to_hex("--color-base-1-02", "#1a1a1a");
		const surface = css_var_to_hex("--color-base-1-05", "#252526");
		const border = css_var_to_hex("--color-base-1-10", "#3c3c3c");

		const fg = css_var_to_hex("--color-fg-11", "#d4d4d4");
		const fgMuted = css_var_to_hex("--color-fg-07", "#858585");
		const fgStrong = css_var_to_hex("--color-fg-12", "#ffffff");

		const accent1 = css_var_to_hex("--color-accent-01", "#264f78");
		const accent6 = css_var_to_hex("--color-accent-06", "#3b8eea");
		const accent7 = css_var_to_hex("--color-accent-07", "#4aa3ff");

		try {
			monaco.editor.defineTheme(pages_MONACO_THEME_NAME_DARK, {
				base: "vs-dark",
				inherit: true,
				rules: [],
				colors: {
					"editor.background": bg,
					"editor.foreground": fg,

					"editorLineNumber.foreground": fgMuted,
					"editorLineNumber.activeForeground": fg,
					"editorCursor.foreground": fgStrong,

					"editor.selectionBackground": hex_with_alpha(accent1, 0.35),
					"editor.inactiveSelectionBackground": hex_with_alpha(accent1, 0.22),

					"editor.findMatchBackground": hex_with_alpha(accent7, 0.35),
					"editor.findMatchHighlightBackground": hex_with_alpha(accent6, 0.25),
					"editor.findRangeHighlightBackground": hex_with_alpha(accent6, 0.18),

					"editor.lineHighlightBackground": hex_with_alpha(surface, 0.65),
					"editor.lineHighlightBorder": "#00000000",

					"editorGutter.background": gutterBg,

					"editorIndentGuide.background1": hex_with_alpha(border, 0.55),
					"editorIndentGuide.activeBackground1": hex_with_alpha(fgMuted, 0.55),

					"editorBracketMatch.background": hex_with_alpha(css_var_to_hex("--color-base-1-08", "#2d2d2d"), 0.9),
					"editorBracketMatch.border": border,

					"editorRuler.foreground": css_var_to_hex("--color-base-1-07", "#2a2a2a"),

					"editorHoverWidget.background": surface,
					"editorHoverWidget.border": border,
					"editorSuggestWidget.background": surface,
					"editorSuggestWidget.border": border,
					"editorWidget.background": surface,
					"editorWidget.border": border,

					"scrollbarSlider.background": hex_with_alpha(border, 0.45),
					"scrollbarSlider.hoverBackground": hex_with_alpha(border, 0.65),
					"scrollbarSlider.activeBackground": hex_with_alpha(fgMuted, 0.55),

					"editorWhitespace.foreground": hex_with_alpha(fgMuted, 0.35),

					"minimap.background": bg,
				},
			});
		} catch (err) {
			console.error("app_monaco_register_ai_docs_dark_theme: failed to define/apply theme", err);
		}
	};
})();
// #endregion monaco editor

// #region presence store

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
	color: string;
};

type pages_PresenceStore_UserData = {
	name: string;
};

export class pages_PresenceStore extends TypedEventTarget<pages_PresenceStore_Event["__map"]> {
	sessionIdUserIdMap = new Map<string, string>();
	sessionIds = new Set<string>();
	presenceData = new Map<string, pages_PresenceStore_SessionData>();
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
				name: args.data.usersRoomData[session.userId]?.name,
			});

			this.presenceData.set(session.sessionId, {
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
				this.presenceData.set(newSession.sessionId, {
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
					name: newData.usersRoomData[newSession.userId]?.name,
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
		if (!currentPresenceData) {
			if (this.disposed) return;
			throw should_never_happen("currentPresenceData is undefined");
		}

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
