import { create } from "zustand";

export const useAppGlobalStore = ((/* iife */) => {
	const store = create(() => ({
		/**
		 * Whether the composer selection is collapsed and at the start of the document.
		 *
		 * Used to allow arrow up navigation from the composer to the user message above it.
		 */
		ai_chat_composer_selection_collapsed_and_at_start: false,
		/**
		 * Whether the composer selection is collapsed and at the end of the document.
		 *
		 * Used to allow arrow down navigation from the composer to the user message below it when editing.
		 */
		ai_chat_composer_selection_collapsed_and_at_end: false,
		pages_home_id: "",
	}));

	return Object.assign(store, {
		actions: {
			setPagesHomeId: (pagesHomeId: string) => {
				store.setState({ pages_home_id: pagesHomeId });
			},
		},
	});
})();
