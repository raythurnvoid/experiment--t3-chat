import "./index.css";

import type { EditorProps } from "@monaco-editor/react";
import { createFileRoute } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useQuery } from "convex/react";
import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	Info,
	KeyRound,
	Plus,
	RotateCw,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import {
	editor as monaco_editor,
	languages as monaco_languages,
	MarkerSeverity as monaco_MarkerSeverity,
} from "monaco-editor";
import {
	memo,
	useEffect,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	type FormEvent,
	type Ref,
} from "react";

import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { MyBadge } from "@/components/my-badge.tsx";
import { MyButton } from "@/components/my-button.tsx";
import {
	MyCheckboxButton,
	MyCheckboxButtonContent,
	MyCheckboxButtonDescription,
	MyCheckboxButtonLabel,
} from "@/components/my-checkbox-button.tsx";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { ServiceAccountSelect } from "@/components/service-account-select.tsx";
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
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { TextMonospaceBlock } from "@/components/monospace-block/monospace-block-text.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionArgs,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { app_monaco_THEME_NAME_DARK } from "@/lib/app-monaco-config.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { app_fetch_main_api_url } from "@/lib/fetch.ts";
import { cn } from "@/lib/utils.ts";
import {
	api_key_setup_hover_target,
	api_key_setup_listed_scopes,
	api_key_setup_parse,
	api_key_setup_quick_fixes,
	api_key_setup_suggest,
	api_key_setup_with_scopes,
} from "../../../../../../shared/api-key-setup.ts";
import { public_api_SERVICE_ACCOUNT_SCOPES } from "../../../../../../shared/public-api.ts";

const API_KEY_DATETIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});
type RouteApiKeys_Scope = app_convex_FunctionArgs<
	typeof app_convex_api.public_api.api_credential_create
>["scopes"][number];

// Keyed by the backend mutation's scope union, so a new backend scope becomes a type error
// here instead of an unlabeled badge or a missing entry in the "All scopes" list.
const API_KEY_SCOPE_LABELS = {
	"files:list": "List files",
	"files:read": "Read file content",
	"ai_chat:read": "Read my AI conversations",
	"files:download": "Download files",
	"files:write": "Write files",
	"files:permissions": "Manage file policies",
	"files:publish": "Make files public",
	"plugin_data:read": "Read plugin data",
	"plugin_data:write": "Write plugin data",
} as const satisfies Record<RouteApiKeys_Scope, string>;

// "All scopes" list order in the create modal: read scopes first, then download and write scopes.
const API_KEY_SCOPE_ROWS = [
	{ scope: "files:list", description: "View file and folder names, paths, and metadata." },
	{ scope: "files:read", description: "Read the committed content of editable text files by path." },
	{
		scope: "ai_chat:read",
		description: "Read saved messages and tool outputs from AI conversations you created in this workspace.",
	},
	{ scope: "files:download", description: "Get temporary download links for files." },
	{ scope: "files:write", description: "Create and update editable text files by path, and upload other files." },
	{ scope: "files:permissions", description: "Change write policies on files and folders you can manage." },
	{
		scope: "files:publish",
		description:
			'Turn "Anyone on the web" on or off for files and folders you can manage. Public pages then show their images and videos.',
	},
	{ scope: "plugin_data:read", description: "Read the documents an installed plugin stores in this workspace." },
	{ scope: "plugin_data:write", description: "Create, change, and delete those plugin documents." },
] as const satisfies ReadonlyArray<{ scope: RouteApiKeys_Scope; description: string }>;

// The setup accepts only the scopes the "All scopes" list shows, so a pasted scope is always explained there.
const API_KEY_SETUP_ALLOWED_SCOPES = API_KEY_SCOPE_ROWS.map((row) => row.scope);

// The scopes a service account key may use, in the "All scopes" list order. The editor suggests only
// these while the Identity is a service account.
const API_KEY_SETUP_SERVICE_ACCOUNT_SCOPES = API_KEY_SETUP_ALLOWED_SCOPES.filter((scope) =>
	public_api_SERVICE_ACCOUNT_SCOPES.some((serviceAccountScope) => serviceAccountScope === scope),
);

// A scope's docs for the editor's hover and suggest details panel. Name the scopes service account keys cannot use.
function api_key_scope_docs(row: (typeof API_KEY_SCOPE_ROWS)[number]) {
	return API_KEY_SETUP_SERVICE_ACCOUNT_SCOPES.some((scope) => scope === row.scope)
		? row.description
		: `${row.description} Personal keys only.`;
}

// Short labels for the two setup fields, shown on each row of the editor's suggestions.
const API_KEY_SETUP_FIELD_LABELS = {
	name: "Key name",
	scopes: "Scope list",
} as const;

// Docs for the two setup fields, shown on hover and in the suggest details panel.
const API_KEY_SETUP_FIELD_DOCS = {
	name: "A name that tells you where the key is used, 1 to 80 characters.",
	scopes: 'The scopes the key needs, like ["files:list"]. "All scopes" under the editor lists them.',
} as const;

// Every scope that lets a key change stored data. They share one warning under the scope summary.
const API_KEY_WRITE_SCOPES: readonly RouteApiKeys_Scope[] = [
	"files:write",
	"files:permissions",
	"files:publish",
	"plugin_data:write",
];

