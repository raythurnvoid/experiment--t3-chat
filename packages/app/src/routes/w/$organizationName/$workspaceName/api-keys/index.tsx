import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import {
	AlertTriangle,
	CheckCircle2,
	Info,
	KeyRound,
	ListTree,
	Plus,
	RotateCw,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import {
	memo,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
} from "react";

import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
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
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import {
	MyTabs,
	MyTabsList,
	MyTabsPanel,
	MyTabsPanels,
	MyTabsTab,
} from "@/components/my-tabs.tsx";
import { TextMonospaceBlock } from "@/components/monospace-block/monospace-block-text.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionArgs,
	type app_convex_FunctionReturnType,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_fetch_main_api_url } from "@/lib/fetch.ts";
import { cn } from "@/lib/utils.ts";

const API_KEY_NAME_MAX_CHARS = 80;
const API_KEY_DATETIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});
const API_KEY_SCOPES = ["files:list", "files:read"] satisfies app_convex_FunctionArgs<
	typeof app_convex_api.public_api.api_credential_create
>["scopes"];

type RouteApiKeys_CredentialListResult = app_convex_FunctionReturnType<
	typeof app_convex_api.public_api.api_credentials_list
>;
type RouteApiKeys_Credential = NonNullable<RouteApiKeys_CredentialListResult["_yay"]>[number];

type RouteApiKeys_VerificationState =
	| { status: "idle" }
	| { status: "pending"; message: string }
	| { status: "success"; message: string }
	| { status: "error"; message: string };

type RouteApiKeys_Reveal = {
	credential: string;
	kind: "created" | "rotated";
};

function format_api_key_datetime(timestamp: number) {
	return Number.isFinite(timestamp) ? API_KEY_DATETIME_FORMATTER.format(timestamp) : "Unknown";
}

function validate_api_key_name(name: string) {
	const trimmedName = name.trim();
	if (!trimmedName) {
		return "API key name is required";
	}
	if (trimmedName.length > API_KEY_NAME_MAX_CHARS) {
		return `API key name must be ${API_KEY_NAME_MAX_CHARS} characters or fewer`;
	}
	return undefined;
}

