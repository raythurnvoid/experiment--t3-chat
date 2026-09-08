import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { memo, useId, useRef, useState } from "react";

import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyLink } from "@/components/my-link.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputHelperText,
	MyInputLabel,
} from "@/components/my-input.tsx";
import {
	MyModal,
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
	MySelectLabel,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import {
	access_control_FILE_SHARE_LEVEL_KEYS,
	access_control_FILE_SHARE_LEVELS,
	access_control_MAX_SERVICE_ACCOUNT_NAME_LENGTH,
	type access_control_FileShareLevel,
} from "../../../../../../shared/access-control.ts";

type Account = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.access_control.get_service_account>>;
type Grant = app_convex_FunctionReturnType<
	typeof app_convex_api.access_control.list_service_account_grants
>["page"][number];
type RouteServiceAccounts_ClassNames =
	| "RouteServiceAccounts"
	| "RouteServiceAccounts-header"
	| "RouteServiceAccounts-list"
	| "RouteServiceAccounts-item"
	| "RouteServiceAccounts-actions"
	| "RouteServiceAccounts-name"
	| "RouteServiceAccounts-description"
	| "RouteServiceAccounts-fields"
	| "RouteServiceAccounts-error";

const RouteServiceAccountsGrants = memo(function RouteServiceAccountsGrants(props: {
	account: Account;
	onClose: () => void;
}) {
	const { account, onClose } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const grants = usePaginatedQuery(
		app_convex_api.access_control.list_service_account_grants,
		{ membershipId, serviceAccountId: account._id },
		{ initialNumItems: 50 },
	);
	const [resourceKind, setResourceKind] = useState<"workspace" | "file">("workspace");
	const [path, setPath] = useState("");
	const [level, setLevel] = useState<access_control_FileShareLevel>("read");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const pathHelperId = useId();
	const node = useQuery(
		app_convex_api.files_nodes.get_authorized_by_path,
		resourceKind === "file" && path.startsWith("/") ? { membershipId, path } : "skip",
	);
	const management = useQuery(
		app_convex_api.access_control.get_service_account_grant_management_state,
		resourceKind === "workspace"
			? { membershipId, serviceAccountId: account._id, resource: { kind: "workspace" } }
			: node
				? { membershipId, serviceAccountId: account._id, resource: { kind: "file", nodeId: node.nodeId } }
				: "skip",
	);
	const canSet =
		management?.canManage === true && management.grantableLevels.includes(level) && account.revokedAt === null;

	const write = (resource: Grant["resource"], nextLevel: access_control_FileShareLevel | null) => {
		if (pending) return;
		setPending(true);
		setError(null);
		Promise.try(() =>
			nextLevel === null
				? app_convex.mutation(app_convex_api.access_control.remove_service_account_grant, {
						membershipId,
						serviceAccountId: account._id,
						resource,
					})
				: app_convex.mutation(app_convex_api.access_control.set_service_account_grant, {
						membershipId,
						serviceAccountId: account._id,
						resource,
						level: nextLevel,
					}),
		)
			.then((result) => {
				if (result._nay) setError(result._nay.message);
				else if (nextLevel === null) dialogRef.current?.focus();
			})
			.catch((caughtError: unknown) => {
				console.error("[RouteServiceAccountsGrants.write] Failed to change grant", {
					error: caughtError,
					serviceAccountId: account._id,
				});
				setError("Could not change the grant. Try again.");
			})
			.finally(() => setPending(false));
	};

	return (
		<MyModal
			open
			setOpen={(open) => {
				if (!open && !pending) onClose();
			}}
		>
			<MyModalPopover ref={dialogRef} tabIndex={-1} hideOnEscape={!pending} hideOnInteractOutside={!pending}>
				<MyModalHeader>
					<MyModalHeading>Access for {account.name}</MyModalHeading>
					<MyModalDescription>Grants allow access. File policies can still block writes.</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<div className={"RouteServiceAccounts-fields" satisfies RouteServiceAccounts_ClassNames}>
						{grants.status === "LoadingFirstPage" ? (
							<p role="status">Loading grants…</p>
						) : grants.results.length === 0 ? (
							<p>No grants yet.</p>
						) : (
							<ul
								className={"RouteServiceAccounts-list" satisfies RouteServiceAccounts_ClassNames}
								aria-label="Account grants"
							>
								{grants.results.map((grant) => (
									<li
										key={grant.resource.kind === "workspace" ? "workspace" : grant.resource.nodeId}
										className={"RouteServiceAccounts-item" satisfies RouteServiceAccounts_ClassNames}
									>
										<div>
											<strong className={"RouteServiceAccounts-name" satisfies RouteServiceAccounts_ClassNames}>
												{grant.file?.path ?? (grant.resource.kind === "workspace" ? "Workspace" : "Protected item")}
											</strong>
											<p className={"RouteServiceAccounts-description" satisfies RouteServiceAccounts_ClassNames}>
												{grant.resource.kind === "workspace"
													? "Unrestricted workspace content"
													: grant.file?.scope === "restricted_scope"
														? "This restricted scope"
														: "This item only"}
											</p>
										</div>
										<div className={"RouteServiceAccounts-actions" satisfies RouteServiceAccounts_ClassNames}>
											<MySelect
												value={grant.level}
												setValue={(next) => {
													if (grant.canManage && grant.grantableLevels.includes(next as access_control_FileShareLevel))
														void write(grant.resource, next as access_control_FileShareLevel);
												}}
											>
												<MySelectTrigger
													disabled={!grant.canManage || account.revokedAt !== null}
													aria-busy={pending || undefined}
												>
													<MyButton
														variant="outline"
														aria-label={`Access level for ${grant.file?.path ?? (grant.resource.kind === "workspace" ? "workspace" : "protected item")}`}
													>
														{access_control_FILE_SHARE_LEVELS[grant.level].label}
														<MySelectOpenIndicator />
													</MyButton>
												</MySelectTrigger>
												<MySelectPopover unmountOnHide>
													<MySelectPopoverContent>
														{access_control_FILE_SHARE_LEVEL_KEYS.map((key) => (
															<MySelectItem key={key} value={key} disabled={!grant.grantableLevels.includes(key)}>
																{access_control_FILE_SHARE_LEVELS[key].label}
															</MySelectItem>
														))}
													</MySelectPopoverContent>
												</MySelectPopover>
											</MySelect>
											<MyButton
												variant="ghost_destructive"
												disabled={!grant.canManage}
												aria-busy={pending || undefined}
												onClick={() => void write(grant.resource, null)}
											>
												Remove
											</MyButton>
										</div>
									</li>
								))}
							</ul>
						)}
						{grants.status === "CanLoadMore" || grants.status === "LoadingMore" ? (
							<MyButton variant="ghost" disabled={grants.status === "LoadingMore"} onClick={() => grants.loadMore(50)}>
								Load more grants
							</MyButton>
						) : null}
						{account.revokedAt === null ? (
							<form
								className={"RouteServiceAccounts-fields" satisfies RouteServiceAccounts_ClassNames}
								onSubmit={(event) => {
									event.preventDefault();
									if (canSet && management) void write(management.resource, level);
								}}
							>
								<h3>Add or change a grant</h3>
								<MySelect
									value={resourceKind}
									setValue={(next) => {
										if (!pending && (next === "workspace" || next === "file")) {
											setResourceKind(next);
											setError(null);
										}
									}}
								>
									<MySelectLabel>Resource</MySelectLabel>
									<MySelectTrigger>
										<MyButton variant="outline">
											{resourceKind === "workspace" ? "Workspace" : "File or folder"}
											<MySelectOpenIndicator />
										</MyButton>
									</MySelectTrigger>
									<MySelectPopover>
										<MySelectPopoverContent>
											<MySelectItem value="workspace">Workspace</MySelectItem>
											<MySelectItem value="file">File or folder</MySelectItem>
										</MySelectPopoverContent>
									</MySelectPopover>
								</MySelect>
								{resourceKind === "file" ? (
									<MyInput layout="stacked">
										<MyInputLabel>File or folder path</MyInputLabel>
										<MyInputBackground />
										<MyInputArea>
											<MyInputControl
												value={path}
												required
												placeholder="/logs"
												aria-describedby={pathHelperId}
												onChange={(event) => {
													if (!pending) {
														setPath(event.currentTarget.value);
														setError(null);
													}
												}}
											/>
										</MyInputArea>
										<MyInputBox />
										<MyInputHelperText>
											<span id={pathHelperId}>
												{path && node === null ? "This item is unavailable." : "Choose an existing path you can read."}
											</span>
										</MyInputHelperText>
									</MyInput>
								) : null}
								{management ? (
									<p>
										{management.resource.kind === "workspace"
											? "Unrestricted workspace content"
											: `${management.file?.path ?? "Protected item"} — ${management.file?.scope === "restricted_scope" ? "This restricted scope" : "This item only"}`}
									</p>
								) : null}
								<MySelect
									value={level}
									setValue={(next) => {
										if (
											!pending &&
											access_control_FILE_SHARE_LEVEL_KEYS.includes(next as access_control_FileShareLevel)
										)
											setLevel(next as access_control_FileShareLevel);
									}}
								>
									<MySelectLabel>Access level</MySelectLabel>
									<MySelectTrigger>
										<MyButton variant="outline">
											{access_control_FILE_SHARE_LEVELS[level].label}
											<MySelectOpenIndicator />
										</MyButton>
									</MySelectTrigger>
									<MySelectPopover>
										<MySelectPopoverContent>
											{access_control_FILE_SHARE_LEVEL_KEYS.map((key) => (
												<MySelectItem key={key} value={key} disabled={!management?.grantableLevels.includes(key)}>
													{access_control_FILE_SHARE_LEVELS[key].label}
												</MySelectItem>
											))}
										</MySelectPopoverContent>
									</MySelectPopover>
								</MySelect>
								{management?.canManage === false ? <p>You cannot manage access to this resource.</p> : null}
								<MyButton type="submit" variant="outline" disabled={!canSet} aria-busy={pending || undefined}>
									{pending ? "Saving…" : "Save grant"}
								</MyButton>
							</form>
						) : (
							<p>This account is revoked. It cannot use its grants.</p>
						)}
						{error ? (
							<p role="alert" className={"RouteServiceAccounts-error" satisfies RouteServiceAccounts_ClassNames}>
								{error}
							</p>
						) : null}
					</div>
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="ghost" disabled={pending} onClick={onClose}>
						Done
					</MyButton>
				</MyModalFooter>
			</MyModalPopover>
		</MyModal>
	);
});

function RouteServiceAccountsMembership() {
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const canManage = useQuery(app_convex_api.access_control.get_current_user_workspace_permission, {
		membershipId,
		permission: "workspace.service_accounts.manage",
	});
	const accounts = usePaginatedQuery(
		app_convex_api.access_control.list_service_accounts,
		canManage === true ? { membershipId, includeRevoked: true } : "skip",
		{ initialNumItems: 50 },
	);
	const [editor, setEditor] = useState<{ kind: "create" } | { kind: "rename" | "revoke"; account: Account } | null>(
		null,
	);
	const [grantAccountId, setGrantAccountId] = useState<app_convex_Id<"access_control_service_accounts"> | null>(null);
	const [name, setName] = useState("");
	const [touched, setTouched] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const createButtonRef = useRef<HTMLButtonElement>(null);
	const nameHelperId = useId();
	const grantAccount = useQuery(
		app_convex_api.access_control.get_service_account,
		grantAccountId ? { membershipId, serviceAccountId: grantAccountId } : "skip",
	);
	const validationMessage = name.trim() ? undefined : "Account name is required";
	const openEditor = (next: NonNullable<typeof editor>) => {
		setEditor(next);
		setName(next.kind === "create" ? "" : next.account.name);
		setTouched(false);
		setError(null);
	};
	const closeEditor = () => {
		if (!pending) {
			setEditor(null);
			setError(null);
		}
	};
	const save = () => {
		if (!editor || pending || canManage !== true) return;
		setTouched(true);
		if (editor.kind !== "revoke" && validationMessage) return;
		setPending(true);
		setError(null);
		const request =
			editor.kind === "create"
				? app_convex.mutation(app_convex_api.access_control.create_service_account, {
						membershipId,
						name: name.trim(),
					})
				: editor.kind === "rename"
					? app_convex.mutation(app_convex_api.access_control.rename_service_account, {
							membershipId,
							serviceAccountId: editor.account._id,
							name: name.trim(),
						})
					: app_convex.mutation(app_convex_api.access_control.revoke_service_account, {
							membershipId,
							serviceAccountId: editor.account._id,
						});
		request
			.then((result) => {
				if (result._nay) setError(result._nay.message);
				else setEditor(null);
			})
			.catch((caughtError: unknown) => {
				console.error("[RouteServiceAccounts.save] Failed to change account", { error: caughtError, membershipId });
				setError("Could not change the account. Try again.");
			})
			.finally(() => setPending(false));
	};

	return (
		<main
			className={cn(
				"RouteServiceAccounts" satisfies RouteServiceAccounts_ClassNames,
				"app-scrollable" satisfies AppClassName,
			)}
		>
			<header className={"RouteServiceAccounts-header" satisfies RouteServiceAccounts_ClassNames}>
				<div>
					<h1>Service accounts</h1>
					<p>Named identities for scripts and plugins in this workspace.</p>
				</div>
				<MyButton
					ref={createButtonRef}
					variant="outline"
					disabled={canManage !== true}
					onClick={() => openEditor({ kind: "create" })}
				>
					<Plus aria-hidden />
					Create account
				</MyButton>
			</header>
			{canManage === undefined ? (
				<p role="status">Loading accounts…</p>
			) : !canManage ? (
				<p role="alert">You don't have permission to manage service accounts.</p>
			) : (
				<>
					{accounts.status === "LoadingFirstPage" ? (
						<p role="status">Loading accounts…</p>
					) : accounts.results.length === 0 ? (
						<p>No service accounts yet. New accounts start without access grants.</p>
					) : (
						<ul
							className={"RouteServiceAccounts-list" satisfies RouteServiceAccounts_ClassNames}
							aria-label="Service accounts"
						>
							{accounts.results.map((account) => (
								<li
									key={account._id}
									data-service-account-id={account._id}
									className={"RouteServiceAccounts-item" satisfies RouteServiceAccounts_ClassNames}
								>
									<div>
										<strong className={"RouteServiceAccounts-name" satisfies RouteServiceAccounts_ClassNames}>
											{account.name}
										</strong>
										{account.revokedAt !== null ? <MyBadge variant="secondary">Revoked</MyBadge> : null}
									</div>
									<div className={"RouteServiceAccounts-actions" satisfies RouteServiceAccounts_ClassNames}>
										<MyButton variant="outline" onClick={() => setGrantAccountId(account._id)}>
											Manage grants
										</MyButton>
										<MyButton variant="ghost" onClick={() => openEditor({ kind: "rename", account })}>
											Rename
										</MyButton>
										{account.revokedAt === null ? (
											<>
												<MyLink
													variant="button-outline"
													to="/w/$organizationName/$workspaceName/api-keys"
													params={{ organizationName, workspaceName }}
													search={{ serviceAccountId: account._id }}
												>
													Create API key
												</MyLink>
												<MyButton variant="ghost_destructive" onClick={() => openEditor({ kind: "revoke", account })}>
													Revoke
												</MyButton>
											</>
										) : null}
									</div>
								</li>
							))}
						</ul>
					)}
					{accounts.status === "CanLoadMore" || accounts.status === "LoadingMore" ? (
						<MyButton
							variant="ghost"
							disabled={accounts.status === "LoadingMore"}
							onClick={() => accounts.loadMore(50)}
						>
							Load more accounts
						</MyButton>
					) : null}
				</>
			)}
			<MyModal
				open={editor !== null}
				setOpen={(open) => {
					if (!open) closeEditor();
				}}
			>
				<MyModalPopover hideOnEscape={!pending} hideOnInteractOutside={!pending} finalFocus={createButtonRef}>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<MyModalHeader>
							<MyModalHeading>
								{editor?.kind === "revoke"
									? "Revoke service account"
									: editor?.kind === "rename"
										? "Rename service account"
										: "Create service account"}
							</MyModalHeading>
							<MyModalDescription>
								{editor?.kind === "revoke"
									? `Revoke ${editor.account.name}? Its keys and plugin work will stop. Protected files keep their policies.`
									: "The account name is a label. Its identity stays the same when it is renamed."}
							</MyModalDescription>
						</MyModalHeader>
						<MyModalScrollableArea>
							{editor?.kind !== "revoke" ? (
								<MyInput layout="stacked" displayValidationMessage={touched ? validationMessage : undefined}>
									<MyInputLabel>Name</MyInputLabel>
									<MyInputBackground />
									<MyInputArea>
										<MyInputControl
											autoFocus
											value={name}
											required
											maxLength={access_control_MAX_SERVICE_ACCOUNT_NAME_LENGTH}
											validationMessage={validationMessage}
											aria-describedby={nameHelperId}
											onChange={(event) => {
												if (!pending) {
													setName(event.currentTarget.value);
													setError(null);
												}
											}}
											onBlur={() => setTouched(true)}
										/>
									</MyInputArea>
									<MyInputBox />
									<MyInputHelperText>
										<span id={nameHelperId}>
											{touched && validationMessage ? validationMessage : "For example, Build bot."}
										</span>
									</MyInputHelperText>
								</MyInput>
							) : null}
							{error ? (
								<p role="alert" className={"RouteServiceAccounts-error" satisfies RouteServiceAccounts_ClassNames}>
									{error}
								</p>
							) : null}
						</MyModalScrollableArea>
						<MyModalFooter>
							<MyButton variant="ghost" disabled={pending} onClick={closeEditor}>
								Cancel
							</MyButton>
							<MyButton
								type="submit"
								variant={editor?.kind === "revoke" ? "outline_destructive" : "outline"}
								aria-busy={pending || undefined}
							>
								{pending ? "Saving…" : editor?.kind === "revoke" ? "Revoke account" : "Save account"}
							</MyButton>
						</MyModalFooter>
					</form>
				</MyModalPopover>
			</MyModal>
			{grantAccount ? (
				<RouteServiceAccountsGrants
					key={grantAccount._id}
					account={grantAccount}
					onClose={() => setGrantAccountId(null)}
				/>
			) : null}
		</main>
	);
}

function RouteServiceAccounts() {
	const { membershipId } = AppTenantProvider.useContext();
	return <RouteServiceAccountsMembership key={membershipId} />;
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/service-accounts/")({
	component: RouteServiceAccounts,
});

export { Route };
