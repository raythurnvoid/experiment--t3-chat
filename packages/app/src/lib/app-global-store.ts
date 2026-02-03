import { create } from "zustand";

type app_global_store_State = {
	/**
	 * Whether the composer selection is collapsed and at the start of the document.
	 *
	 * Used to allow arrow up navigation from the composer to the user message above it.
	 */
	ai_chat_composer_selection_collapsed_and_at_start: boolean;
	/**
	 * Whether the composer selection is collapsed and at the end of the document.
	 *
	 * Used to allow arrow down navigation from the composer to the user message below it when editing.
	 */
	ai_chat_composer_selection_collapsed_and_at_end: boolean;
};

export const use_app_global_store = ((/* iife */) => {
	const store = create<app_global_store_State>(() => ({
		ai_chat_composer_selection_collapsed_and_at_start: false,
		ai_chat_composer_selection_collapsed_and_at_end: false,
	}));

	return Object.assign(store, {
		actions: {},
	});
})();