// File list and text reads start in the setup. Every other scope stays opt-in. Keep one scope per line,
// so a new scope starts near the left edge and the suggest list there fits inside the editor.
const API_KEY_SETUP_DEFAULT_TEXT = `{
  "name": "",
  "scopes": [
    "files:list",
    "files:read"
  ]
}`;

// Common setups, shown as buttons above the editor. A preset changes only the "scopes" list, so a typed
// name stays. A service account key leaves out the scopes it cannot use.
const API_KEY_SETUP_PRESETS = [
	{ label: "Read only", scopes: ["files:list", "files:read"] },
	{ label: "Upload CLI", scopes: ["files:list", "files:read", "files:write"] },
	{
		label: "Full files",
		scopes: ["files:list", "files:read", "files:download", "files:write", "files:permissions", "files:publish"],
	},
] as const satisfies ReadonlyArray<{ label: string; scopes: readonly RouteApiKeys_Scope[] }>;

// A junk paste can give thousands of parse errors. Show only the first ones, in the list and as markers.
const API_KEY_SETUP_SHOWN_ERRORS_MAX = 20;

const MONACO_MARKER_OWNER = "api-keys-setup";

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

type RouteApiKeys_SetupParse = ReturnType<typeof api_key_setup_parse<RouteApiKeys_Scope>>;

function format_api_key_datetime(timestamp: number) {
	return Number.isFinite(timestamp) ? API_KEY_DATETIME_FORMATTER.format(timestamp) : "Unknown";
}

/**
 * Test a key through the route that asks for no scope.
 *
 * Testing through a real route, such as listing files, only proves the key holds that one scope. A
 * key made only for plugin documents would then look broken. This route answers with the scopes the
 * key still has, so the message can name them.
 */