async function verify_api_key(credential: string) {
	try {
		const response = await fetch(app_fetch_main_api_url("/api/v1/files/list"), {
			method: "POST",
			credentials: "omit",
			headers: {
				Authorization: `Bearer ${credential}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ path: "/", limit: 1 }),
		});

		if (response.status === 200) {
			return { status: "success", message: "Key verified. It can list files in this workspace." } as const;
		}
		if (response.status === 401) {
			return { status: "error", message: "This key is invalid or revoked." } as const;
		}
		if (response.status === 403) {
			return {
				status: "error",
				message: "The key is valid, but it cannot list files with its current permissions.",
			} as const;
		}
		if (response.status === 429) {
			return { status: "error", message: "Too many attempts. Try again shortly." } as const;
		}

		return { status: "error", message: "The API could not verify this key. Try again." } as const;
	} catch {
		return {
			status: "error",
			message: "Could not reach the API. Check your connection and try again.",
		} as const;
	}
}

// #region code block
type RouteApiKeysCodeBlock_ClassNames =
	| "RouteApiKeysCodeBlock"
	| "RouteApiKeysCodeBlock-header"
	| "RouteApiKeysCodeBlock-language";

type RouteApiKeysCodeBlock_Props = {
	language: string;
	label: string;
	code: string;
};

const RouteApiKeysCodeBlock = memo(function RouteApiKeysCodeBlock(props: RouteApiKeysCodeBlock_Props) {
	const { language, label, code } = props;

	return (
		<div className={"RouteApiKeysCodeBlock" satisfies RouteApiKeysCodeBlock_ClassNames}>
			<div className={"RouteApiKeysCodeBlock-header" satisfies RouteApiKeysCodeBlock_ClassNames}>
				<span className={"RouteApiKeysCodeBlock-language" satisfies RouteApiKeysCodeBlock_ClassNames}>
					{language}
				</span>
				<CopyIconButton variant="ghost-highlightable" text={code} tooltipCopy={`Copy ${label}`} />
			</div>
			<TextMonospaceBlock text={code} aria-label={label} maxHeight="28lh" />
		</div>
	);
});
// #endregion code block

// #region quick start
type RouteApiKeysQuickStart_ClassNames =
	| "RouteApiKeysQuickStart"
	| "RouteApiKeysQuickStart-header"
	| "RouteApiKeysQuickStart-title"
	| "RouteApiKeysQuickStart-description"
	| "RouteApiKeysQuickStart-tabs"
	| "RouteApiKeysQuickStart-notes"
	| "RouteApiKeysQuickStart-note";

const RouteApiKeysQuickStart = memo(function RouteApiKeysQuickStart() {
	const tabsId = `RouteApiKeysQuickStart-${useId()}`;
	const curlTabId = `${tabsId}-curl`;
	const nodeTabId = `${tabsId}-node`;
	const apiOrigin = new URL(app_fetch_main_api_url("/api/v1/files/list")).origin;
	const curlCode = `export T3_API_ORIGIN="${apiOrigin}"
export T3_API_KEY="pk_..."

curl --fail-with-body --silent --show-error \\
  --request POST "$T3_API_ORIGIN/api/v1/files/list" \\
  --header "Authorization: Bearer $T3_API_KEY" \\
  --header "Content-Type: application/json" \\
  --data '{"path":"/","recursive":true,"kind":"file","extension":"md","limit":100}'

curl --fail-with-body --silent --show-error \\
  --request POST "$T3_API_ORIGIN/api/v1/files/read" \\
  --header "Authorization: Bearer $T3_API_KEY" \\
  --header "Content-Type: application/json" \\
  --data '{"path":"/path/to/file.md"}'`;
	const nodeCode = `const apiOrigin = process.env.T3_API_ORIGIN ?? "${apiOrigin}";
const apiKey = process.env.T3_API_KEY;

if (!apiKey) throw new Error("T3_API_KEY is required");

async function post(path, body) {
  const response = await fetch(\`${"${apiOrigin}"}\${path}\`, {
    method: "POST",
    headers: {
      Authorization: \`Bearer ${"${apiKey}"}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(\`API request failed: ${"${response.status}"}\`);
  return response.json();
}

let cursor = null;
let firstMarkdownPath;
do {
  const result = await post("/api/v1/files/list", {
    path: "/",
    cursor,
    recursive: true,
    kind: "file",
    extension: "md",
    limit: 100,
  });
  firstMarkdownPath ??= result.items[0]?.path;
  cursor = result.cursor;
  if (result.isDone) break;
} while (true);

if (!firstMarkdownPath) throw new Error("No Markdown files found");
const file = await post("/api/v1/files/read", { path: firstMarkdownPath });
console.log(file.content);`;

	return (
		<section className={"RouteApiKeysQuickStart" satisfies RouteApiKeysQuickStart_ClassNames}>
			<header className={"RouteApiKeysQuickStart-header" satisfies RouteApiKeysQuickStart_ClassNames}>
				<h2 className={"RouteApiKeysQuickStart-title" satisfies RouteApiKeysQuickStart_ClassNames}>Use an API key</h2>
				<p className={"RouteApiKeysQuickStart-description" satisfies RouteApiKeysQuickStart_ClassNames}>
					Send the key as a Bearer token. List files first, then read one committed Markdown file by path.
				</p>
			</header>

			<div className={"RouteApiKeysQuickStart-tabs" satisfies RouteApiKeysQuickStart_ClassNames}>
				<MyTabs defaultSelectedId={curlTabId}>
					<MyTabsList aria-label="API example language">
						<MyTabsTab id={curlTabId}>curl</MyTabsTab>
						<MyTabsTab id={nodeTabId}>Node.js</MyTabsTab>
					</MyTabsList>
					<MyTabsPanels>
						<MyTabsPanel tabId={curlTabId}>
							<RouteApiKeysCodeBlock language="shell" label="curl API example" code={curlCode} />
						</MyTabsPanel>
						<MyTabsPanel tabId={nodeTabId}>
							<RouteApiKeysCodeBlock language="javascript" label="Node.js API example" code={nodeCode} />
						</MyTabsPanel>
					</MyTabsPanels>
				</MyTabs>
			</div>

			<div className={"RouteApiKeysQuickStart-notes" satisfies RouteApiKeysQuickStart_ClassNames}>
				<p className={"RouteApiKeysQuickStart-note" satisfies RouteApiKeysQuickStart_ClassNames}>
					<Info aria-hidden />
					API reads return committed Markdown content. Unsaved or pending changes are not returned.
				</p>
				<p className={"RouteApiKeysQuickStart-note" satisfies RouteApiKeysQuickStart_ClassNames}>
					<Info aria-hidden />
					Binary file upload is planned and is not available through this flow yet.
				</p>
			</div>
		</section>
	);
});
// #endregion quick start

// #region verification status
type RouteApiKeysVerificationStatus_ClassNames =
	| "RouteApiKeysVerificationStatus"
	| "RouteApiKeysVerificationStatus-state-pending"
	| "RouteApiKeysVerificationStatus-state-success"
	| "RouteApiKeysVerificationStatus-state-error";

const RouteApiKeysVerificationStatus = memo(function RouteApiKeysVerificationStatus(props: {
	state: RouteApiKeys_VerificationState;
}) {
	const { state } = props;
	if (state.status === "idle") return null;
	const stateClassName = `RouteApiKeysVerificationStatus-state-${state.status}` as const satisfies RouteApiKeysVerificationStatus_ClassNames;

	return (
		<div
			className={cn(
				"RouteApiKeysVerificationStatus" satisfies RouteApiKeysVerificationStatus_ClassNames,
				stateClassName,
			)}
			role={state.status === "error" ? "alert" : "status"}
			aria-live={state.status === "error" ? "assertive" : "polite"}
		>
			{state.status === "success" ? <CheckCircle2 aria-hidden /> : state.status === "error" ? <AlertTriangle aria-hidden /> : null}
			{state.message}
		</div>
	);
});
// #endregion verification status

// #region key list item
type RouteApiKeysListItem_ClassNames =
	| "RouteApiKeysListItem"
	| "RouteApiKeysListItem-main"
	| "RouteApiKeysListItem-titleRow"
	| "RouteApiKeysListItem-name"
	| "RouteApiKeysListItem-key"
	| "RouteApiKeysListItem-meta"
	| "RouteApiKeysListItem-metaItem"
	| "RouteApiKeysListItem-metaLabel"
	| "RouteApiKeysListItem-metaValue"
	| "RouteApiKeysListItem-scopes"
	| "RouteApiKeysListItem-actions";

type RouteApiKeysListItem_Props = {
	credential: RouteApiKeys_Credential;
	onRotate?: (credential: RouteApiKeys_Credential) => void;
	onRevoke?: (credential: RouteApiKeys_Credential) => void;
};

const RouteApiKeysListItem = memo(function RouteApiKeysListItem(props: RouteApiKeysListItem_Props) {
	const { credential, onRotate, onRevoke } = props;
	const active = credential.revokedAt === null;

	return (
		<li className={"RouteApiKeysListItem" satisfies RouteApiKeysListItem_ClassNames}>
			<div className={"RouteApiKeysListItem-main" satisfies RouteApiKeysListItem_ClassNames}>
				<div className={"RouteApiKeysListItem-titleRow" satisfies RouteApiKeysListItem_ClassNames}>
					<h3 className={"RouteApiKeysListItem-name" satisfies RouteApiKeysListItem_ClassNames}>{credential.name}</h3>
					<MyBadge variant={active ? "secondary" : "outline"}>{active ? "Active" : "Revoked"}</MyBadge>
				</div>
				<code className={"RouteApiKeysListItem-key" satisfies RouteApiKeysListItem_ClassNames}>
					{credential.obfuscatedValue}
				</code>
			</div>

			<dl className={"RouteApiKeysListItem-meta" satisfies RouteApiKeysListItem_ClassNames}>
				<div className={"RouteApiKeysListItem-metaItem" satisfies RouteApiKeysListItem_ClassNames}>
					<dt className={"RouteApiKeysListItem-metaLabel" satisfies RouteApiKeysListItem_ClassNames}>Created</dt>
					<dd className={"RouteApiKeysListItem-metaValue" satisfies RouteApiKeysListItem_ClassNames}>
						{format_api_key_datetime(credential.createdAt)}
					</dd>
				</div>
				<div className={"RouteApiKeysListItem-metaItem" satisfies RouteApiKeysListItem_ClassNames}>
					<dt className={"RouteApiKeysListItem-metaLabel" satisfies RouteApiKeysListItem_ClassNames}>Last used</dt>
					<dd className={"RouteApiKeysListItem-metaValue" satisfies RouteApiKeysListItem_ClassNames}>
						{credential.lastUsedAt === null ? "Never" : format_api_key_datetime(credential.lastUsedAt)}
					</dd>
				</div>
				{credential.revokedAt !== null ? (
					<div className={"RouteApiKeysListItem-metaItem" satisfies RouteApiKeysListItem_ClassNames}>
						<dt className={"RouteApiKeysListItem-metaLabel" satisfies RouteApiKeysListItem_ClassNames}>Revoked</dt>
						<dd className={"RouteApiKeysListItem-metaValue" satisfies RouteApiKeysListItem_ClassNames}>
							{format_api_key_datetime(credential.revokedAt)}
						</dd>
					</div>
				) : null}
			</dl>

			<div
				className={"RouteApiKeysListItem-scopes" satisfies RouteApiKeysListItem_ClassNames}
				role="group"
				aria-label="Permissions"
			>
				{credential.scopes.map((scope) => (
					<MyBadge key={scope} variant="outline">
						{scope === "files:list"
							? "List files"
							: scope === "files:read"
								? "Read file content"
								: scope}
					</MyBadge>
				))}
			</div>

			{active && onRotate && onRevoke ? (
				<div className={"RouteApiKeysListItem-actions" satisfies RouteApiKeysListItem_ClassNames}>
					<MyButton
						variant="outline"
						aria-label={`Rotate ${credential.name}`}
						onClick={() => onRotate(credential)}
					>
						<RotateCw aria-hidden />
						Rotate
					</MyButton>
					<MyButton
						variant="ghost_destructive"
						aria-label={`Revoke ${credential.name}`}
						onClick={() => onRevoke(credential)}
					>
						<Trash2 aria-hidden />
						Revoke
					</MyButton>
				</div>
			) : null}
		</li>
	);
});
// #endregion key list item

// #region key list
type RouteApiKeysList_ClassNames =
	| "RouteApiKeysList"
	| "RouteApiKeysList-header"
	| "RouteApiKeysList-title"
	| "RouteApiKeysList-description"
	| "RouteApiKeysList-items"
	| "RouteApiKeysList-revoked"
	| "RouteApiKeysList-revokedSummary"
	| "RouteApiKeysList-empty"
	| "RouteApiKeysList-emptyTitle"
	| "RouteApiKeysList-emptyDescription";

type RouteApiKeysList_Props = {
	activeCredentials: RouteApiKeys_Credential[];
	revokedCredentials: RouteApiKeys_Credential[];
	onCreate: () => void;
	onRotate: (credential: RouteApiKeys_Credential) => void;
	onRevoke: (credential: RouteApiKeys_Credential) => void;
};

const RouteApiKeysList = memo(function RouteApiKeysList(props: RouteApiKeysList_Props) {
	const { activeCredentials, revokedCredentials, onCreate, onRotate, onRevoke } = props;

	return (
		<section className={"RouteApiKeysList" satisfies RouteApiKeysList_ClassNames}>
			<header className={"RouteApiKeysList-header" satisfies RouteApiKeysList_ClassNames}>
				<h2 className={"RouteApiKeysList-title" satisfies RouteApiKeysList_ClassNames}>Your keys</h2>
				<p className={"RouteApiKeysList-description" satisfies RouteApiKeysList_ClassNames}>
					Only keys you created for this workspace are shown.
				</p>
			</header>

			{activeCredentials.length === 0 ? (
				<div className={"RouteApiKeysList-empty" satisfies RouteApiKeysList_ClassNames}>
					<KeyRound aria-hidden />
					<h3 className={"RouteApiKeysList-emptyTitle" satisfies RouteApiKeysList_ClassNames}>
						No active API keys for this workspace
					</h3>
					<p className={"RouteApiKeysList-emptyDescription" satisfies RouteApiKeysList_ClassNames}>
						Create a key to list files and read committed file content from a script.
					</p>
					<MyButton onClick={onCreate}>
						<Plus aria-hidden />
						Create API key
					</MyButton>
				</div>
			) : (
				<ul className={"RouteApiKeysList-items" satisfies RouteApiKeysList_ClassNames} aria-label="Active API keys">
					{activeCredentials.map((credential) => (
						<RouteApiKeysListItem
							key={credential.credentialId}
							credential={credential}
							onRotate={onRotate}
							onRevoke={onRevoke}
						/>
					))}
				</ul>
			)}

			{revokedCredentials.length > 0 ? (
				<details className={"RouteApiKeysList-revoked" satisfies RouteApiKeysList_ClassNames}>
					<summary className={"RouteApiKeysList-revokedSummary" satisfies RouteApiKeysList_ClassNames}>
						Recent revoked keys ({revokedCredentials.length})
					</summary>
					<ul className={"RouteApiKeysList-items" satisfies RouteApiKeysList_ClassNames} aria-label="Recent revoked API keys">
						{revokedCredentials.map((credential) => (
							<RouteApiKeysListItem key={credential.credentialId} credential={credential} />
						))}
					</ul>
				</details>
			) : null}
		</section>
	);
});
// #endregion key list

// #region create modal
type RouteApiKeysCreateModal_ClassNames =
	| "RouteApiKeysCreateModal"
	| "RouteApiKeysCreateModal-form"
	| "RouteApiKeysCreateModal-fields"
	| "RouteApiKeysCreateModal-permissions"
	| "RouteApiKeysCreateModal-permissionsTitle"
	| "RouteApiKeysCreateModal-permissionList"
	| "RouteApiKeysCreateModal-permission"
	| "RouteApiKeysCreateModal-permissionText"
	| "RouteApiKeysCreateModal-permissionTitle"
	| "RouteApiKeysCreateModal-permissionDescription";

type RouteApiKeysCreateModal_Props = {
	open: boolean;
	organizationName: string;
	workspaceName: string;
	name: string;
	validationMessage?: string;
	displayValidationMessage?: string;
	error?: string;
	pending: boolean;
	onOpenChange: (open: boolean) => void;
	onNameChange: (name: string) => void;
	onNameBlur: () => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

const RouteApiKeysCreateModal = memo(function RouteApiKeysCreateModal(props: RouteApiKeysCreateModal_Props) {
	const {
		open,
		organizationName,
		workspaceName,
		name,
		validationMessage,
		displayValidationMessage,
		error,
		pending,
		onOpenChange,
		onNameChange,
		onNameBlur,
		onSubmit,
	} = props;
	const helperId = `RouteApiKeysCreateModal-${useId()}-helper`;

	return (
		<MyModal open={open} setOpen={onOpenChange}>
			<MyModalPopover className={"RouteApiKeysCreateModal" satisfies RouteApiKeysCreateModal_ClassNames}>
				<form
					className={"RouteApiKeysCreateModal-form" satisfies RouteApiKeysCreateModal_ClassNames}
					noValidate
					onSubmit={onSubmit}
				>
					<MyModalHeader>
						<MyModalHeading>Create API key</MyModalHeading>
						<MyModalDescription>
							This key will work only in {organizationName}/{workspaceName}.
						</MyModalDescription>
					</MyModalHeader>
					<MyModalScrollableArea>
						<div className={"RouteApiKeysCreateModal-fields" satisfies RouteApiKeysCreateModal_ClassNames}>
							<MyInput layout="stacked" displayValidationMessage={displayValidationMessage}>
								<MyInputLabel>Name</MyInputLabel>
								<MyInputBackground />
								<MyInputArea>
									<MyInputControl
										value={name}
										placeholder="Local file reader"
										autoFocus
										required
										disabled={pending}
										aria-describedby={helperId}
										validationMessage={validationMessage}
										onChange={(event) => onNameChange(event.currentTarget.value)}
										onBlur={onNameBlur}
									/>
								</MyInputArea>
								<MyInputBox />
								<MyInputHelperText>
									<span id={helperId}>
										{displayValidationMessage ?? "Use a name that tells you where this key is used."}
									</span>
								</MyInputHelperText>
							</MyInput>

							<fieldset
								className={"RouteApiKeysCreateModal-permissions" satisfies RouteApiKeysCreateModal_ClassNames}
							>
								<legend
									className={
										"RouteApiKeysCreateModal-permissionsTitle" satisfies RouteApiKeysCreateModal_ClassNames
									}
								>
									Read-only file access
								</legend>
								<ul
									className={
										"RouteApiKeysCreateModal-permissionList" satisfies RouteApiKeysCreateModal_ClassNames
									}
								>
									<li className={"RouteApiKeysCreateModal-permission" satisfies RouteApiKeysCreateModal_ClassNames}>
										<ListTree aria-hidden />
										<span
											className={
												"RouteApiKeysCreateModal-permissionText" satisfies RouteApiKeysCreateModal_ClassNames
											}
										>
											<strong
												className={
													"RouteApiKeysCreateModal-permissionTitle" satisfies RouteApiKeysCreateModal_ClassNames
												}
											>
												List files
											</strong>
											<span
												className={
													"RouteApiKeysCreateModal-permissionDescription" satisfies RouteApiKeysCreateModal_ClassNames
												}
											>
												View file and folder names, paths, and metadata.
											</span>
										</span>
									</li>
									<li className={"RouteApiKeysCreateModal-permission" satisfies RouteApiKeysCreateModal_ClassNames}>
										<KeyRound aria-hidden />
										<span
											className={
												"RouteApiKeysCreateModal-permissionText" satisfies RouteApiKeysCreateModal_ClassNames
											}
										>
											<strong
												className={
													"RouteApiKeysCreateModal-permissionTitle" satisfies RouteApiKeysCreateModal_ClassNames
												}
											>
												Read file content
											</strong>
											<span
												className={
													"RouteApiKeysCreateModal-permissionDescription" satisfies RouteApiKeysCreateModal_ClassNames
												}
											>
												Read committed Markdown content by path.
											</span>
										</span>
									</li>
								</ul>
							</fieldset>

							{error ? <div role="alert">{error}</div> : null}
						</div>
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
							Cancel
						</MyButton>
						<MyButton type="submit" disabled={pending} aria-busy={pending}>
							{pending ? "Creating..." : "Create API key"}
						</MyButton>
					</MyModalFooter>
				</form>
				<MyModalCloseTrigger disabled={pending} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion create modal

// #region reveal modal
type RouteApiKeysRevealModal_ClassNames =
	| "RouteApiKeysRevealModal"
	| "RouteApiKeysRevealModal-content"
	| "RouteApiKeysRevealModal-warning"
	| "RouteApiKeysRevealModal-secret"
	| "RouteApiKeysRevealModal-copy";

type RouteApiKeysRevealModal_Props = {
	reveal: RouteApiKeys_Reveal | null;
	verificationState: RouteApiKeys_VerificationState;
	onVerify: () => void;
	onClose: () => void;
};

const RouteApiKeysRevealModal = memo(function RouteApiKeysRevealModal(props: RouteApiKeysRevealModal_Props) {
	const { reveal, verificationState, onVerify, onClose } = props;
	const verifying = verificationState.status === "pending";

	return (
		<MyModal open={reveal !== null} setOpen={(open) => !open && onClose()}>
			<MyModalPopover className={"RouteApiKeysRevealModal" satisfies RouteApiKeysRevealModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>{reveal?.kind === "rotated" ? "Save your new API key" : "Save your API key"}</MyModalHeading>
					<MyModalDescription>This is the only time the full key will be shown.</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<div className={"RouteApiKeysRevealModal-content" satisfies RouteApiKeysRevealModal_ClassNames}>
						<div className={"RouteApiKeysRevealModal-warning" satisfies RouteApiKeysRevealModal_ClassNames}>
							<AlertTriangle aria-hidden />
							{reveal?.kind === "rotated"
								? "The old key has been revoked. Copy this replacement now and update every script that uses it."
								: "Copy this key now and store it somewhere safe."}
						</div>
						<div className={"RouteApiKeysRevealModal-secret" satisfies RouteApiKeysRevealModal_ClassNames}>
							<TextMonospaceBlock text={reveal?.credential} aria-label="New API key" maxHeight="6lh" />
							<CopyIconButton
								variant="outline"
								className={"RouteApiKeysRevealModal-copy" satisfies RouteApiKeysRevealModal_ClassNames}
								text={reveal?.credential}
								tooltipCopy="Copy API key"
							/>
						</div>
						<RouteApiKeysVerificationStatus state={verificationState} />
					</div>
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="outline" disabled={verifying || reveal === null} aria-busy={verifying} onClick={onVerify}>
						<ShieldCheck aria-hidden />
						{verifying ? "Testing..." : "Test key"}
					</MyButton>
					<MyButton onClick={onClose}>I saved the key</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion reveal modal

// #region confirmation modal
type RouteApiKeysConfirmationModal_ClassNames =
	| "RouteApiKeysConfirmationModal"
	| "RouteApiKeysConfirmationModal-content"
	| "RouteApiKeysConfirmationModal-key";

type RouteApiKeysConfirmationModal_Props = {
	kind: "rotate" | "revoke";
	target: RouteApiKeys_Credential | null;
	pending: boolean;
	error?: string;
	onClose: () => void;
	onConfirm: () => void;
};

const RouteApiKeysConfirmationModal = memo(function RouteApiKeysConfirmationModal(
	props: RouteApiKeysConfirmationModal_Props,
) {
	const { kind, target, pending, error, onClose, onConfirm } = props;
	const rotating = kind === "rotate";

	return (
		<MyModal open={target !== null} setOpen={(open) => !open && !pending && onClose()}>
			<MyModalPopover className={"RouteApiKeysConfirmationModal" satisfies RouteApiKeysConfirmationModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>
						{rotating ? `Rotate “${target?.name ?? "API key"}”?` : `Revoke “${target?.name ?? "API key"}”?`}
					</MyModalHeading>
					<MyModalDescription>
						{rotating
							? "The current key will stop working as soon as the new key is created. Update every script that uses it."
							: "This cannot be undone. Scripts using this key will stop working."}
					</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<div className={"RouteApiKeysConfirmationModal-content" satisfies RouteApiKeysConfirmationModal_ClassNames}>
						{target ? (
							<code className={"RouteApiKeysConfirmationModal-key" satisfies RouteApiKeysConfirmationModal_ClassNames}>
								{target.obfuscatedValue}
							</code>
						) : null}
						{error ? <div role="alert">{error}</div> : null}
					</div>
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="ghost" disabled={pending} onClick={onClose}>
						Cancel
					</MyButton>
					<MyButton variant="destructive" disabled={pending || target === null} aria-busy={pending} onClick={onConfirm}>
						{pending ? (rotating ? "Rotating..." : "Revoking...") : rotating ? "Rotate key" : "Revoke key"}
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger disabled={pending} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion confirmation modal

// #region header and security
type RouteApiKeysHeader_ClassNames =
	| "RouteApiKeysHeader"
	| "RouteApiKeysHeader-title"
	| "RouteApiKeysHeader-description"
	| "RouteApiKeysHeader-toolbar";

const RouteApiKeysHeader = memo(function RouteApiKeysHeader(props: { workspaceName: string; onCreate: () => void }) {
	const { workspaceName, onCreate } = props;

	return (
		<header className={"RouteApiKeysHeader" satisfies RouteApiKeysHeader_ClassNames}>
			<div>
				<h1 className={"RouteApiKeysHeader-title" satisfies RouteApiKeysHeader_ClassNames}>API keys</h1>
				<p className={"RouteApiKeysHeader-description" satisfies RouteApiKeysHeader_ClassNames}>
					Create API keys for scripts and tools that access files in {workspaceName}.
				</p>
			</div>
			<div className={"RouteApiKeysHeader-toolbar" satisfies RouteApiKeysHeader_ClassNames}>
				<MyButton onClick={onCreate}>
					<Plus aria-hidden />
					Create API key
				</MyButton>
			</div>
		</header>
	);
});

type RouteApiKeysSecurity_ClassNames = "RouteApiKeysSecurity" | "RouteApiKeysSecurity-content";

const RouteApiKeysSecurity = memo(function RouteApiKeysSecurity() {
	return (
		<aside className={"RouteApiKeysSecurity" satisfies RouteApiKeysSecurity_ClassNames}>
			<ShieldCheck aria-hidden />
			<div className={"RouteApiKeysSecurity-content" satisfies RouteApiKeysSecurity_ClassNames}>
				<strong>API keys belong to you and work only in this workspace.</strong>
				<span>They use your current file access and do not expire until revoked.</span>
				<span>Keep keys in an environment variable. Do not put them in source code, screenshots, chat, or browser storage.</span>
			</div>
		</aside>
	);
});
// #endregion header and security

// #region root
type RouteApiKeys_ClassNames =
	| "RouteApiKeys"
	| "RouteApiKeys-content"
	| "RouteApiKeys-loading"
	| "RouteApiKeys-error";

function RouteApiKeys() {
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();

	// Remount on a workspace change so secrets, modal state, and pending requests cannot cross tenant boundaries.
	return (
		<RouteApiKeysMembership
			key={membershipId}
			membershipId={membershipId}
			organizationName={organizationName}
			workspaceName={workspaceName}
		/>
	);
}

function RouteApiKeysMembership(props: {
	membershipId: app_convex_FunctionArgs<typeof app_convex_api.public_api.api_credentials_list>["membershipId"];
	organizationName: string;
	workspaceName: string;
}) {
	const { membershipId, organizationName, workspaceName } = props;
	const credentialsResult = useQuery(app_convex_api.public_api.api_credentials_list, { membershipId });
	const mountedRef = useRef(true);
	const createNameDirtyRef = useRef(false);
	const verificationRequestRef = useRef(0);
	const [createOpen, setCreateOpen] = useState(false);
	const [createName, setCreateName] = useState("");
	const [createValidationMessage, setCreateValidationMessage] = useState<string>();
	const [createDisplayValidationMessage, setCreateDisplayValidationMessage] = useState<string>();
	const [createError, setCreateError] = useState<string>();
	const [createPending, setCreatePending] = useState(false);
	const [reveal, setReveal] = useState<RouteApiKeys_Reveal | null>(null);
	const [revealVerificationState, setRevealVerificationState] = useState<RouteApiKeys_VerificationState>({ status: "idle" });
	const [rotateTarget, setRotateTarget] = useState<RouteApiKeys_Credential | null>(null);
	const [rotatePending, setRotatePending] = useState(false);
	const [rotateError, setRotateError] = useState<string>();
	const [revokeTarget, setRevokeTarget] = useState<RouteApiKeys_Credential | null>(null);
	const [revokePending, setRevokePending] = useState(false);
	const [revokeError, setRevokeError] = useState<string>();

	const credentials = credentialsResult?._yay ?? [];
	const activeCredentials = credentials.filter((credential) => credential.revokedAt === null);
	const revokedCredentials = credentials.filter((credential) => credential.revokedAt !== null);

	useLayoutEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			verificationRequestRef.current += 1;
		};
	}, []);

	const handleCreateOpen = useFn(() => {
		setCreateError(undefined);
		setCreateOpen(true);
	});

	const handleCreateOpenChange = useFn((open: boolean) => {
		if (createPending) return;
		setCreateOpen(open);
		if (!open) {
			createNameDirtyRef.current = false;
			setCreateName("");
			setCreateValidationMessage(undefined);
			setCreateDisplayValidationMessage(undefined);
			setCreateError(undefined);
		}
	});

	const handleCreateNameChange = useFn((name: string) => {
		createNameDirtyRef.current = true;
		const nextValidationMessage = validate_api_key_name(name);
		setCreateName(name);
		setCreateValidationMessage(nextValidationMessage);
		setCreateError(undefined);
		if (createDisplayValidationMessage !== undefined) {
			setCreateDisplayValidationMessage(nextValidationMessage);
		}
	});

	const handleCreateNameBlur = useFn(() => {
		if (createNameDirtyRef.current) {
			setCreateDisplayValidationMessage(validate_api_key_name(createName));
		}
	});

	const handleCreate = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (createPending) return;

		const validationMessage = validate_api_key_name(createName);
		setCreateValidationMessage(validationMessage);
		setCreateDisplayValidationMessage(validationMessage);
		if (validationMessage) {
			// noValidate suppresses the browser popup, so return focus to the invalid field ourselves.
			event.currentTarget.querySelector("input")?.focus();
			return;
		}

		const submittedName = createName.trim();
		setCreatePending(true);
		setCreateError(undefined);
		app_convex
			.mutation(app_convex_api.public_api.api_credential_create, {
				membershipId,
				name: submittedName,
				scopes: API_KEY_SCOPES,
			})
			.then((result) => {
				if (!mountedRef.current) return;
				if (result._nay) {
					setCreateError(result._nay.message);
					return;
				}

				setCreateOpen(false);
				setCreateName("");
				setReveal({
					credential: result._yay.credential,
					kind: "created",
				});
				setRevealVerificationState({ status: "idle" });
			})
			.catch((error) => {
				if (!mountedRef.current) return;
				console.error("[RouteApiKeys.handleCreate] Failed to create API key", { error, membershipId });
				setCreateError("Could not create the API key. Try again.");
			})
			.finally(() => {
				if (mountedRef.current) setCreatePending(false);
			});
	});

	const handleCloseReveal = useFn(() => {
		verificationRequestRef.current += 1;
		setReveal(null);
		setRevealVerificationState({ status: "idle" });
	});

	const handleVerifyReveal = useFn(() => {
		if (!reveal || revealVerificationState.status === "pending") return;
		const requestId = ++verificationRequestRef.current;
		setRevealVerificationState({ status: "pending", message: "Testing API key..." });
		void verify_api_key(reveal.credential).then((result) => {
			if (!mountedRef.current || requestId !== verificationRequestRef.current) return;
			setRevealVerificationState(result);
		});
	});

	const handleRotate = useFn(() => {
		if (!rotateTarget || rotatePending) return;
		const target = rotateTarget;
		setRotatePending(true);
		setRotateError(undefined);
		app_convex
			.mutation(app_convex_api.public_api.api_credential_rotate, {
				membershipId,
				credentialId: target.credentialId,
			})
			.then((result) => {
				if (!mountedRef.current) return;
				if (result._nay) {
					setRotateError(result._nay.message);
					return;
				}

				setRotateTarget(null);
				setReveal({
					credential: result._yay.credential,
					kind: "rotated",
				});
				setRevealVerificationState({ status: "idle" });
			})
			.catch((error) => {
				if (!mountedRef.current) return;
				console.error("[RouteApiKeys.handleRotate] Failed to rotate API key", {
					error,
					membershipId,
					credentialId: target.credentialId,
				});
				setRotateError("Could not rotate the API key. Try again.");
			})
			.finally(() => {
				if (mountedRef.current) setRotatePending(false);
			});
	});

	const handleRevoke = useFn(() => {
		if (!revokeTarget || revokePending) return;
		const target = revokeTarget;
		setRevokePending(true);
		setRevokeError(undefined);
		app_convex
			.mutation(app_convex_api.public_api.api_credential_revoke, {
				membershipId,
				credentialId: target.credentialId,
			})
			.then((result) => {
				if (!mountedRef.current) return;
				if (result._nay) {
					setRevokeError(result._nay.message);
					return;
				}
				setRevokeTarget(null);
			})
			.catch((error) => {
				if (!mountedRef.current) return;
				console.error("[RouteApiKeys.handleRevoke] Failed to revoke API key", {
					error,
					membershipId,
					credentialId: target.credentialId,
				});
				setRevokeError("Could not revoke the API key. Try again.");
			})
			.finally(() => {
				if (mountedRef.current) setRevokePending(false);
			});
	});

	return (
		<main className={"RouteApiKeys" satisfies RouteApiKeys_ClassNames}>
			<div className={"RouteApiKeys-content" satisfies RouteApiKeys_ClassNames}>
				<RouteApiKeysHeader workspaceName={workspaceName} onCreate={handleCreateOpen} />
				<RouteApiKeysSecurity />

				{credentialsResult === undefined ? (
					<div className={"RouteApiKeys-loading" satisfies RouteApiKeys_ClassNames} role="status" aria-live="polite">
						<KeyRound aria-hidden />
						Loading API keys...
					</div>
				) : credentialsResult._nay ? (
					<div className={"RouteApiKeys-error" satisfies RouteApiKeys_ClassNames} role="alert">
						<AlertTriangle aria-hidden />
						<div>
							<strong>API keys are unavailable. Try reloading the page.</strong>
							<span>{credentialsResult._nay.message}</span>
						</div>
					</div>
				) : (
					<RouteApiKeysList
						activeCredentials={activeCredentials}
						revokedCredentials={revokedCredentials}
						onCreate={handleCreateOpen}
						onRotate={(credential) => {
							setRotateError(undefined);
							setRotateTarget(credential);
						}}
						onRevoke={(credential) => {
							setRevokeError(undefined);
							setRevokeTarget(credential);
						}}
					/>
				)}

				<RouteApiKeysQuickStart />
			</div>

			<RouteApiKeysCreateModal
				open={createOpen}
				organizationName={organizationName}
				workspaceName={workspaceName}
				name={createName}
				validationMessage={createValidationMessage}
				displayValidationMessage={createDisplayValidationMessage}
				error={createError}
				pending={createPending}
				onOpenChange={handleCreateOpenChange}
				onNameChange={handleCreateNameChange}
				onNameBlur={handleCreateNameBlur}
				onSubmit={handleCreate}
			/>
			<RouteApiKeysRevealModal
				reveal={reveal}
				verificationState={revealVerificationState}
				onVerify={handleVerifyReveal}
				onClose={handleCloseReveal}
			/>
			<RouteApiKeysConfirmationModal
				kind="rotate"
				target={rotateTarget}
				pending={rotatePending}
				error={rotateError}
				onClose={() => {
					if (!rotatePending) setRotateTarget(null);
				}}
				onConfirm={handleRotate}
			/>
			<RouteApiKeysConfirmationModal
				kind="revoke"
				target={revokeTarget}
				pending={revokePending}
				error={revokeError}
				onClose={() => {
					if (!revokePending) setRevokeTarget(null);
				}}
				onConfirm={handleRevoke}
			/>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/api-keys/")({
	component: RouteApiKeys,
});

export { Route };
// #endregion root
