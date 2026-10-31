import "./files-properties-modal.css";

import type { EditorProps } from "@monaco-editor/react";
import { Check, CircleHelp, X } from "lucide-react";
import { useQuery } from "convex/react";
import { editor as monaco_editor } from "monaco-editor";
import { Fragment, memo, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import {
	MyCheckboxButton,
	MyCheckboxButtonContent,
	MyCheckboxButtonDescription,
	MyCheckboxButtonLabel,
} from "@/components/my-checkbox-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { MyModalMonacoEditor } from "@/components/my-modal-monaco-editor.tsx";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { files_format_size } from "@/lib/files.ts";
import { cn, sx } from "@/lib/utils.ts";
import {
	files_metadata_MAX_STRING_VALUE_BYTES,
	files_metadata_MAX_YAML_BYTES,
	files_metadata_parse_entries_yaml,
	files_metadata_stringify_entries_yaml,
} from "../../../shared/files-metadata.ts";
import { files_get_utf8_byte_size, files_node_has_editable_text_content } from "../../../shared/files.ts";
import { users_SYSTEM_AUTHOR } from "../../../shared/users.ts";

/**
 * What a section tells the footer. The footer has one Save button for the whole dialog. It runs the
 * `save` of every section that is `dirty`. A section that cannot save yet is
 * `invalid`, and that turns Save off. A section reports `null` when it has
 * nothing to save.
 *
 * `save` answers `true` when the write worked. The section shows its own error when it did not.
 *
 * `readOnly` lets the footer order metadata around an explicit flag change.
 */
type SaveState = {
	dirty: boolean;
	invalid: boolean;
	readOnly?: boolean;
	save: () => Promise<boolean>;
};

// #region facts
type FilesPropertiesModalFacts_ClassNames = "FilesPropertiesModalFacts" | "FilesPropertiesModalFacts-skeleton";

type FilesPropertiesModalFacts_CssVars = {
	"--FilesPropertiesModalFacts-height": string;
};

const FACTS_LINE_HEIGHT = 22;
const FACTS_PADDING = 10;

// The editor only shows the facts, so it has no scrolling, cursor line, or minimap. Its height fits
// the lines, which are always the same count for one kind of node.
const FACTS_EDITOR_OPTIONS = {
	ariaLabel: "Properties",
	readOnly: true,
	domReadOnly: true,
	// Let Tab move focus on to the next control instead of staying in this block.
	tabFocusMode: true,
	automaticLayout: true,
	fontSize: 16,
	lineHeight: FACTS_LINE_HEIGHT,
	minimap: { enabled: false },
	lineNumbers: "off",
	padding: { top: FACTS_PADDING, bottom: FACTS_PADDING },
	renderLineHighlight: "none",
	// Hide the ruler strip at the right edge. It only marks the cursor line.
	overviewRulerLanes: 0,
	hideCursorInOverviewRuler: true,
	scrollBeyondLastLine: false,
	wordWrap: "on",
} satisfies NonNullable<EditorProps["options"]>;

/**
 * Write a time as `YYYY-MM-DD HH:mm` in the user's time zone. This is the same date shape the metadata
 * editor uses, so a person can copy it into a metadata field or the search box.
 */
const facts_format_time = (timestamp: number) => {
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const facts_height = (lineCount: number) => `${lineCount * FACTS_LINE_HEIGHT + FACTS_PADDING * 2}px`;

type FilesPropertiesModalFacts_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	nodeKind: "file" | "folder";
};

/**
 * The plain facts about the node. Where it is, what it is, and who created and last changed it.
 * They show as read-only `label: value` lines in a Monaco editor, so a person can select and copy them.
 *
 * Every value is read from the node itself, so a rename or a move does not make them wrong.
 */
const FilesPropertiesModalFacts = memo(function FilesPropertiesModalFacts(props: FilesPropertiesModalFacts_Props) {
	const { nodeId, nodeKind } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const node = useQuery(app_convex_api.files_tree.get_file_node_for_membership, { membershipId, fileNodeId: nodeId });

	// A converted upload keeps its stored blob asset, so its size is still the asset size. A file
	// created in-app has no asset, and a folder never has one.
	const asset = useQuery(
		app_convex_api.files_node_asset.get_asset_by_file_node_id,
		nodeKind === "file" ? { membershipId, fileNodeId: nodeId } : "skip",
	);

	const createdByAnagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		node && node.createdBy !== users_SYSTEM_AUTHOR ? { userId: node.createdBy } : "skip",
	);

	const updatedByAnagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		node && node.updatedBy !== users_SYSTEM_AUTHOR ? { userId: node.updatedBy } : "skip",
	);

	// `undefined` means the value is still loading, which keeps the skeleton rows on screen.
	const createdByDisplayName = ((/* iife */) => {
		if (!node) {
			return undefined;
		}
		if (node.createdBy === users_SYSTEM_AUTHOR) {
			return "System";
		}
		if (createdByAnagraphic === undefined) {
			return undefined;
		}
		return createdByAnagraphic?.displayName ?? "Unknown";
	})();

	const updatedByDisplayName = ((/* iife */) => {
		if (!node) {
			return undefined;
		}
		if (node.updatedBy === users_SYSTEM_AUTHOR) {
			return "System";
		}
		if (updatedByAnagraphic === undefined) {
			return undefined;
		}
		return updatedByAnagraphic?.displayName ?? "Unknown";
	})();

	const loading =
		node === undefined ||
		createdByDisplayName === undefined ||
		updatedByDisplayName === undefined ||
		(nodeKind === "file" && asset === undefined);

	const skeletonLineCount = nodeKind === "file" ? 7 : 5;
	const skeleton = (
		<MySkeleton
			className={"FilesPropertiesModalFacts-skeleton" satisfies FilesPropertiesModalFacts_ClassNames}
			style={sx({
				"--FilesPropertiesModalFacts-height": facts_height(skeletonLineCount),
			} satisfies FilesPropertiesModalFacts_CssVars)}
		/>
	);

	if (loading) {
		return skeleton;
	}

	// The node is gone, or this member may not read it. The write-policy section below reports the
	// same absence through its own query, so say nothing more here.
	if (node === null) {
		return null;
	}

	const location = node.path.slice(0, node.path.lastIndexOf("/")) || "/";

	const lines = [
		...(nodeKind === "file"
			? [`Content type: ${node.contentType ?? "Unknown"}`, `Size: ${files_format_size(asset?.size)}`]
			: []),
		`Location: ${location}`,
		`Created: ${facts_format_time(node._creationTime)}`,
		`Created by: ${createdByDisplayName}`,
		`Last edited: ${facts_format_time(node.updatedAt)}`,
		`Last edited by: ${updatedByDisplayName}`,
	];

	return (
		<div className={"FilesPropertiesModalFacts" satisfies FilesPropertiesModalFacts_ClassNames}>
			<MyModalMonacoEditor
				height={facts_height(lines.length)}
				loading={skeleton}
				language="yaml"
				theme={app_monaco_THEME_NAME_DARK}
				value={lines.join("\n")}
				options={FACTS_EDITOR_OPTIONS}
			/>
		</div>
	);
});

type FilesPropertiesModalLockedFacts_Props = {
	node: FilesPropertiesModal_LockedNode;
	nodeKind: "file" | "folder";
};

/**
 * The facts of a node the user cannot open: only what its folder shows of it. It reads nothing.
 */
