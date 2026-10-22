import "./my-modal-monaco-editor.css";
import { Editor, type EditorProps } from "@monaco-editor/react";
import { memo, useId, useState } from "react";
import { sx } from "@/lib/utils.ts";

type MyModalMonacoEditor_ClassNames = "MyModalMonacoEditor" | "MyModalMonacoEditor-overflow";

type MyModalMonacoEditor_CssVars = {
	"--MyModalMonacoEditor-anchor": string;
};

type MyModalMonacoEditor_Props = EditorProps;

/**
 * A Monaco editor for use inside a `MyModalPopover`. Monaco reads `options` once, when it creates the editor.
 *
 * Monaco draws its suggest list, hover, and right-click menu past the editor box. Inside a dialog they
 * would be cut off, because the dialog sets `contain: content`. The app-wide Monaco container cannot hold
 * them either, because Ariakit makes everything outside an open dialog inert. So each editor gets its own
 * empty box inside the dialog, shown in the browser's top layer and pinned to the editor's top-left
 * corner. The top layer paints above the dialog and is not cut off by it. The box is still inside the
 * dialog, so its menus can be clicked.
 */
export const MyModalMonacoEditor = memo(function MyModalMonacoEditor(props: MyModalMonacoEditor_Props) {
	const { options, ...rest } = props;

	const anchorName = `--MyModalMonacoEditor${useId()}`;
	// Create Monaco's node now, so it exists when the editor is created. Monaco styles its popups only under
	// `.monaco-editor`. Monaco's own `.monaco-editor` rule is not in a CSS layer and sets `position: relative`,
	// so the class goes on this inner node and not on the positioned box below.
	const [overflowWidgetsNode] = useState(() => {
		const node = document.createElement("div");
		node.className = "monaco-editor";
		return node;
	});
	// Keep the options in one state slot. @monaco-editor/react sends a changed options object to Monaco, and a
	// DOM node inside it would be copied again on every render.
	const [editorOptions] = useState(() => ({
		...options,
		overflowWidgetsDomNode: overflowWidgetsNode,
		// With `fixedOverflowWidgets`, Monaco ignores `overflowWidgetsDomNode` for the right-click menu and puts
		// the menu inside the editor. Without it, Monaco places the popups from the editor's top-left corner,
		// which is where the box sits.
		fixedOverflowWidgets: false,
	}));

	return (
		<div
			className={"MyModalMonacoEditor" satisfies MyModalMonacoEditor_ClassNames}
			style={sx({ "--MyModalMonacoEditor-anchor": anchorName } satisfies MyModalMonacoEditor_CssVars)}
		>
			<Editor {...rest} options={editorOptions} />
			<div
				ref={(box) => {
					if (!box) {
						return;
					}

					box.append(overflowWidgetsNode);
					if (!box.matches(":popover-open")) {
						box.showPopover();
					}
				}}
				className={"MyModalMonacoEditor-overflow" satisfies MyModalMonacoEditor_ClassNames}
				popover="manual"
			/>
		</div>
	);
});
