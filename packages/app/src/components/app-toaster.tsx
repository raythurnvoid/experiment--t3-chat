import { Toaster } from "sonner";
import { useThemeContext } from "./theme-provider.tsx";
import { sx } from "@/lib/utils.ts";

/**
 * Global toast container. It is a component so it can read the app theme.
 **/
export function AppToaster() {
	const { resolved_theme } = useThemeContext();
	return (
		<Toaster
			theme={resolved_theme}
			position="top-right"
			// Start below the 48px app header, so a toast never covers the header or the notifications bell.
			offset={{ top: 56, right: 16 }}
			mobileOffset={{ top: 56, right: 16, left: 16 }}
			// Sonner injects its own styles outside the app CSS layers, so a layered rule cannot change them.
			// It reads these variables, so set them inline with the floating-surface colors of menus.
			style={sx({
				"--normal-bg": "linear-gradient(var(--color-base-alt-1-04), var(--color-base-alt-1-03))",
				"--normal-border": "var(--color-base-alt-1-10)",
				"--normal-text": "var(--color-fg-11)",
				"--border-radius": "6px",
			})}
			// Sonner paints its action button with `color: var(--normal-bg)`. Our background is a gradient, which is
			// not a valid text color, so the label became invisible. Use the colors of the secondary button.
			toastOptions={{
				actionButtonStyle: {
					background: "var(--color-base-1-08)",
					color: "var(--color-fg-10)",
				},
			}}
		/>
	);
}