const FilesPropertiesModalLockedFacts = memo(function FilesPropertiesModalLockedFacts(
	props: FilesPropertiesModalLockedFacts_Props,
) {
	const { node, nodeKind } = props;

	const location = node.path.slice(0, node.path.lastIndexOf("/")) || "/";
	const lines = [
		...(nodeKind === "file" ? [`Content type: ${node.contentType ?? "Unknown"}`] : []),
		...(nodeKind === "file" && node.contentByteSize !== undefined
			? [`Size: ${files_format_size(node.contentByteSize ?? undefined)}`]
			: []),
		`Location: ${location}`,
		...(node._creationTime !== undefined ? [`Created: ${facts_format_time(node._creationTime)}`] : []),
		...(node.updatedAt !== undefined ? [`Last edited: ${facts_format_time(node.updatedAt)}`] : []),
	];

	return (
		<div className={"FilesPropertiesModalFacts" satisfies FilesPropertiesModalFacts_ClassNames}>
			<MyModalMonacoEditor
				height={facts_height(lines.length)}
				language="yaml"
				theme={app_monaco_THEME_NAME_DARK}
				value={lines.join("\n")}
				options={FACTS_EDITOR_OPTIONS}
			/>
		</div>
	);
});
// #endregion facts

// #region setting
type FilesPropertiesModalSetting_ClassNames = "FilesPropertiesModalSetting" | "FilesPropertiesModalSetting-info";

type FilesPropertiesModalSetting_Props = {
	/** The setting name. The help button is named "About <label>". */
	label: string;
	/** The id of the tooltip text. The checkbox lists it in `aria-describedby` too. */
	infoId: string;
	info: string;
	/** The `MyCheckboxButton` of the setting. */
	children: ReactNode;
};

/**
 * A setting box with a help button in its top-right corner. Hover or keyboard focus on the button
 * shows the extra text in a tooltip. A click or a tap shows it at once. The tooltip itself never opens
 * on touch, so without the click a phone could not read the text. It closes when the pointer leaves,
 * on Escape, and on a click elsewhere.
 *
 * The button sits outside the checkbox `<label>`. A focusable element inside a label is invalid HTML,
 * and a click on it would toggle the checkbox. It is placed over the label line, so the box keeps its
 * size.
 */
const FilesPropertiesModalSetting = memo(function FilesPropertiesModalSetting(
	props: FilesPropertiesModalSetting_Props,
) {
	const { label, infoId, info, children } = props;

	const [infoOpen, setInfoOpen] = useState(false);

	return (
		<div className={"FilesPropertiesModalSetting" satisfies FilesPropertiesModalSetting_ClassNames}>
			{children}
			<MyTooltip open={infoOpen} setOpen={setInfoOpen}>
				<MyTooltipTrigger>
					<MyIconButton
						variant="ghost"
						className={"FilesPropertiesModalSetting-info" satisfies FilesPropertiesModalSetting_ClassNames}
						aria-label={`About ${label}`}
						aria-describedby={infoId}
						// Only open. A click that closed it would hide the text the hover has just shown.
						onClick={() => setInfoOpen(true)}
					>
						<MyIconButtonIcon>
							<CircleHelp />
						</MyIconButtonIcon>
					</MyIconButton>
				</MyTooltipTrigger>
				{/* Keep the text mounted while hidden, so `aria-describedby` and Playwriter can read it. */}
				<MyTooltipContent id={infoId} unmountOnHide={false}>
					<>{info}</>
				</MyTooltipContent>
			</MyTooltip>
		</div>
	);
});
// #endregion setting

// #region read-only
type FilesPropertiesModalReadOnly_ClassNames =
	| "FilesPropertiesModalReadOnly"
	| "FilesPropertiesModalReadOnly-checkbox"
	| "FilesPropertiesModalReadOnly-error"
	| "FilesPropertiesModalReadOnly-actions";

type FilesPropertiesModalReadOnly_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	nodeKind: "file" | "folder";
	onSaveStateChange: (state: SaveState | null) => void;
};

const FilesPropertiesModalReadOnly = memo(function FilesPropertiesModalReadOnly(
	props: FilesPropertiesModalReadOnly_Props,
) {
	const { nodeId, nodeKind, onSaveStateChange } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const state = useQuery(app_convex_api.files_nodes.read_only_get, { membershipId, nodeId });
	const [draft, setDraft] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [bulkTarget, setBulkTarget] = useState<boolean | null>(null);
	const [startingBulk, setStartingBulk] = useState(false);
	const [bulkResult, setBulkResult] = useState<string | null>(null);
	const cancelBulkRef = useRef<HTMLButtonElement>(null);
	const labelId = useId();
	const descriptionId = useId();
	const infoId = useId();
	const readOnly = draft ?? state?.readOnly ?? false;
	const dirty = state !== undefined && state !== null && readOnly !== state.readOnly;
	const canEdit = state?.canEdit === true;

	const save = useFn(() => {
		if (!canEdit || saving) return Promise.resolve(false);
		setSaving(true);
		setError(null);
		return app_convex
			.mutation(app_convex_api.files_nodes.read_only_set, {
				membershipId,
				nodeId,
				readOnly,
			})
			.then((result) => {
				if (result._nay) {
					setError(result._nay.message);
					return false;
				}
				setDraft(null);
				return true;
			})
			.catch((error) => {
				console.error("[FilesPropertiesModalReadOnly.save] Failed to change Read-only", { error, nodeId });
				setError("Read-only was not changed. Try again.");
				return false;
			})
			.finally(() => setSaving(false));
	});

	useEffect(() => {
		onSaveStateChange({ dirty, invalid: dirty && !canEdit, readOnly, save });
	}, [dirty, canEdit, readOnly, save, onSaveStateChange]);

	const startBulk = useFn(() => {
		if (bulkTarget === null || startingBulk || !canEdit) return;
		setStartingBulk(true);
		setError(null);
		setBulkResult(null);
		void app_convex
			.mutation(app_convex_api.files_write_policy_runs.start, {
				membershipId,
				nodeId,
				targetReadOnly: bulkTarget,
			})
			.then((result) => {
				if (result._nay) {
					setError(result._nay.message);
					return;
				}
				setBulkResult("Updating Read-only in the background. Track it in Activity.");
				setBulkTarget(null);
			})
			.catch((error) => {
				console.error("[FilesPropertiesModalReadOnly.startBulk] Failed to start Read-only changes", { error, nodeId });
				setError("Read-only changes did not start. Try again.");
			})
			.finally(() => setStartingBulk(false));
	});

	// Say first why the box is off, when it is.
	const info = [
		canEdit
			? null
			: state === null
				? "This setting is not available for this item."
				: "You need Can edit permission to change this.",
		"Plugins and API keys with the Manage Read-only permission can still make changes. Changes already in progress may still finish.",
	]
		.filter((sentence) => sentence !== null)
		.join(" ");

	return (
		<div className={"FilesPropertiesModalReadOnly" satisfies FilesPropertiesModalReadOnly_ClassNames}>
			{/* The description never changes. Why the box is off, and the details few people need, go in
			    the help tooltip. */}
			<FilesPropertiesModalSetting label="Read-only" infoId={infoId} info={info}>
				<MyCheckboxButton
					className={"FilesPropertiesModalReadOnly-checkbox" satisfies FilesPropertiesModalReadOnly_ClassNames}
					variant="outline"
					checked={readOnly}
					disabled={!canEdit}
					aria-labelledby={labelId}
					aria-describedby={`${descriptionId} ${infoId}`}
					aria-busy={saving || undefined}
					onCheckedChange={(checked) => {
						// Keep the focused input enabled while saving, but ignore another change.
						if (saving) return;
						setDraft(checked);
						setError(null);
					}}
				>
					<MyCheckboxButtonContent>
						<MyCheckboxButtonLabel id={labelId}>Read-only</MyCheckboxButtonLabel>
						<MyCheckboxButtonDescription id={descriptionId}>
							{nodeKind === "folder"
								? "Stops normal changes to this folder, like adding or removing items in it. Items inside keep their own setting."
								: "Stops normal changes to this file."}
							{" Anyone with Can edit can turn this off."}
						</MyCheckboxButtonDescription>
					</MyCheckboxButtonContent>
				</MyCheckboxButton>
			</FilesPropertiesModalSetting>
			{nodeKind === "folder" ? (
				<div className={"FilesPropertiesModalReadOnly-actions" satisfies FilesPropertiesModalReadOnly_ClassNames}>
					<MyButton variant="outline" disabled={!canEdit || startingBulk} onClick={() => setBulkTarget(true)}>
						Make contents Read-only
					</MyButton>
					<MyButton variant="outline" disabled={!canEdit || startingBulk} onClick={() => setBulkTarget(false)}>
						Clear Read-only from contents
					</MyButton>
				</div>
			) : null}
			{bulkResult ? <p role="status">{bulkResult}</p> : null}
			{error && bulkTarget === null ? (
				<p
					role="alert"
					className={"FilesPropertiesModalReadOnly-error" satisfies FilesPropertiesModalReadOnly_ClassNames}
				>
					{error}
				</p>
			) : null}
			<MyModal
				open={bulkTarget !== null}
				setOpen={(open) => {
					if (!open && !startingBulk) setBulkTarget(null);
				}}
			>
				<MyModalPopover initialFocus={cancelBulkRef}>
					<MyModalHeader>
						<MyModalHeading>
							{bulkTarget ? "Make contents Read-only?" : "Clear Read-only from contents?"}
						</MyModalHeading>
						<MyModalDescription>
							This changes the current contents you can edit. It does not change this folder's own setting.
						</MyModalDescription>
					</MyModalHeader>
					<MyModalScrollableArea>
						<p>
							This checks the contents as it runs. It may miss items added or moved during the run. Changes already made
							stay if you stop. There is no Undo.
						</p>
						{bulkTarget === false ? <p>This also clears Read-only settings set by hand.</p> : null}
						{error ? <p role="alert">{error}</p> : null}
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton ref={cancelBulkRef} variant="ghost" disabled={startingBulk} onClick={() => setBulkTarget(null)}>
							Cancel
						</MyButton>
						<MyButton disabled={startingBulk} aria-busy={startingBulk || undefined} onClick={() => void startBulk()}>
							{startingBulk ? "Starting…" : "Start"}
						</MyButton>
					</MyModalFooter>
					<MyModalCloseTrigger disabled={startingBulk} />
				</MyModalPopover>
			</MyModal>
		</div>
	);
});
// #endregion read-only