async function verify_api_key(credential: string) {
	try {
		const response = await fetch(app_fetch_main_api_url("/api/v1/auth/verify"), {
			method: "POST",
			credentials: "omit",
			headers: {
				Authorization: `Bearer ${credential}`,
			},
		});

		if (response.status === 200) {
			const body: unknown = await response.json();
			const scopes =
				body && typeof body === "object" && "scopes" in body && Array.isArray(body.scopes)
					? body.scopes.filter((scope): scope is string => typeof scope === "string")
					: [];
			if (scopes.length === 0) {
				return {
					status: "error",
					message: "The key is valid, but your current permissions allow none of its scopes.",
				} as const;
			}

			return { status: "success", message: `Key verified. It can use: ${scopes.join(", ")}.` } as const;
		}
		if (response.status === 401) {
			return { status: "error", message: "This key is invalid or revoked." } as const;
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
				<span className={"RouteApiKeysCodeBlock-language" satisfies RouteApiKeysCodeBlock_ClassNames}>{language}</span>
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
let firstMarkdownFilePath;
do {
  const result = await post("/api/v1/files/list", {
    path: "/",
    cursor,
    recursive: true,
    kind: "file",
    // One file extension per call.
    extension: "md",
    limit: 100,
  });
  firstMarkdownFilePath ??= result.items[0]?.path;
  cursor = result.cursor;
  if (result.isDone) break;
} while (true);

if (!firstMarkdownFilePath) throw new Error("No Markdown files found");
const file = await post("/api/v1/files/read", { path: firstMarkdownFilePath });
console.log(file.content);`;

	return (
		<section className={"RouteApiKeysQuickStart" satisfies RouteApiKeysQuickStart_ClassNames}>
			<header className={"RouteApiKeysQuickStart-header" satisfies RouteApiKeysQuickStart_ClassNames}>
				<h2 className={"RouteApiKeysQuickStart-title" satisfies RouteApiKeysQuickStart_ClassNames}>Use an API key</h2>
				<p className={"RouteApiKeysQuickStart-description" satisfies RouteApiKeysQuickStart_ClassNames}>
					Send the key as a Bearer token. List files first, then read one committed text file by path.
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
					API reads return the committed content of editable text files: Markdown plus recognized plain text types like
					.json, .yaml, or .csv. Unsaved or pending changes are not returned.
				</p>
				<p className={"RouteApiKeysQuickStart-note" satisfies RouteApiKeysQuickStart_ClassNames}>
					<Info aria-hidden />
					Keys with write access can create and update Markdown files through /api/v1/files/write and
					/api/v1/files/write-many, and upload files through /api/v1/files/upload-urls. Uploads with a recognized plain
					text extension are converted into editable documents.
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
	const stateClassName =
		`RouteApiKeysVerificationStatus-state-${state.status}` as const satisfies RouteApiKeysVerificationStatus_ClassNames;

	return (
		<div
			className={cn(
				"RouteApiKeysVerificationStatus" satisfies RouteApiKeysVerificationStatus_ClassNames,
				stateClassName,
			)}
			role={state.status === "error" ? "alert" : "status"}
			aria-live={state.status === "error" ? "assertive" : "polite"}
		>
			{state.status === "success" ? (
				<CheckCircle2 aria-hidden />
			) : state.status === "error" ? (
				<AlertTriangle aria-hidden />
			) : null}
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
	const sponsor = useQuery(app_convex_api.users.get_anagraphic, { userId: credential.sponsorUserId });

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
					<dt className={"RouteApiKeysListItem-metaLabel" satisfies RouteApiKeysListItem_ClassNames}>Identity</dt>
					<dd className={"RouteApiKeysListItem-metaValue" satisfies RouteApiKeysListItem_ClassNames}>
						{credential.serviceAccountId === null
							? "Personal"
							: (credential.serviceAccountName ?? "Service account unavailable")}
					</dd>
				</div>
				<div className={"RouteApiKeysListItem-metaItem" satisfies RouteApiKeysListItem_ClassNames}>
					<dt className={"RouteApiKeysListItem-metaLabel" satisfies RouteApiKeysListItem_ClassNames}>Sponsor</dt>
					<dd className={"RouteApiKeysListItem-metaValue" satisfies RouteApiKeysListItem_ClassNames}>
						{sponsor?.displayName ?? "Unavailable"}
					</dd>
				</div>
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
						{API_KEY_SCOPE_LABELS[scope]}
					</MyBadge>
				))}
			</div>

			{active && onRotate && onRevoke ? (
				<div className={"RouteApiKeysListItem-actions" satisfies RouteApiKeysListItem_ClassNames}>
					<MyButton variant="outline" aria-label={`Rotate ${credential.name}`} onClick={() => onRotate(credential)}>
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
	| "RouteApiKeysList-revokedChevron"
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
						Create a key for file access or reading your saved AI conversations in this workspace.
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
						<ChevronDown
							className={"RouteApiKeysList-revokedChevron" satisfies RouteApiKeysList_ClassNames}
							aria-hidden
						/>
					</summary>
					<ul
						className={"RouteApiKeysList-items" satisfies RouteApiKeysList_ClassNames}
						aria-label="Recent revoked API keys"
					>
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

// #region create modal editor
type RouteApiKeysCreateModalEditor_ClassNames =
	| "RouteApiKeysCreateModalEditor"
	| "RouteApiKeysCreateModalEditor-skeleton";

type RouteApiKeysCreateModalEditor_Ref = {
	/**
	 * Put the caret at `offset` in the setup text, scroll it into view, and focus the editor.
	 */
	focusAt: (offset: number) => void;
	/**
	 * Replace the whole setup text as one undo step, so Ctrl+Z in the editor undoes only this change.
	 */
	replaceText: (text: string) => void;
};

type RouteApiKeysCreateModalEditor_Props = {
	ref: Ref<RouteApiKeysCreateModalEditor_Ref>;
	text: string;
	errors: RouteApiKeys_SetupParse["errors"];
	/**
	 * The scope ids the editor suggests. Pass a module constant: a new array registers the suggestions again.
	 */
	allowedScopes: readonly RouteApiKeys_Scope[];
	readOnly: boolean;
	onTextChange: (text: string) => void;
};

function to_monaco_range(model: monaco_editor.ITextModel, offset: number, length: number) {
	const start = model.getPositionAt(offset);
	const end = model.getPositionAt(offset + length);
	return {
		startLineNumber: start.lineNumber,
		startColumn: start.column,
		endLineNumber: end.lineNumber,
		endColumn: end.column,
	};
}

const RouteApiKeysCreateModalEditor = memo(function RouteApiKeysCreateModalEditor(
	props: RouteApiKeysCreateModalEditor_Props,
) {
	const { ref, text, errors, allowedScopes, readOnly, onTextChange } = props;
	// Keep the editor in state, so the effects below run again once the editor mounts.
	const [editor, setEditor] = useState<monaco_editor.IStandaloneCodeEditor | null>(null);
	// Keep construction-only Monaco options stable because @monaco-editor/react deep-clones option updates.
	const [editorOptions] = useState(() => {
		return {
			ariaLabel: "API key setup JSON",
			placeholder: '{ "name": "Local file reader", "scopes": ["files:list"] }',
			// Let Tab move focus out to the next control. Monaco traps Tab by default, and people paste
			// this text instead of typing its indentation.
			tabFocusMode: true,
			automaticLayout: true,
			fontSize: 16,
			lineHeight: 22,
			minimap: { enabled: false },
			lineNumbers: "off",
			lineDecorationsWidth: 14,
			folding: false,
			glyphMargin: false,
			padding: { top: 10, bottom: 10 },
			scrollBeyondLastLine: false,
			wordWrap: "on",
			// Let the mouse wheel scroll the dialog when the pointer is over a short setup.
			scrollbar: { alwaysConsumeMouseWheel: false },
			// Monaco counts JSON keys and values as strings, and by default suggests nothing inside strings.
			// Field names and scope ids are always strings here, so turn suggestions on there.
			quickSuggestions: { other: "on", comments: "off", strings: "on" },
			// Show only the suggestions below. Monaco would otherwise fill an empty list with words from the text.
			// Keep suggesting while a picked field's snippet is active, so the scope list opens inside `"scopes": []`.
			suggest: { showWords: false, snippetsPreventQuickSuggestions: false },
			// Do not mark every copy of the word under the caret. `:` splits words, so every "files" would light up.
			occurrencesHighlight: "off",
		} satisfies NonNullable<EditorProps["options"]>;
	});

	useImperativeHandle(
		ref,
		() => ({
			focusAt: (offset) => {
				const model = editor?.getModel();
				if (!editor || !model) {
					return;
				}

				const position = model.getPositionAt(offset);
				editor.setPosition(position);
				editor.revealPositionInCenterIfOutsideViewport(position);
				editor.focus();
			},
			replaceText: (nextText) => {
				const model = editor?.getModel();
				if (!editor || !model) {
					onTextChange(nextText);
					return;
				}

				// The `value` prop would also apply the text as an edit, but it closes the undo step only after
				// it. Ctrl+Z would then undo the typing just before this change too. The edit calls
				// `onTextChange` through the editor's change event.
				editor.pushUndoStop();
				editor.executeEdits("api-keys-setup-replace", [{ range: model.getFullModelRange(), text: nextText }]);
				editor.pushUndoStop();
			},
		}),
		[editor, onTextChange],
	);

	const handleOnMount = useFn<EditorProps["onMount"]>((mountedEditor) => {
		setEditor(mountedEditor);

		// Ariakit focuses the first control when the dialog opens, before Monaco has mounted. So move focus
		// into the editor here. The dialog unmounts when it closes, so it always mounts with the default
		// text: put the caret inside its empty name.
		const model = mountedEditor.getModel();
		if (model && text === API_KEY_SETUP_DEFAULT_TEXT) {
			mountedEditor.setPosition(model.getPositionAt(API_KEY_SETUP_DEFAULT_TEXT.indexOf('""') + 1));
		}
		mountedEditor.focus();
	});

	// Lock the text while the create request runs. Otherwise the summary could change after the scopes were sent.
	useEffect(() => {
		editor?.updateOptions({ readOnly });
	}, [editor, readOnly]);

	// The app turns Monaco's own JSON checks off, so show the shared parser's errors as markers, and offer
	// their quick fixes on Ctrl+. and the light bulb. Register the fixes again for each new error list, so
	// they always match the markers. Answer only for this editor's model, like the providers below.
	useEffect(() => {
		const model = editor?.getModel();
		if (!model) {
			return;
		}

		monaco_editor.setModelMarkers(
			model,
			MONACO_MARKER_OWNER,
			// A zero-length error still needs one character, or Monaco draws nothing.
			errors.map((error) => ({
				severity: monaco_MarkerSeverity.Error,
				message: error.message,
				...to_monaco_range(model, error.offset, Math.max(error.length, 1)),
			})),
		);

		const codeActionProvider = monaco_languages.registerCodeActionProvider(
			"json",
			{
				provideCodeActions: (actionModel, _range, context) => {
					if (actionModel !== model) {
						return undefined;
					}

					const text = model.getValue();
					const actions = context.markers.flatMap((marker) => {
						// Find the error the marker was made from: same message, same start.
						const error = errors.find((item) => {
							const start = model.getPositionAt(item.offset);
							return (
								item.message === marker.message &&
								start.lineNumber === marker.startLineNumber &&
								start.column === marker.startColumn
							);
						});
						if (!error) {
							return [];
						}

						return api_key_setup_quick_fixes(text, error, allowedScopes).map((fix, index) => ({
							title: fix.title,
							kind: "quickfix",
							diagnostics: [marker],
							isPreferred: index === 0,
							edit: {
								edits: fix.edits.map((edit) => ({
									resource: model.uri,
									// Monaco skips the fix if the text changed after it was made.
									versionId: model.getVersionId(),
									textEdit: { range: to_monaco_range(model, edit.offset, edit.length), text: edit.content },
								})),
							},
						}));
					});

					return { actions, dispose: () => {} };
				},
			},
			{ providedCodeActionKinds: ["quickfix"] },
		);

		return () => {
			codeActionProvider.dispose();
		};
	}, [editor, errors, allowedScopes]);

	// Suggest field names and scope ids, and show their docs on hover. Monaco keeps one list of these
	// providers per language, shared by every editor, so answer only for this editor's model. Remove them
	// when the editor unmounts, or each new dialog would add another copy of every suggestion.
	useEffect(() => {
		if (!editor) {
			return;
		}

		const completionProvider = monaco_languages.registerCompletionItemProvider("json", {
			// Open the scope list as soon as a new list item can start: after `[` and after `,`.
			triggerCharacters: ['"', "[", ","],
			provideCompletionItems: (model, position) => {
				if (model !== editor.getModel()) {
					return undefined;
				}

				const suggestion = api_key_setup_suggest(model.getValue(), model.getOffsetAt(position), allowedScopes);
				if (!suggestion) {
					return { suggestions: [] };
				}

				// Show each item's short label on its row and its full docs in Monaco's details panel. The panel
				// opens past the editor's edge, which works because `MyModalMonacoEditor` shows it above the dialog.
				const range = to_monaco_range(model, suggestion.replace.offset, suggestion.replace.length);
				if (suggestion.kind === "field") {
					return {
						suggestions: suggestion.values.map((key) => ({
							label: { label: key, description: API_KEY_SETUP_FIELD_LABELS[key] },
							documentation: API_KEY_SETUP_FIELD_DOCS[key],
							kind: monaco_languages.CompletionItemKind.Property,
							filterText: `"${key}"`,
							// Add the value too, with the caret inside it, unless the field already has its colon.
							insertText: suggestion.colonFollows ? `"${key}"` : key === "name" ? '"name": "$1"' : '"scopes": [$1]',
							insertTextRules: monaco_languages.CompletionItemInsertTextRule.InsertAsSnippet,
							// Open the scope list right away inside the new `[]`.
							command:
								key === "scopes" && !suggestion.colonFollows
									? { id: "editor.action.triggerSuggest", title: "Suggest scopes" }
									: undefined,
							range,
						})),
					};
				}

				return {
					suggestions: suggestion.values.map((scope, index) => {
						const row = API_KEY_SCOPE_ROWS.find((item) => item.scope === scope);
						return {
							label: { label: scope, description: API_KEY_SCOPE_LABELS[scope] },
							documentation: row ? api_key_scope_docs(row) : undefined,
							kind: monaco_languages.CompletionItemKind.Value,
							filterText: `"${scope}"`,
							insertText: `"${scope}"`,
							// Keep the "All scopes" list order instead of sorting by name.
							sortText: String(index).padStart(2, "0"),
							range,
						};
					}),
				};
			},
		});

		const hoverProvider = monaco_languages.registerHoverProvider("json", {
			provideHover: (model, position) => {
				if (model !== editor.getModel()) {
					return undefined;
				}

				// Build the docs only from our own constants, never from the pasted text.
				const target = api_key_setup_hover_target(model.getValue(), model.getOffsetAt(position));
				const range = target ? to_monaco_range(model, target.offset, target.length) : undefined;
				if (target?.kind === "field" && (target.value === "name" || target.value === "scopes")) {
					return { range, contents: [{ value: API_KEY_SETUP_FIELD_DOCS[target.value] }] };
				}

				const row = target?.kind === "scope" ? API_KEY_SCOPE_ROWS.find((item) => item.scope === target.value) : null;
				if (!row) {
					return undefined;
				}

				return {
					range,
					contents: [
						{ value: `**${API_KEY_SCOPE_LABELS[row.scope]}** \`${row.scope}\`` },
						{ value: api_key_scope_docs(row) },
					],
				};
			},
		});

		return () => {
			completionProvider.dispose();
			hoverProvider.dispose();
		};
	}, [editor, allowedScopes]);

	return (
		<div className={"RouteApiKeysCreateModalEditor" satisfies RouteApiKeysCreateModalEditor_ClassNames}>
			<MyModalMonacoEditor
				height="200px"
				// Monaco needs a moment after mount to create the editor. Show a skeleton of the same size in
				// that gap, so the default "Loading..." text never flashes.
				loading={
					<MySkeleton
						className={"RouteApiKeysCreateModalEditor-skeleton" satisfies RouteApiKeysCreateModalEditor_ClassNames}
					/>
				}
				language="json"
				theme={app_monaco_THEME_NAME_DARK}
				value={text}
				options={editorOptions}
				onMount={handleOnMount}
				onChange={(value) => onTextChange(value ?? "")}
			/>
		</div>
	);
});
// #endregion create modal editor

