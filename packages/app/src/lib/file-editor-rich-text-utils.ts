// Adapted from `references-submodules/liveblocks/packages/liveblocks-react-tiptap/src/types.ts`
// and `src/utils.ts` from the same package, merged here.
// The types and helpers that only served the dropped mention/toolbar/version-history components were left
// behind; the thread plugin types moved to `shared/files-tiptap-comments.ts` because Convex needs them.

import type { ClientRectObject } from "@floating-ui/dom";
import type { ContextualPromptContext, ContextualPromptResponse, Relax, ThreadData } from "@liveblocks/core";
import type { Editor, Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import type { ChainedCommands } from "@tiptap/react";
import type { ProsemirrorBinding } from "@tiptap/y-tiptap";
import type { Doc, PermanentUserData, Snapshot } from "yjs";
import type { files_yjs_Provider } from "@/lib/files-yjs-provider.ts";
import type { files_PresenceStore } from "@/lib/files.ts";

const CONTEXT_TRUNCATION = "[…]";
const CONTEXT_BLOCK_SEPARATOR = "\n";

export const file_editor_rich_text_get_rect_from_coords = (coords: {
	top: number;
	left: number;
	right: number;
	bottom: number;
}): ClientRectObject => {
	return {
		...coords,
		x: coords.left,
		y: coords.top,
		width: coords.right - coords.left,
		height: coords.bottom - coords.top,
	};
};

export function file_editor_rich_text_get_contextual_prompt_context(
	editor: Editor,
	maxLength = 10_000,
): ContextualPromptContext {
	const { selection, doc } = editor.state;

	const selectionLength = selection.to - selection.from;

	if (maxLength >= doc.content.size) {
		// If the document is smaller than the maximum length, return the entire document
		return {
			beforeSelection: doc.textBetween(0, selection.from, CONTEXT_BLOCK_SEPARATOR),
			selection: doc.textBetween(selection.from, selection.to, CONTEXT_BLOCK_SEPARATOR),
			afterSelection: doc.textBetween(selection.to, doc.content.size, CONTEXT_BLOCK_SEPARATOR),
		};
	} else if (selectionLength > maxLength) {
		// If the selection is too large, truncate its middle to still allow continuations
		const selectionStart = doc.textBetween(
			selection.from,
			selection.from + Math.floor(maxLength / 2) - CONTEXT_TRUNCATION.length,
			CONTEXT_BLOCK_SEPARATOR,
		);
		const selectionEnd = doc.textBetween(
			selection.to - Math.floor(maxLength / 2) + CONTEXT_TRUNCATION.length,
			selection.to,
			CONTEXT_BLOCK_SEPARATOR,
		);

		return {
			beforeSelection: "",
			selection: `${selectionStart}${CONTEXT_TRUNCATION}${selectionEnd}`,
			afterSelection: "",
		};
	} else {
		// If the selection is smaller than (or equal to) the maximum length, extract as much as possible from the document around the selection

		// Start by taking as much as possible after the selection
		let beforeLength = Math.min(selection.from, Math.floor((maxLength - selectionLength) / 2));
		const afterLength = Math.min(doc.content.size - selection.to, maxLength - selectionLength - beforeLength);

		// If needed (e.g. the selection is near the end), compensate before the selection
		if (beforeLength + afterLength + selectionLength < maxLength) {
			beforeLength = Math.min(selection.from, maxLength - selectionLength - afterLength);
		}

		let beforeSelection = doc.textBetween(
			Math.max(0, selection.from - beforeLength),
			selection.from,
			CONTEXT_BLOCK_SEPARATOR,
		);
		let afterSelection = doc.textBetween(
			selection.to,
			Math.min(doc.content.size, selection.to + afterLength),
			CONTEXT_BLOCK_SEPARATOR,
		);

		// Add leading truncation if `beforeSelection` doesn't contain the document's start
		if (selection.from - beforeLength > 0) {
			beforeSelection = `${CONTEXT_TRUNCATION}${beforeSelection}`;
		}

		// Add trailing truncation if `afterSelection` doesn't contain the document's end
		if (selection.to + afterLength < doc.content.size) {
			afterSelection = `${afterSelection}${CONTEXT_TRUNCATION}`;
		}

		return {
			beforeSelection,
			selection: doc.textBetween(selection.from, selection.to, CONTEXT_BLOCK_SEPARATOR),
			afterSelection,
		};
	}
}

export const file_editor_rich_text_AI_TOOLBAR_SELECTION_PLUGIN_KEY = new PluginKey("lb-ai-toolbar-selection-plugin");

/**
 * @beta
 */
export type file_editor_rich_text_ResolveContextualPrompt_Args = {
	/**
	 * The prompt being requested by the user.
	 */
	prompt: string;

	/**
	 * The context of the document and its current selection.
	 */
	context: ContextualPromptContext;

	/**
	 * The previous request and its response, if this is a follow-up request.
	 */
	previous?: {
		prompt: string;
		response: ContextualPromptResponse;
	};

	/**
	 * An abort signal that can be used to cancel requests.
	 */
	signal: AbortSignal;
};

/**
 * @beta
 */
export type file_editor_rich_text_ResolveContextualPrompt_Response = ContextualPromptResponse;

export interface file_editor_rich_text_AiConfiguration {
	/**
	 * The AI's name. ("Ask {name} anything…", "{name} is thinking…", etc)
	 */
	name?: string;

	/**
	 * A function that returns an a response to a contextual prompt.
	 */
	resolveContextualPrompt?: (
		args: file_editor_rich_text_ResolveContextualPrompt_Args,
	) => Promise<ContextualPromptResponse>;
}

export type file_editor_rich_text_TiptapExtension_Options = {
	field?: string;
	comments?: boolean; // | CommentsConfiguration
	mentions?: boolean; // | MentionsConfiguration
	ai?: boolean | file_editor_rich_text_AiConfiguration;
	offlineSupport_experimental?: boolean;
	threads_experimental?: ThreadData[];
	enablePermanentUserData?: boolean;

	/**
	 * Provide a pre-instantiated Yjs provider from the app layer.
	 * When set, the extension will reuse it and will NOT destroy it.
	 */
	yjsProvider?: files_yjs_Provider;
	/**
	 * Convex presence store for awareness. Required for Convex-backed presence.
	 */
	presenceStore?: files_PresenceStore;
};

export type file_editor_rich_text_TiptapExtension_Storage = {
	unsubs: (() => void)[];
	doc: Doc;
	provider: files_yjs_Provider;
	permanentUserData?: PermanentUserData;
};

export type file_editor_rich_text_AiExtension_Options = Required<
	Pick<file_editor_rich_text_AiConfiguration, "name" | "resolveContextualPrompt">
> & {
	doc: Doc | undefined;
	pud: PermanentUserData | undefined;
};

/**
 * The state of the AI toolbar.
 *
 *                             ┌────────────────────────────────────────────────────────────────────────────────┐
 *                             │                                                                                │
 *                             │ ┌──────────────────────────────────────────────┐                               │
 *                             ▼ ▼                                              │                               │
 *              ┌───────$closeAiToolbar()───────┐                               │                               │
 *              ▼                               ◇                               ◇                               ◇
 *  ┌───────────────────────┐       ┌───────────────────────┐       ┌───────────────────────┐       ┌───────────────────────┐
 *  │        CLOSED         │       │        ASKING         │       │       THINKING        │       │       REVIEWING       │
 *  └───────────────────────┘       └───────────────────────┘       └───────────────────────┘       └───────────────────────┘
 *           ▲ ◇ ◇                           ▲ ▲ ◇ ▲                          ▲ ◇                             ▲ ◇ ◇
 *           │ │ └───$openAiToolbarAsking()──┘ │ │ └ ─ ─ ─ ─ ─ ─⚠─ ─ ─ ─ ─ ─ ─│─├── ─ ─ ─ ─ ─ ─✓─ ─ ─ ─ ─ ─ ─ ┘ │ │
 *           │ │                               │ ▼                            │ │                               │ │
 *           │ └─────────────────$startAiToolbarThinking(prompt)──────────────┘ │                               │ │
 *           │                                 │ ▲                              │                               │ │
 *           │                                 │ └──────────────────────────────┼───────────────────────────────┘ │
 *           │                                 │                                │                                 │
 *           │                                 └───$cancelAiToolbarThinking()───┘                                 │
 *           │                                                                                                    │
 *           └─────────────────────────────────────$acceptAiToolbarResponse()─────────────────────────────────────┘
 *
 */
export type file_editor_rich_text_AiToolbarState = Relax<
	| {
			phase: "closed";
	  }
	| {
			phase: "asking";

			/**
			 * The selection stored when opening the AI toolbar.
			 */
			initialSelection: Range;

			/**
			 * The custom prompt being written in the toolbar.
			 */
			customPrompt: string;

			/**
			 * A potential error that occurred during the last AI request.
			 */
			error?: Error;
	  }
	| {
			phase: "thinking";

			/**
			 * The selection stored when opening the AI toolbar.
			 */
			initialSelection: Range;

			/**
			 * The custom prompt being written in the toolbar.
			 */
			customPrompt: string;

			/**
			 * An abort controller to cancel the AI request.
			 */
			abortController: AbortController;

			/**
			 * The prompt sent to the AI.
			 */
			prompt: string;

			/**
			 * The previous response if this "thinking" phase is a refinement.
			 */
			previousResponse?: ContextualPromptResponse;
	  }
	| {
			phase: "reviewing";

			/**
			 * The selection stored when opening the AI toolbar.
			 */
			initialSelection: Range;

			/**
			 * The custom prompt being written in the toolbar.
			 */
			customPrompt: string;

			/**
			 * The prompt sent to the AI.
			 */
			prompt: string;

			/**
			 * The response of the AI request.
			 */
			response: ContextualPromptResponse;
	  }
>;

export type file_editor_rich_text_AiExtension_Storage = {
	name: string;
	state: file_editor_rich_text_AiToolbarState;
	snapshot?: Snapshot;
};

export type file_editor_rich_text_AiCommands<ReturnType = boolean> = {
	/**
	 * Open the AI toolbar, with an optional prompt.
	 */
	askAi: (prompt?: string) => ReturnType;

	/**
	 * Close the AI toolbar.
	 */
	closeAi: () => ReturnType;

	// Transitions (see file_editor_rich_text_AiToolbarState)

	/**
	 * @internal
	 * @transition
	 *
	 * Close the AI toolbar.
	 */
	$closeAiToolbar: () => ReturnType;

	/**
	 * @internal
	 * @transition
	 *
	 * Accept the current AI response and close the AI toolbar.
	 */
	$acceptAiToolbarResponse: () => ReturnType;

	/**
	 * @internal
	 * @transition
	 *
	 * Open the AI toolbar in the "asking" phase.
	 */
	$openAiToolbarAsking: () => ReturnType;

	/**
	 * @internal
	 * @transition
	 *
	 * Set (and open if not already open) the AI toolbar in the "thinking" phase with the given prompt.
	 */
	$startAiToolbarThinking: (prompt: string, withPreviousResponse?: boolean) => ReturnType;

	/**
	 * @internal
	 * @transition
	 *
	 * Cancel the current "thinking" phase, going back to the "asking" phase.
	 */
	$cancelAiToolbarThinking: () => ReturnType;

	// Other

	/**
	 * @internal
	 *
	 * Show the diff of the current "reviewing" phase.
	 */
	_showAiToolbarReviewingDiff: () => ReturnType;

	/**
	 * @internal
	 *
	 * Handle the success of the current "thinking" phase.
	 */
	_handleAiToolbarThinkingSuccess: (response: ContextualPromptResponse) => ReturnType;

	/**
	 * @internal
	 *
	 * Handle an error of the current "thinking" phase.
	 */
	_handleAiToolbarThinkingError: (error: unknown) => ReturnType;

	/**
	 * @internal
	 *
	 * Update the current custom AI prompt.
	 */
	_updateAiToolbarCustomPrompt: (customPrompt: string | ((currentCustomPrompt: string) => string)) => ReturnType;
};

export type file_editor_rich_text_YSyncPluginState = {
	binding: ProsemirrorBinding;
};

// Keep the storage keys `liveblocksAi` and `liveblocksExtension`: Tiptap derives `editor.storage[name]` from
// the extension name, so these must match the extension names in the modules that create them.
declare module "@tiptap/core" {
	interface Storage {
		liveblocksAi: file_editor_rich_text_AiExtension_Storage;
		liveblocksExtension: file_editor_rich_text_TiptapExtension_Storage;
	}

	interface Commands<ReturnType> {
		liveblocksAi: file_editor_rich_text_AiCommands<ReturnType>;

		// TODO: this is already defined in collaboration-caret, we shouldn't need it, but something isn't working
		// maybe because we use configure?
		collaborationCaret: {
			/**
			 * Update details of the current user
			 * @example editor.commands.updateUser({ name: 'John Doe', color: '#305500' })
			 */
			updateUser: (attributes: Record<string, any>) => ReturnType;
			/**
			 * Update details of the current user
			 *
			 * @deprecated The "user" command is deprecated. Please use "updateUser" instead. Read more: https://tiptap.dev/api/extensions/collaboration-caret
			 */
			user: (attributes: Record<string, any>) => ReturnType;
		};

		collaboration: {
			/**
			 * Undo recent changes
			 * @example editor.commands.undo()
			 */
			undo: () => ReturnType;
			/**
			 * Reapply reverted changes
			 * @example editor.commands.redo()
			 */
			redo: () => ReturnType;
		};
	}
}

// `ChainedCommands` is only referenced through the module augmentation above, but importing it keeps the
// augmented `Commands` interface resolvable from this module.
export type file_editor_rich_text_ChainedCommands = ChainedCommands;
