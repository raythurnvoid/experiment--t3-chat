// Minimal for Markdown-only: editor worker is enough
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { app_colors_css_vars, app_colors_css_vars_dark } from "@/assets/ts/app-colors-css-vars.ts";

// If you later need other languages, add these:
// import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
// import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
// import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";
// import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

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

// Tokenizer-only for v1: plain-text documents get syntax colors but no language services.
// Only the base editor worker is wired above, and monaco 0.57's json/css/html/typescript modes
// register worker-backed providers (completions, hovers, folding ranges, document symbols,
// colors, validation) that request a labelled worker. `getWorker` answers with the base editor
// worker, so every such call errors with "Missing requestHandler or method: doValidation" (and
// doComplete, getFoldingRanges, ...). Turning single options off is not enough — the providers
// stay registered — so disable the whole feature set through each mode's `setModeConfiguration`.
// The languages the app can actually open (see `files_monaco_language_id_of_content_type`) that have a
// worker mode are json, css, html, javascript and typescript; the rest are monarch-only already.
monaco.json.jsonDefaults.setModeConfiguration({
	// JSON's tokens provider is synchronous mode code, not worker-backed: it is the one feature
	// tokenizer-only keeps. css/js/ts tokenize through basic-languages monarch grammars outside
	// these modes, so their configurations can turn everything off.
	tokens: true,
	completionItems: false,
	hovers: false,
	documentSymbols: false,
	colors: false,
	foldingRanges: false,
	diagnostics: false,
	selectionRanges: false,
	documentFormattingEdits: false,
	documentRangeFormattingEdits: false,
});
monaco.css.cssDefaults.setModeConfiguration({
	completionItems: false,
	hovers: false,
	documentSymbols: false,
	definitions: false,
	references: false,
	documentHighlights: false,
	rename: false,
	colors: false,
	foldingRanges: false,
	diagnostics: false,
	selectionRanges: false,
	documentFormattingEdits: false,
	documentRangeFormattingEdits: false,
});
monaco.html.htmlDefaults.setModeConfiguration({
	completionItems: false,
	hovers: false,
	documentSymbols: false,
	links: false,
	documentHighlights: false,
	rename: false,
	colors: false,
	foldingRanges: false,
	diagnostics: false,
	selectionRanges: false,
	documentFormattingEdits: false,
	documentRangeFormattingEdits: false,
});
const app_monaco_TS_TOKENIZER_ONLY_MODE_CONFIGURATION = {
	completionItems: false,
	hovers: false,
	documentSymbols: false,
	definitions: false,
	references: false,
	documentHighlights: false,
	rename: false,
	diagnostics: false,
	documentRangeFormattingEdits: false,
	signatureHelp: false,
	onTypeFormattingEdits: false,
	codeActions: false,
	inlayHints: false,
};
monaco.typescript.typescriptDefaults.setModeConfiguration(app_monaco_TS_TOKENIZER_ONLY_MODE_CONFIGURATION);
monaco.typescript.javascriptDefaults.setModeConfiguration(app_monaco_TS_TOKENIZER_ONLY_MODE_CONFIGURATION);

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

/**
 * Build the Monaco theme from one theme's color map (dark or light).
 */
function app_monaco_theme_data(
	colors: Partial<Record<app_monaco_ColorKey, { hex: string }>>,
	base: monaco.editor.BuiltinTheme,
): monaco.editor.IStandaloneThemeData {
	const app_monaco_get_color_hex = (key: app_monaco_ColorKey, fallbackHex: string) => colors[key]?.hex ?? fallbackHex;

	return {
		base,
		inherit: true,
		rules: [],
		colors: {
			"editor.background": app_monaco_get_color_hex("color-base-1-02", "#1e1e1e"),
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

			"editorGutter.background": app_monaco_get_color_hex("color-base-1-02", "#1e1e1e"),

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

			// Keep in sync with --app-scrollbar-thumb (color-base-1-07) and
			// --app-scrollbar-thumb-active (color-base-1-10) in app.css. This static theme
			// cannot read those var() tokens, so the scale entries are repeated here.
			"scrollbarSlider.background": hex_with_alpha(app_monaco_get_color_hex("color-base-1-07", "#2a2a2a"), 0.85),
			"scrollbarSlider.hoverBackground": hex_with_alpha(app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"), 0.85),
			"scrollbarSlider.activeBackground": app_monaco_get_color_hex("color-base-1-10", "#3c3c3c"),

			"editorWhitespace.foreground": hex_with_alpha(app_monaco_get_color_hex("color-fg-07", "#858585"), 0.35),
		},
	};
}

// Monaco requires: /^[a-z0-9\-]+$/i (no underscores)
export const app_monaco_THEME_NAME = "app-files-monaco-theme";

const app_monaco_apply_theme = ((/* iife */) => {
	let appliedDark: boolean | null = null;

	/**
	 * Follow the theme class that `ThemeProvider` (and the early script in index.html) puts on `<html>`.
	 * All editors share one Monaco theme, so defining it again under the same name and applying it
	 * repaints every open editor. Its static colors cannot read the CSS `var()` tokens, so they come from
	 * the generated color maps.
	 */
	return function app_monaco_apply_theme() {
		const dark = document.documentElement.classList.contains("dark");
		if (dark === appliedDark) {
			return;
		}

		appliedDark = dark;
		try {
			monaco.editor.defineTheme(
				app_monaco_THEME_NAME,
				dark
					? app_monaco_theme_data(app_colors_css_vars_dark, "vs-dark")
					: app_monaco_theme_data(app_colors_css_vars, "vs"),
			);
			monaco.editor.setTheme(app_monaco_THEME_NAME);
		} catch (err) {
			console.error("app_monaco_apply_theme: failed to define/apply theme", err);
		}
	};
})();

app_monaco_apply_theme();
new MutationObserver(app_monaco_apply_theme).observe(document.documentElement, {
	attributes: true,
	attributeFilter: ["class"],
});

// Ensure @monaco-editor/react and direct `monaco-editor` imports share the exact same Monaco instance.
// This prevents subtle runtime errors when passing models between the two.
loader.config({ monaco });
