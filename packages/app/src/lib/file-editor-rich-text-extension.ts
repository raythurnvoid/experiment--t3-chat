// Adapted from `references-submodules/liveblocks/packages/liveblocks-react-tiptap/src/LiveblocksExtension.ts`. Collaboration is
// backed by Convex, so the presence store and the Yjs provider are passed in by the app instead of coming
// from a Liveblocks Room.
//
// Tiptap extension callbacks use `this`, which the React Compiler cannot read. It skips the hook and leaves
// it as written, which is what we want, but the lint rule still reports every `this`. So we turn it off here.
/* eslint-disable react-hooks/todo */
//
// NOTE: Mentions integration (text-mentions endpoints + room private hooks) was
// used when this package was wired to the Liveblocks Room system. We migrated
// away from that integration, but we keep the code commented out for reference.
//
// import {
//   useCreateTextMention,
//   useDeleteTextMention,
// } from "@liveblocks/react/_private";

import type { AnyExtension, Editor } from "@tiptap/core";
import { Extension, Mark } from "@tiptap/core";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret, { type CollaborationCaretOptions } from "@tiptap/extension-collaboration-caret";
import { useEffect, useRef } from "react";

import { file_editor_rich_text_AiExtension } from "@/lib/file-editor-rich-text-ai-extension.ts";
import { files_FILTERED_THREADS_PLUGIN_KEY, files_thread_id_sets_equal } from "../../shared/files-tiptap-comments.ts";
import type {
	file_editor_rich_text_ResolveContextualPrompt_Args,
	file_editor_rich_text_ResolveContextualPrompt_Response,
	file_editor_rich_text_TiptapExtension_Options,
	file_editor_rich_text_TiptapExtension_Storage,
} from "@/lib/file-editor-rich-text-utils.ts";

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

const DEFAULT_OPTIONS: WithRequired<file_editor_rich_text_TiptapExtension_Options, "field"> = {
	field: "default",
	// TODO: to be refactored for Convex BE
	// mentions: true,
	offlineSupport_experimental: false,
	enablePermanentUserData: false,
};

const LiveblocksCollab = Collaboration.extend({
	// Override the onCreate method to warn users about potential misconfigurations
	onCreate() {
		if (!this.editor.extensionManager.extensions.find((e) => e.name === "doc")) {
			console.warn(
				"[Liveblocks] The tiptap document extension is required for Liveblocks collaboration. Please add it or use Tiptap StarterKit extension.",
			);
		}
		if (!this.editor.extensionManager.extensions.find((e) => e.name === "paragraph")) {
			console.warn(
				"[Liveblocks] The tiptap paragraph extension is required for Liveblocks collaboration. Please add it or use Tiptap StarterKit extension.",
			);
		}

		if (!this.editor.extensionManager.extensions.find((e) => e.name === "text")) {
			console.warn(
				"[Liveblocks] The tiptap text extension is required for Liveblocks collaboration. Please add it or use Tiptap StarterKit extension.",
			);
		}
		if (this.editor.extensionManager.extensions.find((e) => e.name === "undoRedo")) {
			console.warn(
				"[Liveblocks] The undoRedo extension is enabled, Liveblocks extension provides its own. Please remove or disable the undoRedo extension to prevent conflicts.",
			);
		}
	},
});

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
	const editor = useRef<Editor | null>(null);

	// TODO: to be refactored for Convex BE
	// TODO: we don't need these things if comments isn't turned on...
	// TODO: we don't have a reference to the editor here, need to figure this out
	// useErrorListener((error) => {
	//   // If thread creation fails, we remove the thread id from the associated nodes and unwrap the nodes if they are no longer associated with any threads
	//   if (
	//     error.context.type === "CREATE_THREAD_ERROR" &&
	//     error.context.roomId === room.id
	//   ) {
	//     handleThreadDelete(error.context.threadId);
	//   }
	// });

	// Keep historical Liveblocks initial-content bootstrapping commented out
	// because Convex now owns initial document content on the server.

	const prevThreadsRef = useRef<Set<string> | undefined>(undefined);

	useEffect(() => {
		if (!editor.current) return;

		const newThreads = options.threads_experimental
			? new Set(options.threads_experimental.map((t) => t.id))
			: undefined;

		const hasFilteredThreadsChanged = !files_thread_id_sets_equal(prevThreadsRef.current, newThreads);

		if (hasFilteredThreadsChanged) {
			prevThreadsRef.current = newThreads;
		}

		if (hasFilteredThreadsChanged) {
			editor.current.view.dispatch(
				editor.current.state.tr.setMeta(files_FILTERED_THREADS_PLUGIN_KEY, {
					filteredThreads: options.threads_experimental
						? new Set(options.threads_experimental.map((t) => t.id))
						: undefined,
				}),
			);
		}
	}, [options.threads_experimental]);

	// TODO: to be refactored for Convex BE
	// const createTextMention = useCreateTextMention();
	// const deleteTextMention = useDeleteTextMention();

	// Tiptap has options default as any, in tiptap2, we could use never, but now we must use any

	return Extension.create<any, file_editor_rich_text_TiptapExtension_Storage>({
		name: "liveblocksExtension",

		onCreate() {
			editor.current = this.editor;
			if (this.editor.options.content) {
				console.warn(
					"[Liveblocks] Initial content must be set in the useFileEditorRichTextExtension hook option. Remove content from your editor options.",
				);
			}

			// Keep initial Yjs content server-owned. Convex seeds new documents before
			// the provider hydrates, so the editor must not write bootstrap content.

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

				LiveblocksCollab.configure({
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

			// TODO: to be refactored for Convex BE
			// if (options.mentions) {
			//   extensions.push(
			//     MentionExtension.configure({
			//       onCreateMention: (mention) => {
			//         createTextMention(mention.notificationId, mention);
			//       },
			//       onDeleteMention: deleteTextMention,
			//     })
			//   );
			// }
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
