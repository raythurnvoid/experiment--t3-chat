// Keep Monaco runtime helpers here, not in `files.ts`. Only the editors import this module, while
// the app entry loads `files.ts`. Monaco code there would make every page download the whole editor.
import { editor as monaco_editor } from "monaco-editor";

export function files_monaco_create_editor_model(text: string, languageId: string) {
	const model = monaco_editor.createModel(text, languageId);
	// Keep this pin: Monaco is a second normalizer. Without it a CRLF string reaching a mounted
	// model would flip the whole buffer's line endings and mark the file dirty with no user edit.
	model.setEOL(monaco_editor.EndOfLineSequence.LF);
	return model;
}
