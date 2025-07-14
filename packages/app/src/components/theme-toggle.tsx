import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { useThemeContext } from "./theme-provider";

/**
 * Theme toggle component that allows users to manually switch themes
 * Supports light, dark, and system preference modes
 */
export const ThemeToggle = () => {
	const { mode, resolved_theme, set_mode } = useThemeContext();

	const get_icon = () => {
		if (mode === "system") {
			return <Monitor className="h-4 w-4" />;
		}
		return resolved_theme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />;
	};

	const get_mode_label = (theme_mode: typeof mode) => {
		switch (theme_mode) {
			case "light":
				return "Light";
			case "dark":
				return "Dark";
			case "system":
				return "System";
			default:
				return "System";
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm" className="h-9 w-9" aria-label={`Current theme: ${get_mode_label(mode)}`}>
					{get_icon()}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={() => set_mode("light")} className="cursor-pointer">
					<Sun className="mr-2 h-4 w-4" />
					Light
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => set_mode("dark")} className="cursor-pointer">
					<Moon className="mr-2 h-4 w-4" />
					Dark
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => set_mode("system")} className="cursor-pointer">
					<Monitor className="mr-2 h-4 w-4" />
					System
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
