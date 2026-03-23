import { useSyncExternalStore } from "react";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { objects_equal_deep } from "@/lib/object.ts";
import { has_defined_property } from "./utils.ts";
import { useFn } from "../hooks/utils-hooks.ts";

/** Selected opened-chat tab id inside the page editor agent sidebar. */

type FieldDefinition<T> = {
	defaultValue: T;
	parse: (raw: string | null) => T;
	serialize: (value: T) => string | null;
	equals?: (left: T, right: T) => boolean;
};

function define_field<K extends `app${string}`, T>(definition: FieldDefinition<T>) {
	return definition as typeof definition & { __key: K };
}

const storage_local_schema = {
	"app::auth::anonymous_token": define_field<"app::auth::anonymous_token", string | null>({
		defaultValue: null,
		parse: (raw) => raw,
		serialize: (value) => value,
	}),

	"app::auth::anonymous_token_user_id": define_field<"app::auth::anonymous_token_user_id", string | null>({
		defaultValue: null,
		parse: (raw) => raw,
		serialize: (value) => value,
	}),

	"app_state::pages_last_tab": define_field<"app_state::pages_last_tab", AppElementId | null>({
		defaultValue: null,
		parse: (raw) => {
			if (!raw) {
				return null;
			}

			switch (raw) {
				case "app_page_editor_sidebar_tabs_comments":
				case "app_page_editor_sidebar_tabs_agent":
					return raw;
				default:
					return null;
			}
		},
		serialize: (value) => value,
	}),

	"app_state::page_editor_sidebar_agent_selected_tab": define_field<
		"app_state::page_editor_sidebar_agent_selected_tab",
		string | null
	>({
		parse: (raw) => {
			if (!raw || raw.trim() === "") {
				return null;
			}

			return raw;
		},
		serialize: (value) => value,
		defaultValue: null,
	}),

	"app_state::page_editor_sidebar_open_tabs": define_field<
		"app_state::page_editor_sidebar_open_tabs",
		Array<{ id: string; title: string }>
	>({
		parse: (raw) => {
			if (!raw) {
				return [];
			}

			try {
				return JSON.parse(raw);
			} catch {
				return [];
			}
		},
		serialize: (value) => JSON.stringify(value),
		defaultValue: [],
		equals: objects_equal_deep,
	}),

	"app_state::sidebar::main_app_open": define_field<"app_state::sidebar::main_app_open", boolean>({
		parse: (raw) => raw !== "0",
		serialize: (value) => (value ? "1" : "0"),
		defaultValue: true,
	}),

	"app_state::sidebar::main_app_collapsed": define_field<"app_state::sidebar::main_app_collapsed", boolean>({
		parse: (value) => value === "1",
		serialize: (value) => (value ? "1" : "0"),
		defaultValue: false,
	}),

	"app_state::sidebar::pages_open": define_field<"app_state::sidebar::pages_open", boolean>({
		parse: (raw) => raw !== "0",
		serialize: (value) => (value ? "1" : "0"),
		defaultValue: true,
	}),

	"app_state::presence::enabled": define_field<"app_state::presence::enabled", boolean>({
		parse: (value) => value !== "0",
		serialize: (value) => (value ? "1" : "0"),
		defaultValue: true,
	}),

	"app_state::resizable_panel::page_editor_panel": define_field<
		"app_state::resizable_panel::page_editor_panel",
		number[] | null
	>({
		parse: (raw) => {
			try {
				return JSON.parse(raw ?? "null") as number[] | null;
			} catch {
				return null;
			}
		},
		serialize: (value) => (value ? JSON.stringify(value) : null),
		defaultValue: null,
		equals: (left, right) => left === right || (left != null && right != null && objects_equal_deep(left, right)),
	}),

	"app_state::resizable_panel::main_panel": define_field<"app_state::resizable_panel::main_panel", number[] | null>({
		parse: (raw) => {
			try {
				return JSON.parse(raw ?? "null") as number[] | null;
			} catch {
				return null;
			}
		},
		serialize: (value) => (value ? JSON.stringify(value) : null),
		defaultValue: null,
		equals: (left, right) => left === right || (left != null && right != null && objects_equal_deep(left, right)),
	}),

	"app_state::pages_last_open::scope::${membershipId}": define_field<
		`app_state::pages_last_open::scope::${string}`,
		string | null
	>({
		parse: (value) => value,
		serialize: (value) => value,
		defaultValue: null,
	}),

	"app_state::ai_chat_last_open::scope::${membershipId}": define_field<
		`app_state::ai_chat_last_open::scope::${string}`,
		string | null
	>({
		parse: (value) => value,
		serialize: (value) => value,
		defaultValue: null,
	}),
} as const;

/**
 * All keys used for `localStorage` values.
 *
 * Avoid generic names. You can use this pattern to make the key descriptive
 * `app_<feature_name>_<some_key>`
 */
export type storage_local_Key = (typeof storage_local_schema)[keyof typeof storage_local_schema]["__key"];

type GetDefinitionFromStorageKey<Key> =
	(typeof storage_local_schema)[keyof typeof storage_local_schema] extends infer Def
		? Def extends { __key: infer Pattern }
			? Key extends Pattern
				? Def
				: never
			: never
		: never;

type GetStorageValueFromKey<Key> = ReturnType<GetDefinitionFromStorageKey<Key>["parse"]>;

export type storage_local_ValueByKey = {
	[Key in storage_local_Key]: GetStorageValueFromKey<Key>;
};

/**
 * All keys used for `sessionStorage` values.
 *
 * Avoid generic names. You can use this pattern to make the key descriptive
 * `app_<feature_name>_<some_key>`
 */
