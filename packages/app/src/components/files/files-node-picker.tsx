import "./files-node-picker.css";

import { usePaginatedQuery, useQueries, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReference } from "convex/server";
import { FileText, Folder } from "lucide-react";
import {
	Fragment,
	memo,
	useEffect,
	useId,
	useImperativeHandle,
	useMemo,
	useState,
	type MouseEvent,
	type ReactNode,
	type Ref,
} from "react";

import { MyButton } from "@/components/my-button.tsx";
import type { MyMenuItem_ClassNames } from "@/components/my-menu.tsx";
import { MySearchSelectItem, MySearchSelectList } from "@/components/my-search-select.tsx";
import { MySelectItemsGroup, MySelectItemsGroupText } from "@/components/my-select.tsx";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_ROOT_ID } from "@/lib/files.ts";
import { detect_search_query_mode } from "@/lib/files-search.ts";
import { FilesTreeProvider } from "@/lib/files-tree-context.tsx";
import { path_name_of } from "@/lib/paths.ts";
import { cn } from "@/lib/utils.ts";
import { files_search_query_folder_path } from "../../../shared/files-search-query.ts";

// #region item content
type FilesNodePickerItemContent_ClassNames =
	| "FilesNodePickerItemContent"
	| "FilesNodePickerItemContent-icon"
	| "FilesNodePickerItemContent-text"
	| "FilesNodePickerItemContent-name"
	| "FilesNodePickerItemContent-detail"
	| "FilesNodePickerItemContent-hint";

type FilesNodePickerItemContent_Props = {
	icon: ReactNode;
	label: string;
	/**
	 * The folder of a search row, under the name.
	 */
	folderPath: string | null;
	/**
	 * Why the row cannot be picked, under the name and the folder.
	 */
	reason: string | null;
	/**
	 * The id of the reason, so the row can name it with `aria-describedby`.
	 */
	reasonId: string;
	/**
	 * A short word at the end of the row that says what Enter does, like "Open".
	 */
	hint: string | null;
};

const FilesNodePickerItemContent = memo(function FilesNodePickerItemContent(props: FilesNodePickerItemContent_Props) {
	const { icon, label, folderPath, reason, reasonId, hint } = props;

	return (
		<span className={"FilesNodePickerItemContent" satisfies FilesNodePickerItemContent_ClassNames}>
			<span className={"FilesNodePickerItemContent-icon" satisfies FilesNodePickerItemContent_ClassNames}>{icon}</span>
			<span className={"FilesNodePickerItemContent-text" satisfies FilesNodePickerItemContent_ClassNames}>
				<span className={"FilesNodePickerItemContent-name" satisfies FilesNodePickerItemContent_ClassNames}>
					{label}
				</span>
				{folderPath !== null && (
					<span className={"FilesNodePickerItemContent-detail" satisfies FilesNodePickerItemContent_ClassNames}>
						{folderPath}
					</span>
				)}
				{reason !== null && (
					<span
						id={reasonId}
						className={"FilesNodePickerItemContent-detail" satisfies FilesNodePickerItemContent_ClassNames}
					>
						{reason}
					</span>
				)}
			</span>
			{hint !== null && (
				// The row keeps its name alone. The hint only shows what Enter does.
				<span aria-hidden className={"FilesNodePickerItemContent-hint" satisfies FilesNodePickerItemContent_ClassNames}>
					{hint}
				</span>
			)}
		</span>
	);
});
// #endregion item content

// #region picker
const FILES_NODE_PICKER_PAGE_SIZE = 50;

/**
 * One file or folder a picker shows.
 */
export type FilesNodePicker_Row = {
	nodeId: app_convex_Id<"files_nodes">;
	name: string;
	path: string;
	kind: app_convex_Doc<"files_nodes">["kind"];
	contentType: app_convex_Doc<"files_nodes">["contentType"];
};

/**
 * The open folder that the `folderRow` row picks. In a folder picker it can be the root.
 */
export type FilesNodePicker_Folder = {
	nodeId: app_convex_Id<"files_nodes"> | typeof files_ROOT_ID;
	name: string;
	path: string;
};

export type FilesNodePicker_Pickable = { ok: true } | { ok: false; reason: string };

/**
 * A row the caller adds before the files, like a person in a Channels mention.
 */
type FilesNodePicker_LeadingRow = {
	key: string;
	label: string;
	icon: ReactNode;
	onPick: () => void;
};

