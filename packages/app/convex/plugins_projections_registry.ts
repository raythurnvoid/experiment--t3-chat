/**
 * Host-owned list of plugin names that project store documents into workspace files.
 *
 * Keep this module tiny and free of `plugins.ts` imports. The store write doors import it
 * only to decide whether a mutation should schedule a projection sync. Importing the
 * projection runtime from those doors would cycle: `plugins.ts` already imports `plugins_data.ts`.
 */
export const plugins_PROJECTION_PLUGIN_NAMES = ["chitchat", "council"] as const;

export type plugins_ProjectionPluginName = (typeof plugins_PROJECTION_PLUGIN_NAMES)[number];

const plugins_PROJECTION_PLUGIN_NAME_SET = new Set<string>(plugins_PROJECTION_PLUGIN_NAMES);

/**
 * Return true when this plugin has a registered file projection.
 *
 * Unregistered plugins must not read projection tables or schedule work.
 */
export function plugins_projections_is_registered(pluginName: string): pluginName is plugins_ProjectionPluginName {
	return plugins_PROJECTION_PLUGIN_NAME_SET.has(pluginName);
}

/**
 * Derive the file-projection channel changed by one store document.
 *
 * Keep these rules beside the registry so every store write can mark its exact channel without
 * importing a projection runtime back into `plugins_data.ts`.
 */
export function plugins_projections_channel_key_for_store_document(args: {
	pluginName: string;
	collection: string;
	key: string;
	scopeId: string | undefined;
}) {
	if (args.pluginName === "council") {
		return args.collection === "meetings" && args.scopeId === undefined && !args.key.startsWith("p/")
			? args.key
			: null;
	}

	if (
		args.pluginName !== "chitchat" ||
		!["channels", "messages", "replies", "reactions"].includes(args.collection)
	) {
		return null;
	}

	if (args.scopeId !== undefined) {
		// A private channel stores member read cursors beside its channel doc. They are not content.
		return args.collection === "channels" && args.key !== args.scopeId ? null : args.scopeId;
	}

	if (args.key.startsWith("p/")) {
		return null;
	}
	if (args.collection === "channels") {
		return args.key.includes(":") ? null : args.key;
	}

	const channelKey = args.key.split(":")[0];
	return channelKey && !channelKey.startsWith("p/") ? channelKey : null;
}
