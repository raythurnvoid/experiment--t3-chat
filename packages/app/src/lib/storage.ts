import type { LiteralUnion } from "react-hook-form";

/**
 * All keys used for `localStorage` values.
 *
 * Avoid generic names. You can use this pattern to make the key descriptive
 * `app_<feature_name>_<some_key>`
 */
export type storage_local_Key = "app::auth::anonymous_token";

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
