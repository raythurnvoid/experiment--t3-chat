import "./files-properties-modal.css";

import { Editor, type EditorProps } from "@monaco-editor/react";
import { Save } from "lucide-react";
import { useQuery } from "convex/react";
import type { editor as monaco_editor } from "monaco-editor";
import { memo, useEffect, useId, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
import { MyCheckboxButton } from "@/components/my-checkbox-button.tsx";
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
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_relative_time } from "@/lib/date.ts";
import { files_format_size } from "@/lib/files.ts";
import { cn } from "@/lib/utils.ts";
import {
	files_metadata_parse_entries_yaml,
	files_metadata_stringify_entries_yaml,
} from "../../../shared/files-metadata.ts";
import { users_SYSTEM_AUTHOR } from "../../../shared/users.ts";

// #region facts
type FilesPropertiesModalFacts_ClassNames =
	| "FilesPropertiesModalFacts"
	| "FilesPropertiesModalFacts-row"
	| "FilesPropertiesModalFacts-label"
	| "FilesPropertiesModalFacts-value"
	| "FilesPropertiesModalFacts-skeleton";

type FilesPropertiesModalFacts_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	nodeKind: "file" | "folder";
};

/**
 * The plain facts about the node. Where it is, what it is, and who created and last changed it.
 *
 * Every value is read from the node itself, so a rename or a move does not make them wrong.
 */
const FilesPropertiesModalFacts = memo(function FilesPropertiesModalFacts(props: FilesPropertiesModalFacts_Props) {
	const { nodeId, nodeKind } = props;
	const { membershipId } = AppTenantProvider.useContext();

	const node = useQuery(app_convex_api.files_nodes.get_file_node_for_membership, { membershipId, fileNodeId: nodeId });

	// A converted upload keeps its stored blob asset, so its size is still the asset size. A file
	// created in-app has no asset, and a folder never has one.
	const asset = useQuery(
		app_convex_api.r2.get_asset_by_file_node_id,
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

	if (loading) {
		return (
			<dl className={"FilesPropertiesModalFacts" satisfies FilesPropertiesModalFacts_ClassNames}>
				{Array.from({ length: nodeKind === "file" ? 7 : 5 }, (_, index) => (
					<div key={index} className={"FilesPropertiesModalFacts-row" satisfies FilesPropertiesModalFacts_ClassNames}>
						<dt className={"FilesPropertiesModalFacts-label" satisfies FilesPropertiesModalFacts_ClassNames}>
							<MySkeleton
								className={"FilesPropertiesModalFacts-skeleton" satisfies FilesPropertiesModalFacts_ClassNames}
							/>
						</dt>
						<dd className={"FilesPropertiesModalFacts-value" satisfies FilesPropertiesModalFacts_ClassNames}>
							<MySkeleton
								className={"FilesPropertiesModalFacts-skeleton" satisfies FilesPropertiesModalFacts_ClassNames}
							/>
						</dd>
					</div>
				))}
			</dl>
		);
	}

	// The node is gone, or this member may not read it. The read-only section below reports the
	// same absence through its own query, so say nothing more here.
	if (node === null) {
		return null;
	}

	const location = node.path.slice(0, node.path.lastIndexOf("/")) || "/";

	return (
		<dl className={"FilesPropertiesModalFacts" satisfies FilesPropertiesModalFacts_ClassNames}>
			{nodeKind === "file" ? (
				<>
					<div className={"FilesPropertiesModalFacts-row" satisfies FilesPropertiesModalFacts_ClassNames}>
						<dt className={"FilesPropertiesModalFacts-label" satisfies FilesPropertiesModalFacts_ClassNames}>
							Content type
						</dt>
						<dd className={"FilesPropertiesModalFacts-value" satisfies FilesPropertiesModalFacts_ClassNames}>
							{node.contentType ?? "Unknown"}
						</dd>
					</div>
					<div className={"FilesPropertiesModalFacts-row" satisfies FilesPropertiesModalFacts_ClassNames}>
						<dt className={"FilesPropertiesModalFacts-label" satisfies FilesPropertiesModalFacts_ClassNames}>Size</dt>
						<dd className={"FilesPropertiesModalFacts-value" satisfies FilesPropertiesModalFacts_ClassNames}>
							{files_format_size(asset?.size)}
						</dd>
					</div>
				</>
			) : null}
			<div className={"FilesPropertiesModalFacts-row" satisfies FilesPropertiesModalFacts_ClassNames}>
				<dt className={"FilesPropertiesModalFacts-label" satisfies FilesPropertiesModalFacts_ClassNames}>Location</dt>
				<dd className={"FilesPropertiesModalFacts-value" satisfies FilesPropertiesModalFacts_ClassNames}>{location}</dd>
			</div>
			<div className={"FilesPropertiesModalFacts-row" satisfies FilesPropertiesModalFacts_ClassNames}>
				<dt className={"FilesPropertiesModalFacts-label" satisfies FilesPropertiesModalFacts_ClassNames}>Created</dt>
				<dd className={"FilesPropertiesModalFacts-value" satisfies FilesPropertiesModalFacts_ClassNames}>
					{format_relative_time(node._creationTime)}
				</dd>
			</div>
			<div className={"FilesPropertiesModalFacts-row" satisfies FilesPropertiesModalFacts_ClassNames}>
				<dt className={"FilesPropertiesModalFacts-label" satisfies FilesPropertiesModalFacts_ClassNames}>Created by</dt>
				<dd className={"FilesPropertiesModalFacts-value" satisfies FilesPropertiesModalFacts_ClassNames}>
					{createdByDisplayName}
				</dd>
			</div>
			<div className={"FilesPropertiesModalFacts-row" satisfies FilesPropertiesModalFacts_ClassNames}>
				<dt className={"FilesPropertiesModalFacts-label" satisfies FilesPropertiesModalFacts_ClassNames}>
					Last edited
				</dt>
				<dd className={"FilesPropertiesModalFacts-value" satisfies FilesPropertiesModalFacts_ClassNames}>
					{format_relative_time(node.updatedAt)}
				</dd>
			</div>
			<div className={"FilesPropertiesModalFacts-row" satisfies FilesPropertiesModalFacts_ClassNames}>
				<dt className={"FilesPropertiesModalFacts-label" satisfies FilesPropertiesModalFacts_ClassNames}>
					Last edited by
				</dt>
				<dd className={"FilesPropertiesModalFacts-value" satisfies FilesPropertiesModalFacts_ClassNames}>
					{updatedByDisplayName}
				</dd>
			</div>
		</dl>
	);
});
// #endregion facts

// #region read-only
type FilesPropertiesModalReadOnly_ClassNames =
	| "FilesPropertiesModalReadOnly"
	| "FilesPropertiesModalReadOnly-checkbox"
	| "FilesPropertiesModalReadOnly-text"
	| "FilesPropertiesModalReadOnly-label"
	| "FilesPropertiesModalReadOnly-description"
	| "FilesPropertiesModalReadOnly-actions"
	| "FilesPropertiesModalReadOnly-error";

type FilesPropertiesModalReadOnly_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	nodeKind: "file" | "folder";
	hasVisibleReadOnlyDescendant: boolean;
	onNavigateNode?: (nodeId: app_convex_Id<"files_nodes">) => void;
	onClose: () => void;
};

