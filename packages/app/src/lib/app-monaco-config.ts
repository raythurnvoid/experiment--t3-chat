// Minimal for Markdown-only: editor worker is enough
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { app_colors_css_vars } from "@/assets/ts/app-colors-css-vars.ts";

// If you later need other languages, add these:
// import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
// import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
// import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
// import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
	getWorker(_moduleId: string, _label: string) {
		// For Markdown, the base editor worker is sufficient
		return new EditorWorker();
		// If you add more:
		// switch (label) {
		//   case "json": return new JsonWorker();
		//   case "css":
		//   case "scss":
		//   case "less": return new CssWorker();
		//   case "html":
		//   case "handlebars":
		//   case "razor": return new HtmlWorker();
		//   case "typescript":
		//   case "javascript": return new TsWorker();
		//   default: return new EditorWorker();
		// }
	},
};

function hex_with_alpha(hex: string, alpha01: number) {
	const clamped = Math.max(0, Math.min(1, alpha01));
	const alpha = Math.round(clamped * 255)
		.toString(16)
		.padStart(2, "0");

	const normalized = hex.startsWith("#") ? hex.slice(1) : hex;
	const rrggbb = normalized.slice(0, 6);
	return `#${rrggbb}${alpha}`;
}

type app_monaco_ColorKey = keyof typeof app_colors_css_vars;

const app_monaco_get_color_hex = ((/* iife */) => {
	function value(key: app_monaco_ColorKey, fallbackHex: string) {
		return app_colors_css_vars[key]?.hex ?? fallbackHex;
	}

	const cache = new Map<string, string>();

	return function app_monaco_get_color_hex(key: app_monaco_ColorKey, fallbackHex: string) {
		const cacheKey = `${key}|${fallbackHex}`;
		const cachedValue = cache.get(cacheKey);
		if (cachedValue) {
			return cachedValue;
		}

		const result = value(key, fallbackHex);
		cache.set(cacheKey, result);
		return result;
	};
})();

// Monaco requires: /^[a-z0-9\-]+$/i (no underscores)
export const app_monaco_THEME_NAME_DARK = "app-pages-monaco-theme-dark";

try {
	monaco.editor.defineTheme(app_monaco_THEME_NAME_DARK, {
		base: "vs-dark",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": app_monaco_get_color_hex("color-base-1-03", "#1e1e1e"),
			"editor.foreground": app_monaco_get_color_hex("color-fg-11", "#d4d4d4"),

			"editorLineNumber.foreground": app_monaco_get_color_hex("color-fg-07", "#858585"),
			"editorLineNumber.activeForeground": app_monaco_get_color_hex("color-fg-11", "#d4d4d4"),
			"editorCursor.foreground": app_monaco_get_color_hex("color-fg-12", "#ffffff"),

			"editor.selectionBackground": hex_with_alpha(app_monaco_get_color_hex("color-accent-09", "#6fc0ff"), 0.55),
			"editor.inactiveSelectionBackground": hex_with_alpha(
				app_monaco_get_color_hex("color-accent-08", "#5db3ff"),
				0.35,
			),

			"editor.findMatchBackground": hex_with_alpha(app_monaco_get_color_hex("color-accent-07", "#4aa3ff"), 0.35),
			"editor.findMatchHighlightBackground": hex_with_alpha(
				app_monaco_get_color_hex("color-accent-06", "#3b8eea"),
				0.25,
			),
			"editor.findRangeHighlightBackground": hex_with_alpha(
				app_monaco_get_color_hex("color-accent-06", "#3b8eea"),
				0.18,
			),

			"editor.lineHighlightBackground": hex_with_alpha(app_monaco_get_color_hex("color-base-1-05", "#252526"), 0.65),
			"editor.lineHighlightBorder": "#00000000",

			"editorGutter.background": app_monaco_get_color_hex("color-base-1-02", "#1a1a1a"),

			"editorIndentGuide.background1": hex_with_alpha(app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"), 0.55),
			"editorIndentGuide.activeBackground1": hex_with_alpha(app_monaco_get_color_hex("color-fg-07", "#858585"), 0.55),

			"editorBracketMatch.background": hex_with_alpha(app_monaco_get_color_hex("color-base-1-08", "#2d2d2d"), 0.9),
			"editorBracketMatch.border": app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"),

			"editorRuler.foreground": app_monaco_get_color_hex("color-base-1-07", "#2a2a2a"),

			"editorHoverWidget.background": app_monaco_get_color_hex("color-base-1-05", "#252526"),
			"editorHoverWidget.border": app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"),
			"editorSuggestWidget.background": app_monaco_get_color_hex("color-base-1-05", "#252526"),
			"editorSuggestWidget.border": app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"),
			"editorWidget.background": app_monaco_get_color_hex("color-base-1-05", "#252526"),
			"editorWidget.border": app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"),

			"scrollbarSlider.background": hex_with_alpha(app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"), 0.45),
			"scrollbarSlider.hoverBackground": hex_with_alpha(app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"), 0.65),
			"scrollbarSlider.activeBackground": hex_with_alpha(app_monaco_get_color_hex("color-fg-07", "#858585"), 0.55),

			"editorWhitespace.foreground": hex_with_alpha(app_monaco_get_color_hex("color-fg-07", "#858585"), 0.35),

			"minimap.background": app_monaco_get_color_hex("color-base-1-03", "#1e1e1e"),
		},
	});
	monaco.editor.setTheme(app_monaco_THEME_NAME_DARK);
} catch (err) {
	console.error("app_monaco_register_ai_docs_dark_theme: failed to define/apply theme", err);
}

// Ensure @monaco-editor/react and direct `monaco-editor` imports share the exact same Monaco instance.
// This prevents subtle runtime errors when passing models between the two.
loader.config({ monaco });
