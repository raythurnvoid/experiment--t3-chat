import { Liveblocks } from "@liveblocks/node";

export * from "../shared/pages.ts";

const LIVEBLOCKS_SECRET_KEY = process.env.LIVEBLOCKS_SECRET_KEY!;
if (!LIVEBLOCKS_SECRET_KEY) {
	throw new Error("LIVEBLOCKS_SECRET_KEY env var is not set");
}

export const server_pages_get_liveblocks = ((/* iife */) => {
	function value() {
		return new Liveblocks({ secret: LIVEBLOCKS_SECRET_KEY });
	}

	let cache: ReturnType<typeof value> | undefined;

	return function server__pages__get_liveblocks() {
		return (cache ??= value());
	};
})();
