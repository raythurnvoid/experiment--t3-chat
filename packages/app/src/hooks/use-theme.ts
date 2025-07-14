import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeConfig {
	mode: ThemeMode;
	resolved_theme: ResolvedTheme;
	set_mode: (mode: ThemeMode) => void;
}

const ai_chat_THEME_STORAGE_KEY = "ai-chat-theme-mode";

/**
 * Hook to manage theme based on system preference
 * Automatically detects system color scheme and applies appropriate theme
 */
export const useTheme = (): ThemeConfig => {
	// Initialize mode from localStorage or default to "system"
	const [mode, set_mode_state] = useState<ThemeMode>(() => {
		if (typeof window === "undefined") return "system";

		const stored = localStorage.getItem(ai_chat_THEME_STORAGE_KEY);
		return (stored as ThemeMode) || "system";
	});

	// Detect system preference
	const [system_preference, set_system_preference] = useState<ResolvedTheme>(() => {
		if (typeof window === "undefined") return "light";
		return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	});

	// Resolve the final theme
	const resolved_theme: ResolvedTheme = mode === "system" ? system_preference : mode;

	// Set mode and persist to localStorage
	const set_mode = (new_mode: ThemeMode) => {
		set_mode_state(new_mode);
		localStorage.setItem(ai_chat_THEME_STORAGE_KEY, new_mode);
	};

	// Listen for system preference changes
	useEffect(() => {
		if (typeof window === "undefined") return;

		const media_query = window.matchMedia("(prefers-color-scheme: dark)");

		const handle_change = (e: MediaQueryListEvent) => {
			set_system_preference(e.matches ? "dark" : "light");
		};

		media_query.addEventListener("change", handle_change);

		// Set initial value
		set_system_preference(media_query.matches ? "dark" : "light");

		return () => {
			media_query.removeEventListener("change", handle_change);
		};
	}, []);

	// Apply theme class to document
	useEffect(() => {
		const root = document.documentElement;

		// Remove both classes first
		root.classList.remove("light", "dark");

		// Add the resolved theme class
		root.classList.add(resolved_theme);

		// Also set data attribute for potential styling
		root.setAttribute("data-theme", resolved_theme);
	}, [resolved_theme]);

	return {
		mode,
		resolved_theme,
		set_mode,
	};
};