/**
 * One checkbox for a lock that can be set in more than one place.
 *
 * A node does not store a true/false flag. It stores `readOnlyScopeNodeId`, which points at the node
 * that owns the lock. So a node can be locked here, locked by a folder above it, or locked in both
 * places at once. The checkbox answers the question most people ask: can this be changed? The line
 * under it says which lock is doing it. That matters, because unchecking the box under a folder lock
 * removes only the lock set here, and the node stays read-only.
 *
 * A lock owned by a folder above cannot be released from this node at all. In that case the checkbox
 * is disabled and the two buttons below take over.
 */
const FilesPropertiesModalReadOnly = memo(function FilesPropertiesModalReadOnly(
	props: FilesPropertiesModalReadOnly_Props,
) {
	const { nodeId, nodeKind, hasVisibleReadOnlyDescendant, onNavigateNode, onClose } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const descriptionId = useId();
	const [isRunning, setIsRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const managementState = useQuery(app_convex_api.files_nodes.get_node_read_only_management_state, {
		membershipId,
		nodeId,
	});

	// The server hides the source path when the user cannot read that folder.
	const sourceLabel = managementState?.source?.path ?? "a protected folder";
	const isDirectUnderOuterLock = managementState?.readOnlyState === "self" && managementState.hasInheritedParentLock;
	const isReadOnly = managementState != null && managementState.readOnlyState !== "writable";
	// An inherited-only lock lives on a folder above, so this node cannot release it. Adding a
	// direct lock here is still allowed, through the button below rather than the checkbox.
	const canToggle = managementState?.canManage === true && managementState.readOnlyState !== "inherited";

	const description = ((/* iife */) => {
		// `undefined` means the query has not answered yet. `null` means this membership may not read
		// the node, and the facts section above then renders nothing at all. Do not add a second way
		// to say that here. Show the same loading text for both.
		if (managementState == null) {
			return "Loading read-only settings…";
		}
		if (managementState.readOnlyState === "writable") {
			return `Anyone with permission to edit can change this ${nodeKind}.`;
		}
		if (managementState.readOnlyState === "inherited") {
			return `Read-only because ${sourceLabel} is locked. Unlock it there to make this ${nodeKind} writable.`;
		}
		if (isDirectUnderOuterLock) {
			return `Locked here and by ${sourceLabel}. Unchecking removes only the lock set here, so this ${nodeKind} stays read-only.`;
		}
		return `Locked here. Unchecking makes this ${nodeKind} writable again.`;
	})();

	// The two mutations do not share a return type, so branch on the call rather than passing the
	// function reference in.
	const write = (readOnly: boolean) => {
		setError(null);
		setIsRunning(true);

		Promise.try(() =>
			readOnly
				? app_convex.mutation(app_convex_api.files_nodes.set_node_read_only, { membershipId, nodeId })
				: app_convex.mutation(app_convex_api.files_nodes.set_node_writable, { membershipId, nodeId }),
		)
			.then((result) => {
				if (result._nay) {
					setError(result._nay.message);
				}
			})
			.catch((caughtError: unknown) => {
				console.error("[FilesPropertiesModalReadOnly.write] Failed to change read-only state", {
					error: caughtError,
					nodeId,
				});
				setError("Failed to change read-only state");
			})
			.finally(() => {
				setIsRunning(false);
			});
	};

	const handleCheckedChange = useFn((checked: boolean) => {
		if (isRunning || !canToggle) {
			return;
		}

		write(checked);
	});

	const handleAddDirectLock = useFn(() => {
		if (isRunning) {
			return;
		}

		write(true);
	});

	const handleManageSource = useFn(() => {
		if (!managementState?.source || !onNavigateNode) {
			return;
		}

		onNavigateNode(managementState.source.nodeId);
		onClose();
	});

	return (
		<div className={"FilesPropertiesModalReadOnly" satisfies FilesPropertiesModalReadOnly_ClassNames}>
			<MyCheckboxButton
				className={"FilesPropertiesModalReadOnly-checkbox" satisfies FilesPropertiesModalReadOnly_ClassNames}
				variant="outline"
				checked={isReadOnly}
				disabled={!canToggle || isRunning}
				aria-describedby={descriptionId}
				aria-busy={isRunning || undefined}
				onCheckedChange={handleCheckedChange}
			>
				<span className={"FilesPropertiesModalReadOnly-text" satisfies FilesPropertiesModalReadOnly_ClassNames}>
					<span className={"FilesPropertiesModalReadOnly-label" satisfies FilesPropertiesModalReadOnly_ClassNames}>
						Read-only
					</span>
					<span
						id={descriptionId}
						className={"FilesPropertiesModalReadOnly-description" satisfies FilesPropertiesModalReadOnly_ClassNames}
					>
						{description}
						{managementState?.canManage === false ? " You cannot change this." : null}
						{nodeKind === "folder" && managementState?.readOnlyState === "writable"
							? " Locking a folder also protects everything inside it."
							: null}
						{hasVisibleReadOnlyDescendant
							? " This folder contains read-only items, so it cannot be renamed, moved, or archived."
							: null}
					</span>
				</span>
			</MyCheckboxButton>

			{managementState?.readOnlyState === "inherited" && managementState.canManage ? (
				<div className={"FilesPropertiesModalReadOnly-actions" satisfies FilesPropertiesModalReadOnly_ClassNames}>
					{managementState.source && onNavigateNode ? (
						<MyButton variant="outline" disabled={isRunning} onClick={handleManageSource}>
							Manage {managementState.source.path}
						</MyButton>
					) : null}
					{/* A direct lock changes nothing while the outer lock stands. It keeps this node
					    read-only if somebody unlocks the folder above later. */}
					<MyButton variant="ghost" disabled={isRunning} onClick={handleAddDirectLock}>
						Also lock here
					</MyButton>
				</div>
			) : null}

			{error ? (
				<p
					className={"FilesPropertiesModalReadOnly-error" satisfies FilesPropertiesModalReadOnly_ClassNames}
					role="alert"
				>
					{error}
				</p>
			) : null}
		</div>
	);
});
// #endregion read-only

// #region metadata
type FilesPropertiesModalMetadata_ClassNames =
	| "FilesPropertiesModalMetadata"
	| "FilesPropertiesModalMetadata-description"
	| "FilesPropertiesModalMetadata-editor"
	| "FilesPropertiesModalMetadata-skeleton"
	| "FilesPropertiesModalMetadata-actions"
	| "FilesPropertiesModalMetadata-status"
	| "FilesPropertiesModalMetadata-status-error";

type FilesPropertiesModalMetadata_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	/**
	 * Report an unsaved draft, so the footer can warn before the dialog is closed. Closing throws the
	 * draft away, and a modal is easier to dismiss by accident than the sidebar tab this replaced.
	 */
	onDirtyChange: (dirty: boolean) => void;
};

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
	const { nodeId, onDirtyChange } = props;
	const { membershipId } = AppTenantProvider.useContext();

	const entries = useQuery(app_convex_api.files_metadata.get_entries, { membershipId, fileNodeId: nodeId });
	const canWrite = useQuery(app_convex_api.files_nodes.get_current_user_file_write_permission, {
		membershipId,
		nodeId,
	});
	const readOnlyManagement = useQuery(app_convex_api.files_nodes.get_node_read_only_management_state, {
		membershipId,
		nodeId,
	});

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
	const editorRef = useRef<monaco_editor.IStandaloneCodeEditor | null>(null);
	// The exact text of the last draft this section sent. The server stores a map, not text, so what
	// comes back is the map rendered again. It rarely matches character for character. The editor
	// uses CRLF, a comment is not stored, and `4.0` comes back quoted. Remember the text that was
	// sent, so the effect below can tell the server sending our own save back apart from a real edit
	// by somebody else.
	const sentDraftRef = useRef<string | null>(null);

	const isLocked = readOnlyManagement != null && readOnlyManagement.readOnlyState !== "writable";
	const editable = canWrite === true && readOnlyManagement != null && !isLocked;
	const dirty = metadata.draftYaml !== metadata.serverYaml;
	const statusId = useId();
	// Show the permission reason first when permission and the lock both block writing, so the
	// section matches the order the server checks them in.
	const blockedReason =
		canWrite === false ? "You don't have permission to edit this file." : isLocked ? "This file is read-only." : null;

	// Keep these options in one state slot that never changes. @monaco-editor/react deep-clones the
	// options object whenever it changes, and some values in here point back at DOM nodes, so the
	// clone would run into a cycle.
	//
	// The file editors move Monaco's suggest and hover popups into one app-wide container, so those
	// popups can paint past the editor's edge. This editor cannot do that. The app-wide container
	// sits outside the modal, and Ariakit marks everything outside an open dialog as inert, so the
	// popups would paint behind the dialog. A container inside the modal does not work either. The
	// modal sets `contain: content`, which makes the modal the reference box for `position: fixed`,
	// and `fixedOverflowWidgets` writes screen coordinates that would then land in the wrong place.
	// So the popups stay inside the editor box and clip at its edge. This field is small, so that is
	// acceptable.
	const [editorOptions] = useState(() => {
		return {
			ariaLabel: "File metadata YAML",
			// Let Tab move focus out to the footer instead of typing a tab character. Monaco traps Tab
			// by default, which leaves a keyboard user stuck inside this small field, and YAML cannot
			// use tabs for indentation anyway.
			tabFocusMode: true,
			automaticLayout: true,
			fontSize: 13,
			lineHeight: 19,
			minimap: { enabled: false },
			lineNumbers: "off",
			padding: { top: 10, bottom: 10 },
			scrollBeyondLastLine: false,
			wordWrap: "on",
		} satisfies NonNullable<EditorProps["options"]>;
	});

	const handleOnMount = useFn<EditorProps["onMount"]>((editor) => {
		editorRef.current = editor;
		editor.updateOptions({ readOnly: saving || !editable });
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
		if (saving || !editable || metadata.draftYaml === metadata.serverYaml) {
			return;
		}

		// Parse with the shared parser first, so an invalid draft does not spend a write rate-limit
		// token. The `set_entries` mutation runs the same parser on the server.
		const parsed = files_metadata_parse_entries_yaml(metadata.draftYaml);
		if (parsed._nay) {
			setMetadata((current) => ({ ...current, feedback: { kind: "error", message: parsed._nay.message } }));
			toast.error(parsed._nay.message);
			return;
		}

		const yamlToSave = metadata.draftYaml;
		const serverYamlBeforeSave = metadata.serverYaml;
		// Mark the draft as sent before the call, because the reactive query can push the saved map
		// back before this promise settles.
		sentDraftRef.current = yamlToSave;
		setSaving(true);
		setMetadata((current) => ({ ...current, feedback: null }));
		app_convex
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
					return;
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
		onDirtyChange(dirty && editable);
	}, [dirty, editable, onDirtyChange]);

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
			// `sentDraftRef` here: StrictMode runs this updater twice, and the second run would take the
			// conflict branch below.
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
			<p className={"FilesPropertiesModalMetadata-description" satisfies FilesPropertiesModalMetadata_ClassNames}>
				Keys and values stored next to this file. A value is text, a number, or true/false. Lists and nested values are
				not allowed.
			</p>

			<div className={"FilesPropertiesModalMetadata-editor" satisfies FilesPropertiesModalMetadata_ClassNames}>
				{metadata.loaded ? (
					<Editor
						height="160px"
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
			</div>

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
				<MyButton
					className={cn(blockedReason && ("MyButton-state-disabled" satisfies MyButton_ClassNames))}
					disabled={blockedReason === null && (saving || !editable || !dirty)}
					aria-disabled={blockedReason ? true : undefined}
					aria-describedby={blockedReason ? statusId : undefined}
					aria-busy={saving}
					onClick={handleSave}
				>
					<Save aria-hidden />
					{saving ? "Saving..." : "Save metadata"}
				</MyButton>
			</div>
		</div>
	);
});
// #endregion metadata

