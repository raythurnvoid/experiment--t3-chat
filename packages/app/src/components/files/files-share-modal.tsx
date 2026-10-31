import "./files-share-modal.css";

import { useQueries, useQuery } from "convex/react";
import { Link2, Lock, Plug, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { CopyPathIcon } from "@/components/copy-path-icon.tsx";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
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
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { PrincipalPicker, type PrincipalPicker_Principal } from "@/components/principal-picker.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_time } from "@/lib/date.ts";
import { url_path_file_by_node_id, url_share_link } from "@/lib/urls.ts";
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
	principal: PrincipalPicker_Principal;
	name: string;
	/** The person's picture. Undefined for a role or an app, and for a person without one. */
	avatarUrl: string | undefined;
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
	onLevelChange: (principal: PrincipalPicker_Principal, level: access_control_FileShareLevel) => void;
	onRemove: (principal: PrincipalPicker_Principal) => void;
};

const FilesShareModalEntry = memo(function FilesShareModalEntry(props: FilesShareModalEntry_Props) {
	const {
		principal,
		name,
		avatarUrl,
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
			data-share-principal={PrincipalPicker.value(principal)}
			data-share-level={level ?? undefined}
		>
			{principal.kind === "user" ? (
				<MyAvatar size="32px" className={"FilesShareModalEntry-icon" satisfies FilesShareModalEntry_ClassNames}>
					<MyAvatarImage src={avatarUrl} alt={name} fallbackDelay={false} />
					<MyAvatarFallback>{compute_fallback_user_name(name)}</MyAvatarFallback>
				</MyAvatar>
			) : (
				<div className={"FilesShareModalEntry-icon" satisfies FilesShareModalEntry_ClassNames} aria-hidden>
					{principal.kind === "role" ? <ShieldCheck /> : <Plug />}
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
						{/* The row being saved keeps its value and uses `aria-disabled`, not `disabled`. A real
						    `disabled` drops keyboard focus to the page, and the user loses their place in the
						    list. `aria-disabled` keeps focus, and the trigger does not open while it is set.
						    `aria-busy` gives the wait cursor (`MyButton` CSS). */}
						<MySelectTrigger disabled={busy && !pending}>
							<MyButton
								type="button"
								variant="outline"
								className={cn(
									"FilesShareModalEntry-level-trigger" satisfies FilesShareModalEntry_ClassNames,
									pending && ("MyButton-state-disabled" satisfies MyButton_ClassNames),
								)}
								aria-label={`Access level for ${name}`}
								aria-disabled={pending || undefined}
								aria-busy={pending || undefined}
							>
								<span>{access_control_FILE_SHARE_LEVELS[level].label}</span>
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
	| "FilesShareModalSourceRow-actions";

type FilesShareModalSourceRow_CustomAttributes = {
	"data-share-source": "added";
	/** The folder this row is about. */
	"data-share-inherited": app_convex_Id<"files_nodes">;
};

type FilesShareModalSourceRow_Props = {
	folderNodeId: app_convex_Id<"files_nodes">;
	name: string;
	meta: string;
	children: ReactNode;
};

/**
 * A row for a folder above with added people. Its people reach this item too, but are changed on
 * that folder.
 */
const FilesShareModalSourceRow = memo(function FilesShareModalSourceRow(props: FilesShareModalSourceRow_Props) {
	const { folderNodeId, name, meta, children } = props;

	return (
		<li
			className={"FilesShareModalSourceRow" satisfies FilesShareModalSourceRow_ClassNames}
			{...({
				"data-share-source": "added",
				"data-share-inherited": folderNodeId,
			} satisfies FilesShareModalSourceRow_CustomAttributes)}
		>
			<div className={"FilesShareModalSourceRow-icon" satisfies FilesShareModalSourceRow_ClassNames} aria-hidden>
				<Lock />
			</div>
			<div className={"FilesShareModalSourceRow-main" satisfies FilesShareModalSourceRow_ClassNames}>
				<span className={"FilesShareModalSourceRow-name" satisfies FilesShareModalSourceRow_ClassNames}>{name}</span>
				<span className={"FilesShareModalSourceRow-meta" satisfies FilesShareModalSourceRow_ClassNames}>{meta}</span>
			</div>
			<div className={"FilesShareModalSourceRow-actions" satisfies FilesShareModalSourceRow_ClassNames}>{children}</div>
		</li>
	);
});
// #endregion source row

// #region general access
type FilesShareModalGeneral_ClassNames =
	| "FilesShareModalGeneral"
	| "FilesShareModalGeneral-row"
	| "FilesShareModalGeneral-icon"
	| "FilesShareModalGeneral-main"
	| "FilesShareModalGeneral-trigger"
	| "FilesShareModalGeneral-current"
	| "FilesShareModalGeneral-text"
	| "FilesShareModalGeneral-note"
	| "FilesShareModalGeneral-actions";

/**
 * `base`: the item takes the access of the workspace, or of the restricted folder above. `view`: it is
 * restricted, and everyone in the workspace can view it. `people`: only the people on the list.
 */
type FilesShareModalGeneral_Value = "base" | "view" | "people";

type FilesShareModalGeneral_CustomAttributes = {
	"data-share-general": FilesShareModalGeneral_Value;
};

type FilesShareModalGeneral_Props = {
	value: FilesShareModalGeneral_Value;
	options: Array<{ value: FilesShareModalGeneral_Value; label: string; disabled: boolean }>;
	/** Whether the current choice lets the whole workspace in, for the icon. */
	openToWorkspace: boolean;
	/** What the current choice means, in words. */
	text: string;
	/** Why the choice cannot change. Shown as text, so it is not only in a tooltip. */
	note: string | null;
	/** `false` shows the current choice as text, with no select. */
	editable: boolean;
	/** The change here is the one being saved. */
	pending: boolean;
	/** A write is running somewhere in the dialog, so this control may not start a second one. */
	busy: boolean;
	onValueChange: (value: FilesShareModalGeneral_Value) => void;
	/** "Manage on <folder>", beside the choice. */
	actions: ReactNode;
	/** The confirm box of a change started here. */
	children: ReactNode;
};

/**
 * Who can open the item, as one choice: the access it takes from above, everyone in the workspace as
 * viewers, or only the people on the list. Drive and Notion put the same choice under the people list.
 */
const FilesShareModalGeneral = memo(function FilesShareModalGeneral(props: FilesShareModalGeneral_Props) {
	const { value, options, openToWorkspace, text, note, editable, pending, busy, onValueChange, actions, children } =
		props;

	const label = options.find((option) => option.value === value)?.label;

	return (
		<section
			aria-label="General access"
			className={cn(
				"FilesShareModal-section" satisfies FilesShareModal_ClassNames,
				"FilesShareModalGeneral" satisfies FilesShareModalGeneral_ClassNames,
			)}
			{...({ "data-share-general": value } satisfies FilesShareModalGeneral_CustomAttributes)}
		>
			<h3 className={"FilesShareModal-section-heading" satisfies FilesShareModal_ClassNames}>General access</h3>

			<div className={"FilesShareModalGeneral-row" satisfies FilesShareModalGeneral_ClassNames}>
				<div className={"FilesShareModalGeneral-icon" satisfies FilesShareModalGeneral_ClassNames} aria-hidden>
					{openToWorkspace ? <Users /> : <Lock />}
				</div>

				<div className={"FilesShareModalGeneral-main" satisfies FilesShareModalGeneral_ClassNames}>
					{editable ? (
						<MySelect
							value={value}
							setValue={(nextValue) => {
								// Choosing what it already is changes nothing, so it sends nothing.
								if (nextValue !== value) {
									onValueChange(nextValue as FilesShareModalGeneral_Value);
								}
							}}
						>
							{/* Uses `aria-disabled` while its own write runs, same reason as a row's level trigger. */}
							<MySelectTrigger disabled={busy && !pending}>
								<MyButton
									type="button"
									variant="outline"
									className={cn(
										"FilesShareModalGeneral-trigger" satisfies FilesShareModalGeneral_ClassNames,
										pending && ("MyButton-state-disabled" satisfies MyButton_ClassNames),
									)}
									aria-label="Who can open this"
									aria-disabled={pending || undefined}
									aria-busy={pending || undefined}
								>
									<span>{label}</span>
									<MySelectOpenIndicator />
								</MyButton>
							</MySelectTrigger>
							<MySelectPopover unmountOnHide sameWidth>
								<MySelectPopoverContent>
									{options.map((option) => (
										<MySelectItem
											key={option.value}
											value={option.value}
											data-share-general={option.value}
											disabled={option.disabled}
										>
											{option.label}
											{option.value === value ? <MySelectItemIndicator /> : null}
										</MySelectItem>
									))}
								</MySelectPopoverContent>
							</MySelectPopover>
						</MySelect>
					) : (
						<span className={"FilesShareModalGeneral-current" satisfies FilesShareModalGeneral_ClassNames}>
							{label}
						</span>
					)}
					<span className={"FilesShareModalGeneral-text" satisfies FilesShareModalGeneral_ClassNames}>{text}</span>
					{note ? (
						<span className={"FilesShareModalGeneral-note" satisfies FilesShareModalGeneral_ClassNames}>{note}</span>
					) : null}
				</div>

				{actions ? (
					<div className={"FilesShareModalGeneral-actions" satisfies FilesShareModalGeneral_ClassNames}>{actions}</div>
				) : null}
			</div>

			{children}
		</section>
	);
});
// #endregion general access

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
							{/* Uses `aria-disabled` while its own write runs, same reason as a row's level trigger. */}
							<MySelectTrigger disabled={busy && !pending}>
								<MyButton
									type="button"
									variant="outline"
									className={cn(
										"FilesShareModalLink-level-trigger" satisfies FilesShareModalLink_ClassNames,
										pending && ("MyButton-state-disabled" satisfies MyButton_ClassNames),
									)}
									aria-label="Anyone with the link"
									aria-disabled={pending || undefined}
									aria-busy={pending || undefined}
								>
									<span>{levelLabel}</span>
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

						{linkOn ? (
							<CopyIconButton text={url_share_link({ token: link.token })} tooltipCopy="Copy public link" />
						) : null}
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
							{/* Uses `aria-disabled` while its own write runs, same reason as a row's level trigger. */}
							<MySelectTrigger disabled={busy && !publicPending}>
								<MyButton
									type="button"
									variant="outline"
									className={cn(
										"FilesShareModalLink-level-trigger" satisfies FilesShareModalLink_ClassNames,
										publicPending && ("MyButton-state-disabled" satisfies MyButton_ClassNames),
									)}
									aria-label="Inside public documents"
									aria-disabled={publicPending || undefined}
									aria-busy={publicPending || undefined}
								>
									<span>{publicFlag.isPublic ? "Shown" : "Not shown"}</span>
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

// #region copy
type FilesShareModalCopy_ClassNames = "FilesShareModalCopy" | "FilesShareModalCopy-preview";

type FilesShareModalCopy_Props = {
	nodeKindText: "file" | "folder";
	path: string;
	link: string;
};

/**
 * The item's path and its app link. Each row shows the exact text that its button copies. The app link
 * opens only for people with access. The public link above is the one for everybody else.
 */
const FilesShareModalCopy = memo(function FilesShareModalCopy(props: FilesShareModalCopy_Props) {
	const { nodeKindText, path, link } = props;

	return (
		<section
			aria-label="Path and link"
			className={cn(
				"FilesShareModal-section" satisfies FilesShareModal_ClassNames,
				"FilesShareModalCopy" satisfies FilesShareModalCopy_ClassNames,
			)}
		>
			<h3 className={"FilesShareModal-section-heading" satisfies FilesShareModal_ClassNames}>Path and link</h3>
			<p className={"FilesShareModal-section-text" satisfies FilesShareModal_ClassNames}>
				{`The link opens this ${nodeKindText} only for people with access.`}
			</p>

			{/* The rows use the people row layout, so the icons and text line up with the list above. */}
			<ul className={"FilesShareModal-list" satisfies FilesShareModal_ClassNames}>
				<li className={"FilesShareModalEntry" satisfies FilesShareModalEntry_ClassNames}>
					<div className={"FilesShareModalEntry-icon" satisfies FilesShareModalEntry_ClassNames} aria-hidden>
						<CopyPathIcon />
					</div>
					<div className={"FilesShareModalEntry-main" satisfies FilesShareModalEntry_ClassNames}>
						<span className={"FilesShareModalEntry-name" satisfies FilesShareModalEntry_ClassNames}>Path</span>
						<span className={"FilesShareModalCopy-preview" satisfies FilesShareModalCopy_ClassNames}>{path}</span>
					</div>
					<div className={"FilesShareModalEntry-actions" satisfies FilesShareModalEntry_ClassNames}>
						<CopyIconButton variant="ghost-highlightable" tooltipCopy="Copy path" text={path} />
					</div>
				</li>
				<li className={"FilesShareModalEntry" satisfies FilesShareModalEntry_ClassNames}>
					<div className={"FilesShareModalEntry-icon" satisfies FilesShareModalEntry_ClassNames} aria-hidden>
						<Link2 />
					</div>
					<div className={"FilesShareModalEntry-main" satisfies FilesShareModalEntry_ClassNames}>
						<span className={"FilesShareModalEntry-name" satisfies FilesShareModalEntry_ClassNames}>Link</span>
						<span className={"FilesShareModalCopy-preview" satisfies FilesShareModalCopy_ClassNames}>{link}</span>
					</div>
					<div className={"FilesShareModalEntry-actions" satisfies FilesShareModalEntry_ClassNames}>
						<CopyIconButton variant="ghost-highlightable" tooltipCopy="Copy link" text={link} />
					</div>
				</li>
			</ul>
		</section>
	);
});
// #endregion copy

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
	| "FilesShareModalSkeleton-general-level"
	| "FilesShareModalSkeleton-link-level";

/**
 * Stands in for the dialog while it loads, in its most common shape: a file shared with nobody, so
 * the list has only the owner row, General access is the workspace, and the link is off.
 *
 * It uses the same section, add row, entry row, and General access classes as the loaded dialog, and
 * each bar is as tall as the text line or button it stands for. So that shape loads with no layout
 * shift. A list with added people, or a folder (no link section), still changes height when the data
 * arrives.
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
				<div className={"FilesShareModalEntry" satisfies FilesShareModalEntry_ClassNames}>
					<MySkeleton className={"FilesShareModalSkeleton-icon" satisfies FilesShareModalSkeleton_ClassNames} />
					<div className={"FilesShareModalEntry-main" satisfies FilesShareModalEntry_ClassNames}>
						<MySkeleton className={"FilesShareModalSkeleton-name" satisfies FilesShareModalSkeleton_ClassNames} />
						<MySkeleton className={"FilesShareModalSkeleton-meta" satisfies FilesShareModalSkeleton_ClassNames} />
					</div>
				</div>
			</section>

			<section className={"FilesShareModal-section" satisfies FilesShareModal_ClassNames}>
				<h3 className={"FilesShareModal-section-heading" satisfies FilesShareModal_ClassNames}>General access</h3>
				<div className={"FilesShareModalGeneral-row" satisfies FilesShareModalGeneral_ClassNames}>
					<MySkeleton className={"FilesShareModalSkeleton-icon" satisfies FilesShareModalSkeleton_ClassNames} />
					<div className={"FilesShareModalGeneral-main" satisfies FilesShareModalGeneral_ClassNames}>
						<MySkeleton
							className={"FilesShareModalSkeleton-general-level" satisfies FilesShareModalSkeleton_ClassNames}
						/>
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

			<section className={"FilesShareModal-section" satisfies FilesShareModal_ClassNames}>
				<h3 className={"FilesShareModal-section-heading" satisfies FilesShareModal_ClassNames}>Path and link</h3>
				<MySkeleton className={"FilesShareModalSkeleton-text" satisfies FilesShareModalSkeleton_ClassNames} />
				<div className={"FilesShareModal-list" satisfies FilesShareModal_ClassNames}>
					{["path", "link"].map((row) => (
						<div key={row} className={"FilesShareModalEntry" satisfies FilesShareModalEntry_ClassNames}>
							<MySkeleton className={"FilesShareModalSkeleton-icon" satisfies FilesShareModalSkeleton_ClassNames} />
							<div className={"FilesShareModalEntry-main" satisfies FilesShareModalEntry_ClassNames}>
								<MySkeleton className={"FilesShareModalSkeleton-name" satisfies FilesShareModalSkeleton_ClassNames} />
								<MySkeleton className={"FilesShareModalSkeleton-meta" satisfies FilesShareModalSkeleton_ClassNames} />
							</div>
						</div>
					))}
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
	| "FilesShareModal-add-level-trigger"
	| "FilesShareModal-list"
	| "FilesShareModal-unavailable";

/**
 * One change the dialog can make. General access makes the first three: "Only people added" from the
 * workspace restricts the item, picking the workspace or the folder above unrestricts it, and
 * `workspace_view` turns "Everyone in this workspace can view" on or off.
 */
type FilesShareModalChange =
	| { kind: "restrict" }
	| { kind: "unrestrict" }
	| { kind: "workspace_view"; enabled: boolean }
	| {
			kind: "set";
			principal: PrincipalPicker_Principal;
			level: access_control_FileShareLevel;
			/** The add picker started it, so a yes clears the picker. */
			fromPicker: boolean;
	  }
	| { kind: "remove"; principal: PrincipalPicker_Principal };

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

/** A name that has not arrived, or that failed to load, reads the same way the file tree writes it. */
function read_display_name(
	value: app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error,
) {
	return value == null || value instanceof Error ? "Unknown" : value.displayName;
}

function read_avatar_url(
	value: app_convex_FunctionReturnType<typeof app_convex_api.users.get_anagraphic> | undefined | Error,
) {
	return value == null || value instanceof Error ? undefined : value.avatarUrl;
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

	const { organizationId, organizationName, workspaceName, membershipId } = AppTenantProvider.useContext();

	// Set when the user steps from a node up to the restricted folder that decides its access. It is
	// keyed by the node it was opened from, so opening the dialog on another node drops it without an
	// effect.
	const [scopeStep, setScopeStep] = useState<{
		fromNodeId: app_convex_Id<"files_nodes">;
		nodeId: app_convex_Id<"files_nodes">;
	} | null>(null);
	const viewNodeId = scopeStep && scopeStep.fromNodeId === nodeId ? scopeStep.nodeId : nodeId;

	const [addPrincipalValue, setAddPrincipalValue] = useState("");
	/** The text in the add field. A pick puts the picked name here. */
	const [addPrincipalText, setAddPrincipalText] = useState("");
	/** The level the user picked for the next add. Null until they pick one: the default depends on the item. */
	const [addLevel, setAddLevel] = useState<access_control_FileShareLevel | null>(null);
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
	const addPrincipalInputRef = useRef<HTMLInputElement>(null);

	const shareState = useQuery(
		app_convex_api.files_sharing.get_node_share_state,
		viewNodeId ? { membershipId, nodeId: viewNodeId } : "skip",
	);
	// Any active member may read this, so the picker can show custom role names to everybody. The
	// server still refuses a change the caller is not allowed to make.
	const customRoles = useQuery(app_convex_api.access_control.list_roles, viewNodeId ? { organizationId } : "skip");

	// Everybody the dialog has to name: the owner's fixed row, the people on the lists, and the link's
	// creator. The add picker reads its own names from the member search, one page at a time.
	// The react compiler cannot memoize a value built from a hook result, so these two are by hand.
	const namedUserIds = useMemo(() => {
		const userIds = new Set<app_convex_Id<"users">>();
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
	}, [shareState]);

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

	// The item takes the access of the workspace, or of the restricted folder above, exactly when it is
	// not restricted itself.
	const inheritsBase = shareState?.access !== "restricted_root";
	const workspaceView = Boolean(shareState?.workspaceView);
	const generalValue: FilesShareModalGeneral_Value = inheritsBase ? "base" : workspaceView ? "view" : "people";
	const baseScope = shareState?.baseScope ?? null;
	const baseLabel = baseScope ? `People with access to ${baseScope.name}` : "Everyone in this workspace";

	// Added people get view or edit only. "Can manage" is for a restricted root, so a choice kept from
	// one falls back to the default when the node stops being one. On a view-only item everyone can
	// already view, so a new person is most likely added to edit.
	const shareLevels = !inheritsBase
		? access_control_FILE_SHARE_LEVEL_KEYS
		: access_control_FILE_SHARE_LEVEL_KEYS.filter((levelKey) => levelKey !== "manage");
	const addLevelValue =
		addLevel && shareLevels.includes(addLevel) ? addLevel : generalValue === "view" ? "write" : "read";

	const handleClose = useFn(() => {
		if (pendingKey) {
			return;
		}

		setScopeStep(null);
		setAddPrincipalValue("");
		setAddPrincipalText("");
		setAddLevel(null);
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
			setAddPrincipalText("");
			addPrincipalInputRef.current?.focus();
		};

		// The General access select stays where it is after its change, and keeps focus. Only the confirm
		// box's yes button goes away.
		if (change.kind === "restrict") {
			runShareWrite({
				key: "general",
				request: app_convex.mutation(app_convex_api.files_sharing.restrict_node, { membershipId, nodeId: viewNodeId }),
				successMessage: "Access restricted",
				onDone: fromConfirm ? focusDialog : undefined,
			});
		} else if (change.kind === "unrestrict") {
			runShareWrite({
				key: "general",
				request: app_convex.mutation(app_convex_api.files_sharing.unrestrict_node, {
					membershipId,
					nodeId: viewNodeId,
				}),
				successMessage: `Changed to "${baseLabel}"`,
				onDone: fromConfirm ? focusDialog : undefined,
			});
		} else if (change.kind === "workspace_view") {
			runShareWrite({
				key: "general",
				request: app_convex.mutation(app_convex_api.files_sharing.set_node_workspace_view, {
					membershipId,
					nodeId: viewNodeId,
					enabled: change.enabled,
				}),
				successMessage: change.enabled ? "Everyone in this workspace can view" : "Access restricted",
				onDone: fromConfirm ? focusDialog : undefined,
			});
		} else if (change.kind === "set") {
			runShareWrite({
				key: change.fromPicker ? "add" : PrincipalPicker.value(change.principal),
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
				key: PrincipalPicker.value(change.principal),
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
			request: app_convex.mutation(app_convex_api.files_share_links.set_node_share_link, {
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
		setAddPrincipalText("");
		setAddLevel(null);
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
				principal: entry.principal as PrincipalPicker_Principal,
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
	/** "Everyone in this workspace (Can view), Ada (Can view), Admin (Can edit)" for a folder above. */
	const folderPeopleText = (folder: {
		name: string;
		entries: FilesShareModalServerEntry[] | null;
		workspaceView: boolean | null;
	}) => {
		if (!folder.entries) return `Change on ${folder.name}.`;

		const names = [
			...(folder.workspaceView ? [`Everyone in this workspace (${access_control_FILE_SHARE_LEVELS.read.label})`] : []),
			...nameEntries(folder.entries).map(
				(entry) => `${entry.name} (${access_control_FILE_SHARE_LEVELS[entry.level].label})`,
			),
		];
		return names.length === 0 ? "Nobody yet." : names.join(", ");
	};

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
	 * the item takes the access from above, and "Everyone in this workspace can view" only while it is on.
	 */
	const coverageSources = (
		coverage: NonNullable<NonNullable<typeof shareState>["callerCoverage"]>,
		principal: PrincipalPicker_Principal,
		general: FilesShareModalGeneral_Value,
	) =>
		[
			general === "base" && coverage.base
				? {
						level: coverage.base,
						through: baseScope?.name ?? (principal.kind === "service_account" ? "workspace access" : "workspace role"),
					}
				: null,
			general === "base" && coverage.folder ? { level: coverage.folder.level, through: coverage.folder.name } : null,
			general === "view" && coverage.workspace
				? { level: coverage.workspace, through: "Everyone in this workspace" }
				: null,
			coverage.role ? { level: coverage.role.level, through: roleName(coverage.role.role) } : null,
		].filter((source) => source !== null);

	const entryHint = (entry: (typeof entries)[number]) => {
		if (!entry.coverage) return null;
		const best = coverageSources(entry.coverage, entry.principal, generalValue).reduce<{
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
		const general: FilesShareModalGeneral_Value =
			change?.kind === "unrestrict"
				? "base"
				: change?.kind === "restrict"
					? "people"
					: change?.kind === "workspace_view"
						? change.enabled
							? "view"
							: "people"
						: generalValue;
		// Added people cannot manage, so an unrestrict turns every manage on the list into edit.
		const listLevel = (principal: PrincipalPicker_Principal, level: access_control_FileShareLevel | null) => {
			const changed =
				(change?.kind === "set" || change?.kind === "remove") &&
				PrincipalPicker.value(change.principal) === PrincipalPicker.value(principal);
			const next = changed ? (change.kind === "set" ? change.level : null) : level;
			return change?.kind === "unrestrict" && next === "manage" ? "write" : next;
		};
		const callerPrincipal: PrincipalPicker_Principal = { kind: "user", userId: state.callerUserId };
		const sources: Array<{ level: access_control_FileShareLevel | null; through: string | null }> = [
			{
				level: listLevel(callerPrincipal, entries.find((entry) => entry.isCaller)?.level ?? null),
				through: null,
			},
			...entries
				.filter((entry) => entry.principal.kind === "role" && state.callerRoles.includes(entry.principal.role))
				.map((entry) => ({ level: listLevel(entry.principal, entry.level), through: entry.name })),
			...(state.callerCoverage
				? coverageSources({ ...state.callerCoverage, role: null }, callerPrincipal, general)
				: []),
		];
		return sources.reduce((result, source) => (level_rank(source.level) > level_rank(result.level) ? source : result), {
			level: null,
			through: null,
		});
	};

	/** The confirm text for a change, or null when the change can go at once. */
	const confirmTextFor = (change: FilesShareModalChange) => {
		if (!shareState) return null;

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

		// Restricting asks only about the public links it ends. Otherwise it is a clear choice: the caller
		// keeps access, and the list shows who still has access right after. Product decision, 2026-10-26.
		// Turning on "can view" from the workspace restricts too, so it asks the same, in its own words.
		if (change.kind === "restrict") {
			return linkLine ? { title: "Restrict access?", lines: [linkLine], action: "Restrict" } : null;
		}
		if (change.kind === "workspace_view" && change.enabled && inheritsBase) {
			return linkLine
				? { title: 'Change to "Everyone in this workspace can view"?', lines: [linkLine], action: "Change" }
				: null;
		}

		// Only the grant changes, so no link ends and nobody on the list loses their own level.
		if (change.kind === "workspace_view") {
			return pluginLine ? { title: "Change access?", lines: [pluginLine], action: "Change anyway" } : null;
		}

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
			// Unrestricting deletes the workspace grant. Inside a restricted folder that does not let the
			// workspace in, the members who are not on that folder's list lose access.
			if (baseScope && workspaceView && !baseScope.workspaceView) {
				lines.push(`People in this workspace who cannot open ${baseScope.name} lose access.`);
			}
			if (linkLine) lines.push(linkLine);
			if (pluginLine) lines.push(pluginLine);
			return lines.length > 0 ? { title: `Change to "${baseLabel}"?`, lines, action: "Change" } : null;
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

		// A change that goes at once closes any other box, which asked about the state before it.
		if (confirmTextFor(change)) {
			setChangeConfirm({ nodeId: viewNodeId, change });
		} else {
			setChangeConfirm(null);
			runChange(change, false);
		}
	};

	const handleAdd = () => {
		const principal = PrincipalPicker.fromValue(addPrincipalValue);
		if (principal) {
			requestChange({ kind: "set", principal, level: addLevelValue, fromPicker: true });
		}
	};

	const handleGeneralChange = (value: FilesShareModalGeneral_Value) => {
		requestChange(
			value === "base"
				? { kind: "unrestrict" }
				: value === "view"
					? { kind: "workspace_view", enabled: true }
					: generalValue === "view"
						? { kind: "workspace_view", enabled: false }
						: { kind: "restrict" },
		);
	};

	const confirmText = confirmChange ? confirmTextFor(confirmChange) : null;

	const takenPrincipalValues = new Set(entries.map((entry) => PrincipalPicker.value(entry.principal)));
	// Offer roles only to a caller who can manage roles. Existing role rows can still be lowered or
	// removed, because those changes grant no new access.
	const pickerRoles = (
		!shareState?.canShareWithRoles
			? []
			: [
					...access_control_SYSTEM_ROLES.map((role) => role as access_control_RoleRef),
					...(customRoles ?? []).map((role) => role._id as access_control_RoleRef),
				]
	)
		.map((role) => ({ role, name: roleName(role) }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const selectedPrincipal = PrincipalPicker.fromValue(addPrincipalValue);
	const addDisabled =
		addPrincipalValue === "" ||
		busy ||
		(selectedPrincipal?.kind === "service_account" &&
			(!shareState?.canShareWithServiceAccounts || !shareState.serviceGrantableLevels.includes(addLevelValue)));

	// Typing after a pick starts a new search, so the old pick no longer stands.
	const handleAddTextChange = (text: string) => {
		setAddPrincipalText(text);
		setAddPrincipalValue("");
	};

	const handleAddPick = (value: string, name: string) => {
		setAddPrincipalText(name);
		setAddPrincipalValue(value);
	};

	// Leaving the access from above restricts the item. A plugin area above and a missing edit
	// permission block it, and General access says why in text, not only in a tooltip.
	const pluginDecides = Boolean(shareState?.pluginArea && !shareState.pluginArea.isSelf);
	const restrictBlocked = generalValue === "base" && !shareState?.canRestrict;
	const generalNote = !shareState?.canManage
		? null
		: pluginDecides
			? `${pluginName} decides who can open this folder.`
			: restrictBlocked
				? "You need Can edit here to restrict this."
				: null;
	// "Can view" for the whole workspace only goes on where the workspace has access above: no restricted
	// folder above, or one that the whole workspace can view too. Elsewhere it is offered only while it is
	// already on, so it can be turned off.
	const workspaceInAbove = baseScope === null || baseScope.workspaceView === true;
	const generalOptions = [
		{ value: "base" as const, label: baseLabel, disabled: false },
		...(workspaceInAbove || generalValue === "view"
			? [{ value: "view" as const, label: "Everyone in this workspace can view", disabled: restrictBlocked }]
			: []),
		{ value: "people" as const, label: "Only people added", disabled: restrictBlocked },
	];

	// A change that costs something asks first and says what. The box shows in the section whose
	// control started the change, so it appears next to that control.
	const confirmInGeneral =
		confirmChange?.kind === "restrict" ||
		confirmChange?.kind === "unrestrict" ||
		confirmChange?.kind === "workspace_view";
	const confirmBox =
		confirmChange && confirmText ? (
			<div
				className={"FilesShareModal-confirm" satisfies FilesShareModal_ClassNames}
				{...({ "data-share-confirm": confirmChange.kind } satisfies FilesShareModal_CustomAttributes)}
			>
				<h4 className={"FilesShareModal-subheading" satisfies FilesShareModal_ClassNames}>{confirmText.title}</h4>
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
						{confirmText.action}
					</MyButton>
				</div>
			</div>
		) : null;

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
					<MyModalDescription>{`Choose who can open this ${nodeKindText}.`}</MyModalDescription>
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
							{/* The people who can open this beside General access: the folders above with added
							    people, the owner, and the people added here. `data-share-scope` says which of the
							    three states this is, so a browser test never has to read the wording. */}
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
										{/* Stays enabled while its own add runs, same reason as a row's level trigger:
										    the add puts focus back here, and a disabled field cannot take it. */}
										<PrincipalPicker
											ref={addPrincipalInputRef}
											label="Person, role, or app to add"
											placeholder="Add a person, role, or app…"
											text={addPrincipalText}
											selectedValue={addPrincipalValue}
											takenValues={takenPrincipalValues}
											ownerUserId={shareState.organizationOwnerUserId}
											roles={pickerRoles}
											canPickApps={shareState.canShareWithServiceAccounts}
											disabled={busy && pendingKey !== "add"}
											onTextChange={handleAddTextChange}
											onPick={handleAddPick}
										/>
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

										{/* Keep the label while adding. `aria-busy` gives the wait cursor (`MyButton` CSS). */}
										<MyButton disabled={addDisabled} aria-busy={pendingKey === "add" || undefined} onClick={handleAdd}>
											<Plus aria-hidden />
											Add
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
									{/* Folders above with added people. Their people reach this item too, but are
									    changed on that folder. */}
									{inheritsBase
										? shareState.inheritedFrom.extended.map((folder) => (
												<FilesShareModalSourceRow
													key={folder.nodeId}
													folderNodeId={folder.nodeId}
													name={`People added to ${folder.name}`}
													meta={folderPeopleText(folder)}
												>
													{folder.entries ? (
														<MyButton variant="outline" disabled={busy} onClick={() => handleStepInto(folder.nodeId)}>
															Manage on {folder.name}
														</MyButton>
													) : null}
												</FilesShareModalSourceRow>
											))
										: null}

									{/* The owner always gets in and holds no grant, so they get a fixed row. It also keeps
									    the list from being empty. */}
									<FilesShareModalEntry
										principal={{ kind: "user", userId: shareState.organizationOwnerUserId }}
										name={isOwner ? "You" : read_display_name(userAnagraphicDict[shareState.organizationOwnerUserId])}
										avatarUrl={read_avatar_url(userAnagraphicDict[shareState.organizationOwnerUserId])}
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

									{entries.map((entry) => (
										<FilesShareModalEntry
											key={PrincipalPicker.value(entry.principal)}
											principal={entry.principal}
											name={entry.isCaller ? "You" : entry.name}
											avatarUrl={
												entry.principal.kind === "user"
													? read_avatar_url(userAnagraphicDict[entry.principal.userId])
													: undefined
											}
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
											pending={pendingKey === PrincipalPicker.value(entry.principal)}
											busy={busy}
											canRaiseRoleLevel={shareState.canShareWithRoles}
											onLevelChange={(principal, level) =>
												requestChange({ kind: "set", principal, level, fromPicker: false })
											}
											onRemove={(principal) => requestChange({ kind: "remove", principal })}
										/>
									))}
								</ul>

								{confirmBox && !confirmInGeneral ? confirmBox : null}
							</section>

							<FilesShareModalGeneral
								value={generalValue}
								options={generalOptions}
								openToWorkspace={generalValue === "view" || (generalValue === "base" && workspaceInAbove)}
								text={
									generalValue === "view"
										? "Everyone in this workspace can view this. People added with Can edit can change it."
										: generalValue === "people"
											? "Only the people above can open this."
											: shareState.inheritedFrom.restricted
												? folderPeopleText(shareState.inheritedFrom.restricted)
												: "Everyone in this workspace can open this. Their workspace role decides if they can edit."
								}
								note={generalNote}
								editable={shareState.canManage && !pluginDecides}
								pending={pendingKey === "general"}
								busy={busy}
								onValueChange={handleGeneralChange}
								actions={
									generalValue === "base" && shareState.inheritedFrom.restricted?.entries ? (
										<MyButton
											variant="outline"
											disabled={busy}
											onClick={() => handleStepInto(shareState.inheritedFrom.restricted!.nodeId)}
										>
											Manage on {shareState.inheritedFrom.restricted.name}
										</MyButton>
									) : null
								}
							>
								{confirmBox && confirmInGeneral ? confirmBox : null}
							</FilesShareModalGeneral>

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

							{/* Every reader gets these. They follow `viewNodeId`, so after a step up they copy the
							    folder the dialog shows now. */}
							<FilesShareModalCopy
								nodeKindText={nodeKindText}
								path={shareState.nodePath}
								link={`${window.location.origin}${url_path_file_by_node_id({ organizationName, workspaceName, nodeId: shareState.nodeId })}`}
							/>
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
