import "./file-editor-rich-text-tools-table.css";
import {
	Columns3,
	Rows3,
	Table as TableIcon,
	TableColumnsSplit,
	TableProperties,
	TableRowsSplit,
	Trash2,
	type LucideIcon,
} from "lucide-react";
import { memo } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import {
	MyMenu,
	MyMenuTrigger,
	MyMenuPopover,
	MyMenuPopoverScrollableArea,
	MyMenuPopoverContent,
	MyMenuItem,
	MyMenuItemsGroup,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	type MyMenuItem_Props,
} from "@/components/my-menu.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";

export type FileEditorRichTextToolsTable_ClassNames =
	| "FileEditorRichTextToolsTable"
	| "FileEditorRichTextToolsTable-popover";

type TableCommandKey =
	| "addRowBefore"
	| "addRowAfter"
	| "addColumnBefore"
	| "addColumnAfter"
	| "deleteRow"
	| "deleteColumn"
	| "toggleHeaderRow"
	| "deleteTable";

type TableCommandItem = {
	key: TableCommandKey;
	name: string;
	Icon: LucideIcon;
	destructive?: boolean;
};

const tableCommandItems: TableCommandItem[] = [
	{ key: "addRowBefore", name: "Add row above", Icon: Rows3 },
	{ key: "addRowAfter", name: "Add row below", Icon: Rows3 },
	{ key: "addColumnBefore", name: "Add column left", Icon: Columns3 },
	{ key: "addColumnAfter", name: "Add column right", Icon: Columns3 },
	{ key: "deleteRow", name: "Delete row", Icon: TableRowsSplit },
	{ key: "deleteColumn", name: "Delete column", Icon: TableColumnsSplit },
	{ key: "toggleHeaderRow", name: "Toggle header row", Icon: TableProperties },
	{ key: "deleteTable", name: "Delete table", Icon: Trash2, destructive: true },
];

// #region menu item
type FileEditorRichTextToolsTableItem_Props = {
	editor: Editor;
	item: TableCommandItem;
	disabled: boolean;
};

const FileEditorRichTextToolsTableItem = memo(function FileEditorRichTextToolsTableItem(
	props: FileEditorRichTextToolsTableItem_Props,
) {
	const { editor, item, disabled } = props;

	const handleClick = useFn<NonNullable<MyMenuItem_Props["onClick"]>>(() => {
		editor.chain().focus()[item.key]().run();
	});

	return (
		<MyMenuItem variant={item.destructive ? "destructive" : undefined} disabled={disabled} onClick={handleClick}>
			<MyMenuItemContent>
				<MyMenuItemContentIcon>
					<item.Icon />
				</MyMenuItemContentIcon>
				<MyMenuItemContentPrimary>{item.name}</MyMenuItemContentPrimary>
			</MyMenuItemContent>
		</MyMenuItem>
	);
});
// #endregion menu item

// #region root
export type FileEditorRichTextToolsTable_Props = {
	editor: Editor;
};

type FileEditorRichTextToolsTableInner_Props = FileEditorRichTextToolsTable_Props & {
	canByKey: Record<TableCommandKey, boolean>;
};

const FileEditorRichTextToolsTableInner = memo(function FileEditorRichTextToolsTableInner(
	props: FileEditorRichTextToolsTableInner_Props,
) {
	const { editor, canByKey } = props;

	return (
		<div className={cn("FileEditorRichTextToolsTable" satisfies FileEditorRichTextToolsTable_ClassNames)}>
			<MyMenu>
				<MyMenuTrigger>
					<MyIconButton variant="ghost-highlightable" tooltip="Table commands">
						<MyIconButtonIcon>
							<TableIcon />
						</MyIconButtonIcon>
					</MyIconButton>
				</MyMenuTrigger>
				<MyMenuPopover
					className={cn("FileEditorRichTextToolsTable-popover" satisfies FileEditorRichTextToolsTable_ClassNames)}
				>
					<MyMenuPopoverScrollableArea>
						<MyMenuPopoverContent>
							<MyMenuItemsGroup>
								{tableCommandItems.map((item) => (
									<FileEditorRichTextToolsTableItem
										key={item.key}
										editor={editor}
										item={item}
										disabled={!canByKey[item.key]}
									/>
								))}
							</MyMenuItemsGroup>
						</MyMenuPopoverContent>
					</MyMenuPopoverScrollableArea>
				</MyMenuPopover>
			</MyMenu>
		</div>
	);
});

export const FileEditorRichTextToolsTable = memo(function FileEditorRichTextToolsTable(
	props: FileEditorRichTextToolsTable_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	// Subscribe to each command's availability so the items enable the moment the caret enters a
	// table and disable when it leaves.
	const canByKey = useEditorState({
		editor,
		selector: ({ editor }): Record<TableCommandKey, boolean> => {
			const can = editor.can();
			return {
				addRowBefore: can.addRowBefore(),
				addRowAfter: can.addRowAfter(),
				addColumnBefore: can.addColumnBefore(),
				addColumnAfter: can.addColumnAfter(),
				deleteRow: can.deleteRow(),
				deleteColumn: can.deleteColumn(),
				toggleHeaderRow: can.toggleHeaderRow(),
				deleteTable: can.deleteTable(),
			};
		},
	});

	return <FileEditorRichTextToolsTableInner editor={editor} canByKey={canByKey} />;
});
// #endregion root