// #region root
type FilesPropertiesModal_ClassNames =
	| "FilesPropertiesModal"
	| "FilesPropertiesModal-body"
	| "FilesPropertiesModal-section"
	| "FilesPropertiesModal-section-heading"
	| "FilesPropertiesModal-unsaved"
	| "FilesPropertiesModal-footer-spacer";

export type FilesPropertiesModal_Props = {
	nodeId: app_convex_Id<"files_nodes"> | null;
	nodeName: string;
	nodeKind: "file" | "folder";
	hasVisibleReadOnlyDescendant: boolean;
	returnFocusRef?: RefObject<HTMLElement | null>;
	onNavigateNode?: (nodeId: app_convex_Id<"files_nodes">) => void;
	onClose: () => void;
};

export const FilesPropertiesModal = memo(function FilesPropertiesModal(props: FilesPropertiesModal_Props) {
	const { nodeId, nodeName, nodeKind, hasVisibleReadOnlyDescendant, returnFocusRef, onNavigateNode, onClose } = props;
	const [dirty, setDirty] = useState(false);

	const handleClose = useFn(() => {
		// The metadata section unmounts with the dialog body, so it cannot report the draft it just
		// lost. Clear the flag here, or the next file opens still showing the unsaved-draft warning
		// left over from the file that was just closed.
		setDirty(false);
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
			>
				<MyModalHeader>
					<MyModalHeading>Properties</MyModalHeading>
					<MyModalDescription>{nodeName}</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea>
					<div className={"FilesPropertiesModal-body" satisfies FilesPropertiesModal_ClassNames}>
						{nodeId ? (
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
										hasVisibleReadOnlyDescendant={hasVisibleReadOnlyDescendant}
										onNavigateNode={onNavigateNode}
										onClose={handleClose}
									/>
								</section>

								{/* Only a file carries a metadata map. `set_entries` refuses a folder, so a folder
								    gets no editor at all instead of one that always fails to save. */}
								{nodeKind === "file" ? (
									<section
										aria-label="Metadata"
										className={"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames}
									>
										<h3 className={"FilesPropertiesModal-section-heading" satisfies FilesPropertiesModal_ClassNames}>
											Metadata
										</h3>
										<FilesPropertiesModalMetadata nodeId={nodeId} onDirtyChange={setDirty} />
									</section>
								) : null}
							</>
						) : null}
					</div>
				</MyModalScrollableArea>

				<MyModalFooter>
					{/* The read-only checkbox writes as soon as it is clicked, and Save metadata sits next
					    to the editor it saves. So closing can only throw away an unsaved draft. Saying so
					    is enough, and nothing here needs its own confirm step. */}
					{dirty ? (
						<p className={"FilesPropertiesModal-unsaved" satisfies FilesPropertiesModal_ClassNames}>
							Unsaved metadata will be lost.
						</p>
					) : null}
					<div className={"FilesPropertiesModal-footer-spacer" satisfies FilesPropertiesModal_ClassNames} />
					<MyButton variant="ghost" onClick={handleClose}>
						Done
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion root
