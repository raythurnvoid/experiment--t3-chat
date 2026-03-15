import { create } from "zustand";

/** One open agent tab in the page editor sidebar (thread id + display title). */
export type page_editor_sidebar_open_tab_Entry = { id: string; title: string };

/**
 * All keys used for `localStorage` values.
 *
 * Avoid generic names. You can use this pattern to make the key descriptive
 * `app_<feature_name>_<some_key>`
 */
export type storage_local_Key =
	| "app::auth::anonymous_token"
	| "app::auth::anonymous_token_user_id"
	| `app_state::${string}`;

/**
 * All keys used for `sessionStorage` values.
 *
 * Avoid generic names. You can use this pattern to make the key descriptive
 * `app_<feature_name>_<some_key>`
 */
export type storage_session_Key = never;

const mockStorage = {
	getItem: () => null,
	setItem: () => null,
	removeItem: () => null,
	clear: () => null,
	key: () => null,
	length: 0,
} satisfies Storage as Storage;

/**
 * Normally the browser dispatches a `StorageEvent` when the storage is changed in another tab,
 * but in order to sync the react storage in the current tab, we manually dispatch a `StorageEvent`
 * even when the storage is changed in the current tab.
 */
function storage_dispatch_storage_event(key: string, newValue: string | null, storageArea: Storage) {
	if (typeof window === "undefined") {
		return;
	}

	window.dispatchEvent(new StorageEvent("storage", { key, newValue, url: window.location.href, storageArea }));
}

/**
 * Subscribe to storage events.
 *
 * Returns an unsubscribe function that should be called to clean up the event listener.
 */
export function storage_listen_event(callback: (event: StorageEvent) => void) {
	window.addEventListener("storage", callback);
	return () => window.removeEventListener("storage", callback);
}

/**
 * Subscribe to localStorage events only.
 *
 * Returns an unsubscribe function that should be called to clean up the event listener.
 * Only events from localStorage will trigger the callback.
 */
export function storage_local_subscribe_to_storage_events(callback: (event: StorageEvent) => void) {
	return storage_listen_event((event) => {
		if (event.storageArea === window.localStorage) {
			callback(event);
		}
	});
}

/**
 * Subscribe to sessionStorage events only.
 *
 * Returns an unsubscribe function that should be called to clean up the event listener.
 * Only events from sessionStorage will trigger the callback.
 */
export function storage_session_subscribe_to_storage_events(callback: (event: StorageEvent) => void) {
	return storage_listen_event((event) => {
		if (event.storageArea === window.sessionStorage) {
			callback(event);
		}
	});
}

/**
 * Safe access to `localStorage` with automatic event dispatching.
 *
 * Will prevent errors in weird browsers configurations that for
 * some reason don't have `localStorage` available by returning a mock storage object.
 *
 * Accessing the `localStorage` might throw a `DOMException` with `name` set to `SecurityError`,
 * If the user disabled the permissions to access the storage. In this case this function
 * will return the mock storage object.
 *
 * The returned object automatically dispatches storage events when items are set or removed.
 */
export function storage_local() {
	let storage: Storage;

	if (typeof window === "undefined") {
		storage = mockStorage;
	} else {
		try {
			storage = window.localStorage;
		} catch (error) {
			storage = mockStorage;
		}
	}

	return {
		getItem: (key: storage_local_Key) => storage.getItem(key),
		setItem: (key: storage_local_Key, value: string) => {
			storage.setItem(key, value);
			storage_dispatch_storage_event(key, value, storage);
		},
		removeItem: (key: storage_local_Key) => {
			storage.removeItem(key);
			storage_dispatch_storage_event(key, null, storage);
		},
		clear: () => storage.clear(),
		key: (index: number) => storage.key(index),
		get length() {
			return storage.length;
		},
	};
}

/**
 * Safe access to `sessionStorage` with automatic event dispatching.
 *
 * Will prevent errors in weird browsers configurations that for
 * some reason don't have `sessionStorage` available by returning a mock storage object.
 *
 * Accessing the `sessionStorage` might throw a `DOMException` with `name` set to `SecurityError`,
 * If the user disabled the permissions to access the storage. In this case this function
 * will return the mock storage object.
 *
 * The returned object automatically dispatches storage events when items are set or removed.
 */
export function storage_session() {
	let storage: Storage;

	if (typeof window === "undefined") {
		storage = mockStorage;
	} else {
		try {
			storage = window.sessionStorage;
		} catch (error) {
			storage = mockStorage;
		}
	}

	return {
		getItem: (key: storage_session_Key) => storage.getItem(key),
		setItem: (key: storage_session_Key, value: string) => {
			storage.setItem(key, value);
			storage_dispatch_storage_event(key, value, storage);
		},
		removeItem: (key: storage_session_Key) => {
			storage.removeItem(key);
			storage_dispatch_storage_event(key, null, storage);
		},
		clear: () => storage.clear(),
		key: (index: number) => storage.key(index),
		get length() {
			return storage.length;
		},
	};
}