// #region collaboration
type FilesPropertiesModalCollaboration_ClassNames =
	| "FilesPropertiesModalCollaboration"
	| "FilesPropertiesModalCollaboration-setting"
	| "FilesPropertiesModalCollaboration-checkbox"
	| "FilesPropertiesModalCollaboration-description"
	| "FilesPropertiesModalCollaboration-confirm-modal"
	| "FilesPropertiesModalCollaboration-confirm-body"
	| "FilesPropertiesModalCollaboration-confirm-text"
	| "FilesPropertiesModalCollaboration-error";

type FilesPropertiesModalCollaboration_Props = {
	nodeId: app_convex_Id<"files_nodes">;
};

/**
 * One checkbox that turns the shared editing document of a text file on or off.
 *
 * On means the file has a Yjs document: several people type at once, the edits merge, and comments
 * stay attached to the words they were written on. Off means the file is one saved text: an editor
 * replaces the whole file when it saves. The last save wins.
 *
 * Turning it on is safe, so the box writes straight away. Turning it off cannot be undone, so the
 * box does not write. It opens the confirm step below, which names what the file loses.
 *
 * This section owns its `<section>` element, unlike the other sections. Only a text file can be
 * collaborative, and whether this file is one is known only after the node query answers. A wrapper
 * in the root would already have drawn its divider line by then, and an image would show an empty
 * strip.
 */
