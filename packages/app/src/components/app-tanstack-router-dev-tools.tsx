import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { cn } from "@/lib/utils";

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
			}}
		/>
	);
}