// #region app local storage state
/** Selected tab id: comments element id or thread id for a chat tab. */
export type page_editor_sidebar_selected_tab_id = string | null;

type app_local_storage_state_State = {
	pages_last_open: string | null;
	/** Page editor sidebar selected tab: comments id or thread id. */
	pages_last_tab: page_editor_sidebar_selected_tab_id;
	page_editor_sidebar_open_tabs: page_editor_sidebar_open_tab_Entry[];
	ai_chat_last_open: string | null;
	main_app_sidebar_open: boolean;
	main_app_sidebar_collapsed: boolean;
	pages_sidebar_open: boolean;
	presence_enabled: boolean;
	page_editor_panel_layout: number[] | null;
	main_panel_layout: number[] | null;
};

const app_local_storage_state_KEYS = {
	pages_last_open: "app_state::pages_last_open",
	pages_last_tab: "app_state::pages_last_tab",
	page_editor_sidebar_open_tabs: "app_state::page_editor_sidebar_open_tabs",
	ai_chat_last_open: "app_state::ai_chat_last_open",
	main_app_sidebar_open: "app_state::sidebar::main_app_open",
	main_app_sidebar_collapsed: "app_state::sidebar::main_app_collapsed",
	pages_sidebar_open: "app_state::sidebar::pages_open",
	presence_enabled: "app_state::presence::enabled",
	page_editor_panel_layout: "app_state::resizable_panel::page_editor_panel",
	main_panel_layout: "app_state::resizable_panel::main_panel",
} as const satisfies Record<string, storage_local_Key>;

