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
		 * Home file Convex node id keyed by membership id.
		 */
		files_home_id_by_membership_id: {} as Record<string, string>,
	}));

	return Object.assign(store, {
		actions: {
			setDrivesHomeIdForMembershipId: (membershipId: string, filesHomeId: string) => {
				store.setState((state) => ({
					files_home_id_by_membership_id: {
						...state.files_home_id_by_membership_id,
						[membershipId]: filesHomeId,
					},
				}));
			},
		},
	});
})();