const FilesPropertiesModalCollaboration = memo(function FilesPropertiesModalCollaboration(
	props: FilesPropertiesModalCollaboration_Props,
) {
	const { nodeId } = props;

	const { membershipId } = AppTenantProvider.useContext();
	const labelId = useId();
	const descriptionId = useId();
	const reasonId = useId();
	const confirmTextId = useId();
	const checkboxRef = useRef<HTMLInputElement>(null);
	const cancelOffRef = useRef<HTMLButtonElement>(null);
	const [isRunning, setIsRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isConfirmingOff, setIsConfirmingOff] = useState(false);

	const node = useQuery(app_convex_api.files_tree.get_file_node_for_membership, { membershipId, fileNodeId: nodeId });
	const canWrite = useQuery(app_convex_api.files_tree.get_current_user_file_write_permission, {
		membershipId,
		nodeId,
	});
	const cleanupBlocksCollaboration = useQuery(app_convex_api.files_nodes_content.get_file_collaboration_cleanup_state, {
		membershipId,
		nodeId,
	});

	const isCollaborative = node?.collaborationEnabled === true;
	const blockedReason =
		canWrite === false
			? node?.writeBlockedReason === "read_only"
				? "Turn off Read-only to change this."
				: "You need Can edit permission to change this."
			: null;
	const canToggle = canWrite === true;

	const runToggle = (collaborative: boolean) => {
		setError(null);
		setIsRunning(true);

		Promise.try(() =>
			collaborative
				? app_convex.action(app_convex_api.files_nodes_content.set_file_collaborative, { membershipId, nodeId })
				: app_convex.mutation(app_convex_api.files_nodes_content.set_file_non_collaborative, {
						membershipId,
						nodeId,
						acknowledgeDropCollaborativeHistory: true,
					}),
		)
			.then((result) => {
				if (result._nay) {
					setError(result._nay.message);
					return;
				}

				checkboxRef.current?.focus();
				setIsConfirmingOff(false);
			})
			.catch((caughtError: unknown) => {
				console.error("[FilesPropertiesModalCollaboration.runToggle] Failed to change collaboration", {
					error: caughtError,
					nodeId,
				});
				setError("Failed to change collaboration");
			})
			.finally(() => {
				setIsRunning(false);
			});
	};

	const handleCheckedChange = useFn((checked: boolean) => {
		if (isRunning || !canToggle) {
			return;
		}

		setError(null);

		// Turning it on loses nothing, so it needs no confirm step. Turning it off deletes the shared
		// edit history and the comment marks, so it asks first.
		if (checked) {
			runToggle(true);
		} else {
			setIsConfirmingOff(true);
		}
	});

	const handleConfirmOff = useFn(() => {
		if (isRunning) {
			return;
		}

		runToggle(false);
	});

	const handleOffOpenChange = useFn((open: boolean) => {
		// Escape and the backdrop cannot close the dialog while the change is being written.
		if (!open && !isRunning) {
			setIsConfirmingOff(false);
		}
	});

	// The node is still loading, is gone, or this member may not read it. The policy section above
	// already reports that, so render nothing here.
	if (node === undefined || node === null) {
		return null;
	}

	// Only editable text can carry a collaborative document. An image or another stored blob has no
	// mode to choose, so it gets no section at all.
	if (!files_node_has_editable_text_content(node)) {
		return null;
	}

	return (
		<section
			aria-label="Collaboration"
			className={cn(
				"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames,
				"FilesPropertiesModalCollaboration" satisfies FilesPropertiesModalCollaboration_ClassNames,
			)}
		>
			{/* The description never changes. While the box is off, hovering it shows why, like the billing
			    tooltips in the header. The tooltip sits on a wrapper, because `MyCheckboxButton` passes its
			    props to the hidden input. */}
			<MyTooltip open={blockedReason ? undefined : false}>
				<MyTooltipTrigger disabled={!blockedReason}>
					<div
						className={
							"FilesPropertiesModalCollaboration-setting" satisfies FilesPropertiesModalCollaboration_ClassNames
						}
					>
						<MyCheckboxButton
							ref={checkboxRef}
							className={
								"FilesPropertiesModalCollaboration-checkbox" satisfies FilesPropertiesModalCollaboration_ClassNames
							}
							variant="outline"
							checked={isCollaborative}
							// Do not disable this while the write runs, or the
							// browser throws a keyboard user out of the dialog. `handleCheckedChange` ignores a second
							// press instead.
							disabled={!canToggle}
							aria-labelledby={labelId}
							aria-describedby={blockedReason ? `${descriptionId} ${reasonId}` : descriptionId}
							aria-busy={isRunning || undefined}
							onCheckedChange={handleCheckedChange}
						>
							<MyCheckboxButtonContent>
								<MyCheckboxButtonLabel id={labelId}>Collaborative editing</MyCheckboxButtonLabel>
								<MyCheckboxButtonDescription id={descriptionId}>
									Edit with your teammates in real time and see what they are editing.
								</MyCheckboxButtonDescription>
							</MyCheckboxButtonContent>
						</MyCheckboxButton>
					</div>
				</MyTooltipTrigger>
				{/* Keep the reason mounted while hidden, so `aria-describedby` and Playwriter can read it. */}
				<MyTooltipContent id={reasonId} unmountOnHide={false}>
					<>{blockedReason}</>
				</MyTooltipContent>
			</MyTooltip>

			{cleanupBlocksCollaboration === true ? (
				<p
					className={
						"FilesPropertiesModalCollaboration-description" satisfies FilesPropertiesModalCollaboration_ClassNames
					}
					role="status"
				>
					Old edit history is being removed. You can turn collaboration on after cleanup finishes.
				</p>
			) : null}

			{/* Turning collaboration off deletes data, so it asks in its own dialog. Start on Cancel, the safe
			    choice. */}
			<MyModal open={isConfirmingOff} setOpen={handleOffOpenChange}>
				<MyModalPopover
					className={
						"FilesPropertiesModalCollaboration-confirm-modal" satisfies FilesPropertiesModalCollaboration_ClassNames
					}
					initialFocus={cancelOffRef}
					aria-describedby={confirmTextId}
				>
					<MyModalHeader>
						<MyModalHeading>Turn collaboration off?</MyModalHeading>
					</MyModalHeader>
					<MyModalScrollableArea>
						<div
							className={
								"FilesPropertiesModalCollaboration-confirm-body" satisfies FilesPropertiesModalCollaboration_ClassNames
							}
						>
							<p
								id={confirmTextId}
								className={
									"FilesPropertiesModalCollaboration-confirm-text" satisfies FilesPropertiesModalCollaboration_ClassNames
								}
							>
								The edit history and comment marks are removed for everyone. Comments and saved versions are kept.
							</p>
							{/* A failed write keeps this dialog open, so show the error here, not behind it. */}
							{error ? (
								<p
									className={
										"FilesPropertiesModalCollaboration-error" satisfies FilesPropertiesModalCollaboration_ClassNames
									}
									role="alert"
								>
									{error}
								</p>
							) : null}
						</div>
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton ref={cancelOffRef} variant="ghost" disabled={isRunning} onClick={() => setIsConfirmingOff(false)}>
							Cancel
						</MyButton>
						<MyButton
							variant="destructive"
							disabled={isRunning}
							aria-busy={isRunning || undefined}
							onClick={handleConfirmOff}
						>
							{isRunning ? "Turning off..." : "Turn collaboration off"}
						</MyButton>
					</MyModalFooter>
					<MyModalCloseTrigger disabled={isRunning} />
				</MyModalPopover>
			</MyModal>

			{error && !isConfirmingOff ? (
				<p
					className={"FilesPropertiesModalCollaboration-error" satisfies FilesPropertiesModalCollaboration_ClassNames}
					role="alert"
				>
					{error}
				</p>
			) : null}
		</section>
	);
});
// #endregion collaboration

// #region metadata
type FilesPropertiesModalMetadata_ClassNames =
	| "FilesPropertiesModalMetadata"
	| "FilesPropertiesModalMetadata-header"
	| "FilesPropertiesModalMetadata-heading"
	| "FilesPropertiesModalMetadata-description"
	| "FilesPropertiesModalMetadata-help"
	| "FilesPropertiesModalMetadata-editor"
	| "FilesPropertiesModalMetadata-skeleton"
	| "FilesPropertiesModalMetadata-placeholder"
	| "FilesPropertiesModalMetadata-limits"
	| "FilesPropertiesModalMetadata-actions"
	| "FilesPropertiesModalMetadata-status"
	| "FilesPropertiesModalMetadata-status-error";

type FilesPropertiesModalMetadata_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	/**
	 * Report the unsaved draft and how to save it. The footer Save button uses this, and the footer
	 * warns before the dialog is closed, because closing throws the draft away.
	 */
	onSaveStateChange: (saveState: SaveState | null) => void;
};

/**
 * Example lines shown in the empty editor. Monaco has no placeholder option, so the section draws
 * this text over the editor while the draft is empty.
 */
const METADATA_PLACEHOLDER =
	"Write one field per line, like this:\nowner: Jane Doe\nbudget: 5000\ndue-date: 2026-03-05\napproved: true";

type FilesPropertiesModalMetadata_State = {
	draftYaml: string;
	serverYaml: string;
	/**
	 * False until the stored map has been read once. Monaco is created from `value`, so the editor
	 * must not mount before the draft holds the stored YAML. Filling it afterwards would show an
	 * empty field for one frame and put that fill in the editor's own undo history.
	 */
	loaded: boolean;
	feedback: { kind: "conflict" | "error" | "success"; message: string } | null;
};

