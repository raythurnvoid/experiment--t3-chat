import { create } from "zustand";

import type { AppElementId } from "@/lib/dom-utils.ts";
import { storage_local, storage_local_subscribe_to_storage_events, type storage_local_Key } from "@/lib/storage.ts";

type app_local_storage_state_State = {
	pages_last_open: string | null;
	ai_chat_last_open: string | null;
	pages_last_tab: AppElementId | null;
	presence_enabled: boolean;
};

const app_local_storage_state_KEYS = {
	pages_last_open: "app_state::pages_last_open",
	ai_chat_last_open: "app_state::ai_chat_last_open",
	pages_last_tab: "app_state::pages_last_tab",
	presence_enabled: "app::presence::enabled",
} as const satisfies Record<string, storage_local_Key>;

export const useAppLocalStorageState = ((/* iife */) => {
	const storage = storage_local();

	const parsePagesLastTab = (value: string | null): AppElementId | null => {
		if (!value) {
			return null;
		}

		switch (value) {
			case "app_page_editor_sidebar_tabs_comments":
			case "app_page_editor_sidebar_tabs_agent":
				return value;
			default:
				return null;
		}
	};

	const parsePresenceEnabled = (value: string | null): boolean => {
		return value !== "0";
	};

	const initialState = {
		pages_last_open: storage.getItem(app_local_storage_state_KEYS.pages_last_open),
		ai_chat_last_open: storage.getItem(app_local_storage_state_KEYS.ai_chat_last_open),
		pages_last_tab: parsePagesLastTab(storage.getItem(app_local_storage_state_KEYS.pages_last_tab)),
		presence_enabled: parsePresenceEnabled(storage.getItem(app_local_storage_state_KEYS.presence_enabled)),
	} satisfies app_local_storage_state_State;

	const store = create<app_local_storage_state_State>(() => initialState);

	let suppressWrite = false;

	const writeValue = (key: storage_local_Key, value: string | null) => {
		if (value === null) {
			storage.removeItem(key);
			return;
		}

		storage.setItem(key, value);
	};

	store.subscribe((state, prev) => {
		if (suppressWrite) {
			return;
		}

		if (state.pages_last_open !== prev.pages_last_open) {
			writeValue(app_local_storage_state_KEYS.pages_last_open, state.pages_last_open);
		}

		if (state.ai_chat_last_open !== prev.ai_chat_last_open) {
			writeValue(app_local_storage_state_KEYS.ai_chat_last_open, state.ai_chat_last_open);
		}

		if (state.pages_last_tab !== prev.pages_last_tab) {
			writeValue(app_local_storage_state_KEYS.pages_last_tab, state.pages_last_tab);
		}

		if (state.presence_enabled !== prev.presence_enabled) {
			writeValue(app_local_storage_state_KEYS.presence_enabled, state.presence_enabled ? "1" : "0");
		}
	});

	if (typeof window !== "undefined") {
		storage_local_subscribe_to_storage_events((event) => {
			if (!event.key) {
				return;
			}

			switch (event.key) {
				case app_local_storage_state_KEYS.pages_last_open: {
					const nextValue = event.newValue ?? null;
					const current = store.getState().pages_last_open;
					if (current === nextValue) {
						return;
					}

					suppressWrite = true;
					store.setState({ pages_last_open: nextValue });
					suppressWrite = false;
					return;
				}
				case app_local_storage_state_KEYS.ai_chat_last_open: {
					const nextValue = event.newValue ?? null;
					const current = store.getState().ai_chat_last_open;
					if (current === nextValue) {
						return;
					}

					suppressWrite = true;
					store.setState({ ai_chat_last_open: nextValue });
					suppressWrite = false;
					return;
				}
				case app_local_storage_state_KEYS.pages_last_tab: {
					const nextValue = parsePagesLastTab(event.newValue);
					const current = store.getState().pages_last_tab;
					if (current === nextValue) {
						return;
					}

					suppressWrite = true;
					store.setState({ pages_last_tab: nextValue });
					suppressWrite = false;
					return;
				}
				case app_local_storage_state_KEYS.presence_enabled: {
					const nextValue = parsePresenceEnabled(event.newValue);
					const current = store.getState().presence_enabled;
					if (current === nextValue) {
						return;
					}

					suppressWrite = true;
					store.setState({ presence_enabled: nextValue });
					suppressWrite = false;
					return;
				}
				default: {
					return;
				}
			}
		});
	}

	return store;
})();
