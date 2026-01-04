// Minimal for Markdown-only: editor worker is enough
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

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

function css_color_to_hex(cssColor: string) {
	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return null;
	}

	// Normalize via canvas
	ctx.fillStyle = "#000";
	ctx.fillStyle = cssColor;

	const normalized = ctx.fillStyle;
	// Usually: "#rrggbb" or "rgba(r, g, b, a)"
	if (typeof normalized !== "string") {
		return null;
	}

	if (normalized.startsWith("#")) {
		const hex = normalized.toLowerCase();
		if (hex.length === 7 || hex.length === 9) {
			return hex;
		}
		return null;
	}

	const rgbaMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(normalized);
	if (!rgbaMatch) {
		return null;
	}

	const r = Math.max(0, Math.min(255, Number(rgbaMatch[1])));
	const g = Math.max(0, Math.min(255, Number(rgbaMatch[2])));
	const b = Math.max(0, Math.min(255, Number(rgbaMatch[3])));
	const a = rgbaMatch[4] == null ? 1 : Math.max(0, Math.min(1, Number(rgbaMatch[4])));

	const toHex2 = (n: number) => n.toString(16).padStart(2, "0");
	const rrggbb = `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
	if (a === 1) {
		return rrggbb;
	}

	const alpha = Math.round(a * 255);
	return `${rrggbb}${toHex2(alpha)}`;
}

function hex_with_alpha(hex: string, alpha01: number) {
	// Accepts "#rrggbb" or "#rrggbbaa"
	const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
	if (!m) {
		return hex;
	}

	const clamped = Math.max(0, Math.min(1, alpha01));
	const alpha = Math.round(clamped * 255)
		.toString(16)
		.padStart(2, "0");
	return `#${m[1]}${alpha}`;
}

function css_var_to_hex(varName: string, fallbackHex: string) {
	const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
	if (!raw) {
		return fallbackHex;
	}

	const converted = css_color_to_hex(raw);
	return converted ?? fallbackHex;
}

// Monaco requires: /^[a-z0-9\-]+$/i (no underscores)
export const app_monaco_THEME_NAME_DARK = "app-pages-monaco-theme-dark";

const bg = css_var_to_hex("--color-base-1-03", "#1e1e1e");
const gutterBg = css_var_to_hex("--color-base-1-02", "#1a1a1a");
const surface = css_var_to_hex("--color-base-1-05", "#252526");
const border = css_var_to_hex("--color-base-1-10", "#3c3c3c");

const fg = css_var_to_hex("--color-fg-11", "#d4d4d4");
const fgMuted = css_var_to_hex("--color-fg-07", "#858585");
const fgStrong = css_var_to_hex("--color-fg-12", "#ffffff");

const accent1 = css_var_to_hex("--color-accent-01", "#264f78");
const accent6 = css_var_to_hex("--color-accent-06", "#3b8eea");
const accent7 = css_var_to_hex("--color-accent-07", "#4aa3ff");

try {
	monaco.editor.defineTheme(app_monaco_THEME_NAME_DARK, {
		base: "vs-dark",
		inherit: true,
		rules: [],
		colors: {
			"editor.background": bg,
			"editor.foreground": fg,

			"editorLineNumber.foreground": fgMuted,
			"editorLineNumber.activeForeground": fg,
			"editorCursor.foreground": fgStrong,

			"editor.selectionBackground": hex_with_alpha(accent1, 0.35),
			"editor.inactiveSelectionBackground": hex_with_alpha(accent1, 0.22),

			"editor.findMatchBackground": hex_with_alpha(accent7, 0.35),
			"editor.findMatchHighlightBackground": hex_with_alpha(accent6, 0.25),
			"editor.findRangeHighlightBackground": hex_with_alpha(accent6, 0.18),

			"editor.lineHighlightBackground": hex_with_alpha(surface, 0.65),
			"editor.lineHighlightBorder": "#00000000",

			"editorGutter.background": gutterBg,

			"editorIndentGuide.background1": hex_with_alpha(border, 0.55),
			"editorIndentGuide.activeBackground1": hex_with_alpha(fgMuted, 0.55),

			"editorBracketMatch.background": hex_with_alpha(css_var_to_hex("--color-base-1-08", "#2d2d2d"), 0.9),
			"editorBracketMatch.border": border,

			"editorRuler.foreground": css_var_to_hex("--color-base-1-07", "#2a2a2a"),

			"editorHoverWidget.background": surface,
			"editorHoverWidget.border": border,
			"editorSuggestWidget.background": surface,
			"editorSuggestWidget.border": border,
			"editorWidget.background": surface,
			"editorWidget.border": border,

			"scrollbarSlider.background": hex_with_alpha(border, 0.45),
			"scrollbarSlider.hoverBackground": hex_with_alpha(border, 0.65),
			"scrollbarSlider.activeBackground": hex_with_alpha(fgMuted, 0.55),

			"editorWhitespace.foreground": hex_with_alpha(fgMuted, 0.35),

			"minimap.background": bg,
		},
	});
	monaco.editor.setTheme(app_monaco_THEME_NAME_DARK);
} catch (err) {
	console.error("app_monaco_register_ai_docs_dark_theme: failed to define/apply theme", err);
}

// Ensure @monaco-editor/react and direct `monaco-editor` imports share the exact same Monaco instance.
// This prevents subtle runtime errors when passing models between the two.
loader.config({ monaco });
