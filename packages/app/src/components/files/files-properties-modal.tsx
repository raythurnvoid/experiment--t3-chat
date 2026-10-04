import "./files-properties-modal.css";

import { Editor, type EditorProps } from "@monaco-editor/react";
import { Check, CircleHelp, Plug, User, X } from "lucide-react";
import { useQuery } from "convex/react";
import { editor as monaco_editor } from "monaco-editor";
import { Fragment, memo, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import { MyChipOverflowRow } from "@/components/my-chip.tsx";
import {
	MyCheckboxButton,
	MyCheckboxButtonContent,
	MyCheckboxButtonDescription,
	MyCheckboxButtonLabel,
} from "@/components/my-checkbox-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyRadioButton, MyRadioButtonDescription, MyRadioButtonLabel } from "@/components/my-radio-button.tsx";
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
import { files_format_size } from "@/lib/files.ts";
import { cn, sx } from "@/lib/utils.ts";
import {
	files_metadata_parse_entries_yaml,
	files_metadata_stringify_entries_yaml,
} from "../../../shared/files-metadata.ts";
import { files_node_has_editable_text_content } from "../../../shared/files.ts";
import { FilesWritePolicyWritersModal, type FilesWritePolicyWriter } from "./files-write-policy-writers-modal.tsx";
import { users_SYSTEM_AUTHOR } from "../../../shared/users.ts";

/**
 * What a section tells the footer. The footer has one Save button for the whole dialog. It runs the
 * `save` of every section that is `dirty`. A section that cannot save yet (for example a selected
 * writer with nobody chosen) is `invalid`, and that turns Save off. A section reports `null` when it has
 * nothing to save.
 *
 * `save` answers `true` when the write worked. The section shows its own error when it did not.
 *
 * A section whose save cannot be undone sets `confirm`. Then Save first opens a dialog with these
 * words, and nothing is written until the person confirms.
 */
type SaveState = {
	dirty: boolean;
	invalid: boolean;
	confirm: { title: string; text: string; action: string } | null;
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
			<Editor
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
// #endregion facts

// #region write policy
type FilesPropertiesModalWritePolicy_ClassNames =
	| "FilesPropertiesModalWritePolicy"
	| "FilesPropertiesModalWritePolicy-heading"
	| "FilesPropertiesModalWritePolicy-choices"
	| "FilesPropertiesModalWritePolicy-option"
	| "FilesPropertiesModalWritePolicy-option-picker"
	| "FilesPropertiesModalWritePolicy-description"
	| "FilesPropertiesModalWritePolicy-error"
	| "FilesPropertiesModalWritePolicy-new-items"
	| "FilesPropertiesModalWritePolicy-apply";

type PolicyDraft = {
	mode: "editable" | "read_only" | "writer";
	writers: FilesWritePolicyWriter[];
};

/**
 * The rule as the save calls take it: ids only, no names.
 */
type SavedPolicy =
	| {
			mode: "read_only";
	  }
	| {
			mode: "writer";
			writers: (
				| { kind: "user"; userId: app_convex_Id<"users"> }
				| { kind: "service_account"; serviceAccountId: app_convex_Id<"access_control_service_accounts"> }
			)[];
	  }
	| null;

/**
 * The rule as the query returns it: names for the writers this person can see, and how many they cannot.
 */
type VisiblePolicy =
	| {
			mode: "read_only";
	  }
	| {
			mode: "writer";
			writers: FilesWritePolicyWriter[];
			hiddenWriterCount: number;
	  }
	| null;

function policy_draft_from_visible(policy: VisiblePolicy): PolicyDraft {
	if (policy?.mode === "writer") {
		return { mode: "writer", writers: policy.writers };
	}
	return { mode: policy?.mode === "read_only" ? "read_only" : "editable", writers: [] };
}

function saved_policy_from_draft(draft: PolicyDraft): SavedPolicy {
	if (draft.mode === "read_only") {
		return { mode: "read_only" };
	}
	if (draft.mode === "writer") {
		return {
			mode: "writer",
			writers: draft.writers.map((writer) =>
				writer.kind === "user"
					? { kind: "user", userId: writer.userId }
					: { kind: "service_account", serviceAccountId: writer.serviceAccountId },
			),
		};
	}
	return null;
}

/**
 * Compare two rules without caring about the order of the writers.
 */
function policy_fingerprint(policy: SavedPolicy) {
	if (policy?.mode === "writer") {
		return `writer:${policy.writers.map(FilesWritePolicyWritersModal.writerKey).sort().join(",")}`;
	}
	return policy?.mode ?? "editable";
}

function policy_choice_label(policy: SavedPolicy) {
	if (!policy) {
		return POLICY_LABELS.editable;
	}
	return policy.mode === "read_only" ? POLICY_LABELS.read_only : POLICY_LABELS.writer;
}

function policy_hidden_writer_count(policy: VisiblePolicy) {
	return policy?.mode === "writer" ? policy.hiddenWriterCount : 0;
}

type FilesPropertiesModalWriterSummary_ClassNames =
	| "FilesPropertiesModalWriterSummary"
	| "FilesPropertiesModalWriterSummary-empty"
	| "FilesPropertiesModalWriterSummary-note";

type FilesPropertiesModalWriterSummary_Props = {
	writers: FilesWritePolicyWriter[];
	hiddenWriterCount: number;
	disabled: boolean;
	onManage: () => void;
};

/**
 * Show who can edit as chips, and one button that opens the dialog where the writers change.
 */
const FilesPropertiesModalWriterSummary = memo(function FilesPropertiesModalWriterSummary(
	props: FilesPropertiesModalWriterSummary_Props,
) {
	const { writers, hiddenWriterCount, disabled, onManage } = props;

	const manageButton = (
		<MyButton variant="outline" disabled={disabled} onClick={onManage}>
			{writers.length === 0 ? "Add writers" : `Manage writers (${writers.length})`}
		</MyButton>
	);

	return (
		<div className={"FilesPropertiesModalWriterSummary" satisfies FilesPropertiesModalWriterSummary_ClassNames}>
			{writers.length > 0 ? (
				<MyChipOverflowRow
					items={writers.map((writer) => ({
						id: FilesWritePolicyWritersModal.writerKey(writer),
						label: writer.name,
						media: writer.kind === "user" ? <User /> : <Plug />,
					}))}
					leading={manageButton}
				/>
			) : (
				<div
					className={"FilesPropertiesModalWriterSummary-empty" satisfies FilesPropertiesModalWriterSummary_ClassNames}
				>
					{manageButton}
					<p
						className={"FilesPropertiesModalWriterSummary-note" satisfies FilesPropertiesModalWriterSummary_ClassNames}
					>
						Nobody is chosen yet, so this works like read-only.
					</p>
				</div>
			)}
			{hiddenWriterCount > 0 ? (
				<p className={"FilesPropertiesModalWriterSummary-note" satisfies FilesPropertiesModalWriterSummary_ClassNames}>
					{hiddenWriterCount === 1
						? "1 more writer is no longer available."
						: `${hiddenWriterCount} more writers are no longer available.`}
				</p>
			) : null}
		</div>
	);
});

type FilesPropertiesModalWritePolicy_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	nodeKind: "file" | "folder";
	onSaveStateChange: (state: SaveState | null) => void;
};

const POLICY_MODES = ["editable", "read_only", "writer"] as const;

const POLICY_LABELS = {
	editable: "Everyone with access",
	read_only: "No one (read-only)",
	writer: "Custom",
} satisfies Record<(typeof POLICY_MODES)[number], string>;

/**
 * Words for the three blocks: the item's own rule, and, for a folder, the rule for items inside. A person
 * sees a plugin where the code says service account, because "service account" means nothing to them.
 */
const POLICY_COPY = {
	file: {
		title: "Who can edit",
		helper: "Choose who can change this file.",
		editable: "Anyone with edit access can change this file.",
		read_only: "The file can be read, but not changed.",
		writer: "Only the people and plugins you choose can edit.",
	},
	folder: {
		title: "Who can change this folder",
		helper: "Choose who can change this folder. Each item inside keeps its own rule.",
		editable: "Anyone with edit access can add, remove, and rename items.",
		read_only: "The folder can be read, but items cannot be added, removed, or renamed.",
		writer: "Only the people and plugins you choose can add, remove, and rename items.",
	},
	default: {
		title: "Rule for items inside",
		helper: "Choose the rule for files and subfolders in this folder.",
		editable: "Anyone with edit access can edit the items.",
		read_only: "The items can be read, but not changed.",
		writer: "Only the people and plugins you choose can edit the items.",
	},
} satisfies Record<string, { title: string; helper: string } & Record<(typeof POLICY_MODES)[number], string>>;

/**
 * Edit this item's own rule and, for folders, the rule for items inside. New items get that rule when
 * they are created. Saving changes the items already inside only when the person also checks "Also
 * apply it to the items already inside" and confirms.
 */
const FilesPropertiesModalWritePolicy = memo(function FilesPropertiesModalWritePolicy(
	props: FilesPropertiesModalWritePolicy_Props,
) {
	const { nodeId, nodeKind, onSaveStateChange } = props;

	const { membershipId } = AppTenantProvider.useContext();
	const policyGroupId = `FilesPropertiesModalWritePolicy-${useId()}`;
	const defaultGroupId = `FilesPropertiesModalWritePolicy-default-${useId()}`;
	const applyLabelId = useId();
	const applyDescriptionId = useId();
	const [isRunning, setIsRunning] = useState(false);
	const [isDefaultRunning, setIsDefaultRunning] = useState(false);
	const [isApplying, setIsApplying] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [defaultError, setDefaultError] = useState<string | null>(null);
	const [applyError, setApplyError] = useState<string | null>(null);
	const [applyResult, setApplyResult] = useState<string | null>(null);
	const [applyToContents, setApplyToContents] = useState(false);
	const [draft, setDraft] = useState<PolicyDraft | null>(null);
	const [defaultDraft, setDefaultDraft] = useState<PolicyDraft | null>(null);
	// Which rule the writers dialog edits, or `null` while it is closed.
	const [writersDialog, setWritersDialog] = useState<"policy" | "default" | null>(null);

	const managementState = useQuery(app_convex_api.files_nodes.get_node_write_policy_management_state, {
		membershipId,
		nodeId,
	});
	const savedPolicy: VisiblePolicy = managementState?.localPolicy ?? null;
	const savedDefault: VisiblePolicy = managementState?.localDefault ?? null;
	const choice = draft ?? policy_draft_from_visible(savedPolicy);
	const defaultChoice = defaultDraft ?? policy_draft_from_visible(savedDefault);
	const canManage = managementState?.canManage === true;
	const policyUnsaved =
		draft !== null && policy_fingerprint(saved_policy_from_draft(draft)) !== policy_fingerprint(savedPolicy);
	const defaultUnsaved =
		defaultDraft !== null &&
		policy_fingerprint(saved_policy_from_draft(defaultDraft)) !== policy_fingerprint(savedDefault);
	// A Custom rule with nobody chosen cannot be saved yet.
	const policyInvalid = policyUnsaved && choice.mode === "writer" && choice.writers.length === 0;
	const defaultInvalid = defaultUnsaved && defaultChoice.mode === "writer" && defaultChoice.writers.length === 0;
	// Applying copies the rule for items inside. It cannot copy writers that are hidden from this person,
	// so it stays off until the person replaces those writers.
	const applyUnavailable = policy_hidden_writer_count(savedDefault) > 0 && !defaultUnsaved;
	const applyRuleLabel = applyToContents ? policy_choice_label(saved_policy_from_draft(defaultChoice)) : null;

	const savePolicy = () => {
		const writePolicy = saved_policy_from_draft(choice);

		setError(null);
		setIsRunning(true);

		return app_convex
			.mutation(app_convex_api.files_nodes.set_node_write_policy, { membershipId, nodeId, writePolicy })
			.then((result) => {
				if (result._nay) {
					setError(result._nay.message);
					return false;
				}

				setDraft(null);
				return true;
			})
			.catch((caughtError: unknown) => {
				console.error("[FilesPropertiesModalWritePolicy.savePolicy] Failed to change protection", {
					error: caughtError,
					nodeId,
				});
				setError("Failed to change protection");
				return false;
			})
			.finally(() => {
				setIsRunning(false);
			});
	};

	const saveDefault = () => {
		const newChildWritePolicy = saved_policy_from_draft(defaultChoice);

		setDefaultError(null);
		setIsDefaultRunning(true);

		return app_convex
			.mutation(app_convex_api.files_nodes.set_node_new_child_write_policy, {
				membershipId,
				nodeId,
				newChildWritePolicy,
			})
			.then((result) => {
				if (result._nay) {
					setDefaultError(result._nay.message);
					return false;
				}

				setDefaultDraft(null);
				return true;
			})
			.catch((caughtError: unknown) => {
				console.error("[FilesPropertiesModalWritePolicy.saveDefault] Failed to change new-item default", {
					error: caughtError,
					nodeId,
				});
				setDefaultError("Failed to change new-item default");
				return false;
			})
			.finally(() => {
				setIsDefaultRunning(false);
			});
	};

	const applyToItemsInside = (writePolicy: SavedPolicy) => {
		setApplyError(null);
		setApplyResult(null);
		setIsApplying(true);

		return app_convex
			.mutation(app_convex_api.files_write_policy_runs.start, { membershipId, nodeId, writePolicy })
			.then((result) => {
				if (result._nay) {
					setApplyError(result._nay.message);
					return false;
				}

				// A big folder takes many steps, so the job runs in the background and reports in Activity.
				setApplyResult("Updating the items inside in the background. Track it in Activity.");
				setApplyToContents(false);
				return true;
			})
			.catch((caughtError: unknown) => {
				console.error("[FilesPropertiesModalWritePolicy.applyToItemsInside] Failed to apply the rule", {
					error: caughtError,
					nodeId,
				});
				setApplyError("Failed to apply the rule to the items inside");
				return false;
			})
			.finally(() => {
				setIsApplying(false);
			});
	};

	// The footer Save button calls this. It writes only the rules that changed, and the two rules
	// are independent, so they run together.
	const save = useFn(() => {
		const writes: Promise<boolean>[] = [];
		if (canManage && policyUnsaved && !policyInvalid && !isRunning) {
			writes.push(savePolicy());
		}
		if (canManage && defaultUnsaved && !defaultInvalid && !isDefaultRunning) {
			writes.push(saveDefault());
		}
		// Read the rule now. The save below clears the draft, but the job must copy what the person saw.
		const applyPolicy = saved_policy_from_draft(defaultChoice);

		return Promise.all(writes).then((results) => {
			// Start copying the rule only after both rules are saved. If a save failed, the person
			// should fix it first instead of getting a half-done change.
			if (!results.every(Boolean)) {
				return false;
			}
			if (canManage && applyToContents && !applyUnavailable && !isApplying) {
				return applyToItemsInside(applyPolicy);
			}
			return true;
		});
	});

	useEffect(() => {
		onSaveStateChange({
			dirty: policyUnsaved || defaultUnsaved || applyToContents,
			invalid: policyInvalid || defaultInvalid || (applyToContents && applyUnavailable),
			// Applying replaces the rules of many items and cannot be undone, so Save asks first.
			confirm:
				applyRuleLabel === null
					? null
					: {
							title: "Change the rule of all items inside?",
							text: `Every file and subfolder in this folder that you can manage gets “${applyRuleLabel}”. This replaces their current rule, including chosen writers. Archived items are not changed. You cannot undo this.`,
							action: "Save and apply",
						},
			save,
		});
	}, [
		policyUnsaved,
		defaultUnsaved,
		applyToContents,
		applyUnavailable,
		policyInvalid,
		defaultInvalid,
		applyRuleLabel,
		save,
		onSaveStateChange,
	]);

	const renderChoices = (args: {
		choiceValue: PolicyDraft;
		onChoice: (choice: PolicyDraft) => void;
		groupId: string;
		running: boolean;
		groupKind: "policy" | "default";
		writerPicker: ReactNode;
	}) => {
		const { choiceValue, onChoice, groupId, running, groupKind, writerPicker } = args;

		const copy = POLICY_COPY[groupKind === "default" ? "default" : nodeKind];
		const headingId = `${groupId}-heading`;
		const helperId = `${groupId}-helper`;

		return (
			<>
				<h3
					id={headingId}
					className={"FilesPropertiesModalWritePolicy-heading" satisfies FilesPropertiesModalWritePolicy_ClassNames}
				>
					{copy.title}
				</h3>
				<p
					id={helperId}
					className={"FilesPropertiesModalWritePolicy-description" satisfies FilesPropertiesModalWritePolicy_ClassNames}
				>
					{copy.helper}
					{managementState === null ? " This setting is not available for this item." : null}
					{managementState?.canManage === false ? " You cannot change this setting." : null}
				</p>
				<fieldset
					className={"FilesPropertiesModalWritePolicy-choices" satisfies FilesPropertiesModalWritePolicy_ClassNames}
					aria-labelledby={headingId}
					aria-describedby={helperId}
				>
					{POLICY_MODES.map((mode) => {
						const labelId = `${groupId}-${mode}-label`;
						const optionDescriptionId = `${groupId}-${mode}-description`;

						return (
							<div
								key={mode}
								className={
									"FilesPropertiesModalWritePolicy-option" satisfies FilesPropertiesModalWritePolicy_ClassNames
								}
							>
								<MyRadioButton
									name={groupId}
									checked={choiceValue.mode === mode}
									disabled={!canManage}
									aria-busy={running || undefined}
									aria-labelledby={labelId}
									aria-describedby={optionDescriptionId}
									onChange={() => {
										if (!running) {
											onChoice({ ...choiceValue, mode });
											// Choosing Custom with nobody chosen opens the dialog, so the next step is clear.
											if (mode === "writer" && choiceValue.writers.length === 0) {
												setWritersDialog(groupKind);
											}
											if (groupKind === "policy") {
												setError(null);
											} else {
												setDefaultError(null);
											}
										}
									}}
								>
									<MyRadioButtonLabel id={labelId}>{POLICY_LABELS[mode]}</MyRadioButtonLabel>
									<MyRadioButtonDescription id={optionDescriptionId}>{copy[mode]}</MyRadioButtonDescription>
								</MyRadioButton>
								{/* The picker is a sibling of the radio button, not a child, so a button is never inside a label. The
							    grid draws it inside the radio button's border. */}
								{mode === "writer" && choiceValue.mode === "writer" ? (
									<div
										className={
											"FilesPropertiesModalWritePolicy-option-picker" satisfies FilesPropertiesModalWritePolicy_ClassNames
										}
									>
										{writerPicker}
									</div>
								) : null}
							</div>
						);
					})}
				</fieldset>
			</>
		);
	};

	return (
		<div className={"FilesPropertiesModalWritePolicy" satisfies FilesPropertiesModalWritePolicy_ClassNames}>
			{renderChoices({
				choiceValue: choice,
				onChoice: (choiceValue) => setDraft(choiceValue),
				groupId: policyGroupId,
				running: isRunning,
				groupKind: "policy",
				writerPicker: (
					<FilesPropertiesModalWriterSummary
						writers={choice.writers}
						hiddenWriterCount={policy_hidden_writer_count(savedPolicy)}
						disabled={!canManage || isRunning}
						onManage={() => setWritersDialog("policy")}
					/>
				),
			})}
			{error ? (
				<p
					className={"FilesPropertiesModalWritePolicy-error" satisfies FilesPropertiesModalWritePolicy_ClassNames}
					role="alert"
				>
					{error}
				</p>
			) : null}

			{nodeKind === "folder" ? (
				<div
					className={"FilesPropertiesModalWritePolicy-new-items" satisfies FilesPropertiesModalWritePolicy_ClassNames}
				>
					{renderChoices({
						choiceValue: defaultChoice,
						onChoice: (choiceValue) => setDefaultDraft(choiceValue),
						groupId: defaultGroupId,
						running: isDefaultRunning,
						groupKind: "default",
						writerPicker: (
							<FilesPropertiesModalWriterSummary
								writers={defaultChoice.writers}
								hiddenWriterCount={policy_hidden_writer_count(savedDefault)}
								disabled={!canManage || isDefaultRunning}
								onManage={() => setWritersDialog("default")}
							/>
						),
					})}
					{/* Copying the rule onto the items already inside is one step of the next Save, not a setting
					    that stays on. Do not disable the box while the job starts, or the browser throws a
					    keyboard user out of the dialog. */}
					<MyCheckboxButton
						className={"FilesPropertiesModalWritePolicy-apply" satisfies FilesPropertiesModalWritePolicy_ClassNames}
						variant="outline"
						checked={applyToContents}
						disabled={!canManage || applyUnavailable}
						aria-labelledby={applyLabelId}
						aria-describedby={applyDescriptionId}
						aria-busy={isApplying || undefined}
						onCheckedChange={(checked) => {
							if (!isApplying) {
								setApplyToContents(checked);
								setApplyError(null);
								setApplyResult(null);
							}
						}}
					>
						<MyCheckboxButtonContent>
							<MyCheckboxButtonLabel id={applyLabelId}>Also apply it to the items already inside</MyCheckboxButtonLabel>
							<MyCheckboxButtonDescription id={applyDescriptionId}>
								{applyUnavailable
									? "Some chosen writers are no longer available, so this is off. Change the writers first."
									: "Without this, only new items get the rule."}
							</MyCheckboxButtonDescription>
						</MyCheckboxButtonContent>
					</MyCheckboxButton>
					{applyResult ? (
						<p
							className={
								"FilesPropertiesModalWritePolicy-description" satisfies FilesPropertiesModalWritePolicy_ClassNames
							}
							role="status"
						>
							{applyResult}
						</p>
					) : null}
					{applyError ? (
						<p
							className={"FilesPropertiesModalWritePolicy-error" satisfies FilesPropertiesModalWritePolicy_ClassNames}
							role="alert"
						>
							{applyError}
						</p>
					) : null}
					{defaultError ? (
						<p
							className={"FilesPropertiesModalWritePolicy-error" satisfies FilesPropertiesModalWritePolicy_ClassNames}
							role="alert"
						>
							{defaultError}
						</p>
					) : null}
				</div>
			) : null}

			<FilesWritePolicyWritersModal
				open={writersDialog !== null}
				setOpen={(open) => {
					if (!open) {
						setWritersDialog(null);
					}
				}}
				title={writersDialog === "default" ? "Writers for items inside" : "Writers"}
				subtitle={POLICY_COPY[writersDialog === "default" ? "default" : nodeKind].writer}
				writers={writersDialog === "default" ? defaultChoice.writers : choice.writers}
				hiddenWriterCount={policy_hidden_writer_count(writersDialog === "default" ? savedDefault : savedPolicy)}
				onWritersChange={(writers) => {
					if (writersDialog === "default") {
						setDefaultDraft({ ...defaultChoice, writers });
						setDefaultError(null);
					} else {
						setDraft({ ...choice, writers });
						setError(null);
					}
				}}
			/>
		</div>
	);
});
// #endregion write policy

// #region collaboration
type FilesPropertiesModalCollaboration_ClassNames =
	| "FilesPropertiesModalCollaboration"
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
	const descriptionId = useId();
	const confirmTextId = useId();
	const checkboxRef = useRef<HTMLInputElement>(null);
	const cancelOffRef = useRef<HTMLButtonElement>(null);
	const [isRunning, setIsRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isConfirmingOff, setIsConfirmingOff] = useState(false);

	const node = useQuery(app_convex_api.files_nodes.get_file_node_for_membership, { membershipId, fileNodeId: nodeId });
	const canWrite = useQuery(app_convex_api.files_nodes.get_current_user_file_write_permission, {
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
				? "This file is read-only."
				: "You don't have permission to edit this file."
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

	const description = isCollaborative
		? "Changes show up in real time, and your edits are saved as you type. You can see what your teammates are editing."
		: "Turn this on to see changes in real time and what your teammates are editing.";

	return (
		<section
			aria-label="Collaboration"
			className={cn(
				"FilesPropertiesModal-section" satisfies FilesPropertiesModal_ClassNames,
				"FilesPropertiesModalCollaboration" satisfies FilesPropertiesModalCollaboration_ClassNames,
			)}
		>
			<MyCheckboxButton
				ref={checkboxRef}
				className={"FilesPropertiesModalCollaboration-checkbox" satisfies FilesPropertiesModalCollaboration_ClassNames}
				variant="outline"
				checked={isCollaborative}
				// Do not disable this while the write runs, or the
				// browser throws a keyboard user out of the dialog. `handleCheckedChange` ignores a second
				// press instead.
				disabled={!canToggle}
				aria-describedby={descriptionId}
				aria-busy={isRunning || undefined}
				onCheckedChange={handleCheckedChange}
			>
				<MyCheckboxButtonContent>
					<MyCheckboxButtonLabel>Collaborative editing</MyCheckboxButtonLabel>
					<MyCheckboxButtonDescription id={descriptionId}>
						{description}
						{blockedReason ? ` ${blockedReason}` : null}
					</MyCheckboxButtonDescription>
				</MyCheckboxButtonContent>
			</MyCheckboxButton>

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
	const canWrite = useQuery(app_convex_api.files_nodes.get_current_user_file_write_permission, {
		membershipId,
		nodeId,
	});
	const node = useQuery(app_convex_api.files_nodes.get_file_node_for_membership, { membershipId, fileNodeId: nodeId });

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
	const statusId = useId();
	// Show the permission reason first when permission and the lock both block writing, so the
	// section matches the order the server checks them in.
	const blockedReason =
		canWrite === false
			? node?.writeBlockedReason === "read_only"
				? "This item is read-only, so its metadata cannot be changed."
				: "You don't have permission to change this item's metadata."
			: null;

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
		if (saving || !editable || metadata.draftYaml === metadata.serverYaml) {
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
		onSaveStateChange({ dirty: dirty && editable, invalid: false, confirm: null, save: handleSave });
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
					<Editor
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

export type FilesPropertiesModal_Props = {
	nodeId: app_convex_Id<"files_nodes"> | null;
	nodeName: string;
	nodeKind: "file" | "folder";
	returnFocusRef?: RefObject<HTMLElement | null>;
	onClose: () => void;
};

export const FilesPropertiesModal = memo(function FilesPropertiesModal(props: FilesPropertiesModal_Props) {
	const { nodeId, nodeName, nodeKind, returnFocusRef, onClose } = props;

	const { membershipId } = AppTenantProvider.useContext();
	const [policySaveState, setPolicySaveState] = useState<SaveState | null>(null);
	const [metadataSaveState, setMetadataSaveState] = useState<SaveState | null>(null);
	const [saving, setSaving] = useState(false);
	const [isConfirmingSave, setIsConfirmingSave] = useState(false);
	const confirmSaveTextId = useId();
	const cancelSaveRef = useRef<HTMLButtonElement>(null);

	// The sections below read these same queries. Nothing else in the app subscribes to them before
	// the modal opens, so the first answer needs a server round trip. Wait for it here and show the
	// skeleton. Then every section finds its answer already in the Convex cache and draws once,
	// with the right values.
	const node = useQuery(
		app_convex_api.files_nodes.get_file_node_for_membership,
		nodeId ? { membershipId, fileNodeId: nodeId } : "skip",
	);
	const managementState = useQuery(
		app_convex_api.files_nodes.get_node_write_policy_management_state,
		nodeId ? { membershipId, nodeId } : "skip",
	);
	const metadataEntries = useQuery(
		app_convex_api.files_metadata.get_entries,
		nodeId ? { membershipId, fileNodeId: nodeId } : "skip",
	);
	const loading = node === undefined || managementState === undefined || metadataEntries === undefined;

	const saveStates = [policySaveState, metadataSaveState];
	const dirty = saveStates.some((saveState) => saveState?.dirty);
	const invalid = saveStates.some((saveState) => saveState?.invalid);
	const saveConfirm = saveStates.find((saveState) => saveState?.dirty && saveState.confirm)?.confirm ?? null;

	const runSave = () => {
		setSaving(true);

		Promise.all(saveStates.map((saveState) => (saveState?.dirty ? saveState.save() : Promise.resolve(true))))
			.then((results) => {
				if (results.every(Boolean)) {
					toast.success("Properties saved");
				}
			})
			.catch((error: unknown) => {
				console.error("[FilesPropertiesModal.runSave] Unexpected async error", { error });
			})
			.finally(() => {
				setSaving(false);
				// A failed save shows its error in its own section, so close the confirm dialog either way.
				setIsConfirmingSave(false);
			});
	};

	const handleSave = useFn(() => {
		if (saving || !dirty || invalid) {
			return;
		}

		if (saveConfirm) {
			setIsConfirmingSave(true);
			return;
		}

		runSave();
	});

	const handleConfirmSave = useFn(() => {
		if (saving) {
			return;
		}

		runSave();
	});

	const handleConfirmSaveOpenChange = useFn((open: boolean) => {
		// Escape and the backdrop cannot close the dialog while the save runs.
		if (!open && !saving) {
			setIsConfirmingSave(false);
		}
	});

	const handleClose = useFn(() => {
		// The sections unmount with the dialog body, so they cannot report that their draft is gone.
		// Clear the states here, or the next file opens still showing the unsaved warning left over
		// from the file that was just closed.
		setPolicySaveState(null);
		setMetadataSaveState(null);
		setIsConfirmingSave(false);
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
					{/* Start with "/" to show the path from the root. */}
					<MyModalDescription>{node?.path ?? `/${nodeName}`}</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea
					className={"FilesPropertiesModal-scrollable-area" satisfies FilesPropertiesModal_ClassNames}
					aria-busy={loading || undefined}
				>
					<div className={"FilesPropertiesModal-body" satisfies FilesPropertiesModal_ClassNames}>
						{nodeId && loading ? (
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
									<FilesPropertiesModalWritePolicy
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
					<MyButton disabled={!dirty || invalid || saving} aria-busy={saving || undefined} onClick={handleSave}>
						{saving ? "Saving…" : "Save"}
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger />

				{/* A save that cannot be undone asks in its own dialog. Start on Cancel, the safe choice. */}
				<MyModal open={isConfirmingSave && saveConfirm !== null} setOpen={handleConfirmSaveOpenChange}>
					<MyModalPopover
						className={"FilesPropertiesModal-confirm-modal" satisfies FilesPropertiesModal_ClassNames}
						initialFocus={cancelSaveRef}
						aria-describedby={confirmSaveTextId}
					>
						<MyModalHeader>
							<MyModalHeading>{saveConfirm?.title}</MyModalHeading>
						</MyModalHeader>
						<MyModalScrollableArea>
							<p
								id={confirmSaveTextId}
								className={"FilesPropertiesModal-confirm-text" satisfies FilesPropertiesModal_ClassNames}
							>
								{saveConfirm?.text}
							</p>
						</MyModalScrollableArea>
						<MyModalFooter>
							<MyButton
								ref={cancelSaveRef}
								variant="ghost"
								disabled={saving}
								onClick={() => setIsConfirmingSave(false)}
							>
								Cancel
							</MyButton>
							<MyButton
								variant="destructive"
								disabled={saving}
								aria-busy={saving || undefined}
								onClick={handleConfirmSave}
							>
								{saving ? "Saving…" : saveConfirm?.action}
							</MyButton>
						</MyModalFooter>
						<MyModalCloseTrigger disabled={saving} />
					</MyModalPopover>
				</MyModal>
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion root
