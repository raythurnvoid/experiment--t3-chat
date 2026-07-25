// Adapted from `references-submodules/liveblocks/packages/liveblocks-react-tiptap/src/LiveblocksExtension.ts`. Collaboration is
// backed by Convex, so the presence store and the Yjs provider are passed in by the app instead of coming
// from a Liveblocks Room. The mentions integration, the thread-error recovery listener, and the
// thread filtering that the Liveblocks Room provided were dropped. Threads come from Convex, and
// mentions are not wired to Convex at all.

import type { AnyExtension } from "@tiptap/core";
import { Extension, Mark } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret, { type CollaborationCaretOptions } from "@tiptap/extension-collaboration-caret";

import { file_editor_rich_text_AiExtension } from "@/lib/file-editor-rich-text-ai-extension.ts";
import type {
	file_editor_rich_text_ResolveContextualPrompt_Args,
	file_editor_rich_text_ResolveContextualPrompt_Response,
	file_editor_rich_text_TiptapExtension_Options,
	file_editor_rich_text_TiptapExtension_Storage,
} from "@/lib/file-editor-rich-text-utils.ts";

const DEFAULT_OPTIONS = { field: "default" } satisfies file_editor_rich_text_TiptapExtension_Options;

// Keep this mark. `renderSnapshot` in the AI extension writes `ychange` marks when it shows a Yjs
// snapshot diff. No UI reaches that command today, but the command graph still does. Yjs rebuilds
// marks by name when it loads a document, and an undeclared mark name throws instead of being
// dropped, so removing this can make an already stored document impossible to open.
const YChangeMark = Mark.create({
	name: "ychange",
	inclusive: false,
	parseHTML() {
		return [{ tag: "ychange" }];
	},
	addAttributes() {
		return {
			user: {
				default: null,
				parseHTML: (element) => element.getAttribute("ychange_user") ?? null,
				renderHTML: (attributes: { user: string | null }) => {
					if (!attributes.user) {
						return {};
					}
					return { "data-ychange-user": attributes.user };
				},
			},
			type: {
				default: null,
				parseHTML: (element) => element.getAttribute("ychange_type") ?? null,
				renderHTML: (attributes: { type: string | null }) => {
					if (!attributes.type) {
						return {};
					}
					return {
						"data-ychange-type": attributes.type,
						"data-liveblocks": "",
						class: `lb-root lb-tiptap-change lb-tiptap-change-${attributes.type}`,
					};
				},
			},
			color: {
				default: null,
				parseHTML: (element) => {
					return element.getAttribute("ychange_color") ?? null;
				},
				renderHTML: () => {
					// attributes: { color: { light: string; dark: string } | null }
					return {}; // we don't need this color attribute for now
				},
			},
		};
	},
	renderHTML({ HTMLAttributes }) {
		return ["ychange", HTMLAttributes, 0];
	},
});

