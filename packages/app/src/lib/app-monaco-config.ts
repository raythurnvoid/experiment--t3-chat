// Minimal for Markdown-only: editor worker is enough
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

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
