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

		/**
		 * Homepage Convex page id keyed by `app_tenantPaths_scopeKey` (workspace + project scope).
		 */
		pages_home_id_by_scope: {} as Record<string, string>,
	}));

	return Object.assign(store, {
		actions: {
			setPagesHomeIdForScope: (scopeKey: string, pagesHomeId: string) => {
				store.setState((state) => ({
					pages_home_id_by_scope: { ...state.pages_home_id_by_scope, [scopeKey]: pagesHomeId },
				}));
			},
		},
	});
})();
