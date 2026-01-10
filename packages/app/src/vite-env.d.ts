/// <reference types="vite/client" />

interface Window {
	rt0_chat_current_thread_id?: string | undefined;
}

declare module "lucide-react/dist/esm/icons/*.js" {
	import type { IconNode } from "lucide-react";

	export const __iconNode: IconNode;
}