const FilesPropertiesModalMetadata = memo(function FilesPropertiesModalMetadata(
	props: FilesPropertiesModalMetadata_Props,
) {
	const { nodeId, onSaveStateChange } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const entries = useQuery(app_convex_api.files_metadata.get_entries, { membershipId, fileNodeId: nodeId });
	const canWrite = useQuery(app_convex_api.files_tree.get_current_user_file_write_permission, {
		membershipId,
		nodeId,
	});
	const node = useQuery(app_convex_api.files_tree.get_file_node_for_membership, { membershipId, fileNodeId: nodeId });

	// YAML is only the edit format. The stored map is the source of truth, so the section always
	// re-renders it from the entries instead of keeping the exact text somebody typed.
	const serverYaml = entries === undefined ? undefined : files_metadata_stringify_entries_yaml(entries);

	// Convex answers from its cache when the query is already subscribed, so the stored map can be
	// here on the first render. Take it now, and the editor mounts on the real text with no extra
	// paint. When it is not here yet, the effect below fills this in and the skeleton holds.
	const [metadata, setMetadata] = useState<FilesPropertiesModalMetadata_State>(() => ({
		draftYaml: serverYaml ?? "",
		serverYaml: serverYaml ?? "",
		loaded: serverYaml !== undefined,
		feedback: null,
	}));
	const [saving, setSaving] = useState(false);
	// The placeholder waits for this. Until Monaco is ready, the editor's loading skeleton is on screen.
	const [editorMounted, setEditorMounted] = useState(false);
	const editorRef = useRef<monaco_editor.IStandaloneCodeEditor | null>(null);
	// The exact text of the last draft this section sent. The server stores a map, not text, so what
	// comes back is the map rendered again. It rarely matches character for character. The editor
	// uses CRLF, a comment is not stored, and `4.0` comes back quoted. Remember the text that was
	// sent, so the effect below can tell the server sending our own save back apart from a real edit
	// by somebody else.
	const sentDraftRef = useRef<string | null>(null);

	const editable = canWrite === true;
	const dirty = metadata.draftYaml !== metadata.serverYaml;
	const draftBytes = files_get_utf8_byte_size(metadata.draftYaml);
	const statusId = useId();
	// Show the permission reason first when permission and the lock both block writing, so the
	// section matches the order the server checks them in.
	const blockedReason =
		canWrite === false
			? node?.writeBlockedReason === "read_only"
				? "This item is read-only, so its metadata cannot be changed."
				: "You don't have permission to change this item's metadata."
			: null;

	// Keep construction-only Monaco options stable because @monaco-editor/react deep-clones option updates.
	const [editorOptions] = useState(() => {
		return {
			ariaLabel: "Metadata YAML",
			// Let Tab move focus out to the footer instead of typing a tab character. Monaco traps Tab
			// by default, which leaves a keyboard user stuck inside this small field, and YAML cannot
			// use tabs for indentation anyway.
			tabFocusMode: true,
			automaticLayout: true,
			fontSize: 16,
			lineHeight: 22,
			minimap: { enabled: false },
			lineNumbers: "off",
			// Start the text 14px from the left and draw no gutter. The placeholder is placed at the same 14px.
			lineDecorationsWidth: 14,
			folding: false,
			glyphMargin: false,
			padding: { top: 10, bottom: 10 },
			scrollBeyondLastLine: false,
			wordWrap: "on",
		} satisfies NonNullable<EditorProps["options"]>;
	});

	const handleOnMount = useFn<EditorProps["onMount"]>((editor) => {
		editorRef.current = editor;
		editor.updateOptions({ readOnly: saving || !editable });
		setEditorMounted(true);
	});

	const handleChange = useFn<EditorProps["onChange"]>((value) => {
		const draftYaml = value ?? "";
		// The editor no longer holds the draft that was sent, so a later server change is somebody
		// else's edit and has to warn instead of being adopted.
		if (draftYaml !== sentDraftRef.current) {
			sentDraftRef.current = null;
		}

		setMetadata((current) => ({
			...current,
			draftYaml,
			// Keep a conflict warning while the draft still differs from the server, so the user is not
			// told the warning is gone before they resolve it.
			feedback: draftYaml !== current.serverYaml && current.feedback?.kind === "conflict" ? current.feedback : null,
		}));
	});

	const handleSave = useFn(() => {
		// The footer can call this just after an explicit unlock, before the query catches up.
		if (saving || metadata.draftYaml === metadata.serverYaml) {
			return Promise.resolve(false);
		}

		// Parse with the shared parser first, so an invalid draft does not spend a write rate-limit
		// token. The `set_entries` mutation runs the same parser on the server.
		const parsed = files_metadata_parse_entries_yaml(metadata.draftYaml);
		if (parsed._nay) {
			setMetadata((current) => ({ ...current, feedback: { kind: "error", message: parsed._nay.message } }));
			toast.error(parsed._nay.message);
			return Promise.resolve(false);
		}

		const yamlToSave = metadata.draftYaml;
		const serverYamlBeforeSave = metadata.serverYaml;
		// Mark the draft as sent before the call, because the reactive query can push the saved map
		// back before this promise settles.
		sentDraftRef.current = yamlToSave;
		setSaving(true);
		setMetadata((current) => ({ ...current, feedback: null }));
		return app_convex
			.mutation(app_convex_api.files_metadata.set_entries, {
				membershipId,
				fileNodeId: nodeId,
				metadataYaml: yamlToSave,
			})
			.then((result) => {
				if (result._nay) {
					// The write did not land, so a later server change is somebody else's edit, not the
					// server sending our own save back.
					sentDraftRef.current = null;
					// Some refusals end with a period and some do not, so add one only when it is missing.
					const reason = result._nay.message.endsWith(".") ? result._nay.message : `${result._nay.message}.`;
					setMetadata((current) => ({
						...current,
						feedback:
							current.serverYaml !== serverYamlBeforeSave
								? {
										kind: "conflict",
										message: `${reason} Metadata also changed elsewhere. Review this draft before saving again.`,
									}
								: { kind: "error", message: result._nay.message },
					}));
					toast.error(result._nay.message);
					return false;
				}

				// The reactive query pushes the saved map back, and the effect below is what really
				// updates `draftYaml` and `serverYaml`. Only report the result here, and only with the
				// updater form of `setMetadata`. Writing a whole new state object here would undo that
				// effect when the query push and this promise arrive in the same React update. The draft
				// still counts as saved when the effect already replaced it with the server's own YAML.
				setMetadata((current) => ({
					...current,
					feedback:
						current.draftYaml === yamlToSave || current.draftYaml === current.serverYaml
							? { kind: "success", message: "Metadata saved" }
							: {
									kind: "conflict",
									message: "An earlier draft was saved. Review the current draft before saving again.",
								},
				}));

				return true;
			})
			.catch((error: unknown) => {
				sentDraftRef.current = null;
				console.error("[FilesPropertiesModalMetadata.handleSave] Failed to save file metadata", {
					error,
					fileNodeId: nodeId,
				});
				setMetadata((current) => ({
					...current,
					feedback: { kind: "error", message: "Failed to save metadata" },
				}));
				toast.error("Failed to save metadata");

				return false;
			})
			.finally(() => {
				setSaving(false);
			});
	});

	// readOnly cannot live in `editorOptions`, which is frozen at construction, so push it to the
	// editor handle instead.
	useEffect(() => {
		editorRef.current?.updateOptions({ readOnly: saving || !editable });
	}, [saving, editable]);

	useEffect(() => {
		onSaveStateChange({ dirty, invalid: dirty && !editable, save: handleSave });
	}, [dirty, editable, handleSave, onSaveStateChange]);

	useEffect(() => {
		if (serverYaml === undefined) {
			return;
		}

		setMetadata((current) => {
			// A file with no metadata renders as the same empty text the state starts with, so check
			// `loaded` too. Without it that file would never leave the skeleton.
			if (serverYaml === current.serverYaml && current.loaded) {
				return current;
			}

			// Nothing was typed yet, so follow the server.
			if (current.draftYaml === current.serverYaml) {
				return { draftYaml: serverYaml, serverYaml, loaded: true, feedback: null };
			}

			// The draft already says what the server now says, so a conflict warning is resolved. Keep
			// any other message. A save whose text came back unchanged also lands here, and its
			// "Metadata saved" must survive.
			if (current.draftYaml === serverYaml) {
				return { ...current, serverYaml, feedback: current.feedback?.kind === "conflict" ? null : current.feedback };
			}

			// This is the server's own rendering of the draft this section just sent, and nothing was typed
			// since. Adopt it so the editor shows the stored map and Save goes back to disabled. Never write
			// `sentDraftRef` here: React can run an updater more than once, and the second run would take
			// the conflict branch below.
			if (current.draftYaml === sentDraftRef.current) {
				return { draftYaml: serverYaml, serverYaml, loaded: true, feedback: current.feedback };
			}

			// Somebody else (another tab, or the chat agent) changed the metadata while this draft was
			// open. Keep the draft and warn, instead of throwing away what the user typed.
			return {
				...current,
				serverYaml,
				feedback: {
					kind: "conflict",
					message: "Metadata changed elsewhere. Review this draft before saving it over the newer version.",
				},
			};
		});
	}, [serverYaml]);

	return (
		<div className={"FilesPropertiesModalMetadata" satisfies FilesPropertiesModalMetadata_ClassNames}>
			{/* The heading and the description stack in the first column. The help button sits in the top
			    right corner and spans both rows, so it does not make any row taller. */}
			<div className={"FilesPropertiesModalMetadata-header" satisfies FilesPropertiesModalMetadata_ClassNames}>
				<h3
					className={cn(
						"FilesPropertiesModalMetadata-heading" satisfies FilesPropertiesModalMetadata_ClassNames,
						"FilesPropertiesModal-section-heading" satisfies FilesPropertiesModal_ClassNames,
					)}
				>
					Metadata
				</h3>
				<p className={"FilesPropertiesModalMetadata-description" satisfies FilesPropertiesModalMetadata_ClassNames}>
					Add your own fields to this item. Select the help button to see how.
				</p>
				<div className={"FilesPropertiesModalMetadata-help" satisfies FilesPropertiesModalMetadata_ClassNames}>
					<FilesPropertiesModalMetadataHelp />
				</div>
			</div>

			<div className={"FilesPropertiesModalMetadata-editor" satisfies FilesPropertiesModalMetadata_ClassNames}>
				{metadata.loaded ? (
					<MyModalMonacoEditor
						height="160px"
						// Monaco needs a moment after mount to create the editor. Show the same skeleton in
						// that gap, so the default "Loading..." text never flashes.
						loading={
							<MySkeleton
								className={"FilesPropertiesModalMetadata-skeleton" satisfies FilesPropertiesModalMetadata_ClassNames}
							/>
						}
						language="yaml"
						theme={app_monaco_THEME_NAME_DARK}
						value={metadata.draftYaml}
						options={editorOptions}
						onMount={handleOnMount}
						onChange={handleChange}
					/>
				) : (
					<MySkeleton
						className={"FilesPropertiesModalMetadata-skeleton" satisfies FilesPropertiesModalMetadata_ClassNames}
					/>
				)}

				{/* A read-only item cannot be typed in, so an example would only mislead. */}
				{editorMounted && editable && metadata.draftYaml === "" ? (
					<div
						className={"FilesPropertiesModalMetadata-placeholder" satisfies FilesPropertiesModalMetadata_ClassNames}
						aria-hidden
					>
						{METADATA_PLACEHOLDER}
					</div>
				) : null}
			</div>

			<p
				className={"FilesPropertiesModalMetadata-limits" satisfies FilesPropertiesModalMetadata_ClassNames}
				data-metadata-yaml-bytes={draftBytes}
			>
				YAML: {draftBytes.toLocaleString()} of {files_metadata_MAX_YAML_BYTES.toLocaleString()} bytes. Text values: up
				to {files_metadata_MAX_STRING_VALUE_BYTES.toLocaleString()} bytes each. Some letters use more than one byte.
			</p>

			<div className={"FilesPropertiesModalMetadata-actions" satisfies FilesPropertiesModalMetadata_ClassNames}>
				{(metadata.feedback ?? blockedReason) ? (
					<p
						id={statusId}
						className={cn(
							"FilesPropertiesModalMetadata-status" satisfies FilesPropertiesModalMetadata_ClassNames,
							metadata.feedback && metadata.feedback.kind !== "success"
								? ("FilesPropertiesModalMetadata-status-error" satisfies FilesPropertiesModalMetadata_ClassNames)
								: undefined,
						)}
						role={metadata.feedback && metadata.feedback.kind !== "success" ? "alert" : "status"}
					>
						{metadata.feedback?.message ?? blockedReason}
					</p>
				) : null}
			</div>
		</div>
	);
});
// #endregion metadata