export type storage_session_Key = never;

const mock_storage = {
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
		storage = mock_storage;
	} else {
		try {
			storage = window.localStorage;
		} catch (error) {
			storage = mock_storage;
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
		storage = mock_storage;
	} else {
		try {
			storage = window.sessionStorage;
		} catch (error) {
			storage = mock_storage;
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

const registered_field_definitions = new Map<
	storage_local_Key,
	(typeof storage_local_schema)[keyof typeof storage_local_schema]
>();
const cache_by_storage_key = new Map<storage_local_Key, unknown>();

function get_local_storage_field_definition_from_key(key: storage_local_Key) {
	if (key in storage_local_schema) {
		return storage_local_schema[key as keyof typeof storage_local_schema];
	}

	if (key.includes("::scope::")) {
		const [staticKey] = key.split("::scope::");
		const normalizedKey = `${staticKey}::scope::\${membershipId}` as keyof typeof storage_local_schema;

		if (normalizedKey in storage_local_schema) {
			return storage_local_schema[normalizedKey];
		}
	}

	return undefined;
}

const runtime = ((/* iife */) => {
	const store = createStore<{
		versionByStorageKey: Partial<Record<storage_local_Key, number>>;
	}>()(
		subscribeWithSelector(() => ({
			versionByStorageKey: {},
		})),
	);

	const bumpVersion = (storageKey: storage_local_Key) => {
		store.setState((state) => ({
			versionByStorageKey: {
				...state.versionByStorageKey,
				[storageKey]: (state.versionByStorageKey[storageKey] ?? 0) + 1,
			},
		}));
	};

	const subscribe = (storageKey: storage_local_Key, onStoreChange: () => void) => {
		return store.subscribe(
			(state) => state.versionByStorageKey[storageKey] ?? 0,
			() => {
				onStoreChange();
			},
		);
	};

	if (typeof window !== "undefined") {
		storage_local_subscribe_to_storage_events((event) => {
			if (!event.key) {
				return;
			}

			const storageKey = event.key as storage_local_Key;
			const definition = registered_field_definitions.get(storageKey);
			if (!definition) {
				return;
			}

			const nextValue = definition.parse(event.newValue);
			const currentValue = cache_by_storage_key.get(storageKey);
			const areValuesEqual = has_defined_property(definition, "equals") ? definition.equals : Object.is;
			if (cache_by_storage_key.has(storageKey) && areValuesEqual(currentValue as never, nextValue as never)) {
				return;
			}

			cache_by_storage_key.set(storageKey, nextValue);
			bumpVersion(storageKey);
		});
	}

	return {
		...store,
		subscribe,
	};
})();

export function app_local_storage_get_value<K extends storage_local_Key>(key: K) {
	const definition = get_local_storage_field_definition_from_key(key);
	if (!definition) {
		throw new Error(`Unknown local storage key: ${key}`);
	}

	registered_field_definitions.set(key, definition);

	if (!cache_by_storage_key.has(key)) {
		const rawValue = storage_local().getItem(key);
		cache_by_storage_key.set(key, definition.parse(rawValue));
	}

	return cache_by_storage_key.get(key) as GetStorageValueFromKey<K>;
}

export function app_local_storage_set_value<K extends storage_local_Key>(
	key: K,
	value:
		| GetStorageValueFromKey<K>
		| ((previousValue: GetStorageValueFromKey<K>) => GetStorageValueFromKey<K>),
) {
	const definition = get_local_storage_field_definition_from_key(key);
	if (!definition) {
		throw new Error(`Unknown local storage key: ${key}`);
	}

	let nextValue;
	if (typeof value === "function") {
		const previousValue = app_local_storage_get_value(key);
		nextValue = value(previousValue);
	} else {
		nextValue = value;
	}

	// @ts-expect-error
	const serializedValue = definition.serialize(nextValue);

	const storage = storage_local();
	if (serializedValue === null) {
		storage.removeItem(key);
		return;
	}

	storage.setItem(key, serializedValue);
}

export function useAppLocalStorageValue<K extends storage_local_Key>(key: K) {
	const definition = get_local_storage_field_definition_from_key(key);
	if (!definition) {
		throw new Error(`Unknown local storage key: ${key}`);
	}

	const defaultValue = definition.defaultValue as unknown as GetStorageValueFromKey<K>;

	return useSyncExternalStore(
		(onStoreChange) => runtime.subscribe(key, onStoreChange),
		() => app_local_storage_get_value(key),
		() => defaultValue,
	);
}

export function useAppLocalStorageStateValue<K extends storage_local_Key>(key: K) {
	const definition = get_local_storage_field_definition_from_key(key);
	if (!definition) {
		throw new Error(`Unknown local storage key: ${key}`);
	}

	const defaultValue = definition.defaultValue as unknown as GetStorageValueFromKey<K>;

	const value = useSyncExternalStore(
		(onStoreChange) => runtime.subscribe(key, onStoreChange),
		() => app_local_storage_get_value(key),
		() => defaultValue,
	);

	const setValue = useFn(
		(
			nextValue:
				| GetStorageValueFromKey<K>
				| ((previousValue: GetStorageValueFromKey<K>) => GetStorageValueFromKey<K>),
		) => {
			app_local_storage_set_value(key, nextValue);
		},
	);

	return [value, setValue] as unknown as [
		GetStorageValueFromKey<K>,
		(
			nextValue:
				| GetStorageValueFromKey<K>
				| ((previousValue: GetStorageValueFromKey<K>) => GetStorageValueFromKey<K>),
		) => void,
	];
}