// #region create modal
type RouteApiKeysCreateModal_ClassNames =
	| "RouteApiKeysCreateModal"
	| "RouteApiKeysCreateModal-form"
	| "RouteApiKeysCreateModal-fields"
	| "RouteApiKeysCreateModal-setup"
	| "RouteApiKeysCreateModal-setupTitle"
	| "RouteApiKeysCreateModal-setupHint"
	| "RouteApiKeysCreateModal-presets"
	| "RouteApiKeysCreateModal-errors"
	| "RouteApiKeysCreateModal-summary"
	| "RouteApiKeysCreateModal-summaryTitle"
	| "RouteApiKeysCreateModal-summaryList"
	| "RouteApiKeysCreateModal-scopes"
	| "RouteApiKeysCreateModal-scopesSummary"
	| "RouteApiKeysCreateModal-scopesChevron"
	| "RouteApiKeysCreateModal-scopeList"
	| "RouteApiKeysCreateModal-scope"
	| "RouteApiKeysCreateModal-scopeCheckbox"
	| "RouteApiKeysCreateModal-writeWarning";

type RouteApiKeysCreateModal_CustomAttributes = {
	"data-api-key-setup-state": "empty" | "default" | "invalid" | "valid";
};

type RouteApiKeysCreateModal_Props = {
	open: boolean;
	organizationName: string;
	workspaceName: string;
	setupText: string;
	/**
	 * Null while the editor is empty.
	 */
	setupParse: RouteApiKeys_SetupParse | null;
	/**
	 * True after a Create click on a setup with problems. The dialog then shows every problem, even on an
	 * empty editor or the untouched default text.
	 */
	submitAttempted: boolean;
	serviceAccountId: app_convex_Id<"access_control_service_accounts"> | null;
	canBindAccount: boolean;
	error?: string;
	pending: boolean;
	onOpenChange: (open: boolean) => void;
	onSetupTextChange: (text: string) => void;
	onServiceAccountChange: (value: app_convex_Id<"access_control_service_accounts"> | null) => void;
	onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

const RouteApiKeysCreateModal = memo(function RouteApiKeysCreateModal(props: RouteApiKeysCreateModal_Props) {
	const {
		open,
		organizationName,
		workspaceName,
		setupText,
		setupParse,
		submitAttempted,
		serviceAccountId,
		canBindAccount,
		error,
		pending,
		onOpenChange,
		onSetupTextChange,
		onServiceAccountChange,
		onSubmit,
	} = props;
	const editorRef = useRef<RouteApiKeysCreateModalEditor_Ref>(null);

	const setup = setupParse?.setup ?? null;
	const setupErrors = setupParse?.errors ?? [
		{ code: "not_object" as const, offset: 0, length: 0, message: "Paste a key setup." },
	];
	// Before the first Create click, show no red errors on an empty editor or the untouched default text,
	// which only lacks a name.
	const setupState: RouteApiKeysCreateModal_CustomAttributes["data-api-key-setup-state"] =
		setupParse === null && !submitAttempted
			? "empty"
			: setupText === API_KEY_SETUP_DEFAULT_TEXT && !submitAttempted
				? "default"
				: setup === null
					? "invalid"
					: "valid";
	const shownErrors = setupState === "invalid" ? setupErrors.slice(0, API_KEY_SETUP_SHOWN_ERRORS_MAX) : [];
	const hiddenErrorCount = setupState === "invalid" ? setupErrors.length - shownErrors.length : 0;
	const hasWriteScope = setup?.scopes.some((scope) => API_KEY_WRITE_SCOPES.includes(scope)) ?? false;
	const allowedScopes: readonly RouteApiKeys_Scope[] =
		serviceAccountId === null ? API_KEY_SETUP_ALLOWED_SCOPES : API_KEY_SETUP_SERVICE_ACCOUNT_SCOPES;
	// The scope checkboxes mirror the text, which stays the only source of the setup. Null while the JSON is
	// broken: the checkboxes are then off until the text parses again.
	const listedScopes = api_key_setup_listed_scopes(setupText);

	// Each change below goes through the editor as one undo step, so Ctrl+Z in the editor undoes it.
	const handlePresetClick = (scopes: readonly RouteApiKeys_Scope[]) => {
		const presetScopes = scopes.filter((scope) => allowedScopes.includes(scope));
		// A broken or empty text cannot keep its name, so start a new setup from the preset.
		editorRef.current?.replaceText(
			api_key_setup_with_scopes(setupText, presetScopes) ?? JSON.stringify({ name: "", scopes: presetScopes }, null, 2),
		);
	};

	const handleScopeCheckedChange = (scope: RouteApiKeys_Scope, checked: boolean) => {
		if (listedScopes === null) {
			return;
		}

		const nextText = api_key_setup_with_scopes(
			setupText,
			checked ? [...listedScopes, scope] : listedScopes.filter((item) => item !== scope),
		);
		if (nextText !== null) {
			editorRef.current?.replaceText(nextText);
		}
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		// A setup with problems creates nothing. Put the caret on the first problem, so it is quick to fix.
		// When the problem is a JSON string, like an empty name `""`, put the caret before its closing
		// quote, so the next keys the user types go inside the string.
		const firstError = setupErrors[0];
		if (setup === null && firstError) {
			const markedText = setupText.slice(firstError.offset, firstError.offset + firstError.length);
			const isString = markedText.length >= 2 && markedText.startsWith('"') && markedText.endsWith('"');
			editorRef.current?.focusAt(isString ? firstError.offset + firstError.length - 1 : firstError.offset);
		}
		onSubmit(event);
	};

	return (
		<MyModal open={open} setOpen={onOpenChange}>
			<MyModalPopover
				className={"RouteApiKeysCreateModal" satisfies RouteApiKeysCreateModal_ClassNames}
				// Mount the dialog only while it is open. A closed dialog then holds no hidden editor, and each new
				// key starts with a fresh editor and no undo history from the last key.
				unmountOnHide
				// In Chromium, Monaco does not stop the Escape key, so Escape inside the editor would close the
				// dialog and drop the setup text. Once the text is edited, Tab out of the editor first, then
				// Escape closes the dialog.
				hideOnEscape={(event) =>
					setupText.trim() === "" ||
					setupText === API_KEY_SETUP_DEFAULT_TEXT ||
					!(event.target instanceof Element && event.target.closest(".monaco-editor"))
				}
			>
				<form
					className={"RouteApiKeysCreateModal-form" satisfies RouteApiKeysCreateModal_ClassNames}
					{...({ "data-api-key-setup-state": setupState } satisfies RouteApiKeysCreateModal_CustomAttributes)}
					noValidate
					onSubmit={handleSubmit}
				>
					<MyModalHeader>
						<MyModalHeading>Create API key</MyModalHeading>
						<MyModalDescription>
							This key will work only in {organizationName}/{workspaceName}.
						</MyModalDescription>
					</MyModalHeader>
					<MyModalScrollableArea>
						<div className={"RouteApiKeysCreateModal-fields" satisfies RouteApiKeysCreateModal_ClassNames}>
							<ServiceAccountSelect
								value={serviceAccountId}
								label="Identity"
								emptyLabel="Personal"
								disabled={pending || !canBindAccount}
								onChange={onServiceAccountChange}
							/>
							{serviceAccountId ? (
								<p>
									Service keys cannot make files public, read AI conversations, or use plugin data. The key acts as this
									account, with the account's grants.
								</p>
							) : null}
							{serviceAccountId && !canBindAccount ? (
								<p role="status">You need permission to manage service accounts to bind this key.</p>
							) : null}

							<div className={"RouteApiKeysCreateModal-setup" satisfies RouteApiKeysCreateModal_ClassNames}>
								<div className={"RouteApiKeysCreateModal-setupTitle" satisfies RouteApiKeysCreateModal_ClassNames}>
									Setup
								</div>
								<p className={"RouteApiKeysCreateModal-setupHint" satisfies RouteApiKeysCreateModal_ClassNames}>
									Paste or edit the key setup as JSON: a name that tells you where the key is used, and the scopes it
									needs.
								</p>
								<div
									className={"RouteApiKeysCreateModal-presets" satisfies RouteApiKeysCreateModal_ClassNames}
									role="group"
									aria-label="Scope presets"
								>
									{API_KEY_SETUP_PRESETS.map((preset) => (
										<MyButton
											key={preset.label}
											variant="outline"
											disabled={pending}
											onClick={() => handlePresetClick(preset.scopes)}
										>
											{preset.label}
										</MyButton>
									))}
								</div>
								<RouteApiKeysCreateModalEditor
									ref={editorRef}
									text={setupText}
									errors={shownErrors}
									allowedScopes={allowedScopes}
									readOnly={pending}
									onTextChange={onSetupTextChange}
								/>
								{shownErrors.length > 0 ? (
									<ul
										className={"RouteApiKeysCreateModal-errors" satisfies RouteApiKeysCreateModal_ClassNames}
										role="status"
										aria-label="Problems in the setup"
									>
										{shownErrors.map((setupError, index) => (
											<li key={index}>{setupError.message}</li>
										))}
										{hiddenErrorCount > 0 ? <li>And {hiddenErrorCount} more problems.</li> : null}
									</ul>
								) : null}
								{setupState === "default" ? (
									<p className={"RouteApiKeysCreateModal-setupHint" satisfies RouteApiKeysCreateModal_ClassNames}>
										Type a name for the key.
									</p>
								) : null}
							</div>

							{setup ? (
								<div className={"RouteApiKeysCreateModal-summary" satisfies RouteApiKeysCreateModal_ClassNames}>
									<div className={"RouteApiKeysCreateModal-summaryTitle" satisfies RouteApiKeysCreateModal_ClassNames}>
										This key can:
									</div>
									<ul
										className={"RouteApiKeysCreateModal-summaryList" satisfies RouteApiKeysCreateModal_ClassNames}
										aria-label="Scopes of the new key"
									>
										{setup.scopes.map((scope) => (
											<li key={scope}>
												{API_KEY_SCOPE_LABELS[scope]} <code>{scope}</code>
											</li>
										))}
									</ul>
								</div>
							) : null}

							{hasWriteScope ? (
								<p className={"RouteApiKeysCreateModal-writeWarning" satisfies RouteApiKeysCreateModal_ClassNames}>
									<AlertTriangle aria-hidden />A write key can create and replace files and plugin documents everywhere
									you can write. Treat it like a password.
								</p>
							) : null}

							<details className={"RouteApiKeysCreateModal-scopes" satisfies RouteApiKeysCreateModal_ClassNames}>
								<summary
									className={"RouteApiKeysCreateModal-scopesSummary" satisfies RouteApiKeysCreateModal_ClassNames}
								>
									All scopes
									<ChevronDown
										className={"RouteApiKeysCreateModal-scopesChevron" satisfies RouteApiKeysCreateModal_ClassNames}
										aria-hidden
									/>
								</summary>
								{listedScopes === null ? (
									<p className={"RouteApiKeysCreateModal-setupHint" satisfies RouteApiKeysCreateModal_ClassNames}>
										The setup JSON has a problem. Fix it, or pick a preset, to use these checkboxes.
									</p>
								) : null}
								<ul
									className={"RouteApiKeysCreateModal-scopeList" satisfies RouteApiKeysCreateModal_ClassNames}
									aria-label="All scopes"
								>
									{API_KEY_SCOPE_ROWS.map((row) => {
										const checked = listedScopes?.includes(row.scope) ?? false;
										return (
											<li
												key={row.scope}
												className={"RouteApiKeysCreateModal-scope" satisfies RouteApiKeysCreateModal_ClassNames}
											>
												<MyCheckboxButton
													className={
														"RouteApiKeysCreateModal-scopeCheckbox" satisfies RouteApiKeysCreateModal_ClassNames
													}
													variant="outline"
													checked={checked}
													// A service account key cannot add a personal-only scope, but can still remove one.
													disabled={
														pending || listedScopes === null || (!checked && !allowedScopes.includes(row.scope))
													}
													onCheckedChange={(nextChecked) => handleScopeCheckedChange(row.scope, nextChecked)}
												>
													<MyCheckboxButtonContent>
														<MyCheckboxButtonLabel>
															{API_KEY_SCOPE_LABELS[row.scope]} <code>{row.scope}</code>
														</MyCheckboxButtonLabel>
														<MyCheckboxButtonDescription>
															{row.description}
															{public_api_SERVICE_ACCOUNT_SCOPES.some((scope) => scope === row.scope)
																? null
																: " Personal keys only."}
														</MyCheckboxButtonDescription>
													</MyCheckboxButtonContent>
												</MyCheckboxButton>
											</li>
										);
									})}
								</ul>
							</details>

							{error ? <div role="alert">{error}</div> : null}
						</div>
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
							Cancel
						</MyButton>
						<MyButton
							type="submit"
							disabled={pending || (serviceAccountId !== null && !canBindAccount)}
							aria-busy={pending}
						>
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
					Create API keys for scripts and tools that work with {workspaceName}.
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
				<span>They follow their selected permissions and current access, and do not expire until revoked.</span>
				<span>
					A key with write access can create and replace files everywhere you can write, so treat it like a password.
				</span>
				<span>
					Keep keys in an environment variable. Do not put them in source code, screenshots, chat, or browser storage.
				</span>
			</div>
		</aside>
	);
});
// #endregion header and security

// #region root
type RouteApiKeys_ClassNames = "RouteApiKeys" | "RouteApiKeys-content" | "RouteApiKeys-loading" | "RouteApiKeys-error";

function RouteApiKeys() {
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const search = Route.useSearch();

	// Remount on a workspace change so secrets, modal state, and pending requests cannot cross tenant boundaries.
	return (
		<RouteApiKeysMembership
			key={`${membershipId}:${search.serviceAccountId ?? ""}`}
			membershipId={membershipId}
			organizationName={organizationName}
			workspaceName={workspaceName}
			initialServiceAccountId={search.serviceAccountId}
		/>
	);
}

function RouteApiKeysMembership(props: {
	membershipId: app_convex_FunctionArgs<typeof app_convex_api.public_api.api_credentials_list>["membershipId"];
	organizationName: string;
	workspaceName: string;
	initialServiceAccountId?: string;
}) {
	const { membershipId, organizationName, workspaceName, initialServiceAccountId } = props;
	const credentialsResult = useQuery(app_convex_api.public_api.api_credentials_list, { membershipId });
	const canBindAccount = useQuery(app_convex_api.access_control.get_current_user_workspace_permission, {
		membershipId,
		permission: "workspace.service_accounts.manage",
	});
	const mountedRef = useRef(true);
	const verificationRequestRef = useRef(0);
	const [createOpen, setCreateOpen] = useState(initialServiceAccountId !== undefined);
	const [createServiceAccountId, setCreateServiceAccountId] =
		useState<app_convex_Id<"access_control_service_accounts"> | null>(
			initialServiceAccountId ? (initialServiceAccountId as app_convex_Id<"access_control_service_accounts">) : null,
		);
	// Keep the editor text exactly as the editor gives it. The editor replaces its whole text, and moves
	// the caret, when this value differs from its own.
	const [createSetupText, setCreateSetupText] = useState(API_KEY_SETUP_DEFAULT_TEXT);
	const [createSubmitAttempted, setCreateSubmitAttempted] = useState(false);
	const [createError, setCreateError] = useState<string>();
	const [createPending, setCreatePending] = useState(false);
	const [reveal, setReveal] = useState<RouteApiKeys_Reveal | null>(null);
	const [revealVerificationState, setRevealVerificationState] = useState<RouteApiKeys_VerificationState>({
		status: "idle",
	});
	const [rotateTarget, setRotateTarget] = useState<RouteApiKeys_Credential | null>(null);
	const [rotatePending, setRotatePending] = useState(false);
	const [rotateError, setRotateError] = useState<string>();
	const [revokeTarget, setRevokeTarget] = useState<RouteApiKeys_Credential | null>(null);
	const [revokePending, setRevokePending] = useState(false);
	const [revokeError, setRevokeError] = useState<string>();

	const credentials = credentialsResult?._yay ?? [];
	const activeCredentials = credentials.filter((credential) => credential.revokedAt === null);
	const revokedCredentials = credentials.filter((credential) => credential.revokedAt !== null);
	// An empty editor is not an error. Skip the parser so it does not say "Value expected".
	const createSetupParse =
		createSetupText.trim() === ""
			? null
			: api_key_setup_parse(createSetupText, {
					allowedScopes: API_KEY_SETUP_ALLOWED_SCOPES,
					serviceAccountScopes: createServiceAccountId === null ? null : public_api_SERVICE_ACCOUNT_SCOPES,
				});

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
			setCreateSetupText(API_KEY_SETUP_DEFAULT_TEXT);
			setCreateSubmitAttempted(false);
			setCreateServiceAccountId(null);
			setCreateError(undefined);
		}
	});

	const handleCreateSetupTextChange = useFn((text: string) => {
		setCreateSetupText(text);
		setCreateError(undefined);
	});

	// A switch to a service account keeps the setup text as it is. The parser then marks each scope that
	// service account keys cannot use, instead of removing it without a word.
	const handleServiceAccountChange = useFn((value: app_convex_Id<"access_control_service_accounts"> | null) => {
		if (createPending || (value !== null && canBindAccount !== true)) {
			return;
		}
		setCreateServiceAccountId(value);
		setCreateError(undefined);
	});

	const handleCreate = useFn((event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (createPending) return;

		// A setup with problems creates nothing. Show every problem instead, even the ones hidden on the
		// untouched default text.
		const setup = createSetupParse?.setup;
		if (!setup) {
			setCreateSubmitAttempted(true);
			return;
		}
		if (createServiceAccountId !== null && canBindAccount !== true) {
			return;
		}

		setCreatePending(true);
		setCreateError(undefined);
		app_convex
			.mutation(app_convex_api.public_api.api_credential_create, {
				membershipId,
				name: setup.name,
				scopes: setup.scopes,
				serviceAccountId: createServiceAccountId,
			})
			.then((result) => {
				if (!mountedRef.current) return;
				if (result._nay) {
					setCreateError(result._nay.message);
					return;
				}

				setCreateOpen(false);
				setCreateSetupText(API_KEY_SETUP_DEFAULT_TEXT);
				setCreateSubmitAttempted(false);
				setCreateServiceAccountId(null);
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
		<main className={cn("RouteApiKeys" satisfies RouteApiKeys_ClassNames, "app-scrollable" satisfies AppClassName)}>
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
				setupText={createSetupText}
				setupParse={createSetupParse}
				submitAttempted={createSubmitAttempted}
				serviceAccountId={createServiceAccountId}
				canBindAccount={canBindAccount === true}
				error={createError}
				pending={createPending}
				onOpenChange={handleCreateOpenChange}
				onSetupTextChange={handleCreateSetupTextChange}
				onServiceAccountChange={handleServiceAccountChange}
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
	validateSearch: zodValidator(z.object({ serviceAccountId: z.string().optional().catch(undefined) })),
});

export { Route };
// #endregion root