/**
 * A query that answers which of the given files can be picked.
 */
type FilesNodePicker_PickableFilesQuery = FunctionReference<
	"query",
	"public",
	{
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		fileNodeIds: Array<app_convex_Id<"files_nodes">>;
	},
	Array<app_convex_Id<"files_nodes">>
>;

/**
 * One row of the list: a file or folder, the row that picks the open folder, a row of the caller,
 * or the Show more row of one list. A folder row opens the folder. A file row picks the file.
 */
type FilesNodePicker_Item =
	| { kind: "node"; key: string; row: FilesNodePicker_Row; pickable: FilesNodePicker_Pickable }
	| { kind: "folder"; key: string; folder: FilesNodePicker_Folder; label: string; pickable: FilesNodePicker_Pickable }
	| { kind: "leading"; key: string; row: FilesNodePicker_LeadingRow }
	| { kind: "more"; key: string; loadMore: () => void };

type FilesNodePicker_ClassNames =
	| "FilesNodePicker-breadcrumb"
	| "FilesNodePicker-list"
	| "FilesNodePicker-item"
	| "FilesNodePicker-group-label"
	| "FilesNodePicker-status"
	| "FilesNodePicker-announcement";

export type FilesNodePicker_Ref = {
	/**
	 * Handle a key of the text field that keeps focus. Returns true when the picker used the key.
	 * Only the `listbox` variant reads keys. In the `select` variant the select reads them.
	 */
	onKeyDown: (event: KeyboardEvent) => boolean;
};

type FilesNodePicker_FolderRow = {
	label: string;
	onPick: (folder: FilesNodePicker_Folder) => void;
};

export type FilesNodePicker_Props = {
	ref?: Ref<FilesNodePicker_Ref>;
	/**
	 * The typed text. Text up to the last "/" is a folder path, and text after it searches names in
	 * that folder. Text with no "/" searches names in the open folder, or in the whole workspace at the
	 * root. Empty text browses the open folder.
	 */
	query: string;
	/**
	 * Rows to show before the files, like the people of a Channels mention. They show while the
	 * picker lists the root or searches the whole workspace, not inside a folder.
	 */
	leadingRows?: FilesNodePicker_LeadingRow[];
	/**
	 * Whether a file can be picked. Files that cannot be picked show disabled, with the reason under
	 * the name.
	 */
	getPickable?: (row: FilesNodePicker_Row) => FilesNodePicker_Pickable;
	/**
	 * A server rule that the rows do not carry, like "the upload finished". The picker asks `query`
	 * about the shown files, 50 at a time, and files it leaves out show disabled with `reason`. A file
	 * stays pickable until its answer arrives, so the server must check the pick again.
	 */
	pickableFilesQuery?: { query: FilesNodePicker_PickableFilesQuery; reason: string };
	/**
	 * Clear the typed text. Opening a folder does it, so the open folder shows and new text searches
	 * inside it.
	 */
	clearQuery: () => void;
} & (
	| {
			/**
			 * What the picker picks. Folders always open, so a file picker can reach files inside them.
			 */
			select: "file" | "any";
			/**
			 * A first row that picks the open folder, like "Mention this folder", or null for no such row.
			 * The root has no row.
			 */
			folderRow: FilesNodePicker_FolderRow | null;
			onPick: (row: FilesNodePicker_Row) => void;
	  }
	| {
			/**
			 * A folder picker picks where new files go, with its `folderRow` row, like "Save here". The
			 * row shows at the root too, and shows disabled in a folder the user cannot add files to.
			 */
			select: "folder";
			folderRow: FilesNodePicker_FolderRow;
	  }
) &
	(
		| {
				/**
				 * Rows are `MySearchSelectItem`s. Render it inside a `MySearchSelect` popover after its search
				 * input, which holds the query.
				 */
				variant: "select";
		  }
		| {
				/**
				 * Rows are `role="option"`s in a listbox. Focus stays in `ownerElement`, a text field that
				 * forwards its keys to the ref's `onKeyDown`, like a Tiptap suggestion popup.
				 */
				variant: "listbox";
				"aria-label": string;
				ownerElement: HTMLElement;
		  }
	);

/**
 * Pick a file or a folder of the workspace, one folder or one search at a time, with pages of 50
 * and Show more.
 *
 * Saved rows only: UI lists never show drafts. Drafts show in the Pending tab, in the draft folder
 * view and to the agent (files-explorer-tree skill, "Saved-only lists"). So a draft file cannot be
 * picked until it is accepted.
 */
