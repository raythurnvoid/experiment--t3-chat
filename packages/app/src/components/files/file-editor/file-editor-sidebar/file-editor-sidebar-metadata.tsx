import "./file-editor-sidebar-metadata.css";
import { Editor, type EditorProps } from "@monaco-editor/react";
import { useQuery } from "convex/react";
import { Save } from "lucide-react";
import type { editor as monaco_editor } from "monaco-editor";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_Doc } from "@/lib/app-convex-client.ts";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import {
	files_metadata_parse_entries_yaml,
	files_metadata_stringify_entries_yaml,
} from "../../../../../shared/files-metadata.ts";

// #region metadata
type FileEditorSidebarMetadata_ClassNames =
	| "FileEditorSidebarMetadata"
	| "FileEditorSidebarMetadata-description"
	| "FileEditorSidebarMetadata-editor"
	| "FileEditorSidebarMetadata-skeleton"
	| "FileEditorSidebarMetadata-actions"
	| "FileEditorSidebarMetadata-status"
	| "FileEditorSidebarMetadata-status-error";

export type FileEditorSidebarMetadata_Props = {
	node: app_convex_Doc<"files_nodes">;
};

type FileEditorSidebarMetadata_State = {
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

export const FileEditorSidebarMetadata = memo(function FileEditorSidebarMetadata(
	props: FileEditorSidebarMetadata_Props,
) {
	const { node } = props;
	const { membershipId } = AppTenantProvider.useContext();

	const entries = useQuery(app_convex_api.files_metadata.get_entries, { membershipId, fileNodeId: node._id });
	const canWrite = useQuery(app_convex_api.files_nodes.get_current_user_file_write_permission, {
		membershipId,
		nodeId: node._id,
	});
	const readOnlyManagement = useQuery(app_convex_api.files_nodes.get_node_read_only_management_state, {
		membershipId,
		nodeId: node._id,
	});

	// YAML is only the edit format. The stored map is the source of truth, so the panel always
	// re-renders it from the entries instead of keeping the exact text somebody typed.
	const serverYaml = entries === undefined ? undefined : files_metadata_stringify_entries_yaml(entries);

	// Convex answers from its cache when the query is already subscribed, so the stored map can be
	// here on the first render. Take it now, and the editor mounts on the real text with no extra
	// paint. When it is not here yet, the effect below fills this in and the skeleton holds.
	const [metadata, setMetadata] = useState<FileEditorSidebarMetadata_State>(() => ({
		draftYaml: serverYaml ?? "",
		serverYaml: serverYaml ?? "",
		loaded: serverYaml !== undefined,
		feedback: null,
	}));
	const [saving, setSaving] = useState(false);
	const editorRef = useRef<monaco_editor.IStandaloneCodeEditor | null>(null);
	// The exact text of the last draft this panel sent. The server stores a map, not text, so what
	// comes back is the map rendered again. It rarely matches character for character. The editor
	// uses CRLF, a comment is not stored, and `4.0` comes back quoted. Remember what was sent, so the
	// effect below can tell our own echo apart from a real edit by somebody else.
	const sentDraftRef = useRef<string | null>(null);

	const isLocked = readOnlyManagement != null && readOnlyManagement.readOnlyState !== "writable";
	const editable = canWrite === true && readOnlyManagement != null && !isLocked;
	// Point the Save button at the reason with `aria-describedby`. The node id keeps the id unique
	// even if two panels are ever mounted at once.
	const statusId = `FileEditorSidebarMetadata-status-${node._id}`;
	// Show the permission reason first when permission and the lock both block writing, so the panel
	// matches the order the server checks them in.
	const blockedReason =
		canWrite === false ? "You don't have permission to edit this file." : isLocked ? "This file is read-only." : null;

	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);
	// Keep construction-only Monaco options stable because @monaco-editor/react deep-clones option
	// updates and DOM references in these options are cyclic.
	const [editorOptions] = useState(() => {
		return {
			overflowWidgetsDomNode: hoistingContainer ?? undefined,
			fixedOverflowWidgets: true,
			ariaLabel: "File metadata YAML",
			// Let Tab move focus out to the Save button instead of typing a tab character. Monaco traps
			// Tab by default, which leaves a keyboard user stuck inside this small field, and YAML cannot
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

		// Parse with the shared parser first so an invalid draft does not spend a write rate-limit
		// token. The mutation runs the same parser as the real door.
		const parsed = files_metadata_parse_entries_yaml(metadata.draftYaml);
		if (parsed._nay) {
			setMetadata((current) => ({ ...current, feedback: { kind: "error", message: parsed._nay.message } }));
			toast.error(parsed._nay.message);
			return;
		}

		const yamlToSave = metadata.draftYaml;
		const serverYamlBeforeSave = metadata.serverYaml;
		// Mark the draft as sent before the call, because the reactive query can push the saved map back
		// before this promise settles.
		sentDraftRef.current = yamlToSave;
		setSaving(true);
		setMetadata((current) => ({ ...current, feedback: null }));
		app_convex
			.mutation(app_convex_api.files_metadata.set_entries, {
				membershipId,
				fileNodeId: node._id,
				metadataYaml: yamlToSave,
			})
			.then((result) => {
				if (result._nay) {
					// The write did not land, so a later server change is somebody else's, not our echo.
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

				// The reactive query pushes the saved map back through the effect below, which is what
				// really settles `draftYaml` and `serverYaml`. Only report the result here, and only
				// through the updater form: writing a whole state object here would undo that effect when
				// the query push and this promise land in the same tick. The draft still counts as saved
				// when the effect already replaced it with the server's own rendering.
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
				console.error("[FileEditorSidebarMetadata.handleSave] Failed to save file metadata", {
					error,
					fileNodeId: node._id,
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

			// The draft already says what the server now says, so a conflict warning is resolved. Keep any
			// other message: this is also where a save whose text needed no re-rendering lands, and that
			// save's "Metadata saved" must survive.
			if (current.draftYaml === serverYaml) {
				return { ...current, serverYaml, feedback: current.feedback?.kind === "conflict" ? null : current.feedback };
			}

			// This is the server's own rendering of the draft this panel just sent, and nothing was typed
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
		<section aria-label="File metadata" className={"FileEditorSidebarMetadata" satisfies FileEditorSidebarMetadata_ClassNames}>
			<p className={"FileEditorSidebarMetadata-description" satisfies FileEditorSidebarMetadata_ClassNames}>
				Keys and values stored next to this file. A value is text, a number, or true/false. Lists and nested
				values are not allowed.
			</p>

			<div className={"FileEditorSidebarMetadata-editor" satisfies FileEditorSidebarMetadata_ClassNames}>
				{!metadata.loaded || !hoistingContainer ? (
					<MySkeleton className={"FileEditorSidebarMetadata-skeleton" satisfies FileEditorSidebarMetadata_ClassNames} />
				) : (
					<Editor
						height="220px"
						language="yaml"
						theme={app_monaco_THEME_NAME_DARK}
						value={metadata.draftYaml}
						options={editorOptions}
						onMount={handleOnMount}
						onChange={handleChange}
					/>
				)}
			</div>

			<div className={"FileEditorSidebarMetadata-actions" satisfies FileEditorSidebarMetadata_ClassNames}>
				{metadata.feedback ?? blockedReason ? (
					<p
						id={statusId}
						className={cn(
							"FileEditorSidebarMetadata-status" satisfies FileEditorSidebarMetadata_ClassNames,
							metadata.feedback && metadata.feedback.kind !== "success"
								? ("FileEditorSidebarMetadata-status-error" satisfies FileEditorSidebarMetadata_ClassNames)
								: undefined,
						)}
						role={metadata.feedback && metadata.feedback.kind !== "success" ? "alert" : "status"}
					>
						{metadata.feedback?.message ?? blockedReason}
					</p>
				) : null}
				<MyButton
					className={cn(blockedReason && ("MyButton-state-disabled" satisfies MyButton_ClassNames))}
					disabled={blockedReason === null && (saving || !editable || metadata.draftYaml === metadata.serverYaml)}
					aria-disabled={blockedReason ? true : undefined}
					aria-describedby={blockedReason ? statusId : undefined}
					aria-busy={saving}
					onClick={handleSave}
				>
					<Save aria-hidden />
					{saving ? "Saving..." : "Save metadata"}
				</MyButton>
			</div>
		</section>
	);
});
// #endregion metadata