export const useFileEditorRichTextExtension = (opts?: file_editor_rich_text_TiptapExtension_Options) => {
	// Never memoize this hook: it returns a Tiptap extension that must stay exactly as written.
	"use no memo";

	const options = {
		...DEFAULT_OPTIONS,
		...opts,
	};

	// Tiptap has options default as any, in tiptap2, we could use never, but now we must use any
	return Extension.create<any, file_editor_rich_text_TiptapExtension_Storage>({
		name: "liveblocksExtension",

		onCreate() {
			// Keep initial content server-owned. Convex seeds new documents before the provider
			// hydrates, so the editor must not write bootstrap content.
			if (this.editor.options.content) {
				console.warn(
					"[useFileEditorRichTextExtension.onCreate] Editor content is ignored, remove content from your editor options",
				);
			}

			if (!options.presenceStore) {
				throw new Error("presenceStore is required for useFileEditorRichTextExtension");
			}

			const sessionId = options.presenceStore.localSessionId;
			const userId = options.presenceStore.sessionIdUserIdMap.get(sessionId);
			let presence = options.presenceStore.getPresenceData() /* assert not nullish or typescript complains */!;
			if (!presence) {
				throw new Error("presence for local session not found");
			}
			if (!userId) {
				throw new Error("userId for local session not found");
			}

			const updateUser = (info: { userId: string; name: string; color: string }) => {
				if (!info) {
					return;
				}
				if (this.storage.permanentUserData) {
					const pud = this.storage.permanentUserData.clients.get(this.storage.doc.clientID);
					// Only update if there is no entry or if the entry is different
					if (!pud || pud !== info.userId) {
						this.storage.permanentUserData.setUserMapping(this.storage.doc, this.storage.doc.clientID, info.userId);
					}
				}

				const yjsPresence = this.storage.provider.awareness.getLocalState();
				if (info.name !== yjsPresence?.user?.name || info.color !== yjsPresence?.user?.color) {
					this.editor.commands.updateUser({
						name: info.name,
						color: info.color,
					});
				}
			};
			// if we already have user info, we update the user
			if (presence) {
				updateUser({
					userId,
					name: presence.userData.displayName,
					color: presence.sessionData.color,
				});
			}

			const abortController = new AbortController();
			options.presenceStore.addEventListener(
				"data_changed",
				(event) => {
					if (event.detail.sessionId === sessionId) {
						const oldPresenceData = presence;
						if (
							oldPresenceData.userData.displayName !== event.detail.userData.displayName ||
							oldPresenceData.sessionData.color !== event.detail.sessionData.color
						) {
							updateUser({
								userId,
								name: event.detail.userData.displayName,
								color: event.detail.sessionData.color,
							});
						}

						presence = event.detail;
					}
				},
				{ signal: abortController.signal },
			);

			// we also listen in case the user info changes
			this.storage.unsubs.push(() => abortController.abort());
		},
		onDestroy() {
			this.storage.unsubs.forEach((unsub) => unsub());
		},
		addGlobalAttributes() {
			return [
				{
					types: ["paragraph", "heading"],
					attributes: {
						ychange: { default: null },
					},
				},
			];
		},
		addStorage() {
			if (!options.presenceStore) {
				throw new Error("presenceStore is required for useFileEditorRichTextExtension");
			}
			if (!options.yjsProvider) {
				throw new Error("yjsProvider is required for useFileEditorRichTextExtension");
			}

			const { yjsProvider } = options;
			const yDoc = options.yjsProvider.getYDoc();

			return {
				doc: yDoc,
				provider: yjsProvider,
				permanentUserData: yjsProvider.permanentUserData,
				unsubs: [() => yjsProvider.destroy()],
			};
		},
		addExtensions() {
			if (!options.presenceStore) {
				throw new Error("presenceStore is required for useFileEditorRichTextExtension");
			}

			const presenceData = options.presenceStore.getPresenceData();
			if (!presenceData) {
				throw new Error("presenceData for local session not found");
			}

			const user = {
				name: presenceData.userData.displayName,
				color: presenceData.sessionData.color,
			};

			const extensions: AnyExtension[] = [
				YChangeMark,

				Collaboration.configure({
					ySyncOptions: {
						permanentUserData: this.storage.permanentUserData,
					},
					document: this.storage.doc,
					field: options.field,
					provider: this.storage.provider,
				}),
				CollaborationCaret.configure({
					user,
					provider: this.storage.provider,
				}) as Extension<CollaborationCaretOptions>,
			];

			if (options.ai) {
				const aiConfig = options.ai;
				const resolveContextualPrompt = async ({
					prompt,
					context,
					previous,
					signal,
				}: file_editor_rich_text_ResolveContextualPrompt_Args): Promise<file_editor_rich_text_ResolveContextualPrompt_Response> => {
					if (typeof aiConfig !== "boolean" && aiConfig.resolveContextualPrompt) {
						return aiConfig.resolveContextualPrompt({
							prompt,
							context,
							previous,
							signal,
						});
					}
					throw new Error("resolveContextualPrompt is required when ai is enabled");
				};

				extensions.push(
					file_editor_rich_text_AiExtension.configure({
						resolveContextualPrompt,
						...(typeof options.ai === "boolean" ? {} : options.ai),
						doc: this.storage.doc,
						pud: this.storage.permanentUserData,
					}),
				);
			}

			return extensions;
		},
	});
};
