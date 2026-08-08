import { app_convex, type app_convex_Id } from "./app-convex-client.ts";
import type { files_yjs_Provider } from "./files-yjs-provider.ts";

/**
 * Dev-only browser QA hooks, installed on `window.__qa`. Playwriter runners read app state
 * from here instead of importing app modules in page context or parsing private client fields.
 */
type AppQa = {
	/**
	 * The Convex queries this page is currently subscribed to.
	 */
	convexSubscriptions: () => { udfPath: string; args: unknown }[];
	/**
	 * The live Yjs document providers with their sync state.
	 */
	filesYjs: () => {
		nodeId: app_convex_Id<"files_nodes">;
		status: ReturnType<files_yjs_Provider["getStatus"]>;
		loadFailed: boolean;
	}[];
};

declare global {
	interface Window {
		__qa?: AppQa;
	}
}

const active_files_yjs_providers = new Set<files_yjs_Provider>();

/**
 * Track a live provider so `window.__qa.filesYjs()` can report it. Returns the cleanup
 * that removes the provider again; call it when the provider is destroyed.
 */
export function app_qa_register_files_yjs_provider(provider: files_yjs_Provider) {
	active_files_yjs_providers.add(provider);
	return () => {
		active_files_yjs_providers.delete(provider);
	};
}

export function app_qa_install() {
	// Keep the hook out of production builds; Vite erases this whole branch there.
	if (!import.meta.env.DEV) {
		return;
	}

	window.__qa = {
		convexSubscriptions: () => {
			// `listeners` is a private ConvexReactClient field. Its keys are JSON tokens of shape
			// { udfPath, args } (convex/dist/esm/browser/sync/udf_path_utils.js). Reading it here
			// is a deliberate dev-only exception so QA never has to parse it in page context.
			const listeners = (app_convex as unknown as { listeners: Map<string, unknown> }).listeners;
			return [...listeners.keys()].map((token) => {
				const parsed = JSON.parse(token) as { udfPath: string; args: unknown };
				return { udfPath: parsed.udfPath, args: parsed.args };
			});
		},
		filesYjs: () =>
			[...active_files_yjs_providers].map((provider) => ({
				nodeId: provider.args.nodeId,
				status: provider.getStatus(),
				loadFailed: provider.loadFailed,
			})),
	};
}
