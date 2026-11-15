// Keep Monaco runtime helpers here, not in `files.ts`. Only the editors import this module, while
// the app entry loads `files.ts`. Monaco code there would make every page download the whole editor.
import { editor as monaco_editor } from "monaco-editor";
import { ai_chat_ui_context_clear_selection, ai_chat_ui_context_set_selection } from "./ai-chat-ui-context.ts";

export function files_monaco_create_editor_model(text: string, languageId: string) {
	const model = monaco_editor.createModel(text, languageId);
	// Keep this pin: Monaco is a second normalizer. Without it a CRLF string reaching a mounted
	// model would flip the whole buffer's line endings and mark the file dirty with no user edit.
	model.setEOL(monaco_editor.EndOfLineSequence.LF);
	return model;
}

/**
 * Send the selected text of one Monaco pane to the chat screen info, and return the cleanup.
 * `owner` is the editor that owns the pane: both diff panes share the diff editor as owner.
 * Keep the text after blur, because the user then clicks the chat input.
 */
export function files_monaco_listen_selection_for_ai_chat(
	owner: object,
	editor: monaco_editor.ICodeEditor,
	kind: "plain_text" | "diff_original" | "diff_modified",
) {
	const listener = editor.onDidChangeCursorSelection(() => {
		// Only a user selection counts. Remote edits also move the selection.
		const model = editor.getModel();
		const selection = editor.getSelection();
		if (!editor.hasTextFocus() || !model || !selection) return;
		// Send the primary selection only, also with more cursors.
		ai_chat_ui_context_set_selection(owner, { text: model.getValueInRange(selection), editor: kind });
	});
	return () => {
		listener.dispose();
		ai_chat_ui_context_clear_selection(owner);
	};
}
