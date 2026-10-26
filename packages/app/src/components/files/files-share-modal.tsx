import "./files-share-modal.css";

import { usePaginatedQuery, useQueries, useQuery } from "convex/react";
import { Lock, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
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
import {
	MySelect,
	MySelectItem,
	MySelectItemIndicator,
	MySelectItemsGroup,
	MySelectItemsGroupEmpty,
	MySelectItemsGroupText,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_time } from "@/lib/date.ts";
import { url_share_link } from "@/lib/urls.ts";
import { cn, compute_fallback_user_name } from "@/lib/utils.ts";
import {
	access_control_FILE_SHARE_LEVEL_KEYS,
	access_control_FILE_SHARE_LEVELS,
	access_control_is_system_role,
	access_control_SYSTEM_ROLE_MATRIX,
	access_control_SYSTEM_ROLES,
	type access_control_FileShareLevel,
	type access_control_RoleRef,
} from "../../../shared/access-control.ts";

// #region principal value
/**
 * Who one share row is about.
 */
type FilesSharePrincipal =
	| { kind: "user"; userId: app_convex_Id<"users"> }
	| { kind: "role"; role: access_control_RoleRef }
	| { kind: "service_account"; serviceAccountId: app_convex_Id<"access_control_service_accounts"> };

/**
 * One select value that stands for one principal.
 *
 * The kind prefix is what keeps the two apart: a custom role id and a user id are both plain Convex
 * ids, so without it they could collide. The server groups its grants by the same string.
 */
function files_share_principal_value(principal: FilesSharePrincipal) {
	return principal.kind === "user"
		? `user:${principal.userId}`
		: principal.kind === "role"
			? `role:${principal.role}`
			: `service_account:${principal.serviceAccountId}`;
}

function files_share_principal_from_value(value: string): FilesSharePrincipal | null {
	if (value.startsWith("user:")) {
		return { kind: "user", userId: value.slice("user:".length) as app_convex_Id<"users"> };
	}
	if (value.startsWith("role:")) {
		return { kind: "role", role: value.slice("role:".length) as access_control_RoleRef };
	}
	if (value.startsWith("service_account:")) {
		return {
			kind: "service_account",
			serviceAccountId: value.slice("service_account:".length) as app_convex_Id<"access_control_service_accounts">,
		};
	}

	// The empty value of the "choose someone" placeholder lands here.
	return null;
}
// #endregion principal value

// #region entry row
type FilesShareModalEntry_ClassNames =
	| "FilesShareModalEntry"
	| "FilesShareModalEntry-icon"
	| "FilesShareModalEntry-main"
	| "FilesShareModalEntry-name"
	| "FilesShareModalEntry-meta"
	| "FilesShareModalEntry-hint"
	| "FilesShareModalEntry-actions"
	| "FilesShareModalEntry-level-trigger";

type FilesShareModalEntry_Props = {
	principal: FilesSharePrincipal;
	name: string;
	/** Shown under the name, e.g. what the level means or why this row cannot change. */
	meta: string;
	/** Says when another source gives more than this row, e.g. "Can manage through workspace role". */
	hint: string | null;
	level: access_control_FileShareLevel | null;
	/** `false` renders the row read-only, with no select and no Remove. */
	editable: boolean;
	/** This row is the one being saved. */
	pending: boolean;
	/** A write is running somewhere in the dialog, so no control here may start a second one. */
	busy: boolean;
	/**
	 * Whether the caller may raise what a role row gets. Mirrors the backend rule: naming a role at a
	 * higher level hands the role out and needs role management, while a lower or equal level does not.
	 */
	canRaiseRoleLevel: boolean;
	/** The levels the select offers. Added people never get "Can manage", so their rows leave it out. */
	levels?: readonly access_control_FileShareLevel[];
	grantableLevels?: readonly access_control_FileShareLevel[];
	onLevelChange: (principal: FilesSharePrincipal, level: access_control_FileShareLevel) => void;
	onRemove: (principal: FilesSharePrincipal) => void;
};

const FilesShareModalEntry = memo(function FilesShareModalEntry(props: FilesShareModalEntry_Props) {
	const {
		principal,
		name,
		meta,
		hint,
		level,
		editable,
		pending,
		busy,
		canRaiseRoleLevel,
		levels = access_control_FILE_SHARE_LEVEL_KEYS,
		grantableLevels,
		onLevelChange,
		onRemove,
	} = props;

	// `data-share-principal` is the only stable way a browser test can find one row: names are free
	// text and ids from `useId()` change on every render. It is listed as a selector in
	// `.agents/skills/app-playwriter-harness/references/app-map.md`.
	return (
		<li
			className={"FilesShareModalEntry" satisfies FilesShareModalEntry_ClassNames}
			data-share-principal={files_share_principal_value(principal)}
			data-share-level={level ?? undefined}
		>
			{principal.kind === "user" ? (
				<MyAvatar size="32px" className={"FilesShareModalEntry-icon" satisfies FilesShareModalEntry_ClassNames}>
					<MyAvatarImage alt={name} fallbackDelay={false} />
					<MyAvatarFallback>{compute_fallback_user_name(name)}</MyAvatarFallback>
				</MyAvatar>
			) : (
				<div className={"FilesShareModalEntry-icon" satisfies FilesShareModalEntry_ClassNames} aria-hidden>
					<ShieldCheck />
				</div>
			)}

			<div className={"FilesShareModalEntry-main" satisfies FilesShareModalEntry_ClassNames}>
				<span className={"FilesShareModalEntry-name" satisfies FilesShareModalEntry_ClassNames}>{name}</span>
				<span className={"FilesShareModalEntry-meta" satisfies FilesShareModalEntry_ClassNames}>{meta}</span>
				{hint ? (
					<span className={"FilesShareModalEntry-hint" satisfies FilesShareModalEntry_ClassNames}>{hint}</span>
				) : null}
			</div>

			<div className={"FilesShareModalEntry-actions" satisfies FilesShareModalEntry_ClassNames}>
				{level === null ? (
					<MyBadge variant="secondary">Full access</MyBadge>
				) : editable ? (
					<MySelect
						value={level}
						setValue={(value) => onLevelChange(principal, value as access_control_FileShareLevel)}
					>
						{/* The row being saved keeps its own control enabled. Disabling the element the user
						    just used drops keyboard focus to the page, and they lose their place in the list.
						    A second write cannot start anyway: the handlers refuse while one is running. */}
						<MySelectTrigger disabled={busy && !pending}>
							<MyButton
								type="button"
								variant="outline"
								className={"FilesShareModalEntry-level-trigger" satisfies FilesShareModalEntry_ClassNames}
								aria-label={`Access level for ${name}`}
								aria-busy={pending || undefined}
							>
								<span>{pending ? "Saving..." : access_control_FILE_SHARE_LEVELS[level].label}</span>
								<MySelectOpenIndicator />
							</MyButton>
						</MySelectTrigger>
						{/* `unmountOnHide` because the popover portals out of this row: without it every closed
						    row's option list stays in the DOM and a test matching on level names finds many. */}
						<MySelectPopover unmountOnHide>
							<MySelectPopoverContent>
								{levels.map((levelKey) => (
									<MySelectItem
										key={levelKey}
										value={levelKey}
										data-share-level={levelKey}
										disabled={
											(grantableLevels !== undefined && !grantableLevels.includes(levelKey)) ||
											(principal.kind === "role" &&
												!canRaiseRoleLevel &&
												access_control_FILE_SHARE_LEVEL_KEYS.indexOf(levelKey) >
													access_control_FILE_SHARE_LEVEL_KEYS.indexOf(level))
										}
									>
										{access_control_FILE_SHARE_LEVELS[levelKey].label}
										{level === levelKey ? <MySelectItemIndicator /> : null}
									</MySelectItem>
								))}
							</MySelectPopoverContent>
						</MySelectPopover>
					</MySelect>
				) : (
					<MyBadge variant="outline">
						{/* Hidden text, not `aria-label`: ARIA forbids naming a plain span. */}
						<span className="sr-only">Access: </span>
						{access_control_FILE_SHARE_LEVELS[level].label}
					</MyBadge>
				)}

				{editable && level !== null ? (
					<MyIconButton
						variant="ghost_destructive"
						tooltip={`Remove ${name}`}
						disabled={busy && !pending}
						aria-busy={pending || undefined}
						onClick={() => onRemove(principal)}
					>
						<Trash2 aria-hidden />
					</MyIconButton>
				) : null}
			</div>
		</li>
	);
});
// #endregion entry row

// #region source row
type FilesShareModalSourceRow_ClassNames =
	| "FilesShareModalSourceRow"
	| "FilesShareModalSourceRow-icon"
	| "FilesShareModalSourceRow-main"
	| "FilesShareModalSourceRow-name"
	| "FilesShareModalSourceRow-meta"
	| "FilesShareModalSourceRow-note"
	| "FilesShareModalSourceRow-actions";

type FilesShareModalSourceRow_CustomAttributes = {
	/** `base` is the workspace or the restricted folder above. `added` is a folder above with added people. */
	"data-share-source": "base" | "added";
	/** The folder this row is about. Missing on the workspace row. */
	"data-share-inherited": app_convex_Id<"files_nodes"> | undefined;
};

type FilesShareModalSourceRow_Props = {
	source: FilesShareModalSourceRow_CustomAttributes["data-share-source"];
	/** The folder this row is about, or null for the workspace. */
	folderNodeId: app_convex_Id<"files_nodes"> | null;
	name: string;
	meta: string;
	/** Why this row cannot change, shown as text so it is not only in a tooltip. */
	note: string | null;
	children: ReactNode;
};

/**
 * A row for access that comes from somewhere else: the workspace, or a folder above. It sits in the
 * same list as the people, so removing the workspace row is how an item gets restricted.
 */
const FilesShareModalSourceRow = memo(function FilesShareModalSourceRow(props: FilesShareModalSourceRow_Props) {
	const { source, folderNodeId, name, meta, note, children } = props;

	return (
		<li
			className={"FilesShareModalSourceRow" satisfies FilesShareModalSourceRow_ClassNames}
			{...({
				"data-share-source": source,
				"data-share-inherited": folderNodeId ?? undefined,
			} satisfies FilesShareModalSourceRow_CustomAttributes)}
		>
			<div className={"FilesShareModalSourceRow-icon" satisfies FilesShareModalSourceRow_ClassNames} aria-hidden>
				{folderNodeId ? <Lock /> : <Users />}
			</div>
			<div className={"FilesShareModalSourceRow-main" satisfies FilesShareModalSourceRow_ClassNames}>
				<span className={"FilesShareModalSourceRow-name" satisfies FilesShareModalSourceRow_ClassNames}>{name}</span>
				<span className={"FilesShareModalSourceRow-meta" satisfies FilesShareModalSourceRow_ClassNames}>{meta}</span>
				{note ? (
					<span className={"FilesShareModalSourceRow-note" satisfies FilesShareModalSourceRow_ClassNames}>{note}</span>
				) : null}
			</div>
			<div className={"FilesShareModalSourceRow-actions" satisfies FilesShareModalSourceRow_ClassNames}>{children}</div>
		</li>
	);
});
// #endregion source row

// #region link
type FilesShareModalLink_ClassNames =
	| "FilesShareModalLink"
	| "FilesShareModalLink-created"
	| "FilesShareModalLink-error"
	| "FilesShareModalLink-level-trigger"
	| "FilesShareModalLink-public"
	| "FilesShareModalLink-public-text";

type FilesShareModalLink_CustomAttributes = {
	"data-share-link": "on" | "off" | "hidden";
	"data-share-public": "on" | "off";
};

type FilesShareModalLink_Props = {
	/** The file's link. `hidden` when the caller does not manage the file, so they get no link select. */
	link: { token: string; createdAt: number; creatorName: string } | null | "hidden";
	/** The public flag of an image or video file, with its kind. Null for any other file. */
	publicFlag: { isPublic: boolean; canChange: boolean; mediaKind: "image" | "video" } | null;
	/** The link write is the one being saved. */
	pending: boolean;
	/** The public flag write is the one being saved. */
	publicPending: boolean;
	/** A write is running somewhere in the dialog, so this control may not start a second one. */
	busy: boolean;
	/** Why the last link write was refused. Shown here, beside the control, instead of in a toast. */
	error: string | null;
	/** Why the last public flag write was refused. */
	publicError: string | null;
	onEnabledChange: (enabled: boolean) => void;
	onPublicChange: (enabled: boolean) => void;
};

/**
 * Everything public about one file: its link, and for an image or video, whether public documents show
 * it. Folders have neither, so they get no section.
 */
const FilesShareModalLink = memo(function FilesShareModalLink(props: FilesShareModalLink_Props) {
	const { link, publicFlag, pending, publicPending, busy, error, publicError, onEnabledChange, onPublicChange } = props;

	const linkOn = link !== null && link !== "hidden";
	const levelLabel = linkOn ? access_control_FILE_SHARE_LEVELS.read.label : "No access";

	return (
		<section
			aria-label="Public link"
			className={cn(
				"FilesShareModal-section" satisfies FilesShareModal_ClassNames,
				"FilesShareModalLink" satisfies FilesShareModalLink_ClassNames,
			)}
			{...({
				"data-share-link": link === "hidden" ? "hidden" : linkOn ? "on" : "off",
			} satisfies Partial<FilesShareModalLink_CustomAttributes>)}
		>
			{/* The level picker and Copy sit beside the text, as the help button does in the Properties modal. */}
			<div className={"FilesShareModal-section-header" satisfies FilesShareModal_ClassNames}>
				<div className={"FilesShareModal-section-main" satisfies FilesShareModal_ClassNames}>
					<h3 className={"FilesShareModal-section-heading" satisfies FilesShareModal_ClassNames}>Public link</h3>
					{link === "hidden" ? null : (
						<p className={"FilesShareModal-section-text" satisfies FilesShareModal_ClassNames}>
							{linkOn
								? "Anyone who has the link can view this file without signing in."
								: "Only people with access can open this file."}
						</p>
					)}
				</div>

				{link === "hidden" ? null : (
					<div className={"FilesShareModal-section-actions" satisfies FilesShareModal_ClassNames}>
						<MySelect
							value={linkOn ? "on" : "off"}
							setValue={(value) => {
								const enabled = value === "on";
								// Choosing the level it already has changes nothing, so it sends nothing.
								if (enabled !== linkOn) {
									onEnabledChange(enabled);
								}
							}}
						>
							{/* Stays enabled while its own write runs, same reason as a row's level trigger. */}
							<MySelectTrigger disabled={busy && !pending}>
								<MyButton
									type="button"
									variant="outline"
									className={"FilesShareModalLink-level-trigger" satisfies FilesShareModalLink_ClassNames}
									aria-label="Anyone with the link"
									aria-busy={pending || undefined}
								>
									<span>{pending ? "Saving..." : levelLabel}</span>
									<MySelectOpenIndicator />
								</MyButton>
							</MySelectTrigger>
							<MySelectPopover unmountOnHide>
								<MySelectPopoverContent>
									<MySelectItem value="off">
										No access
										{!linkOn ? <MySelectItemIndicator /> : null}
									</MySelectItem>
									<MySelectItem value="on">
										{access_control_FILE_SHARE_LEVELS.read.label}
										{linkOn ? <MySelectItemIndicator /> : null}
									</MySelectItem>
								</MySelectPopoverContent>
							</MySelectPopover>
						</MySelect>

						{linkOn ? <CopyIconButton text={url_share_link({ token: link.token })} tooltipCopy="Copy link" /> : null}
					</div>
				)}
			</div>

			{linkOn ? (
				<p className={"FilesShareModalLink-created" satisfies FilesShareModalLink_ClassNames}>
					Link created by {link.creatorName} on {format_time(link.createdAt)}.
				</p>
			) : null}

			{error ? (
				<p className={"FilesShareModalLink-error" satisfies FilesShareModalLink_ClassNames} role="alert">
					{error}
				</p>
			) : null}

			{/* An image or video can also show inside the public link pages of other files. */}
			{publicFlag ? (
				<div
					className={"FilesShareModalLink-public" satisfies FilesShareModalLink_ClassNames}
					{...({
						"data-share-public": publicFlag.isPublic ? "on" : "off",
					} satisfies Partial<FilesShareModalLink_CustomAttributes>)}
				>
					<p className={"FilesShareModalLink-public-text" satisfies FilesShareModalLink_ClassNames}>
						{publicFlag.isPublic
							? `Public documents that use this ${publicFlag.mediaKind} show it.`
							: `Public documents that use this ${publicFlag.mediaKind} show a gray box instead.`}
					</p>
					{publicFlag.canChange ? (
						<MySelect
							value={publicFlag.isPublic ? "on" : "off"}
							setValue={(value) => {
								const enabled = value === "on";
								// Choosing the value it already has changes nothing, so it sends nothing.
								if (enabled !== publicFlag.isPublic) {
									onPublicChange(enabled);
								}
							}}
						>
							{/* Stays enabled while its own write runs, same reason as a row's level trigger. */}
							<MySelectTrigger disabled={busy && !publicPending}>
								<MyButton
									type="button"
									variant="outline"
									className={"FilesShareModalLink-level-trigger" satisfies FilesShareModalLink_ClassNames}
									aria-label="Inside public documents"
									aria-busy={publicPending || undefined}
								>
									<span>{publicPending ? "Saving..." : publicFlag.isPublic ? "Shown" : "Not shown"}</span>
									<MySelectOpenIndicator />
								</MyButton>
							</MySelectTrigger>
							<MySelectPopover unmountOnHide>
								<MySelectPopoverContent>
									<MySelectItem value="on">
										Shown
										{publicFlag.isPublic ? <MySelectItemIndicator /> : null}
									</MySelectItem>
									<MySelectItem value="off">
										Not shown
										{!publicFlag.isPublic ? <MySelectItemIndicator /> : null}
									</MySelectItem>
								</MySelectPopoverContent>
							</MySelectPopover>
						</MySelect>
					) : null}
				</div>
			) : null}

			{publicError ? (
				<p className={"FilesShareModalLink-error" satisfies FilesShareModalLink_ClassNames} role="alert">
					{publicError}
				</p>
			) : null}
		</section>
	);
});
// #endregion link

// #region skeleton
type FilesShareModalSkeleton_ClassNames =
	| "FilesShareModalSkeleton"
	| "FilesShareModalSkeleton-add-principal"
	| "FilesShareModalSkeleton-add-level"
	| "FilesShareModalSkeleton-add-button"
	| "FilesShareModalSkeleton-icon"
	| "FilesShareModalSkeleton-name"
	| "FilesShareModalSkeleton-meta"
	| "FilesShareModalSkeleton-text"
	| "FilesShareModalSkeleton-link-level";

/**
 * Stands in for the dialog while it loads, in its most common shape: a file shared with nobody, so
 * the list has only the workspace row and the link is off.
 *
 * It uses the same section, add row, and source row classes as the loaded dialog, and each bar is as
 * tall as the text line or button it stands for. So that shape loads with no layout shift. A list
 * with added people, or a folder (no link section), still changes height when the data arrives.
 */
const FilesShareModalSkeleton = memo(function FilesShareModalSkeleton() {
	return (
		<div
			className={cn(
				"FilesShareModal-body" satisfies FilesShareModal_ClassNames,
				"FilesShareModalSkeleton" satisfies FilesShareModalSkeleton_ClassNames,
			)}
			role="status"
			aria-label="Loading sharing"
			aria-busy
		>
			<section className={"FilesShareModal-section" satisfies FilesShareModal_ClassNames}>
				<h3 className={"FilesShareModal-section-heading" satisfies FilesShareModal_ClassNames}>People with access</h3>
				<div className={"FilesShareModal-add" satisfies FilesShareModal_ClassNames}>
					<MySkeleton
						className={"FilesShareModalSkeleton-add-principal" satisfies FilesShareModalSkeleton_ClassNames}
					/>
					<MySkeleton className={"FilesShareModalSkeleton-add-level" satisfies FilesShareModalSkeleton_ClassNames} />
					<MySkeleton className={"FilesShareModalSkeleton-add-button" satisfies FilesShareModalSkeleton_ClassNames} />
				</div>
				<div className={"FilesShareModalSourceRow" satisfies FilesShareModalSourceRow_ClassNames}>
					<MySkeleton className={"FilesShareModalSkeleton-icon" satisfies FilesShareModalSkeleton_ClassNames} />
					<div className={"FilesShareModalSourceRow-main" satisfies FilesShareModalSourceRow_ClassNames}>
						<MySkeleton className={"FilesShareModalSkeleton-name" satisfies FilesShareModalSkeleton_ClassNames} />
						<MySkeleton className={"FilesShareModalSkeleton-meta" satisfies FilesShareModalSkeleton_ClassNames} />
					</div>
				</div>
			</section>

			<section className={"FilesShareModal-section" satisfies FilesShareModal_ClassNames}>
				<div className={"FilesShareModal-section-header" satisfies FilesShareModal_ClassNames}>
					<div className={"FilesShareModal-section-main" satisfies FilesShareModal_ClassNames}>
						<h3 className={"FilesShareModal-section-heading" satisfies FilesShareModal_ClassNames}>Public link</h3>
						<MySkeleton className={"FilesShareModalSkeleton-text" satisfies FilesShareModalSkeleton_ClassNames} />
					</div>
					<div className={"FilesShareModal-section-actions" satisfies FilesShareModal_ClassNames}>
						<MySkeleton className={"FilesShareModalSkeleton-link-level" satisfies FilesShareModalSkeleton_ClassNames} />
					</div>
				</div>
			</section>
		</div>
	);
});
// #endregion skeleton

// #region root
type FilesShareModal_ClassNames =
	| "FilesShareModal"
	| "FilesShareModal-body"
	| "FilesShareModal-section"
	| "FilesShareModal-section-header"
	| "FilesShareModal-section-main"
	| "FilesShareModal-section-heading"
	| "FilesShareModal-section-text"
	| "FilesShareModal-section-actions"
	| "FilesShareModal-confirm"
	| "FilesShareModal-subheading"
	| "FilesShareModal-add"
	| "FilesShareModal-add-principal-trigger"
	| "FilesShareModal-add-level-trigger"
	| "FilesShareModal-list"
	| "FilesShareModal-unavailable";

/**
 * One change the dialog can make. Removing the workspace row restricts the item, and adding it back
 * from the picker unrestricts it.
 */
type FilesShareModalChange =
	| { kind: "restrict" }
	| { kind: "unrestrict" }
	| {
			kind: "set";
			principal: FilesSharePrincipal;
			level: access_control_FileShareLevel;
			/** The add picker started it, so a yes clears the picker. */
			fromPicker: boolean;
	  }
	| { kind: "remove"; principal: FilesSharePrincipal };

type FilesShareModal_CustomAttributes = {
	"data-share-confirm": FilesShareModalChange["kind"];
};

export type FilesShareModal_Props = {
	/** The node the dialog is about. `null` keeps it closed. */
	nodeId: app_convex_Id<"files_nodes"> | null;
	onClose: () => void;
};

/** One row the server sends, on this node or on a folder above. */
type FilesShareModalServerEntry = NonNullable<
	NonNullable<
		app_convex_FunctionReturnType<typeof app_convex_api.files_sharing.get_node_share_state>
	>["inheritedFrom"]["extended"][number]["entries"]
>[number];

/** The picker value of the workspace row, or of the restricted folder above, when it can be added back. */
const FILES_SHARE_BASE_VALUE = "base";

/** A name that has not arrived, or that failed to load, reads the same way the file tree writes it. */
function read_display_name(
	value: app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error,
) {
	return value == null || value instanceof Error ? "Unknown" : value.displayName;
}

/** Higher means more access. No access is -1. */
function level_rank(level: access_control_FileShareLevel | null) {
	return level === null ? -1 : access_control_FILE_SHARE_LEVEL_KEYS.indexOf(level);
}

/** "Ana", "Ana and you", "Ana, Bo, and you". */
function join_names(names: string[]) {
	return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/** Capitalize the first letter, for a sentence that starts with "you". */
function sentence_case(text: string) {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

export const FilesShareModal = memo(function FilesShareModal(props: FilesShareModal_Props) {
	const { nodeId, onClose } = props;

	const { organizationId, workspaceId, membershipId } = AppTenantProvider.useContext();

	// Set when the user steps from a node up to the restricted folder that decides its access. It is
	// keyed by the node it was opened from, so opening the dialog on another node drops it without an
	// effect.
	const [scopeStep, setScopeStep] = useState<{
		fromNodeId: app_convex_Id<"files_nodes">;
		nodeId: app_convex_Id<"files_nodes">;
	} | null>(null);
	const viewNodeId = scopeStep && scopeStep.fromNodeId === nodeId ? scopeStep.nodeId : nodeId;

	const [addPrincipalValue, setAddPrincipalValue] = useState("");
	const [addLevel, setAddLevel] = useState<access_control_FileShareLevel>("read");
	/** The one row, or button, waiting for an answer. Every write here is a single small call. */
	const [pendingKey, setPendingKey] = useState<string | null>(null);
	/** Why the last public link write was refused, kept with the node it was about. */
	const [linkError, setLinkError] = useState<{ nodeId: app_convex_Id<"files_nodes">; message: string } | null>(null);
	/** Why the last public flag write was refused. Keyed by node, like `linkError`. */
	const [publicError, setPublicError] = useState<{ nodeId: app_convex_Id<"files_nodes">; message: string } | null>(
		null,
	);
	/** The change waiting for a yes, because it takes access away. Keyed by node, like `linkError`. */
	const [changeConfirm, setChangeConfirm] = useState<{
		nodeId: app_convex_Id<"files_nodes">;
		change: FilesShareModalChange;
	} | null>(null);
	const listRef = useRef<HTMLUListElement>(null);
	/** Where focus goes when the write a button started replaces the branch that button lived in. */
	const dialogRef = useRef<HTMLDivElement>(null);
	const addPrincipalTriggerRef = useRef<HTMLButtonElement>(null);

	const shareState = useQuery(
		app_convex_api.files_sharing.get_node_share_state,
		viewNodeId ? { membershipId, nodeId: viewNodeId } : "skip",
	);
	const workspaceUserIds = useQuery(
		app_convex_api.organizations.list_organization_workspace_users,
		viewNodeId ? { organizationId, workspaceId } : "skip",
	);
	// Any active member may read this, so the picker can show custom role names to everybody. The
	// server still refuses a change the caller is not allowed to make.
	const customRoles = useQuery(app_convex_api.access_control.list_roles, viewNodeId ? { organizationId } : "skip");
	const serviceAccounts = usePaginatedQuery(
		app_convex_api.access_control.list_service_accounts,
		viewNodeId ? { membershipId, includeRevoked: false } : "skip",
		{ initialNumItems: 50 },
	);

	// Everybody the dialog has to name: the workspace members it can offer, the owner's fixed row, and
	// anybody already on the list who has since left the workspace.
	// The react compiler cannot memoize a value built from a hook result, so these two are by hand.
	const namedUserIds = useMemo(() => {
		const userIds = new Set<app_convex_Id<"users">>(workspaceUserIds ?? []);
		if (shareState) {
			userIds.add(shareState.organizationOwnerUserId);
			// The people on this node, and the people on the folders above it when the server sent them.
			for (const entry of [
				...shareState.entries,
				...[shareState.inheritedFrom.restricted, ...shareState.inheritedFrom.extended].flatMap(
					(folder) => folder?.entries ?? [],
				),
			]) {
				if (entry.principal.kind === "user") {
					userIds.add(entry.principal.userId);
				}
			}
			// The link keeps working after its creator leaves, and the dialog still names them.
			if (shareState.link) {
				userIds.add(shareState.link.createdBy);
			}
		}

		return [...userIds];
	}, [workspaceUserIds, shareState]);

	const userAnagraphicQueryProps = useMemo(
		() =>
			Object.fromEntries(
				namedUserIds.map(
					(userId) =>
						[
							userId,
							{
								query: app_convex_api.users.get_anagraphic,
								args: { userId },
							},
						] as const,
				),
			),
		[namedUserIds],
	);

	const userAnagraphicDict = useQueries(userAnagraphicQueryProps) as Record<
		app_convex_Id<"users">,
		app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error
	>;

	// The workspace row, or the row of the restricted folder above. It is missing exactly when this item
	// is restricted itself.
	const hasBaseRow = shareState?.access !== "restricted_root";
	const baseScope = shareState?.baseScope ?? null;
	const baseLabel = baseScope ? `People with access to ${baseScope.name}` : "Everyone in this workspace";
	const baseAddLabel = baseScope ? `Add access from ${baseScope.name}` : "Add workspace access";

	// Added people get view or edit only. "Can manage" is for a restricted root, so a choice kept from
	// one falls back to "Can view" when the node stops being one.
	const shareLevels = !hasBaseRow
		? access_control_FILE_SHARE_LEVEL_KEYS
		: access_control_FILE_SHARE_LEVEL_KEYS.filter((levelKey) => levelKey !== "manage");
	const addLevelValue = shareLevels.includes(addLevel) ? addLevel : "read";

	const handleClose = useFn(() => {
		if (pendingKey) {
			return;
		}

		setScopeStep(null);
		setAddPrincipalValue("");
		setAddLevel("read");
		setLinkError(null);
		setPublicError(null);
		setChangeConfirm(null);
		onClose();
	});

	/** Every write here answers the same way, so they all report through this. */
	const runShareWrite = useFn(
		(args: {
			key: string;
			request: Promise<{ _nay?: { message: string } }>;
			successMessage: string;
			/** Runs only when the server said yes, so a refusal leaves the form as the user left it. */
			onDone?: () => void;
			/** Shows a refusal beside its control instead of in a toast. */
			onRefused?: (message: string) => void;
		}) => {
			setPendingKey(args.key);
			args.request
				.then((result) => {
					if (result._nay) {
						console.error("[FilesShareModal.runShareWrite] Failed to change sharing:", {
							error: result._nay,
							nodeId: viewNodeId,
							key: args.key,
						});
						// The server message is the real reason: the last manager, a level the caller cannot give
						// away, or a person who left the workspace. A generic "Failed" would leave them stuck.
						if (args.onRefused) {
							args.onRefused(result._nay.message);
						} else {
							toast.error(result._nay.message);
						}
						return;
					}

					toast.success(args.successMessage);
					args.onDone?.();
				})
				.catch((error) => {
					console.error("[FilesShareModal.runShareWrite] Failed to change sharing:", {
						error,
						nodeId: viewNodeId,
						key: args.key,
					});
					toast.error("Failed to change sharing");
				})
				.finally(() => {
					setPendingKey(null);
				});
		},
	);

	/** Send one change. `fromConfirm` says the yes button of the confirm box started it. */
	const runChange = useFn((change: FilesShareModalChange, fromConfirm: boolean) => {
		if (!viewNodeId || pendingKey) {
			return;
		}

		// The button that started the change goes away with the confirm box, or with the branch the new
		// state replaces, so focus would fall to the page. Put it somewhere that is always there.
		const focusDialog = () => {
			setChangeConfirm(null);
			dialogRef.current?.focus();
		};
		// Clearing the picker disables Add, so focus would fall to the page. The picker is where the next
		// one is chosen, and somebody sharing a file usually adds more than one.
		const resetPicker = () => {
			setChangeConfirm(null);
			setAddPrincipalValue("");
			addPrincipalTriggerRef.current?.focus();
		};

		if (change.kind === "restrict") {
			runShareWrite({
				key: "restrict",
				request: app_convex.mutation(app_convex_api.files_sharing.restrict_node, { membershipId, nodeId: viewNodeId }),
				successMessage: "Access restricted",
				onDone: focusDialog,
			});
		} else if (change.kind === "unrestrict") {
			runShareWrite({
				key: "add",
				request: app_convex.mutation(app_convex_api.files_sharing.unrestrict_node, {
					membershipId,
					nodeId: viewNodeId,
				}),
				successMessage: baseScope ? "Access added" : "Workspace access added",
				onDone: resetPicker,
			});
		} else if (change.kind === "set") {
			runShareWrite({
				key: change.fromPicker ? "add" : files_share_principal_value(change.principal),
				request: app_convex.mutation(app_convex_api.files_sharing.set_node_share_grant, {
					membershipId,
					nodeId: viewNodeId,
					principal: change.principal,
					level: change.level,
				}),
				successMessage: change.fromPicker ? "Access granted" : "Access updated",
				onDone: change.fromPicker ? resetPicker : fromConfirm ? focusDialog : undefined,
			});
		} else {
			runShareWrite({
				key: files_share_principal_value(change.principal),
				request: app_convex.mutation(app_convex_api.files_sharing.remove_node_share_grant, {
					membershipId,
					nodeId: viewNodeId,
					principal: change.principal,
				}),
				successMessage: "Access removed",
				// The row holding the focused button is gone now, so focus would fall to the page and a
				// keyboard user would be left outside the dialog. The list is the nearest thing still there,
				// and it announces itself by its label.
				onDone: () => {
					setChangeConfirm(null);
					listRef.current?.focus();
				},
			});
		}
	});

	const handleLinkEnabledChange = useFn((enabled: boolean) => {
		if (!viewNodeId || pendingKey) {
			return;
		}

		setLinkError(null);
		runShareWrite({
			key: "link",
			request: app_convex.mutation(app_convex_api.files_sharing.set_node_share_link, {
				membershipId,
				nodeId: viewNodeId,
				enabled,
			}),
			successMessage: enabled ? "Public link created" : "Public link turned off",
			// Turning a link on can be refused for this file only (a running job, or the workspace cap). Keep
			// that reason next to the select, so the user sees why it stayed off.
			onRefused: (message) => setLinkError({ nodeId: viewNodeId, message }),
		});
	});

	const handlePublicEnabledChange = useFn((enabled: boolean) => {
		if (!viewNodeId || pendingKey) {
			return;
		}

		setPublicError(null);
		runShareWrite({
			key: "public",
			request: app_convex.mutation(app_convex_api.files_sharing.set_node_public, {
				membershipId,
				nodeId: viewNodeId,
				enabled,
			}),
			successMessage: enabled ? "Shown inside public documents" : "Not shown in public documents",
			onRefused: (message) => setPublicError({ nodeId: viewNodeId, message }),
		});
	});

	const handleStepInto = useFn((folderNodeId: app_convex_Id<"files_nodes">) => {
		if (!nodeId) {
			return;
		}

		setScopeStep({ fromNodeId: nodeId, nodeId: folderNodeId });
		// The add form belongs to the node it was filled on. Kept, it would add that pick to the folder.
		setAddPrincipalValue("");
		setAddLevel("read");
		setChangeConfirm(null);
		// The step points the dialog at the folder and drops this button with the branch it was in, so park
		// focus on the dialog itself.
		dialogRef.current?.focus();
	});

	const canEditList = Boolean(shareState?.canAddPeople);
	const confirmChange = changeConfirm?.nodeId === viewNodeId ? changeConfirm.change : null;
	const nodeKindText = shareState?.nodeKind === "folder" ? "folder" : "file";
	const isOwner = Boolean(shareState && shareState.callerUserId === shareState.organizationOwnerUserId);
	const pluginName = shareState?.pluginArea?.pluginName ?? null;
	/** One write at a time. Every control says so, so nothing here is clickable but does nothing. */
	const busy = pendingKey !== null;

	// Wait for the names too, not only for the list. Rendering earlier would show every row as
	// "Unknown" and then swap the names in under the user's mouse.
	const loading =
		shareState === undefined ||
		workspaceUserIds === undefined ||
		customRoles === undefined ||
		namedUserIds.some((userId) => userAnagraphicDict[userId] === undefined);

	const roleName = (role: access_control_RoleRef) =>
		access_control_is_system_role(role)
			? access_control_SYSTEM_ROLE_MATRIX[role].label
			: (customRoles?.find((candidate) => candidate._id === role)?.name ?? "Deleted role");

	/** Rows with names: the caller first, then people, roles, and apps, each kind by name. */
	const nameEntries = <T extends FilesShareModalServerEntry>(list: T[]) =>
		list
			.map((entry) => ({
				...entry,
				principal: entry.principal as FilesSharePrincipal,
				isCaller: entry.principal.kind === "user" && entry.principal.userId === shareState?.callerUserId,
				name:
					entry.principal.kind === "user"
						? read_display_name(userAnagraphicDict[entry.principal.userId])
						: entry.principal.kind === "role"
							? roleName(entry.principal.role)
							: (entry.serviceAccountName ?? "App unavailable"),
			}))
			.sort((a, b) =>
				a.isCaller !== b.isCaller
					? a.isCaller
						? -1
						: 1
					: a.principal.kind === b.principal.kind
						? a.name.localeCompare(b.name)
						: a.principal.kind === "user"
							? -1
							: b.principal.kind === "user"
								? 1
								: a.principal.kind.localeCompare(b.principal.kind),
			);
	const entries = nameEntries(shareState?.entries ?? []);
	/** "Ada (Can view), Admin (Can edit)" for the people of a folder above. */
	const folderPeopleText = (folder: { name: string; entries: FilesShareModalServerEntry[] | null }) =>
		folder.entries
			? folder.entries.length === 0
				? "Nobody yet."
				: nameEntries(folder.entries)
						.map((entry) => `${entry.name} (${access_control_FILE_SHARE_LEVELS[entry.level].label})`)
						.join(", ")
			: `Change on ${folder.name}.`;

	const entryMeta = (entry: (typeof entries)[number]) =>
		entry.isCaller
			? "Your own access"
			: entry.principal.kind === "role"
				? "Everyone with this workspace role"
				: entry.servicePluginName
					? `Used by plugin ${entry.servicePluginName}: this also changes the folders the plugin can use.`
					: access_control_FILE_SHARE_LEVELS[entry.level].description;

	/**
	 * Where a row's other access comes from, in words. Workspace and folder sources count only while
	 * the base row is there.
	 */
	const coverageSources = (
		coverage: NonNullable<NonNullable<typeof shareState>["callerCoverage"]>,
		principal: FilesSharePrincipal,
		baseRow: boolean,
	) =>
		[
			baseRow && coverage.base
				? {
						level: coverage.base,
						through: baseScope?.name ?? (principal.kind === "service_account" ? "workspace access" : "workspace role"),
					}
				: null,
			baseRow && coverage.folder ? { level: coverage.folder.level, through: coverage.folder.name } : null,
			coverage.role ? { level: coverage.role.level, through: roleName(coverage.role.role) } : null,
		].filter((source) => source !== null);

	const entryHint = (entry: (typeof entries)[number]) => {
		if (!entry.coverage) return null;
		const best = coverageSources(entry.coverage, entry.principal, hasBaseRow).reduce<{
			level: access_control_FileShareLevel;
			through: string;
		} | null>(
			(result, source) => (level_rank(source.level) > level_rank(result?.level ?? null) ? source : result),
			null,
		);
		return best && level_rank(best.level) > level_rank(entry.level)
			? `${access_control_FILE_SHARE_LEVELS[best.level].label} through ${best.through}`
			: null;
	};

	/**
	 * The caller's best level after `change` (or today, for null), and where it comes from. `through` is
	 * null for their own row. The owner always has full access and is never asked.
	 *
	 * Take the loaded state as an argument. The React Compiler reads every `shareState.x` path a
	 * closure uses on each render to check its cache, and `shareState` is undefined while it loads.
	 */
	const callerAccessAfter = (state: NonNullable<typeof shareState>, change: FilesShareModalChange | null) => {
		const baseRow = change?.kind === "unrestrict" ? true : hasBaseRow;
		// Added people cannot manage, so an unrestrict turns every manage on the list into edit.
		const listLevel = (principal: FilesSharePrincipal, level: access_control_FileShareLevel | null) => {
			const changed =
				(change?.kind === "set" || change?.kind === "remove") &&
				files_share_principal_value(change.principal) === files_share_principal_value(principal);
			const next = changed ? (change.kind === "set" ? change.level : null) : level;
			return change?.kind === "unrestrict" && next === "manage" ? "write" : next;
		};
		const callerPrincipal: FilesSharePrincipal = { kind: "user", userId: state.callerUserId };
		const sources: Array<{ level: access_control_FileShareLevel | null; through: string | null }> = [
			{
				level: listLevel(callerPrincipal, entries.find((entry) => entry.isCaller)?.level ?? null),
				through: null,
			},
			...entries
				.filter((entry) => entry.principal.kind === "role" && state.callerRoles.includes(entry.principal.role))
				.map((entry) => ({ level: listLevel(entry.principal, entry.level), through: entry.name })),
			...(state.callerCoverage
				? coverageSources({ ...state.callerCoverage, role: null }, callerPrincipal, baseRow)
				: []),
		];
		return sources.reduce((result, source) => (level_rank(source.level) > level_rank(result.level) ? source : result), {
			level: null,
			through: null,
		});
	};

	/** The confirm text for a change, or null when the change can go at once. */
	const confirmTextFor = (change: FilesShareModalChange) => {
		// Restrict never asks. Removing the workspace row is a clear choice, the caller keeps access, and the
		// list shows who still has access right after. Product decision, 2026-10-26.
		if (!shareState || change.kind === "restrict") return null;

		const lines: string[] = [];
		const linkLine =
			shareState.nodeKind === "file"
				? shareState.link
					? "The public link turns off. Changing who can open this always turns it off. You can turn it on again after."
					: null
				: shareState.linksInside
					? "Any public links in this folder turn off. You can turn them on again after."
					: null;
		const pluginLine = shareState.pluginArea?.isSelf
			? `${pluginName} keeps this list up to date. If you change it here, ${pluginName} stops updating it.`
			: null;

		if (change.kind === "unrestrict") {
			// Name everyone who can manage today and cannot after: added people get edit at most, and only
			// the workspace roles or the folder above can still give manage.
			const people: string[] = [];
			const apps: string[] = [];
			for (const entry of entries) {
				if (entry.isCaller || !entry.coverage) continue;
				const managesToday = entry.level === "manage" || entry.coverage.role?.level === "manage";
				const managesAfter = entry.coverage.base === "manage" || entry.coverage.folder?.level === "manage";
				if (managesToday && !managesAfter) {
					(entry.principal.kind === "service_account" ? apps : people).push(entry.name);
				}
			}
			if (
				!isOwner &&
				callerAccessAfter(shareState, null).level === "manage" &&
				callerAccessAfter(shareState, change).level !== "manage"
			) {
				people.push("you");
			}
			if (people.length > 0) lines.push(sentence_case(`${join_names(people)} can no longer change who has access.`));
			if (apps.length > 0) lines.push(`${join_names(apps)} can no longer manage this ${nodeKindText}.`);
			if (linkLine) lines.push(linkLine);
			if (pluginLine) lines.push(pluginLine);
			return lines.length > 0 ? { title: `${baseAddLabel}?`, lines, action: baseAddLabel } : null;
		}

		// A change of your own access asks first and says where you land.
		if (!isOwner) {
			const today = callerAccessAfter(shareState, null);
			const after = callerAccessAfter(shareState, change);
			if (level_rank(after.level) < level_rank(today.level)) {
				lines.push(
					after.level === null
						? "You'll lose access to this."
						: `You'll only be able to ${after.level === "read" ? "view" : "edit"} this${after.through ? `, through ${after.through}` : ""}.`,
				);
			}
		}
		if (pluginLine) lines.push(pluginLine);
		return lines.length > 0
			? {
					title: pluginLine ? "Change access?" : "Change your access?",
					lines,
					action: pluginLine ? "Change anyway" : change.kind === "remove" ? "Remove" : "Change",
				}
			: null;
	};

	/** Ask first when `confirmTextFor` has text for the change, otherwise send it now. */
	const requestChange = (change: FilesShareModalChange) => {
		if (!viewNodeId || pendingKey) {
			return;
		}

		if (confirmTextFor(change)) {
			setChangeConfirm({ nodeId: viewNodeId, change });
		} else {
			runChange(change, false);
		}
	};

	const handleAdd = () => {
		if (addPrincipalValue === FILES_SHARE_BASE_VALUE) {
			requestChange({ kind: "unrestrict" });
			return;
		}

		const principal = files_share_principal_from_value(addPrincipalValue);
		if (principal) {
			requestChange({ kind: "set", principal, level: addLevelValue, fromPicker: true });
		}
	};

	const confirmText = confirmChange ? confirmTextFor(confirmChange) : null;

	const takenPrincipalValues = new Set(entries.map((entry) => files_share_principal_value(entry.principal)));
	// The owner is left out: they already pass every check and hold no grant, so a row for them would
	// be a switch that changes nothing.
	const candidateUsers = (workspaceUserIds ?? [])
		.filter(
			(userId) =>
				userId !== shareState?.organizationOwnerUserId &&
				!takenPrincipalValues.has(files_share_principal_value({ kind: "user", userId })),
		)
		.map((userId) => ({ userId, name: read_display_name(userAnagraphicDict[userId]) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	// Offer roles only to a caller who can manage roles. Existing role rows can still be lowered or
	// removed, because those changes grant no new access.
	const candidateRoles = (
		!shareState?.canShareWithRoles
			? []
			: [
					...access_control_SYSTEM_ROLES.map((role) => ({ role: role as access_control_RoleRef })),
					...(customRoles ?? []).map((role) => ({ role: role._id as access_control_RoleRef })),
				]
	)
		.filter((candidate) => !takenPrincipalValues.has(files_share_principal_value({ kind: "role", ...candidate })))
		.map((candidate) => ({ role: candidate.role, name: roleName(candidate.role) }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const baseSelected = addPrincipalValue === FILES_SHARE_BASE_VALUE;
	const selectedPrincipal = files_share_principal_from_value(addPrincipalValue);
	const addDisabled =
		addPrincipalValue === "" ||
		busy ||
		(selectedPrincipal?.kind === "service_account" &&
			(!shareState?.canShareWithServiceAccounts || !shareState.serviceGrantableLevels.includes(addLevelValue)));
	const selectedCandidateName = baseSelected
		? baseLabel
		: !selectedPrincipal
			? null
			: selectedPrincipal.kind === "user"
				? read_display_name(userAnagraphicDict[selectedPrincipal.userId])
				: selectedPrincipal.kind === "role"
					? roleName(selectedPrincipal.role)
					: (serviceAccounts.results.find((account) => account._id === selectedPrincipal.serviceAccountId)?.name ??
						"App unavailable");

	// Removing the base row restricts the item. A plugin area and a missing edit permission block it,
	// and the row says why in text, not only in a tooltip.
	const baseRowNote = !shareState?.canManage
		? null
		: shareState.pluginArea && !shareState.pluginArea.isSelf
			? `${pluginName} decides who can open this folder.`
			: !shareState.canRestrict
				? "You need Can edit here to restrict this."
				: null;
	const canRemoveBaseRow = Boolean(shareState?.canManage && shareState.canRestrict && !shareState.pluginArea);

	return (
		<MyModal open={nodeId !== null} setOpen={(open) => !open && handleClose()}>
			{/* Escape must not close a dialog that is mid-write: `pendingKey` would stay set and the next
			    dialog would open frozen. Same rule as the role editor. */}
			<MyModalPopover
				ref={dialogRef}
				className={"FilesShareModal" satisfies FilesShareModal_ClassNames}
				hideOnEscape={!busy}
				data-files-share-modal=""
				unmountOnHide
			>
				<MyModalHeader>
					<MyModalHeading>{shareState ? `Share ${shareState.nodeName}` : "Share"}</MyModalHeading>
					<MyModalDescription>{`Only the people below can open this ${nodeKindText}.`}</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea>
					{loading ? (
						<FilesShareModalSkeleton />
					) : !shareState ? (
						<div className={"FilesShareModal-unavailable" satisfies FilesShareModal_ClassNames} role="alert">
							{/* `shareState` is null here, so its kind is unknown. Say neither. */}
							This is not available.
						</div>
					) : (
						<div className={"FilesShareModal-body" satisfies FilesShareModal_ClassNames}>
							{/* One list for everybody who can open this: the workspace (or the folder above), the
							    folders above with added people, the owner, and the people added here. Removing
							    the workspace row restricts the item, and the picker can add it back.
							    `data-share-scope` says which of the three states this is, so a browser test never
							    has to read the wording. */}
							<section
								aria-label="People with access"
								className={"FilesShareModal-section" satisfies FilesShareModal_ClassNames}
								data-share-scope={shareState.scope ? (shareState.scope.isSelf ? "self" : "inherited") : "open"}
								data-share-access={shareState.access}
							>
								<h3 className={"FilesShareModal-section-heading" satisfies FilesShareModal_ClassNames}>
									People with access
								</h3>

								{!shareState.canManage ? (
									<p className={"FilesShareModal-section-text" satisfies FilesShareModal_ClassNames}>
										Only people who can manage this can change access.
									</p>
								) : null}

								{canEditList ? (
									<div className={"FilesShareModal-add" satisfies FilesShareModal_ClassNames}>
										<MySelect value={addPrincipalValue} setValue={(value) => setAddPrincipalValue(value as string)}>
											{/* Stays enabled while its own add runs, same reason as a row's level trigger:
											    the add puts focus back here, and a disabled button cannot take it. */}
											<MySelectTrigger disabled={busy && pendingKey !== "add"}>
												<MyButton
													ref={addPrincipalTriggerRef}
													type="button"
													variant="outline"
													className={"FilesShareModal-add-principal-trigger" satisfies FilesShareModal_ClassNames}
													aria-label="Person, role, or app to add"
													data-share-add-principal={addPrincipalValue}
												>
													<span>{selectedCandidateName ?? "Add a person, role, or app"}</span>
													<MySelectOpenIndicator />
												</MyButton>
											</MySelectTrigger>
											<MySelectPopover unmountOnHide sameWidth>
												<MySelectPopoverScrollableArea>
													<MySelectPopoverContent>
														{/* The base row comes back from the same picker it was removed from. */}
														{!hasBaseRow ? (
															<MySelectItemsGroup>
																<MySelectItemsGroupText>{baseScope ? "Folder" : "Workspace"}</MySelectItemsGroupText>
																<MySelectItem
																	value={FILES_SHARE_BASE_VALUE}
																	data-share-principal={FILES_SHARE_BASE_VALUE}
																>
																	{baseLabel}
																	{baseSelected ? <MySelectItemIndicator /> : null}
																</MySelectItem>
															</MySelectItemsGroup>
														) : null}
														<MySelectItemsGroup separator={!hasBaseRow}>
															<MySelectItemsGroupText>People</MySelectItemsGroupText>
															{candidateUsers.length === 0 ? (
																<MySelectItemsGroupEmpty>Everyone is already on the list</MySelectItemsGroupEmpty>
															) : (
																candidateUsers.map((candidate) => {
																	const value = files_share_principal_value({
																		kind: "user",
																		userId: candidate.userId,
																	});

																	return (
																		<MySelectItem key={value} value={value} data-share-principal={value}>
																			{candidate.name}
																			{addPrincipalValue === value ? <MySelectItemIndicator /> : null}
																		</MySelectItem>
																	);
																})
															)}
														</MySelectItemsGroup>
														{shareState.canShareWithRoles ? (
															<MySelectItemsGroup separator>
																<MySelectItemsGroupText>Workspace roles</MySelectItemsGroupText>
																{candidateRoles.length === 0 ? (
																	<MySelectItemsGroupEmpty>Every role is already on the list</MySelectItemsGroupEmpty>
																) : (
																	candidateRoles.map((candidate) => {
																		const value = files_share_principal_value({
																			kind: "role",
																			role: candidate.role,
																		});

																		return (
																			<MySelectItem key={value} value={value} data-share-principal={value}>
																				{candidate.name}
																				{addPrincipalValue === value ? <MySelectItemIndicator /> : null}
																			</MySelectItem>
																		);
																	})
																)}
															</MySelectItemsGroup>
														) : null}
														{shareState.canShareWithServiceAccounts ? (
															<MySelectItemsGroup separator>
																<MySelectItemsGroupText>Apps</MySelectItemsGroupText>
																{serviceAccounts.results
																	.filter((account) => !takenPrincipalValues.has(`service_account:${account._id}`))
																	.map((account) => (
																		<MySelectItem
																			key={account._id}
																			value={`service_account:${account._id}`}
																			data-share-principal={`service_account:${account._id}`}
																		>
																			{account.name}
																		</MySelectItem>
																	))}
															</MySelectItemsGroup>
														) : null}
													</MySelectPopoverContent>
												</MySelectPopoverScrollableArea>
											</MySelectPopover>
										</MySelect>

										{shareState.canShareWithServiceAccounts &&
										(serviceAccounts.status === "CanLoadMore" || serviceAccounts.status === "LoadingMore") ? (
											<MyButton
												variant="ghost"
												disabled={serviceAccounts.status === "LoadingMore"}
												onClick={() => serviceAccounts.loadMore(50)}
											>
												Load more apps
											</MyButton>
										) : null}
										{/* The workspace row has no level of its own: each person's role decides. */}
										{!baseSelected ? (
											<MySelect
												value={addLevelValue}
												setValue={(value) => setAddLevel(value as access_control_FileShareLevel)}
											>
												<MySelectTrigger disabled={busy}>
													<MyButton
														type="button"
														variant="outline"
														className={"FilesShareModal-add-level-trigger" satisfies FilesShareModal_ClassNames}
														aria-label="Access level for the new person, role, or app"
														data-share-level={addLevelValue}
													>
														<span>{access_control_FILE_SHARE_LEVELS[addLevelValue].label}</span>
														<MySelectOpenIndicator />
													</MyButton>
												</MySelectTrigger>
												<MySelectPopover unmountOnHide>
													<MySelectPopoverContent>
														{shareLevels.map((levelKey) => (
															<MySelectItem
																key={levelKey}
																value={levelKey}
																data-share-level={levelKey}
																disabled={
																	selectedPrincipal?.kind === "service_account" &&
																	!shareState.serviceGrantableLevels.includes(levelKey)
																}
															>
																{access_control_FILE_SHARE_LEVELS[levelKey].label}
																{addLevelValue === levelKey ? <MySelectItemIndicator /> : null}
															</MySelectItem>
														))}
													</MySelectPopoverContent>
												</MySelectPopover>
											</MySelect>
										) : null}

										<MyButton disabled={addDisabled} aria-busy={pendingKey === "add" || undefined} onClick={handleAdd}>
											<Plus aria-hidden />
											{pendingKey === "add" ? "Adding..." : "Add"}
										</MyButton>
									</div>
								) : null}

								{canEditList && shareState.nodeKind === "folder" ? (
									<p className={"FilesShareModal-section-text" satisfies FilesShareModal_ClassNames}>
										They also get everything inside this folder, except restricted items inside it.
									</p>
								) : null}

								<ul
									ref={listRef}
									// Not reachable by Tab, but a remove can put focus here once the row a user was
									// standing on is gone.
									tabIndex={-1}
									className={"FilesShareModal-list" satisfies FilesShareModal_ClassNames}
									aria-label="People, roles, and apps with access"
								>
									{hasBaseRow ? (
										<FilesShareModalSourceRow
											source="base"
											folderNodeId={baseScope?.nodeId ?? null}
											name={baseLabel}
											meta={
												shareState.inheritedFrom.restricted
													? folderPeopleText(shareState.inheritedFrom.restricted)
													: "View and edit access depend on each person's workspace role."
											}
											note={baseRowNote}
										>
											{shareState.inheritedFrom.restricted?.entries ? (
												<MyButton
													variant="outline"
													disabled={busy}
													onClick={() => handleStepInto(shareState.inheritedFrom.restricted!.nodeId)}
												>
													Manage on {shareState.inheritedFrom.restricted.name}
												</MyButton>
											) : null}
											{canRemoveBaseRow ? (
												<MyIconButton
													variant="ghost_destructive"
													tooltip={baseScope ? `Remove access from ${baseScope.name}` : "Remove workspace access"}
													disabled={busy && pendingKey !== "restrict"}
													aria-busy={pendingKey === "restrict" || undefined}
													onClick={() => requestChange({ kind: "restrict" })}
												>
													<Trash2 aria-hidden />
												</MyIconButton>
											) : null}
										</FilesShareModalSourceRow>
									) : null}

									{/* Folders above with added people. Their people reach this item too, but are
									    changed on that folder. */}
									{hasBaseRow
										? shareState.inheritedFrom.extended.map((folder) => (
												<FilesShareModalSourceRow
													key={folder.nodeId}
													source="added"
													folderNodeId={folder.nodeId}
													name={`People added to ${folder.name}`}
													meta={folderPeopleText(folder)}
													note={null}
												>
													{folder.entries ? (
														<MyButton variant="outline" disabled={busy} onClick={() => handleStepInto(folder.nodeId)}>
															Manage on {folder.name}
														</MyButton>
													) : null}
												</FilesShareModalSourceRow>
											))
										: null}

									{/* The owner always gets in and holds no grant, so a restricted item shows a fixed row. */}
									{!hasBaseRow ? (
										<FilesShareModalEntry
											principal={{ kind: "user", userId: shareState.organizationOwnerUserId }}
											name={isOwner ? "You" : read_display_name(userAnagraphicDict[shareState.organizationOwnerUserId])}
											meta={isOwner ? "Owner" : "Organization owner"}
											hint={null}
											level={null}
											editable={false}
											pending={false}
											busy={busy}
											canRaiseRoleLevel={shareState.canShareWithRoles}
											onLevelChange={() => {}}
											onRemove={() => {}}
										/>
									) : null}

									{entries.map((entry) => (
										<FilesShareModalEntry
											key={files_share_principal_value(entry.principal)}
											principal={entry.principal}
											name={entry.isCaller ? "You" : entry.name}
											meta={entryMeta(entry)}
											hint={entryHint(entry)}
											level={entry.level}
											editable={
												canEditList &&
												(entry.principal.kind !== "service_account" || shareState.canShareWithServiceAccounts)
											}
											levels={shareLevels}
											grantableLevels={
												entry.principal.kind === "service_account" ? shareState.serviceGrantableLevels : undefined
											}
											pending={pendingKey === files_share_principal_value(entry.principal)}
											busy={busy}
											canRaiseRoleLevel={shareState.canShareWithRoles}
											onLevelChange={(principal, level) =>
												requestChange({ kind: "set", principal, level, fromPicker: false })
											}
											onRemove={(principal) => requestChange({ kind: "remove", principal })}
										/>
									))}
								</ul>

								{/* A change that costs something asks first and says what. Restrict never asks. */}
								{confirmChange && confirmText ? (
									<div
										className={"FilesShareModal-confirm" satisfies FilesShareModal_ClassNames}
										{...({ "data-share-confirm": confirmChange.kind } satisfies FilesShareModal_CustomAttributes)}
									>
										<h4 className={"FilesShareModal-subheading" satisfies FilesShareModal_ClassNames}>
											{confirmText.title}
										</h4>
										<div role="alert">
											{confirmText.lines.map((line) => (
												<p key={line} className={"FilesShareModal-section-text" satisfies FilesShareModal_ClassNames}>
													{line}
												</p>
											))}
										</div>
										<div className={"FilesShareModal-section-actions" satisfies FilesShareModal_ClassNames}>
											<MyButton
												variant="outline"
												disabled={busy}
												onClick={() => {
													setChangeConfirm(null);
													// The box with this button goes away, so focus would fall to the page.
													dialogRef.current?.focus();
												}}
											>
												Cancel
											</MyButton>
											<MyButton
												variant={confirmChange.kind === "unrestrict" ? undefined : "destructive"}
												disabled={busy}
												aria-busy={busy || undefined}
												onClick={() => runChange(confirmChange, true)}
											>
												{busy ? "Saving..." : confirmText.action}
											</MyButton>
										</div>
									</div>
								) : null}
							</section>

							{/* A link opens one file, never a folder, and only a manager may turn it on or off. An
							    image or video also shows its public flag to anybody who may edit it. */}
							{shareState.nodeKind === "file" && (shareState.canManage || shareState.public?.canChange) ? (
								<FilesShareModalLink
									link={
										!shareState.canManage
											? "hidden"
											: shareState.link
												? {
														token: shareState.link.token,
														createdAt: shareState.link.createdAt,
														creatorName: read_display_name(userAnagraphicDict[shareState.link.createdBy]),
													}
												: null
									}
									publicFlag={shareState.public}
									pending={pendingKey === "link"}
									publicPending={pendingKey === "public"}
									busy={busy}
									error={linkError?.nodeId === viewNodeId ? linkError.message : null}
									publicError={publicError?.nodeId === viewNodeId ? publicError.message : null}
									onEnabledChange={handleLinkEnabledChange}
									onPublicChange={handlePublicEnabledChange}
								/>
							) : null}
						</div>
					)}
				</MyModalScrollableArea>

				<MyModalFooter>
					<MyButton disabled={busy} onClick={handleClose}>
						Done
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger disabled={busy} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion root
