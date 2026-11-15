import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { AppAgentSnapshot_CustomAttributes } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

export function AppTanStackRouterDevTools() {
	return (
		<TanStackRouterDevtools
			position="bottom-left"
			toggleButtonProps={{
				style: {
					transform: "scale(0.5)",
					transformOrigin: "bottom left",
				},
				className: cn("AppTanStackRouterDevTools-toggle"),
				// A dev-only button. Keep it out of the agent's screen snapshot.
				...({ "data-agent-ignore": "" } satisfies Partial<AppAgentSnapshot_CustomAttributes>),
			}}
		/>
	);
}
