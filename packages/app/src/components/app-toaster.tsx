import { Toaster } from "sonner";
import { useThemeContext } from "./theme-provider.tsx";
import { sx } from "@/lib/utils.ts";

/**
 * Global toast container. It is a component so it can read the app theme.
 **/
export function AppToaster() {
	const { resolved_theme } = useThemeContext();
	const dark = resolved_theme === "dark";

	return (
		<Toaster
			theme={resolved_theme}
			position="top-right"
			// Start below the 48px app header, so a toast never covers the header or the notifications bell.
			offset={{ top: 56, right: 16 }}
			mobileOffset={{ top: 56, right: 16, left: 16 }}
			// Sonner injects its own styles outside the app CSS layers, so a layered rule cannot change them.
			// It reads these variables, so set them inline with the floating-surface colors of menus. An inline
			// style cannot use the `.dark` class, so the gradient follows `resolved_theme` here.
			// The light theme mirrors the color steps, so its gradient lists them the other way around.
			style={sx({
				"--normal-bg": dark
					? "linear-gradient(var(--color-base-alt-1-03), var(--color-base-alt-1-02))"
					: "linear-gradient(var(--color-base-alt-1-02), var(--color-base-alt-1-03))",
				"--normal-border": "var(--color-base-alt-1-10)",
				"--normal-text": "var(--color-fg-11)",
				"--border-radius": "6px",
				// Sonner sets its own system font on the toaster, so set the app reading font here.
				fontFamily: "var(--app-font-sans)",
			})}
			// Sonner paints its action button with `color: var(--normal-bg)`. Our background is a gradient, which is
			// not a valid text color, so the label became invisible. Use the colors of the secondary button.
			toastOptions={{
				// A toast floats, so it casts the same shadow as tooltips and hovercards. The token switches with
				// the `.dark` class on the root, so this inline style needs no theme check.
				style: { boxShadow: "var(--app-shadow-floating)" },
				actionButtonStyle: {
					background: "var(--color-base-1-08)",
					color: "var(--color-fg-10)",
				},
			}}
		/>
	);
}