export const useAppLocalStorageState = ((/* iife */) => {
	const storage = storage_local();

	const parsePagesLastTab = (value: string | null): page_editor_sidebar_selected_tab_id => {
		if (!value || value.trim() === "") {
			return null;
		}
		return value;
	};

	const parsePageEditorSidebarOpenTabs = (
		value: string | null,
	): app_local_storage_state_State["page_editor_sidebar_open_tabs"] => {
		if (!value) {
			return [];
		}
		try {
			const parsed = JSON.parse(value) as unknown;
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed.filter(
				(item): item is page_editor_sidebar_open_tab_Entry =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as page_editor_sidebar_open_tab_Entry).id === "string" &&
					typeof (item as page_editor_sidebar_open_tab_Entry).title === "string",
			);
		} catch {
			return [];
		}
	};

	const parsePresenceEnabled = (value: string | null) => {
		return value !== "0";
	};

	const parseSidebarOpen = (value: string | null) => {
		return value !== "0";
	};

	const parseResizablePanelSize = (value: string | null): app_local_storage_state_State["page_editor_panel_layout"] => {
		try {
			return JSON.parse(value ?? "null") as app_local_storage_state_State["page_editor_panel_layout"];
		} catch {
			return null;
		}
	};

	const initialState = {
		pages_last_open: storage.getItem(app_local_storage_state_KEYS.pages_last_open),
		pages_last_tab: parsePagesLastTab(storage.getItem(app_local_storage_state_KEYS.pages_last_tab)),
		page_editor_sidebar_open_tabs: parsePageEditorSidebarOpenTabs(
			storage.getItem(app_local_storage_state_KEYS.page_editor_sidebar_open_tabs),
		),
		ai_chat_last_open: storage.getItem(app_local_storage_state_KEYS.ai_chat_last_open),
		main_app_sidebar_open: parseSidebarOpen(storage.getItem(app_local_storage_state_KEYS.main_app_sidebar_open)),
		main_app_sidebar_collapsed: storage.getItem(app_local_storage_state_KEYS.main_app_sidebar_collapsed) === "1",
		pages_sidebar_open: parseSidebarOpen(storage.getItem(app_local_storage_state_KEYS.pages_sidebar_open)),
		presence_enabled: parsePresenceEnabled(storage.getItem(app_local_storage_state_KEYS.presence_enabled)),
		page_editor_panel_layout: parseResizablePanelSize(
			storage.getItem(app_local_storage_state_KEYS.page_editor_panel_layout),
		),
		main_panel_layout: parseResizablePanelSize(storage.getItem(app_local_storage_state_KEYS.main_panel_layout)),
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

	/**
	 * Apply storage-originated state changes without writing them back to storage again
	 * via the storage subscription causing infinite loops.
	 */
	const setStateWithoutTriggeringWriteback = (nextState: Partial<app_local_storage_state_State>) => {
		suppressWrite = true;
		store.setState(nextState);
		suppressWrite = false;
	};

	store.subscribe((state, prev) => {
		// When the write is performed internally
		// via the cross tab synchronization mechanism,
		// we need to suppress the writeback to avoid infinite loops.
		if (suppressWrite) {
			return;
		}

		if (state.pages_last_open !== prev.pages_last_open) {
			writeValue(app_local_storage_state_KEYS.pages_last_open, state.pages_last_open);
		}

		if (state.pages_last_tab !== prev.pages_last_tab) {
			writeValue(app_local_storage_state_KEYS.pages_last_tab, state.pages_last_tab);
		}

		if (state.page_editor_sidebar_open_tabs !== prev.page_editor_sidebar_open_tabs) {
			writeValue(
				app_local_storage_state_KEYS.page_editor_sidebar_open_tabs,
				JSON.stringify(state.page_editor_sidebar_open_tabs),
			);
		}

		if (state.ai_chat_last_open !== prev.ai_chat_last_open) {
			writeValue(app_local_storage_state_KEYS.ai_chat_last_open, state.ai_chat_last_open);
		}

		if (state.main_app_sidebar_open !== prev.main_app_sidebar_open) {
			writeValue(app_local_storage_state_KEYS.main_app_sidebar_open, state.main_app_sidebar_open ? "1" : "0");
		}

		if (state.main_app_sidebar_collapsed !== prev.main_app_sidebar_collapsed) {
			writeValue(app_local_storage_state_KEYS.main_app_sidebar_collapsed, state.main_app_sidebar_collapsed ? "1" : "0");
		}

		if (state.pages_sidebar_open !== prev.pages_sidebar_open) {
			writeValue(app_local_storage_state_KEYS.pages_sidebar_open, state.pages_sidebar_open ? "1" : "0");
		}

		if (state.presence_enabled !== prev.presence_enabled) {
			writeValue(app_local_storage_state_KEYS.presence_enabled, state.presence_enabled ? "1" : "0");
		}

		if (state.page_editor_panel_layout !== prev.page_editor_panel_layout) {
			writeValue(
				app_local_storage_state_KEYS.page_editor_panel_layout,
				state.page_editor_panel_layout ? JSON.stringify(state.page_editor_panel_layout) : null,
			);
		}

		if (state.main_panel_layout !== prev.main_panel_layout) {
			writeValue(
				app_local_storage_state_KEYS.main_panel_layout,
				state.main_panel_layout ? JSON.stringify(state.main_panel_layout) : null,
			);
		}
	});

	// Ensure cross tab synchronization.
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

					setStateWithoutTriggeringWriteback({ pages_last_open: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.pages_last_tab: {
					const nextValue = parsePagesLastTab(event.newValue);
					const current = store.getState().pages_last_tab;
					if (current === nextValue) {
						return;
					}

					setStateWithoutTriggeringWriteback({ pages_last_tab: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.page_editor_sidebar_open_tabs: {
					const nextValue = parsePageEditorSidebarOpenTabs(event.newValue);
					const current = store.getState().page_editor_sidebar_open_tabs;
					if (current === nextValue || (current.length === nextValue.length && current.every((e, i) => e.id === nextValue[i].id && e.title === nextValue[i].title))) {
						return;
					}

					setStateWithoutTriggeringWriteback({ page_editor_sidebar_open_tabs: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.ai_chat_last_open: {
					const nextValue = event.newValue ?? null;
					const current = store.getState().ai_chat_last_open;
					if (current === nextValue) {
						return;
					}

					setStateWithoutTriggeringWriteback({ ai_chat_last_open: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.main_app_sidebar_open: {
					const nextValue = parseSidebarOpen(event.newValue);
					const current = store.getState().main_app_sidebar_open;
					if (current === nextValue) {
						return;
					}

					setStateWithoutTriggeringWriteback({ main_app_sidebar_open: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.main_app_sidebar_collapsed: {
					const nextValue = event.newValue === "1";
					const current = store.getState().main_app_sidebar_collapsed;
					if (current === nextValue) {
						return;
					}

					setStateWithoutTriggeringWriteback({ main_app_sidebar_collapsed: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.pages_sidebar_open: {
					const nextValue = parseSidebarOpen(event.newValue);
					const current = store.getState().pages_sidebar_open;
					if (current === nextValue) {
						return;
					}

					setStateWithoutTriggeringWriteback({ pages_sidebar_open: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.presence_enabled: {
					const nextValue = parsePresenceEnabled(event.newValue);
					const current = store.getState().presence_enabled;
					if (current === nextValue) {
						return;
					}

					setStateWithoutTriggeringWriteback({ presence_enabled: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.page_editor_panel_layout: {
					const nextValue = parseResizablePanelSize(event.newValue);
					const current = store.getState().page_editor_panel_layout;
					if (current === nextValue) {
						return;
					}

					setStateWithoutTriggeringWriteback({ page_editor_panel_layout: nextValue });
					return;
				}
				case app_local_storage_state_KEYS.main_panel_layout: {
					const nextValue = parseResizablePanelSize(event.newValue);
					const current = store.getState().main_panel_layout;
					if (current === nextValue) {
						return;
					}

					setStateWithoutTriggeringWriteback({ main_panel_layout: nextValue });
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
// #endregion app local storage state