export const FilesNodePicker = memo(function FilesNodePicker(props: FilesNodePicker_Props) {
	const { ref, query, select, folderRow, leadingRows, getPickable, pickableFilesQuery, clearQuery } = props;
	const ownerElement = props.variant === "listbox" ? props.ownerElement : null;
	const { membershipId } = AppTenantProvider.useContext();

	const listboxId = `FilesNodePicker-${useId()}`;
	const [browsePath, setBrowsePath] = useState("/");

	const slashIndex = query.lastIndexOf("/");
	const folderPath = slashIndex === -1 ? browsePath : files_search_query_folder_path(query.slice(0, slashIndex));
	const nameText = query.slice(slashIndex + 1).trim();
	const isSearch = nameText.length > 0;
	// The highlight and the announced reason belong to one list.
	const scope = JSON.stringify([folderPath, query]);

	const folder = useQuery(
		app_convex_api.files_nodes.get_authorized_by_path,
		!isSearch && folderPath !== "/" ? { membershipId, path: folderPath } : "skip",
	);
	const folderId = folderPath === "/" ? files_ROOT_ID : folder?.kind === "folder" ? folder.nodeId : null;
	const browse = FilesTreeProvider.usePickerFolder({
		membershipId,
		folderId: isSearch ? null : folderId,
		withFiles: select !== "folder",
		pageSize: FILES_NODE_PICKER_PAGE_SIZE,
	});
	// One query for the open folder only. The upload door (`create_upload_node`) checks the same
	// write permission on the folder it saves into.
	const canWriteFolder = useQuery(
		app_convex_api.files_nodes.get_current_user_file_write_permission,
		select === "folder" && !isSearch && folderId !== null ? { membershipId, nodeId: folderId } : "skip",
	);

	// Search the name words the search box searches: `readme.md` searches `readme`.
	const nameQuery = detect_search_query_mode(nameText);
	const search = usePaginatedQuery(
		app_convex_api.files_nodes.search_saved,
		isSearch
			? {
					membershipId,
					clause: {
						kind: "name",
						text: nameQuery.mode === "name" ? nameQuery.value : nameText,
						nodeKind: select === "folder" ? "folder" : undefined,
					},
					// Text with no "/" searches the open folder, or the whole workspace at the root.
					folderPath: slashIndex === -1 && folderPath === "/" ? undefined : folderPath,
				}
			: "skip",
		{ initialNumItems: FILES_NODE_PICKER_PAGE_SIZE },
	);

	const toPickerRows = (rows: ReturnType<typeof FilesTreeProvider.usePickerFolder>["children"]["rows"]) =>
		rows.flatMap((row): FilesNodePicker_Row[] =>
			select === "folder" && row.kind === "file"
				? []
				: [{ nodeId: row._id, name: row.name, path: row.path, kind: row.kind, contentType: row.contentType }],
		);
	const searchRows = search.results.flatMap((row): FilesNodePicker_Row[] =>
		row.kind === "problem"
			? []
			: [
					{
						nodeId: row.nodeId,
						name: path_name_of(row.path),
						path: row.path,
						kind: row.kind,
						contentType: row.contentType,
					},
				],
	);
	const sharedRows = browse.shared ? toPickerRows(browse.shared.rows) : [];
	const childRows = toPickerRows(browse.children.rows);

	// Ask `pickableFilesQuery` about the shown files, one query per 50 files. Keep the manual `useMemo`:
	// `useQueries` subscribes again whenever the queries object changes, and the React Compiler does
	// not memoize hook arguments, so an inline object would loop the render. Memoize on the ids joined as text.
	// Read the ids from the hook results: the rows above end up in items, so the compiler treats them as changing.
	const shownFileIdsText = !pickableFilesQuery
		? ""
		: isSearch
			? search.results.flatMap((row) => (row.kind === "file" ? [row.nodeId] : [])).join(",")
			: [...(browse.shared?.rows ?? []), ...browse.children.rows]
					.flatMap((row) => (row.kind === "file" ? [row._id] : []))
					.join(",");
	const pickableQuery = pickableFilesQuery?.query;
	const pickableFilesQueries = useMemo(() => {
		const fileNodeIds = (shownFileIdsText ? shownFileIdsText.split(",") : []) as Array<app_convex_Id<"files_nodes">>;
		const queries: Record<
			string,
			{ query: FilesNodePicker_PickableFilesQuery; args: FunctionArgs<FilesNodePicker_PickableFilesQuery> }
		> = {};
		for (let start = 0; pickableQuery && start < fileNodeIds.length; start += FILES_NODE_PICKER_PAGE_SIZE) {
			queries[start] = {
				query: pickableQuery,
				args: { membershipId, fileNodeIds: fileNodeIds.slice(start, start + FILES_NODE_PICKER_PAGE_SIZE) },
			};
		}
		return queries;
	}, [pickableQuery, membershipId, shownFileIdsText]);
	const pickableFilesAnswers = useQueries(pickableFilesQueries);
	// A file whose answer has not arrived is not unpickable yet.
	const unpickableFileIds = new Set(
		Object.entries(pickableFilesQueries).flatMap(([key, { args }]) => {
			const answer: unknown = pickableFilesAnswers[key];
			return Array.isArray(answer) ? args.fileNodeIds.filter((fileNodeId) => !answer.includes(fileNodeId)) : [];
		}),
	);

	const nodeItem = (sectionKey: string, row: FilesNodePicker_Row): FilesNodePicker_Item => ({
		kind: "node",
		key: `${sectionKey}:${row.nodeId}`,
		row,
		pickable:
			row.kind === "folder"
				? { ok: true }
				: pickableFilesQuery && unpickableFileIds.has(row.nodeId)
					? { ok: false, reason: pickableFilesQuery.reason }
					: (getPickable?.(row) ?? { ok: true }),
	});
	const moreItem = (sectionKey: string, loadMore: () => void): FilesNodePicker_Item => ({
		kind: "more",
		key: `${sectionKey}:more`,
		loadMore,
	});

	const sections: Array<{ key: string; label: string | null; items: FilesNodePicker_Item[] }> = [];
	let statusText: string | null = null;
	// The caller's rows belong to the whole workspace, so they do not show inside a folder.
	if (leadingRows && leadingRows.length > 0 && slashIndex === -1 && browsePath === "/") {
		sections.push({
			key: "leading",
			label: null,
			items: leadingRows.map((row) => ({ kind: "leading", key: `leading:${row.key}`, row })),
		});
	}
	if (isSearch) {
		const problem = search.results.find((row) => row.kind === "problem");
		const hasMore = search.status === "CanLoadMore" || search.status === "LoadingMore";
		sections.push({
			key: "search",
			label: null,
			items: [
				...searchRows.map((row) => nodeItem("search", row)),
				...(hasMore ? [moreItem("search", () => search.loadMore(FILES_NODE_PICKER_PAGE_SIZE))] : []),
			],
		});
		statusText = problem
			? problem.message
			: search.status === "LoadingFirstPage"
				? "Loading…"
				: search.status === "Exhausted" && searchRows.length === 0
					? "No files match"
					: null;
	} else if (folderId === null) {
		statusText = folder === undefined ? "Loading…" : "Folder not found";
	} else {
		// Only a folder picker picks the root: new files can go there, but a mention of it means nothing.
		const currentFolder: FilesNodePicker_Folder | null = folder
			? { nodeId: folder.nodeId, name: folder.name, path: folderPath }
			: select === "folder"
				? { nodeId: files_ROOT_ID, name: "/", path: "/" }
				: null;
		if (folderRow && currentFolder) {
			sections.push({
				key: "folder",
				label: null,
				items: [
					{
						kind: "folder",
						key: "folder",
						folder: currentFolder,
						label: folderRow.label,
						// The row stays pickable while the answer loads. The save door checks again.
						pickable:
							canWriteFolder === false ? { ok: false, reason: "You cannot add files to this folder" } : { ok: true },
					},
				],
			});
		}

		const lists = browse.shared ? [browse.shared, browse.children] : [browse.children];
		if (browse.shared && (sharedRows.length > 0 || browse.shared.status === "more")) {
			sections.push({
				key: "shared",
				label: "Shared with you",
				items: [
					...sharedRows.map((row) => nodeItem("shared", row)),
					...(browse.shared.status === "more" ? [moreItem("shared", browse.shared.loadMore)] : []),
				],
			});
		}
		sections.push({
			key: "children",
			label: null,
			items: [
				...childRows.map((row) => nodeItem("children", row)),
				...(browse.children.status === "more" ? [moreItem("children", browse.children.loadMore)] : []),
			],
		});
		statusText =
			sharedRows.length + childRows.length > 0
				? null
				: lists.some((list) => list.status === "loading")
					? "Loading…"
					: lists.every((list) => list.status === "done")
						? "This folder is empty"
						: null;
	}
	const items = sections.flatMap((section) => section.items);

	// A new list starts back at its first row, with no sync effect.
	const [highlight, setHighlight] = useState({ scope, index: 0 });
	const activeIndex =
		items.length === 0 ? -1 : Math.min(highlight.scope === scope ? highlight.index : 0, items.length - 1);
	const activeKey = activeIndex === -1 ? null : items[activeIndex]!.key;
	// Ids come from the row keys, not the positions. So after Show more or a new folder, the row under
	// the highlight gets a new id, and a screen reader reads it.
	const activeOptionId = activeKey === null ? null : `${listboxId}-option-${activeKey}`;

	// The status line reads out the reason of the disabled row the user last tried to pick, or the folder
	// that just opened. `count` gives each message a new node, so the same text is read again.
	const [announcement, setAnnouncement] = useState({ scope, text: "", count: 0 });

	const openFolder = (path: string) => {
		setBrowsePath(path);
		// The opened folder shows with empty text, so the message belongs to that list.
		setAnnouncement({ scope: JSON.stringify([path, ""]), text: `Opened ${path}`, count: announcement.count + 1 });
		if (query !== "") {
			clearQuery();
		}
	};

	const activate = (item: FilesNodePicker_Item) => {
		if (item.kind === "more") {
			item.loadMore();
		} else if (item.kind === "leading") {
			item.row.onPick();
		} else if (!item.pickable.ok) {
			setAnnouncement({ scope, text: item.pickable.reason, count: announcement.count + 1 });
		} else if (item.kind === "folder") {
			folderRow?.onPick(item.folder);
		} else if (item.row.kind === "folder") {
			openFolder(item.row.path);
		} else if (props.select !== "folder") {
			props.onPick(item.row);
		}
	};

	// Keep DOM focus in the owner text field when a row or a folder of the path is clicked.
	const handleMouseDown = (event: MouseEvent) => {
		event.preventDefault();
	};

	useImperativeHandle(ref, () => ({
		onKeyDown: (event: KeyboardEvent) => {
			// Let an IME confirm its text. That Enter must not pick a row.
			if (event.isComposing) {
				return false;
			}

			if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				if (items.length > 0) {
					const direction = event.key === "ArrowUp" ? -1 : 1;
					setHighlight({ scope, index: (activeIndex + direction + items.length) % items.length });
				}
				return true;
			}

			if (event.key === "Enter") {
				const item = items[activeIndex];
				if (item) {
					activate(item);
				}
				return true;
			}

			return false;
		},
	}));

	// Focus stays in the owner text field. Show the list to assistive tech through it: aria-controls
	// names the listbox and aria-activedescendant follows the highlighted row.
	useEffect(() => {
		if (!ownerElement) {
			return;
		}

		ownerElement.setAttribute("aria-controls", listboxId);
		if (activeOptionId) {
			ownerElement.setAttribute("aria-activedescendant", activeOptionId);
		} else {
			ownerElement.removeAttribute("aria-activedescendant");
		}

		return () => {
			ownerElement.removeAttribute("aria-controls");
			ownerElement.removeAttribute("aria-activedescendant");
		};
	}, [ownerElement, listboxId, activeOptionId]);

	useEffect(() => {
		if (ownerElement && activeOptionId) {
			document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
		}
	}, [ownerElement, activeOptionId]);

	const renderItem = (item: FilesNodePicker_Item) => {
		const reasonId = `${listboxId}-reason-${item.key}`;
		const reason = (item.kind === "node" || item.kind === "folder") && !item.pickable.ok ? item.pickable.reason : null;
		const isDisabled = reason !== null;
		const label =
			item.kind === "node"
				? item.row.name
				: item.kind === "folder"
					? item.label
					: item.kind === "leading"
						? item.row.label
						: "Show more";
		const content =
			item.kind === "more" ? (
				label
			) : (
				<FilesNodePickerItemContent
					icon={
						item.kind === "leading" ? (
							item.row.icon
						) : item.kind === "folder" || item.row.kind === "folder" ? (
							<Folder />
						) : (
							<FileText />
						)
					}
					label={label}
					// Search rows come from many folders, so they show their folder under the name.
					folderPath={
						isSearch && item.kind === "node" ? item.row.path.slice(0, item.row.path.lastIndexOf("/") + 1) : null
					}
					reason={reason}
					reasonId={reasonId}
					// The folder picker has two actions: a folder row opens, and the first row saves.
					hint={select === "folder" && item.kind === "node" ? "Open" : null}
				/>
			);
		// A disabled row is named by its label alone. Its reason is the description, so it is read once.
		const disabledProps = isDisabled ? { "aria-label": label, "aria-describedby": reasonId } : {};

		return props.variant === "select" ? (
			<MySearchSelectItem
				key={item.key}
				value={item.key}
				className={"FilesNodePicker-item" satisfies FilesNodePicker_ClassNames}
				disabled={isDisabled}
				// Keep a disabled row reachable by the arrow keys, so a keyboard user can read its reason.
				accessibleWhenDisabled
				{...disabledProps}
				// The select stops the click of a disabled row before `onClick`, so its reason is announced here.
				onClickCapture={isDisabled ? () => activate(item) : undefined}
				setValueOnClick={false}
				// Close after a pick. Show more and a folder that opens keep the list open.
				hideOnClick={
					item.kind === "folder" || item.kind === "leading" || (item.kind === "node" && item.row.kind === "file")
				}
				onClick={() => activate(item)}
			>
				{content}
			</MySearchSelectItem>
		) : (
			<div
				key={item.key}
				id={`${listboxId}-option-${item.key}`}
				role="option"
				aria-selected={item.key === activeKey}
				aria-disabled={isDisabled || undefined}
				{...disabledProps}
				className={cn(
					"FilesNodePicker-item" satisfies FilesNodePicker_ClassNames,
					"MyMenuItem" satisfies MyMenuItem_ClassNames,
				)}
				onClick={() => activate(item)}
			>
				{content}
			</div>
		);
	};

	const listContent = sections.map((section) => {
		if (section.label === null) {
			return <Fragment key={section.key}>{section.items.map(renderItem)}</Fragment>;
		}

		const labelId = `${listboxId}-${section.key}-label`;
		return props.variant === "select" ? (
			<MySelectItemsGroup key={section.key}>
				<MySelectItemsGroupText>{section.label}</MySelectItemsGroupText>
				{section.items.map(renderItem)}
			</MySelectItemsGroup>
		) : (
			<div key={section.key} role="group" aria-labelledby={labelId}>
				<div id={labelId} className={"FilesNodePicker-group-label" satisfies FilesNodePicker_ClassNames}>
					{section.label}
				</div>
				{section.items.map(renderItem)}
			</div>
		);
	});

	const crumbs = folderPath === "/" ? [] : folderPath.slice(1).split("/");

	return (
		<>
			{/* Keep the path, with its root, mounted in every folder. Enter on a folder of the path would
			    otherwise remove the focused button, and the focus would fall to the page body. */}
			<nav
				aria-label="Folder path"
				className={"FilesNodePicker-breadcrumb" satisfies FilesNodePicker_ClassNames}
				onMouseDown={ownerElement ? handleMouseDown : undefined}
			>
				<MyButton
					variant="ghost"
					aria-current={crumbs.length === 0 ? "location" : undefined}
					onClick={() => openFolder("/")}
				>
					/
				</MyButton>
				{crumbs.map((crumb, index) => (
					<MyButton
						key={index}
						variant="ghost"
						aria-current={index === crumbs.length - 1 ? "location" : undefined}
						onClick={() => openFolder(`/${crumbs.slice(0, index + 1).join("/")}`)}
					>
						{crumb}
					</MyButton>
				))}
			</nav>
			{props.variant === "select" ? (
				<MySearchSelectList className={"FilesNodePicker-list" satisfies FilesNodePicker_ClassNames}>
					{listContent}
				</MySearchSelectList>
			) : (
				<div
					id={listboxId}
					role="listbox"
					aria-label={props["aria-label"]}
					className={"FilesNodePicker-list" satisfies FilesNodePicker_ClassNames}
					onMouseDown={handleMouseDown}
				>
					{listContent}
				</div>
			)}
			{statusText !== null && (
				<div className={"FilesNodePicker-status" satisfies FilesNodePicker_ClassNames}>{statusText}</div>
			)}
			<p role="status" className={"FilesNodePicker-announcement" satisfies FilesNodePicker_ClassNames}>
				{announcement.scope === scope && announcement.text !== "" && (
					<span key={announcement.count}>{announcement.text}</span>
				)}
			</p>
		</>
	);
});
// #endregion picker
