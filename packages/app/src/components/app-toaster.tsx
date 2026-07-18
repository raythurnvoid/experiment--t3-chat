import { Toaster } from "sonner";
import { useThemeContext } from "./theme-provider.tsx";

/**
 * Global toast container. It is a component so it can read the app theme.
 **/
export function AppToaster() {
	const { resolved_theme } = useThemeContext();
	return <Toaster theme={resolved_theme} />;
}