// #region metadata help
type FilesPropertiesModalMetadataHelp_ClassNames =
	| "FilesPropertiesModalMetadataHelp"
	| "FilesPropertiesModalMetadataHelp-text"
	| "FilesPropertiesModalMetadataHelp-heading"
	| "FilesPropertiesModalMetadataHelp-table"
	| "FilesPropertiesModalMetadataHelp-example"
	| "FilesPropertiesModalMetadataHelp-list"
	| "FilesPropertiesModalMetadataHelp-rule"
	| "FilesPropertiesModalMetadataHelp-rule-do"
	| "FilesPropertiesModalMetadataHelp-rule-dont";

/**
 * The YAML samples the help dialog shows, colored like the metadata editor.
 */
const METADATA_HELP_SAMPLES = {
	template: "key: value",
	text: "owner: Jane Doe",
	number: "budget: 5000",
	date: "due-date: 2026-03-05",
	boolean: "approved: true",
	example: "owner: Jane Doe\nbudget: 5000\ndue-date: 2026-03-05\napproved: true",
	keyDo: "task-status: in progress",
	keyDont: "task status: in progress",
	dateDo: "due-date: 2026-03-05",
	dateDontDigits: "due-date: 2026-3-5",
	dateDontSlashes: "due-date: 05/03/2026",
};

/**
 * One row per value type, each with its sample from `METADATA_HELP_SAMPLES`.
 */
const METADATA_HELP_TYPES = [
	["Text", "text"],
	["Number", "number"],
	["Date", "date"],
	["True/false", "boolean"],
] as const;

/**
 * Search box filters that work on metadata. See `shared/files-search-query.ts` for the language.
 */
const METADATA_HELP_SEARCHES = [
	["metadata.status:done", "Status is done"],
	['metadata.owner:"Jane Doe"', "Quote a value with spaces"],
	["metadata.due-date:<2026-11-01", "Due before November 2026"],
	["metadata.owner:*", "Has an owner"],
] as const;

/**
 * A help button that opens a second dialog on top of the Properties dialog. It explains the metadata
 * format with short examples, so the section itself can keep one short line.
 *
 * Keep the rules here in step with `shared/files-metadata.ts`: the key characters, the value types,
 * and the date format that search can compare.
 */
