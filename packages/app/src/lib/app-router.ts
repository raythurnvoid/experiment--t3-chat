import { createRouter } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen.ts";

/** Lazily create the app router once, then return the same instance on every call. */
export const app_router = ((/* iife */) => {
	function value() {
		return createRouter({
			routeTree,
			basepath: import.meta.env.BASE_URL,
		});
	}

	let cache: ReturnType<typeof value> | null = null;

	return function app_router(): ReturnType<typeof value> {
		return (cache ??= value());
	};
})();
