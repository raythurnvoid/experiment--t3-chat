import { ConvexReactClient } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { Result } from "./errors-as-values-utils.ts";

export type {
	FunctionArgs as app_convex_FunctionArgs,
	FunctionReference as app_convex_FunctionReference,
	FunctionReturnType as app_convex_FunctionReturnType,
} from "convex/server";

export type { Watch as app_convex_Watch } from "convex/react";

export * from "../../shared/app-convex.ts";

export const app_convex_deployment_url = import.meta.env
	? (import.meta.env.VITE_CONVEX_URL as string)
	: (process.env.VITE_CONVEX_URL as string);

if (!app_convex_deployment_url) {
	throw new Error("`VITE_CONVEX_URL` env var is not set");
}

export const app_convex = new ConvexReactClient(app_convex_deployment_url, {
	logger: {
		error: console.error,
		warn: console.warn,
		log: console.info,
		logVerbose: () => {}, // console.debug
	},
	onServerDisconnectError: (message) => {
		console.error("app_convex: Convex server disconnected:", message);
	},
});

// #region Convex-App adapters

// #endregion Convex-App adapters

// #region helpers

export async function app_convex_wait_new_query_value<Q extends FunctionReference<"query", "public">>(
	query: Q,
	queryArgs?: FunctionArgs<Q>,
	args?: {
		signal?: AbortSignal;
	},
) {
	const watcher = app_convex.watchQuery(query, queryArgs);

	let canDispose = true;

	const valuePromise = new Promise<FunctionReturnType<Q> | undefined>((resolve) => {
		args?.signal?.addEventListener(
			"abort",
			() => {
				resolve(undefined);

				if (canDispose) {
					canDispose = false;
					dispose();
				}
			},
			{ once: true },
		);

		const dispose = watcher.onUpdate(() => {
			resolve(watcher.localQueryResult());

			if (canDispose) {
				canDispose = false;
				dispose();
			}
		});
	});

	const value = await valuePromise;

	if (value === undefined && canDispose) {
		return Result({ _nay: { name: "nay_abort", message: args?.signal?.reason?.message ?? "Query aborted" } });
	}

	return Result({ _yay: value });
}

// #endregion helpers
