import { createContext, useContext, type ReactNode } from "react";
import { useTheme, type ThemeConfig } from "@/hooks/use-theme";

const ThemeContext = createContext<ThemeConfig | undefined>(undefined);

export interface ThemeProviderProps {
	children: ReactNode;
}

/**
 * Theme provider component that automatically detects system color scheme
 * and provides theme context to the entire app
 */
export const ThemeProvider = ({ children }: ThemeProviderProps) => {
	const theme_config = useTheme();

	return <ThemeContext.Provider value={theme_config}>{children}</ThemeContext.Provider>;
};

/**
 * Hook to access theme configuration from context
 * Must be used within a ai_chat_ThemeProvider
 */
export const useThemeContext = (): ThemeConfig => {
	const context = useContext(ThemeContext);

	if (context === undefined) {
		throw new Error("useThemeContext must be used within a ThemeProvider");
	}

	return context;
};
