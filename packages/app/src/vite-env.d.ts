/// <reference types="vite/client" />

declare module "lucide-react/dist/esm/icons/*.js" {
	import type { IconNode } from "lucide-react";

	export const __iconNode: IconNode;
}
