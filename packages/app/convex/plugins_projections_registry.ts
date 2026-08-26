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
