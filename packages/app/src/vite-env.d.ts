/// <reference types="vite/client" />
/// <reference types="vitest/importMeta" />

declare module "lucide-react/dist/esm/icons/*.js" {
	import type { IconNode } from "lucide-react";

	export const __iconNode: IconNode;
}