const FilesPropertiesModalMetadataHelp = memo(function FilesPropertiesModalMetadataHelp() {
	const [open, setOpen] = useState(false);
	const [samplesHtml, setSamplesHtml] = useState<Record<keyof typeof METADATA_HELP_SAMPLES, string> | null>(null);

	// Show each sample as its own `code` element. Use Monaco's colored HTML once it is ready, and the
	// plain text before that.
	const sample = (name: keyof typeof METADATA_HELP_SAMPLES) =>
		samplesHtml ? (
			// The HTML comes from Monaco, which escapes the text. The text is the constant above.
			<code dangerouslySetInnerHTML={{ __html: samplesHtml[name] }} />
		) : (
			<code>{METADATA_HELP_SAMPLES[name]}</code>
		);

	const rule = (doName: keyof typeof METADATA_HELP_SAMPLES, ...dontNames: (keyof typeof METADATA_HELP_SAMPLES)[]) => (
		<>
			<span
				className={cn(
					"FilesPropertiesModalMetadataHelp-rule" satisfies FilesPropertiesModalMetadataHelp_ClassNames,
					"FilesPropertiesModalMetadataHelp-rule-do" satisfies FilesPropertiesModalMetadataHelp_ClassNames,
				)}
			>
				<Check role="img" aria-label="Correct" />
				{sample(doName)}
			</span>
			{dontNames.map((dontName) => (
				<span
					key={dontName}
					className={cn(
						"FilesPropertiesModalMetadataHelp-rule" satisfies FilesPropertiesModalMetadataHelp_ClassNames,
						"FilesPropertiesModalMetadataHelp-rule-dont" satisfies FilesPropertiesModalMetadataHelp_ClassNames,
					)}
				>
					<X role="img" aria-label="Wrong" />
					{sample(dontName)}
				</span>
			))}
		</>
	);

	// Color the samples with Monaco's own YAML tokenizer and the app theme, so they match the editor.
	// Start while the dialog is still closed, so the samples are already colored when it opens.
	useEffect(() => {
		let cancelled = false;

		Promise.all(
			Object.entries(METADATA_HELP_SAMPLES).map(([name, text]) =>
				// Monaco ends every line with `<br/>`. Drop the last one, or an inline sample breaks the line.
				monaco_editor.colorize(text, "yaml", {}).then((html) => [name, html.replace(/<br\/>$/, "")] as const),
			),
		)
			.then((entries) => {
				if (!cancelled) {
					setSamplesHtml(Object.fromEntries(entries) as Record<keyof typeof METADATA_HELP_SAMPLES, string>);
				}
			})
			.catch((error: unknown) => {
				console.error("[FilesPropertiesModalMetadataHelp] Failed to color the samples", { error });
			});

		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<>
			<MyIconButton variant="ghost" tooltip="How metadata works" aria-haspopup="dialog" onClick={() => setOpen(true)}>
				<MyIconButtonIcon>
					<CircleHelp />
				</MyIconButtonIcon>
			</MyIconButton>

			<MyModal open={open} setOpen={setOpen}>
				<MyModalPopover
					className={"FilesPropertiesModalMetadataHelp" satisfies FilesPropertiesModalMetadataHelp_ClassNames}
				>
					<MyModalHeader>
						<MyModalHeading>How metadata works</MyModalHeading>
					</MyModalHeader>

					<MyModalScrollableArea>
						<p
							className={"FilesPropertiesModalMetadataHelp-text" satisfies FilesPropertiesModalMetadataHelp_ClassNames}
						>
							Metadata is a set of key-value fields on a file or folder. Write one field per line, as{" "}
							{sample("template")}. Saving replaces all fields, so a deleted line is removed.
						</p>

						<h3
							className={
								"FilesPropertiesModalMetadataHelp-heading" satisfies FilesPropertiesModalMetadataHelp_ClassNames
							}
						>
							Values
						</h3>
						<dl
							className={"FilesPropertiesModalMetadataHelp-table" satisfies FilesPropertiesModalMetadataHelp_ClassNames}
						>
							{METADATA_HELP_TYPES.map(([label, name]) => (
								<Fragment key={name}>
									<dt>{label}</dt>
									<dd>{sample(name)}</dd>
								</Fragment>
							))}
						</dl>
						<h3
							className={
								"FilesPropertiesModalMetadataHelp-heading" satisfies FilesPropertiesModalMetadataHelp_ClassNames
							}
						>
							Example
						</h3>
						<pre
							className={
								"FilesPropertiesModalMetadataHelp-example" satisfies FilesPropertiesModalMetadataHelp_ClassNames
							}
						>
							{sample("example")}
						</pre>

						<h3
							className={
								"FilesPropertiesModalMetadataHelp-heading" satisfies FilesPropertiesModalMetadataHelp_ClassNames
							}
						>
							Rules
						</h3>
						<ul
							className={"FilesPropertiesModalMetadataHelp-list" satisfies FilesPropertiesModalMetadataHelp_ClassNames}
						>
							<li>
								Keys have no spaces.
								{rule("keyDo", "keyDont")}
							</li>
							<li>
								Text values can use up to {files_metadata_MAX_STRING_VALUE_BYTES.toLocaleString()} bytes each. Some
								letters use more than one byte. The whole YAML map can use up to{" "}
								{files_metadata_MAX_YAML_BYTES.toLocaleString()} bytes, including keys and quotes. Both the typed YAML
								and its saved form must fit. Long values stay complete when saved.
							</li>
							<li>
								Write dates as <code>YYYY-MM-DD</code> (year, month, day). Search can only compare dates written this
								way.
								{rule("dateDo", "dateDontDigits", "dateDontSlashes")}
							</li>
						</ul>

						<h3
							className={
								"FilesPropertiesModalMetadataHelp-heading" satisfies FilesPropertiesModalMetadataHelp_ClassNames
							}
						>
							Search
						</h3>
						<p
							className={"FilesPropertiesModalMetadataHelp-text" satisfies FilesPropertiesModalMetadataHelp_ClassNames}
						>
							Find items by their fields in the Files search box:
						</p>
						<dl
							className={"FilesPropertiesModalMetadataHelp-table" satisfies FilesPropertiesModalMetadataHelp_ClassNames}
						>
							{METADATA_HELP_SEARCHES.map(([query, meaning]) => (
								<Fragment key={query}>
									<dt>
										<code>{query}</code>
									</dt>
									<dd>{meaning}</dd>
								</Fragment>
							))}
						</dl>
					</MyModalScrollableArea>

					<MyModalFooter>
						<MyButton variant="ghost" onClick={() => setOpen(false)}>
							Done
						</MyButton>
					</MyModalFooter>
					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		</>
	);
});
// #endregion metadata help

// #region skeleton
type FilesPropertiesModalSkeleton_ClassNames =
	| "FilesPropertiesModalSkeleton-general"
	| "FilesPropertiesModalSkeleton-protection"
	| "FilesPropertiesModalSkeleton-collaboration"
	| "FilesPropertiesModalSkeleton-metadata";

type FilesPropertiesModalSkeleton_Props = {
	nodeKind: "file" | "folder";
};

/**
 * A rough copy of the modal body: one block per section, with about the same height.
 *
 * Keep it in step with the sections above. When a section is added, removed, or changes its size a
 * lot, update the matching block in this region and its CSS.
 */
const FilesPropertiesModalSkeleton = memo(function FilesPropertiesModalSkeleton(
	props: FilesPropertiesModalSkeleton_Props,
) {
	const { nodeKind } = props;

	return (
		<>
			<section className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}>
				<MySkeleton
					className={"FilesPropertiesModalSkeleton-general" satisfies FilesPropertiesModalSkeleton_ClassNames}
				/>
			</section>
			<section className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}>
				<MySkeleton
					className={"FilesPropertiesModalSkeleton-protection" satisfies FilesPropertiesModalSkeleton_ClassNames}
				/>
			</section>
			{nodeKind === "file" ? (
				<section className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}>
					<MySkeleton
						className={"FilesPropertiesModalSkeleton-collaboration" satisfies FilesPropertiesModalSkeleton_ClassNames}
					/>
				</section>
			) : null}
			<section className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}>
				<MySkeleton
					className={"FilesPropertiesModalSkeleton-metadata" satisfies FilesPropertiesModalSkeleton_ClassNames}
				/>
			</section>
		</>
	);
});
// #endregion skeleton

// #region root
type FilesPropertiesModal_ClassNames =
	| "FilesPropertiesModal"
	| "FilesPropertiesModal-body"
	| "FilesPropertiesModal-scrollable-area"
	| "FilesPropertiesModal-section"
	| "FilesPropertiesModal-section-heading"
	| "FilesPropertiesModal-unsaved"
	| "FilesPropertiesModal-footer-spacer"
	| "FilesPropertiesModal-confirm-modal"
	| "FilesPropertiesModal-confirm-text";

/**
 * What a folder list shows of a node the user cannot open. A search match has no size or times, so
 * those lines are left out.
 */
type FilesPropertiesModal_LockedNode = {
	path: string;
	contentType: string | null;
	contentByteSize?: number | null;
	_creationTime?: number;
	updatedAt?: number;
};

export type FilesPropertiesModal_Props = {
	nodeId: app_convex_Id<"files_nodes"> | null;
	nodeName: string;
	nodeKind: "file" | "folder";
	/**
	 * Set for a node the user cannot open. The dialog then shows only these facts and reads nothing.
	 */
	lockedNode?: FilesPropertiesModal_LockedNode | null;
	returnFocusRef?: RefObject<HTMLElement | null>;
	onClose: () => void;
};

export const FilesPropertiesModal = memo(function FilesPropertiesModal(props: FilesPropertiesModal_Props) {
	const { nodeId, nodeName, nodeKind, lockedNode = null, returnFocusRef, onClose } = props;

	const { membershipId } = AppTenantProvider.useContext();
	const [policySaveState, setPolicySaveState] = useState<SaveState | null>(null);
	const [metadataSaveState, setMetadataSaveState] = useState<SaveState | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

	// The sections below read these same queries. Nothing else in the app subscribes to them before
	// the modal opens, so the first answer needs a server round trip. Wait for it here and show the
	// skeleton. Then every section finds its answer already in the Convex cache and draws once,
	// with the right values.
	const readsNode = nodeId !== null && lockedNode === null;
	const node = useQuery(
		app_convex_api.files_tree.get_file_node_for_membership,
		readsNode ? { membershipId, fileNodeId: nodeId } : "skip",
	);
	const managementState = useQuery(
		app_convex_api.files_nodes.read_only_get,
		readsNode ? { membershipId, nodeId } : "skip",
	);
	const metadataEntries = useQuery(
		app_convex_api.files_metadata.get_entries,
		readsNode ? { membershipId, fileNodeId: nodeId } : "skip",
	);
	const loading =
		lockedNode === null && (node === undefined || managementState === undefined || metadataEntries === undefined);

	const saveStates = [policySaveState, metadataSaveState];
	const dirty = saveStates.some((saveState) => saveState?.dirty);
	const clearingReadOnly = policySaveState?.dirty && policySaveState.readOnly === false;
	const invalid = policySaveState?.invalid || (metadataSaveState?.invalid && !clearingReadOnly);

	const handleSave = useFn(() => {
		if (saving || !dirty || invalid) return;
		setSaving(true);
		setSaveFeedback(null);
		// Unlock before metadata; lock only after metadata succeeds.
		const ordered = clearingReadOnly ? [policySaveState, metadataSaveState] : [metadataSaveState, policySaveState];
		let savedSection: "metadata" | "read_only" | null = null;
		void (async () => {
			for (const section of ordered) {
				if (!section?.dirty) continue;
				if (!(await section.save())) {
					if (savedSection !== null) {
						setSaveFeedback(
							savedSection === "metadata"
								? "Metadata was saved. Read-only was not changed."
								: "Read-only was turned off. Metadata was not saved.",
						);
					}
					return;
				}
				savedSection = section === policySaveState ? "read_only" : "metadata";
			}
			toast.success("Properties saved");
		})()
			.catch((error) => {
				console.error("[FilesPropertiesModal.handleSave] Unexpected async error", { error });
				setSaveFeedback("Some changes were not saved. Review the settings and try again.");
			})
			.finally(() => setSaving(false));
	});

	const handleClose = useFn(() => {
		// The sections unmount with the dialog body, so they cannot report that their draft is gone.
		// Clear the states here, or the next file opens still showing the unsaved warning left over
		// from the file that was just closed.
		setPolicySaveState(null);
		setMetadataSaveState(null);
		setSaveFeedback(null);
		onClose();
		queueMicrotask(() => returnFocusRef?.current?.focus());
	});

	const handleOpenChange = useFn((open: boolean) => {
		if (!open) {
			handleClose();
		}
	});

	return (
		<MyModal open={nodeId !== null} setOpen={handleOpenChange}>
			<MyModalPopover
				className={"FilesPropertiesModal" satisfies FilesPropertiesModal_ClassNames}
				data-files-properties-modal=""
				unmountOnHide
				// In Chromium, Monaco does not stop the Escape key, so Escape inside an editor would close the
				// dialog and drop the unsaved changes. While there are changes, Tab out of the editor first, then
				// Escape closes the dialog.
				hideOnEscape={(event) => !dirty || !(event.target instanceof Element && event.target.closest(".monaco-editor"))}
			>
				<MyModalHeader>
					<MyModalHeading>Properties</MyModalHeading>
					{/* Start with "/" to show the path from the root. */}
					<MyModalDescription>{node?.path ?? lockedNode?.path ?? `/${nodeName}`}</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea
					className={"FilesPropertiesModal-scrollable-area" satisfies FilesPropertiesModal_ClassNames}
					aria-busy={loading || undefined}
				>
					<div className={"FilesPropertiesModal-body" satisfies FilesPropertiesModal_ClassNames}>
						{nodeId && lockedNode ? (
							<section
								aria-label="General"
								className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}
							>
								<FilesPropertiesModalLockedFacts node={lockedNode} nodeKind={nodeKind} />
							</section>
						) : nodeId && loading ? (
							<FilesPropertiesModalSkeleton nodeKind={nodeKind} />
						) : nodeId ? (
							<>
								<section
									aria-label="General"
									className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}
								>
									<FilesPropertiesModalFacts nodeId={nodeId} nodeKind={nodeKind} />
								</section>

								<section
									aria-label="Protection"
									className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}
								>
									<FilesPropertiesModalReadOnly
										nodeId={nodeId}
										nodeKind={nodeKind}
										onSaveStateChange={setPolicySaveState}
									/>
								</section>

								{/* Only a text file can have a collaborative document, and the section itself decides
								    that from the node. A folder never can, so do not even ask. */}
								{nodeKind === "file" ? <FilesPropertiesModalCollaboration nodeId={nodeId} /> : null}

								<section
									aria-label="Metadata"
									className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}
								>
									<FilesPropertiesModalMetadata nodeId={nodeId} onSaveStateChange={setMetadataSaveState} />
								</section>
							</>
						) : null}
					</div>
				</MyModalScrollableArea>

				<MyModalFooter>
					{saveFeedback ? <p role="alert">{saveFeedback}</p> : null}
					{/* One Save writes every changed section. Closing discards unsaved changes. */}
					{dirty ? (
						<p className={"FilesPropertiesModal-unsaved" satisfies FilesPropertiesModal_ClassNames}>
							Unsaved changes will be lost.
						</p>
					) : null}
					<div className={"FilesPropertiesModal-footer-spacer" satisfies FilesPropertiesModal_ClassNames} />
					<MyButton variant="ghost" onClick={handleClose}>
						Close
					</MyButton>
					<MyButton
						disabled={!dirty || !!invalid || saving}
						aria-busy={saving || undefined}
						onClick={() => void handleSave()}
					>
						{saving ? "Saving…" : "Save"}
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion root
