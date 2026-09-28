import "./index.css";

import { Editor, type EditorProps } from "@monaco-editor/react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { AlertTriangle, Pencil, Plug, Power, Save, Server, Trash2, Unplug, X } from "lucide-react";
import { editor as monaco_editor, MarkerSeverity as monaco_MarkerSeverity } from "monaco-editor";
import { memo, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";

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
import { MySwitch } from "@/components/my-switch.tsx";
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
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import {
	mcp_custom_config_parse,
	mcp_custom_config_to_text,
	type mcp_custom_config_Draft,
	type mcp_custom_config_DraftPart,
} from "../../../../../../shared/mcp-custom-config.ts";

type RouteMcpServers_SavedServer = app_convex_FunctionReturnType<
	typeof app_convex_api.mcp_custom_servers.list
>["servers"][number];

type RouteMcpServers_PluginServer = app_convex_FunctionReturnType<
	typeof app_convex_api.plugins_mcp.list_member_plugin_connections
>["servers"][number];

type RouteMcpServers_Fill = app_convex_FunctionArgs<typeof app_convex_api.mcp_custom_servers.save>["fill"];

type RouteMcpServers_ParseError = ReturnType<typeof mcp_custom_config_parse>["errors"][number];

/**
 * The saved server whose text is in the editor. Save then updates it instead of adding a new one.
 */
type RouteMcpServers_Editing = {
	customServerId: app_convex_Id<"mcp_custom_servers">;
	name: string;
	url: string;
	hasConnection: boolean;
	/**
	 * Headers the saved server keeps as plain text. The parser reads them back as secrets that may
	 * be text, so the card starts with "Not secret" on for them.
	 */
	textHeaderNames: string[];
};

type RouteMcpServers_TestResult = { kind: "pending" } | { kind: "ok" | "error"; message: string };

type RouteMcpServers_SaveResult = { kind: "saved" | "error"; message: string };

type RouteMcpServers_SecretPart = Extract<mcp_custom_config_DraftPart, { kind: "secret" }>;

const MONACO_MARKER_OWNER = "mcp-servers-config";

const PLUGIN_CONNECTION_STATUS_LABELS = {
	connected: "Connected",
	needs_sign_in: "Not signed in",
	needs_reconnect: "Sign in again",
	blocked: "Blocked by your organization's MCP policy",
	disabled: "The plugin is turned off in this workspace",
} as const;

type RouteMcpServers_PluginConnectionStatus = keyof typeof PLUGIN_CONNECTION_STATUS_LABELS;

const DRAFT_STATE_LABELS = {
	ready: "Ready to save",
	needs_values: "Needs values",
	refused: "Cannot be used",
} as const satisfies Record<mcp_custom_config_Draft["state"], string>;

function get_plugin_connection_status(server: RouteMcpServers_PluginServer): RouteMcpServers_PluginConnectionStatus {
	if (!server.installationEnabled) {
		return "disabled";
	}

	if (server.policy === "blocked") {
		return "blocked";
	}

	return server.connection?.status ?? "needs_sign_in";
}

function get_saved_server_status(server: RouteMcpServers_SavedServer) {
	if (!server.enabled) {
		return "off";
	}

	if (server.policy === "blocked") {
		return "blocked";
	}

	if (server.health === "paused" || (server.lastTest && server.lastTest.outcome !== "ok")) {
		return "error";
	}

	return "ready";
}

function format_saved_server_status(server: RouteMcpServers_SavedServer) {
	switch (get_saved_server_status(server)) {
		case "off":
			return "Off";
		case "blocked":
			return "Blocked by your organization's MCP policy";
		case "error":
			return server.health === "paused" ? "Paused after errors" : "Last test failed";
		case "ready":
			return "Ready";
	}
}

function keep_saved_results(results: Record<string, RouteMcpServers_SaveResult>) {
	return Object.fromEntries(Object.entries(results).filter(([, result]) => result.kind === "saved"));
}

function format_last_test(lastTest: RouteMcpServers_SavedServer["lastTest"]) {
	if (lastTest === null) {
		return "Not tested yet";
	}

	return lastTest.outcome === "ok" ? `Last test: ok, ${lastTest.toolCount ?? 0} tools` : "Last test: failed";
}

// #region plugin server
type RouteMcpServersPluginServer_ClassNames =
	| "RouteMcpServersPluginServer"
	| "RouteMcpServersPluginServer-main"
	| "RouteMcpServersPluginServer-titleRow"
	| "RouteMcpServersPluginServer-name"
	| "RouteMcpServersPluginServer-details"
	| "RouteMcpServersPluginServer-actions";

type RouteMcpServersPluginServer_CustomAttributes = {
	"data-mcp-connection-status": RouteMcpServers_PluginConnectionStatus;
};

type RouteMcpServersPluginServer_Props = {
	server: RouteMcpServers_PluginServer;
	onDisconnect: (server: RouteMcpServers_PluginServer) => void;
};

const RouteMcpServersPluginServer = memo(function RouteMcpServersPluginServer(
	props: RouteMcpServersPluginServer_Props,
) {
	const { server, onDisconnect } = props;
	const status = get_plugin_connection_status(server);

	return (
		<li
			className={"RouteMcpServersPluginServer" satisfies RouteMcpServersPluginServer_ClassNames}
			aria-label={server.serverTitle}
			{...({ "data-mcp-connection-status": status } satisfies Partial<RouteMcpServersPluginServer_CustomAttributes>)}
		>
			<div className={"RouteMcpServersPluginServer-main" satisfies RouteMcpServersPluginServer_ClassNames}>
				<div className={"RouteMcpServersPluginServer-titleRow" satisfies RouteMcpServersPluginServer_ClassNames}>
					<h3 className={"RouteMcpServersPluginServer-name" satisfies RouteMcpServersPluginServer_ClassNames}>
						{server.serverTitle}
					</h3>
					<MyBadge variant={status === "connected" ? "secondary" : "outline"}>
						{PLUGIN_CONNECTION_STATUS_LABELS[status]}
					</MyBadge>
				</div>
				<p className={"RouteMcpServersPluginServer-details" satisfies RouteMcpServersPluginServer_ClassNames}>
					{server.pluginName} — {server.serverHost} — You will sign in at {server.authorizationHost}
					{server.health === "paused" ? " — Paused after errors" : ""}
				</p>
			</div>

			{/* No Connect button yet: Press cannot start a sign-in for plugin servers. A member can always remove one. */}
			{server.connection !== null ? (
				<div className={"RouteMcpServersPluginServer-actions" satisfies RouteMcpServersPluginServer_ClassNames}>
					<MyButton
						variant="outline"
						aria-label={`Disconnect ${server.serverTitle}`}
						onClick={() => onDisconnect(server)}
					>
						<Unplug aria-hidden />
						Disconnect
					</MyButton>
				</div>
			) : null}
		</li>
	);
});
// #endregion plugin server

// #region plugin servers
type RouteMcpServersPluginServers_ClassNames =
	| "RouteMcpServersPluginServers"
	| "RouteMcpServersPluginServers-header"
	| "RouteMcpServersPluginServers-title"
	| "RouteMcpServersPluginServers-description"
	| "RouteMcpServersPluginServers-items"
	| "RouteMcpServersPluginServers-empty";

type RouteMcpServersPluginServers_Props = {
	servers: RouteMcpServers_PluginServer[];
	onDisconnect: (server: RouteMcpServers_PluginServer) => void;
};

const RouteMcpServersPluginServers = memo(function RouteMcpServersPluginServers(
	props: RouteMcpServersPluginServers_Props,
) {
	const { servers, onDisconnect } = props;

	return (
		<section className={"RouteMcpServersPluginServers" satisfies RouteMcpServersPluginServers_ClassNames}>
			<header className={"RouteMcpServersPluginServers-header" satisfies RouteMcpServersPluginServers_ClassNames}>
				<h2 className={"RouteMcpServersPluginServers-title" satisfies RouteMcpServersPluginServers_ClassNames}>
					Plugin servers
				</h2>
				<p className={"RouteMcpServersPluginServers-description" satisfies RouteMcpServersPluginServers_ClassNames}>
					MCP servers of the plugins in this workspace that need your own sign-in.
				</p>
			</header>

			{servers.length === 0 ? (
				<p className={"RouteMcpServersPluginServers-empty" satisfies RouteMcpServersPluginServers_ClassNames}>
					No plugin server needs your sign-in in this workspace.
				</p>
			) : (
				<ul
					className={"RouteMcpServersPluginServers-items" satisfies RouteMcpServersPluginServers_ClassNames}
					aria-label="Plugin servers"
				>
					{servers.map((server) => (
						<RouteMcpServersPluginServer
							key={`${server.target.installationId}:${server.target.serverId}`}
							server={server}
							onDisconnect={onDisconnect}
						/>
					))}
				</ul>
			)}
		</section>
	);
});
// #endregion plugin servers

// #region saved server
type RouteMcpServersSavedServer_ClassNames =
	| "RouteMcpServersSavedServer"
	| "RouteMcpServersSavedServer-main"
	| "RouteMcpServersSavedServer-titleRow"
	| "RouteMcpServersSavedServer-name"
	| "RouteMcpServersSavedServer-details"
	| "RouteMcpServersSavedServer-headers"
	| "RouteMcpServersSavedServer-header"
	| "RouteMcpServersSavedServer-secret"
	| "RouteMcpServersSavedServer-test"
	| "RouteMcpServersSavedServer-test-error"
	| "RouteMcpServersSavedServer-actions";

type RouteMcpServersSavedServer_CustomAttributes = {
	"data-mcp-server-status": ReturnType<typeof get_saved_server_status>;
	"data-secret-state": "set" | "missing";
};

type RouteMcpServersSavedServer_Props = {
	server: RouteMcpServers_SavedServer;
	canUse: boolean;
	/**
	 * A save is running. Edit waits for it, because a good save empties the editor.
	 */
	saving: boolean;
	testResult: RouteMcpServers_TestResult | null;
	onTest: (server: RouteMcpServers_SavedServer) => void;
	onEdit: (server: RouteMcpServers_SavedServer) => void;
	onSetEnabled: (server: RouteMcpServers_SavedServer, enabled: boolean) => void;
	onDelete: (server: RouteMcpServers_SavedServer) => void;
};

const RouteMcpServersSavedServer = memo(function RouteMcpServersSavedServer(props: RouteMcpServersSavedServer_Props) {
	const { server, canUse, saving, testResult, onTest, onEdit, onSetEnabled, onDelete } = props;
	const status = get_saved_server_status(server);

	return (
		<li
			className={"RouteMcpServersSavedServer" satisfies RouteMcpServersSavedServer_ClassNames}
			aria-label={server.name}
			{...({ "data-mcp-server-status": status } satisfies Partial<RouteMcpServersSavedServer_CustomAttributes>)}
		>
			<div className={"RouteMcpServersSavedServer-main" satisfies RouteMcpServersSavedServer_ClassNames}>
				<div className={"RouteMcpServersSavedServer-titleRow" satisfies RouteMcpServersSavedServer_ClassNames}>
					<h3 className={"RouteMcpServersSavedServer-name" satisfies RouteMcpServersSavedServer_ClassNames}>
						{server.name}
					</h3>
					<MyBadge variant={status === "ready" ? "secondary" : "outline"}>{format_saved_server_status(server)}</MyBadge>
				</div>
				<p className={"RouteMcpServersSavedServer-details" satisfies RouteMcpServersSavedServer_ClassNames}>
					{server.host} — {format_last_test(server.lastTest)}
					{server.auth.kind === "oauth" ? ` — Signs in at ${server.auth.authorizationHost}` : ""}
				</p>

				{server.headers.length > 0 ? (
					<ul
						className={"RouteMcpServersSavedServer-headers" satisfies RouteMcpServersSavedServer_ClassNames}
						aria-label={`${server.name} headers`}
					>
						{server.headers.map((header) => (
							<li
								key={header.name}
								className={"RouteMcpServersSavedServer-header" satisfies RouteMcpServersSavedServer_ClassNames}
							>
								<code>{header.name}: </code>
								{/* Never a secret value: the list query only says whether a secret is set. */}
								{header.parts.map((part, index) =>
									part.kind === "text" ? (
										<code key={index}>{part.text}</code>
									) : (
										<span
											key={index}
											className={"RouteMcpServersSavedServer-secret" satisfies RouteMcpServersSavedServer_ClassNames}
											title={part.secretName}
											{...({
												"data-secret-state": part.set ? "set" : "missing",
											} satisfies Partial<RouteMcpServersSavedServer_CustomAttributes>)}
										>
											{part.set ? "Set" : "Missing"}
										</span>
									),
								)}
							</li>
						))}
					</ul>
				) : null}

				{testResult ? (
					<p
						className={cn(
							"RouteMcpServersSavedServer-test" satisfies RouteMcpServersSavedServer_ClassNames,
							testResult.kind === "error" &&
								("RouteMcpServersSavedServer-test-error" satisfies RouteMcpServersSavedServer_ClassNames),
						)}
						role="status"
					>
						{testResult.kind === "pending" ? "Testing..." : testResult.message}
					</p>
				) : null}
			</div>

			<div className={"RouteMcpServersSavedServer-actions" satisfies RouteMcpServersSavedServer_ClassNames}>
				<MyButton
					variant="outline"
					disabled={!canUse}
					aria-busy={testResult?.kind === "pending"}
					aria-label={`Test ${server.name}`}
					onClick={() => onTest(server)}
				>
					<Plug aria-hidden />
					Test
				</MyButton>
				<MyButton
					variant="outline"
					disabled={!canUse || saving}
					aria-label={`Edit ${server.name}`}
					onClick={() => onEdit(server)}
				>
					<Pencil aria-hidden />
					Edit
				</MyButton>
				{/* Turning a server off never needs the permission, so a member who lost it can still stop it. */}
				<MyButton
					variant="outline"
					disabled={!server.enabled && !canUse}
					aria-label={server.enabled ? `Turn off ${server.name}` : `Turn on ${server.name}`}
					onClick={() => onSetEnabled(server, !server.enabled)}
				>
					<Power aria-hidden />
					{server.enabled ? "Turn off" : "Turn on"}
				</MyButton>
				<MyButton variant="ghost_destructive" aria-label={`Delete ${server.name}`} onClick={() => onDelete(server)}>
					<Trash2 aria-hidden />
					Delete
				</MyButton>
			</div>
		</li>
	);
});
// #endregion saved server

// #region saved servers
type RouteMcpServersSavedServers_ClassNames =
	| "RouteMcpServersSavedServers"
	| "RouteMcpServersSavedServers-header"
	| "RouteMcpServersSavedServers-title"
	| "RouteMcpServersSavedServers-description"
	| "RouteMcpServersSavedServers-items"
	| "RouteMcpServersSavedServers-empty";

type RouteMcpServersSavedServers_Props = {
	servers: RouteMcpServers_SavedServer[];
	canUse: boolean;
	saving: boolean;
	testResults: Record<string, RouteMcpServers_TestResult>;
	onTest: (server: RouteMcpServers_SavedServer) => void;
	onEdit: (server: RouteMcpServers_SavedServer) => void;
	onSetEnabled: (server: RouteMcpServers_SavedServer, enabled: boolean) => void;
	onDelete: (server: RouteMcpServers_SavedServer) => void;
};

const RouteMcpServersSavedServers = memo(function RouteMcpServersSavedServers(
	props: RouteMcpServersSavedServers_Props,
) {
	const { servers, canUse, saving, testResults, onTest, onEdit, onSetEnabled, onDelete } = props;

	return (
		<section className={"RouteMcpServersSavedServers" satisfies RouteMcpServersSavedServers_ClassNames}>
			<header className={"RouteMcpServersSavedServers-header" satisfies RouteMcpServersSavedServers_ClassNames}>
				<h2 className={"RouteMcpServersSavedServers-title" satisfies RouteMcpServersSavedServers_ClassNames}>
					Your servers
				</h2>
				<p className={"RouteMcpServersSavedServers-description" satisfies RouteMcpServersSavedServers_ClassNames}>
					Servers you added in this workspace. Only you can see and use them.
				</p>
			</header>

			{servers.length === 0 ? (
				<p className={"RouteMcpServersSavedServers-empty" satisfies RouteMcpServersSavedServers_ClassNames}>
					You have not added any MCP servers in this workspace.
				</p>
			) : (
				<ul
					className={"RouteMcpServersSavedServers-items" satisfies RouteMcpServersSavedServers_ClassNames}
					aria-label="Your servers"
				>
					{servers.map((server) => (
						<RouteMcpServersSavedServer
							key={server.customServerId}
							server={server}
							canUse={canUse}
							saving={saving}
							testResult={testResults[server.customServerId] ?? null}
							onTest={onTest}
							onEdit={onEdit}
							onSetEnabled={onSetEnabled}
							onDelete={onDelete}
						/>
					))}
				</ul>
			)}
		</section>
	);
});
// #endregion saved servers

// #region draft secret
type RouteMcpServersDraftSecret_CustomAttributes = {
	"data-secret-state": "set" | "missing";
};

type RouteMcpServersDraftSecret_Props = {
	headerName: string;
	part: RouteMcpServers_SecretPart;
	value: string;
	notSecret: boolean;
	disabled: boolean;
	onValueChange: (value: string) => void;
};

const RouteMcpServersDraftSecret = memo(function RouteMcpServersDraftSecret(props: RouteMcpServersDraftSecret_Props) {
	const { headerName, part, value, notSecret, disabled, onValueChange } = props;
	const secretState = value !== "" || part.stored || part.prefill !== null ? "set" : "missing";

	return (
		<MyInput layout="stacked">
			<MyInputLabel>{`${headerName} (${part.secretName})`}</MyInputLabel>
			<MyInputBackground />
			<MyInputArea>
				<MyInputControl
					{...({ "data-secret-state": secretState } satisfies Partial<RouteMcpServersDraftSecret_CustomAttributes>)}
					// "Not secret" only applies to a pasted literal value.
					type={notSecret && part.canBeText ? "text" : "password"}
					autoComplete="off"
					value={value}
					disabled={disabled}
					placeholder={
						part.stored ? "Leave empty to keep the saved value" : part.prefill !== null ? "Uses the pasted value" : ""
					}
					onChange={(event) => onValueChange(event.currentTarget.value)}
				/>
			</MyInputArea>
			<MyInputBox />
			<MyInputHelperText>
				{part.stored
					? "Set. Type a new value to replace it."
					: part.prefill !== null
						? "Uses the value from the pasted text. Type to replace it."
						: (part.hint ?? "Required.")}
			</MyInputHelperText>
		</MyInput>
	);
});
// #endregion draft secret

// #region draft
type RouteMcpServersDraft_ClassNames =
	| "RouteMcpServersDraft"
	| "RouteMcpServersDraft-header"
	| "RouteMcpServersDraft-title"
	| "RouteMcpServersDraft-refusal"
	| "RouteMcpServersDraft-note"
	| "RouteMcpServersDraft-form"
	| "RouteMcpServersDraft-preview"
	| "RouteMcpServersDraft-headerGroup"
	| "RouteMcpServersDraft-notSecret"
	| "RouteMcpServersDraft-warning"
	| "RouteMcpServersDraft-result"
	| "RouteMcpServersDraft-result-error"
	| "RouteMcpServersDraft-actions";

type RouteMcpServersDraft_CustomAttributes = {
	"data-mcp-draft-state": mcp_custom_config_Draft["state"];
};

type RouteMcpServersDraft_Props = {
	draft: mcp_custom_config_Draft;
	editing: RouteMcpServers_Editing | null;
	saving: boolean;
	disabled: boolean;
	result: RouteMcpServers_SaveResult | null;
	onSave: (draftKey: string, fill: RouteMcpServers_Fill) => void;
};

const RouteMcpServersDraft = memo(function RouteMcpServersDraft(props: RouteMcpServersDraft_Props) {
	const { draft, editing, saving, disabled, result, onSave } = props;
	const [name, setName] = useState(draft.name);
	const [urlFields, setUrlFields] = useState<Record<string, string>>({});
	const [secretValues, setSecretValues] = useState<Record<string, string>>({});
	const [notSecretHeaders, setNotSecretHeaders] = useState(() => editing?.textHeaderNames ?? []);

	const secretParts = draft.headers.flatMap((header) =>
		header.parts.flatMap((part) => (part.kind === "secret" ? [part] : [])),
	);
	const urlText = draft.urlParts
		.map((part) => (part.kind === "text" ? part.text : part.kind === "field" ? (urlFields[part.fieldName] ?? "") : ""))
		.join("");
	const urlPreview = draft.urlParts
		.map((part) => (part.kind === "text" ? part.text : part.kind === "field" ? `{${part.fieldName}}` : ""))
		.join("");
	// Saving a new address deletes the member's sign-in for the server, so warn before the save.
	const addressChangeWarning = editing !== null && editing.hasConnection && urlText !== editing.url;

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		onSave(draft.key, {
			name,
			urlFields: Object.entries(urlFields).map(([fieldName, value]) => ({ name: fieldName, value })),
			notSecretHeaders,
			secretValues: Object.entries(secretValues)
				.filter(([, value]) => value !== "")
				.map(([secretName, value]) => ({ name: secretName, value })),
			// A saved secret keeps its stored value unless the member typed a new one.
			keptSecretNames: [
				...new Set(
					secretParts
						.filter((part) => part.stored && (secretValues[part.secretName] ?? "") === "")
						.map((part) => part.secretName),
				),
			],
		});
	};

	return (
		<article
			className={"RouteMcpServersDraft" satisfies RouteMcpServersDraft_ClassNames}
			aria-label={`Server ${draft.name}`}
			{...({ "data-mcp-draft-state": draft.state } satisfies Partial<RouteMcpServersDraft_CustomAttributes>)}
		>
			<header className={"RouteMcpServersDraft-header" satisfies RouteMcpServersDraft_ClassNames}>
				<h3 className={"RouteMcpServersDraft-title" satisfies RouteMcpServersDraft_ClassNames}>{draft.name}</h3>
				<MyBadge variant={draft.state === "refused" ? "destructive" : "outline"}>
					{DRAFT_STATE_LABELS[draft.state]}
				</MyBadge>
			</header>

			{draft.convertedFromMcpRemote ? (
				<p className={"RouteMcpServersDraft-note" satisfies RouteMcpServersDraft_ClassNames}>
					Use the remote server instead. This entry runs mcp-remote on your computer, so Press connects to the remote
					server directly.
				</p>
			) : null}
			{draft.ignoredKeys.length > 0 ? (
				<p className={"RouteMcpServersDraft-note" satisfies RouteMcpServersDraft_ClassNames}>
					Ignored: {draft.ignoredKeys.join(", ")}
				</p>
			) : null}

			{draft.state === "refused" ? (
				<p className={"RouteMcpServersDraft-refusal" satisfies RouteMcpServersDraft_ClassNames} role="alert">
					<AlertTriangle aria-hidden />
					{draft.refusal}
				</p>
			) : (
				<form className={"RouteMcpServersDraft-form" satisfies RouteMcpServersDraft_ClassNames} onSubmit={handleSubmit}>
					<MyInput layout="stacked">
						<MyInputLabel>Name</MyInputLabel>
						<MyInputBackground />
						<MyInputArea>
							<MyInputControl
								value={name}
								disabled={disabled}
								onChange={(event) => setName(event.currentTarget.value)}
							/>
						</MyInputArea>
						<MyInputBox />
					</MyInput>

					<p className={"RouteMcpServersDraft-preview" satisfies RouteMcpServersDraft_ClassNames}>
						URL: <code>{urlPreview}</code>
					</p>
					{draft.urlParts.map((part) =>
						part.kind === "field" ? (
							<MyInput key={part.fieldName} layout="stacked">
								<MyInputLabel>{part.fieldName}</MyInputLabel>
								<MyInputBackground />
								<MyInputArea>
									<MyInputControl
										value={urlFields[part.fieldName] ?? ""}
										disabled={disabled}
										onChange={(event) => {
											const value = event.currentTarget.value;
											setUrlFields((current) => ({ ...current, [part.fieldName]: value }));
										}}
									/>
								</MyInputArea>
								<MyInputBox />
								<MyInputHelperText>{part.hint ?? "Part of the server address. It is not secret."}</MyInputHelperText>
							</MyInput>
						) : null,
					)}

					{draft.headers.map((header) => {
						const notSecret = notSecretHeaders.includes(header.name);
						return (
							<div
								key={header.name}
								className={"RouteMcpServersDraft-headerGroup" satisfies RouteMcpServersDraft_ClassNames}
							>
								<p className={"RouteMcpServersDraft-preview" satisfies RouteMcpServersDraft_ClassNames}>
									<code>
										{header.name}:{" "}
										{header.parts
											.map((part) =>
												part.kind === "text" ? part.text : part.kind === "secret" ? `{${part.secretName}}` : "",
											)
											.join("")}
									</code>
								</p>
								{header.parts.some((part) => part.kind === "secret" && part.canBeText) ? (
									<label className={"RouteMcpServersDraft-notSecret" satisfies RouteMcpServersDraft_ClassNames}>
										<MySwitch
											checked={notSecret}
											disabled={disabled}
											aria-label={`${header.name} is not secret`}
											onCheckedChange={(checked) =>
												setNotSecretHeaders((current) =>
													checked
														? [...current, header.name]
														: current.filter((headerName) => headerName !== header.name),
												)
											}
										/>
										Not secret
									</label>
								) : null}
								{header.parts.map((part) =>
									part.kind === "secret" ? (
										<RouteMcpServersDraftSecret
											key={part.secretName}
											headerName={header.name}
											part={part}
											value={secretValues[part.secretName] ?? ""}
											notSecret={notSecret}
											disabled={disabled}
											onValueChange={(value) =>
												setSecretValues((current) => ({ ...current, [part.secretName]: value }))
											}
										/>
									) : null,
								)}
							</div>
						);
					})}

					{addressChangeWarning ? (
						<p className={"RouteMcpServersDraft-warning" satisfies RouteMcpServersDraft_ClassNames} role="status">
							<AlertTriangle aria-hidden />
							The server address changed. You will need to sign in again.
						</p>
					) : null}

					{result ? (
						<p
							className={cn(
								"RouteMcpServersDraft-result" satisfies RouteMcpServersDraft_ClassNames,
								result.kind === "error" &&
									("RouteMcpServersDraft-result-error" satisfies RouteMcpServersDraft_ClassNames),
							)}
							role={result.kind === "error" ? "alert" : "status"}
						>
							{result.message}
						</p>
					) : null}

					<div className={"RouteMcpServersDraft-actions" satisfies RouteMcpServersDraft_ClassNames}>
						<MyButton
							type="submit"
							disabled={disabled || result?.kind === "saved"}
							aria-busy={saving}
							aria-label={`Save ${draft.name}`}
						>
							<Save aria-hidden />
							{saving ? "Saving..." : "Save"}
						</MyButton>
					</div>
				</form>
			)}
		</article>
	);
});
// #endregion draft

// #region editor
type RouteMcpServersEditor_ClassNames =
	| "RouteMcpServersEditor"
	| "RouteMcpServersEditor-editor"
	| "RouteMcpServersEditor-errors";

type RouteMcpServersEditor_Props = {
	text: string;
	errors: RouteMcpServers_ParseError[];
	readOnly: boolean;
	onTextChange: (text: string) => void;
};

const RouteMcpServersEditor = memo(function RouteMcpServersEditor(props: RouteMcpServersEditor_Props) {
	const { text, errors, readOnly, onTextChange } = props;
	// Keep the editor in state, so the marker effect below runs again once the editor mounts.
	const [editor, setEditor] = useState<monaco_editor.IStandaloneCodeEditor | null>(null);
	const hoistingContainer = document.getElementById("app_monaco_hoisting_container" satisfies AppElementId);
	// Keep construction-only Monaco options stable because @monaco-editor/react deep-clones
	// option updates and DOM references in these options are cyclic.
	const [editorOptions] = useState(() => {
		return {
			overflowWidgetsDomNode: hoistingContainer ?? undefined,
			fixedOverflowWidgets: true,
			ariaLabel: "MCP server config JSON",
			placeholder: "Paste the MCP config from the server's docs",
			// Let Tab move focus out to the Save button. Monaco traps Tab by default, and members paste
			// this text instead of typing its indentation.
			tabFocusMode: true,
			automaticLayout: true,
			fontSize: 14,
			lineHeight: 20,
			minimap: { enabled: false },
			padding: { top: 12, bottom: 12 },
			scrollBeyondLastLine: false,
			wordWrap: "on",
		} satisfies NonNullable<EditorProps["options"]>;
	});

	const handleOnMount = useFn<EditorProps["onMount"]>((mountedEditor) => {
		setEditor(mountedEditor);
	});

	useEffect(() => {
		editor?.updateOptions({ readOnly });
	}, [editor, readOnly]);

	// The app turns Monaco's own JSON checks off, so show the shared parser's errors as markers.
	useEffect(() => {
		const model = editor?.getModel();
		if (!model) {
			return;
		}

		monaco_editor.setModelMarkers(
			model,
			MONACO_MARKER_OWNER,
			errors.map((error) => {
				const start = model.getPositionAt(error.offset);
				// A zero-length error still needs one character, or Monaco draws nothing.
				const end = model.getPositionAt(error.offset + Math.max(error.length, 1));
				return {
					severity: monaco_MarkerSeverity.Error,
					message: error.message,
					startLineNumber: start.lineNumber,
					startColumn: start.column,
					endLineNumber: end.lineNumber,
					endColumn: end.column,
				};
			}),
		);
	}, [editor, errors]);

	return (
		<div className={"RouteMcpServersEditor" satisfies RouteMcpServersEditor_ClassNames}>
			<div className={"RouteMcpServersEditor-editor" satisfies RouteMcpServersEditor_ClassNames}>
				{hoistingContainer ? (
					<Editor
						height="240px"
						language="json"
						theme={app_monaco_THEME_NAME_DARK}
						value={text}
						options={editorOptions}
						onMount={handleOnMount}
						onChange={(value) => onTextChange(value ?? "")}
					/>
				) : null}
			</div>

			{errors.length > 0 ? (
				<ul
					className={"RouteMcpServersEditor-errors" satisfies RouteMcpServersEditor_ClassNames}
					role="status"
					aria-label="Problems in the pasted text"
				>
					{errors.map((error, index) => (
						<li key={index}>{error.message}</li>
					))}
				</ul>
			) : null}
		</div>
	);
});
// #endregion editor

// #region add
type RouteMcpServersAdd_ClassNames =
	| "RouteMcpServersAdd"
	| "RouteMcpServersAdd-header"
	| "RouteMcpServersAdd-title"
	| "RouteMcpServersAdd-description"
	| "RouteMcpServersAdd-editing"
	| "RouteMcpServersAdd-notice"
	| "RouteMcpServersAdd-drafts";

type RouteMcpServersAdd_Props = {
	canUse: boolean;
	text: string;
	editing: RouteMcpServers_Editing | null;
	savingDraftKey: string | null;
	saveResults: Record<string, RouteMcpServers_SaveResult>;
	notice: string | null;
	onTextChange: (text: string) => void;
	onCancelEdit: () => void;
	onSave: (draftKey: string, fill: RouteMcpServers_Fill) => void;
};

const RouteMcpServersAdd = memo(function RouteMcpServersAdd(props: RouteMcpServersAdd_Props) {
	const { canUse, text, editing, savingDraftKey, saveResults, notice, onTextChange, onCancelEdit, onSave } = props;
	// An empty editor is not an error. Skip the parser so it does not say "Value expected".
	const parsed = text.trim() === "" ? null : mcp_custom_config_parse(text);

	return (
		<section className={"RouteMcpServersAdd" satisfies RouteMcpServersAdd_ClassNames}>
			<header className={"RouteMcpServersAdd-header" satisfies RouteMcpServersAdd_ClassNames}>
				<h2 className={"RouteMcpServersAdd-title" satisfies RouteMcpServersAdd_ClassNames}>
					{editing ? `Edit ${editing.name}` : "Add a server"}
				</h2>
				<p className={"RouteMcpServersAdd-description" satisfies RouteMcpServersAdd_ClassNames}>
					Paste the MCP config JSON from the server's docs. Press reads the Claude, Cursor, VS Code, Windsurf, and Cline
					formats. Press saves the server address and your values, never the pasted text.
				</p>
			</header>

			{canUse ? (
				<>
					{editing ? (
						<div className={"RouteMcpServersAdd-editing" satisfies RouteMcpServersAdd_ClassNames}>
							<span>Editing {editing.name}. Save replaces the saved server.</span>
							<MyButton variant="ghost" disabled={savingDraftKey !== null} onClick={onCancelEdit}>
								<X aria-hidden />
								Cancel edit
							</MyButton>
						</div>
					) : null}

					<RouteMcpServersEditor
						text={text}
						errors={parsed?.errors ?? []}
						readOnly={savingDraftKey !== null}
						onTextChange={onTextChange}
					/>

					{notice ? (
						<p className={"RouteMcpServersAdd-notice" satisfies RouteMcpServersAdd_ClassNames} role="status">
							{notice}
						</p>
					) : null}

					{parsed && parsed.drafts.length > 0 ? (
						<div
							className={"RouteMcpServersAdd-drafts" satisfies RouteMcpServersAdd_ClassNames}
							aria-label="Servers found"
							role="group"
						>
							{parsed.drafts.map((draft) => (
								<RouteMcpServersDraft
									// Start a new card for another edited server, so typed values never carry over.
									key={`${editing?.customServerId ?? "new"}:${draft.key}`}
									draft={draft}
									editing={editing}
									saving={savingDraftKey === draft.key}
									disabled={savingDraftKey !== null}
									result={saveResults[draft.key] ?? null}
									onSave={onSave}
								/>
							))}
						</div>
					) : null}
				</>
			) : (
				<p className={"RouteMcpServersAdd-notice" satisfies RouteMcpServersAdd_ClassNames}>
					You cannot add or test MCP servers in this workspace. You can still turn off and delete the servers you saved.
				</p>
			)}
		</section>
	);
});
// #endregion add

// #region delete modal
type RouteMcpServersDeleteModal_ClassNames = "RouteMcpServersDeleteModal" | "RouteMcpServersDeleteModal-content";

type RouteMcpServersDeleteModal_Props = {
	target: RouteMcpServers_SavedServer | null;
	pending: boolean;
	error: string | null;
	onClose: () => void;
	onConfirm: () => void;
};

const RouteMcpServersDeleteModal = memo(function RouteMcpServersDeleteModal(props: RouteMcpServersDeleteModal_Props) {
	const { target, pending, error, onClose, onConfirm } = props;

	return (
		<MyModal open={target !== null} setOpen={(open) => !open && !pending && onClose()}>
			<MyModalPopover className={"RouteMcpServersDeleteModal" satisfies RouteMcpServersDeleteModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>{`Delete “${target?.name ?? "server"}”?`}</MyModalHeading>
					<MyModalDescription>
						Press deletes the server, its saved secrets, and your sign-in for it. This cannot be undone.
					</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<div className={"RouteMcpServersDeleteModal-content" satisfies RouteMcpServersDeleteModal_ClassNames}>
						{target ? <code>{target.url}</code> : null}
						{error ? <div role="alert">{error}</div> : null}
					</div>
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="ghost" disabled={pending} onClick={onClose}>
						Cancel
					</MyButton>
					<MyButton variant="destructive" disabled={pending || target === null} aria-busy={pending} onClick={onConfirm}>
						{pending ? "Deleting..." : "Delete server"}
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger disabled={pending} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion delete modal

// #region root
type RouteMcpServers_ClassNames =
	| "RouteMcpServers"
	| "RouteMcpServers-content"
	| "RouteMcpServers-loading"
	| "RouteMcpServersHeader"
	| "RouteMcpServersHeader-title"
	| "RouteMcpServersHeader-description";

function RouteMcpServers() {
	const { membershipId } = AppTenantProvider.useContext();

	// Remount on a workspace change so typed secrets and pending requests cannot cross tenant boundaries.
	return <RouteMcpServersMembership key={membershipId} membershipId={membershipId} />;
}

type RouteMcpServersMembership_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
};

function RouteMcpServersMembership(props: RouteMcpServersMembership_Props) {
	const { membershipId } = props;
	const customServers = useQuery(app_convex_api.mcp_custom_servers.list, { membershipId });
	const pluginConnections = useQuery(app_convex_api.plugins_mcp.list_member_plugin_connections, { membershipId });
	const [text, setText] = useState("");
	const [editing, setEditing] = useState<RouteMcpServers_Editing | null>(null);
	const [savingDraftKey, setSavingDraftKey] = useState<string | null>(null);
	// An error belongs to one editor text, so any edit of the text drops it. A saved card stays locked
	// until the editor text is replaced, so a later edit cannot save the same server twice.
	const [saveState, setSaveState] = useState<{ text: string; results: Record<string, RouteMcpServers_SaveResult> }>({
		text: "",
		results: {},
	});
	const [notice, setNotice] = useState<string | null>(null);
	const [testResults, setTestResults] = useState<Record<string, RouteMcpServers_TestResult>>({});
	const [deleteTarget, setDeleteTarget] = useState<RouteMcpServers_SavedServer | null>(null);
	const [deletePending, setDeletePending] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	const saveResults = saveState.text === text ? saveState.results : keep_saved_results(saveState.results);

	const replaceText = (nextText: string) => {
		setText(nextText);
		setSaveState({ text: nextText, results: {} });
	};

	const handleTextChange = useFn((nextText: string) => {
		// A read-only Monaco editor reports the text the page itself set, for example when a save empties
		// it. That is not an edit by the member, so keep the save notice.
		if (nextText === text) {
			return;
		}

		if (nextText.trim() === "") {
			replaceText(nextText);
		} else {
			setText(nextText);
		}
		setNotice(null);
	});

	const handleCancelEdit = useFn(() => {
		replaceText("");
		setEditing(null);
	});

	const handleSave = useFn((draftKey: string, fill: RouteMcpServers_Fill) => {
		if (savingDraftKey !== null) {
			return;
		}

		const sentText = text;
		const draftCount = mcp_custom_config_parse(sentText).drafts.length;
		const setResult = (saveResult: RouteMcpServers_SaveResult) => {
			setSaveState((current) => ({
				text: sentText,
				results: {
					...(current.text === sentText ? current.results : keep_saved_results(current.results)),
					[draftKey]: saveResult,
				},
			}));
		};

		// Every card of an edit saves into the edited server, so a second card would overwrite it.
		if (editing !== null && draftCount > 1) {
			setResult({
				kind: "error",
				message: "Edit one server at a time. Remove the other servers from the text, or cancel the edit.",
			});
			return;
		}

		setSavingDraftKey(draftKey);
		setNotice(null);
		app_convex
			.action(app_convex_api.mcp_custom_servers.save, {
				membershipId,
				customServerId: editing?.customServerId ?? null,
				text: sentText,
				draftKey,
				fill,
			})
			.then((result) => {
				if (result._nay) {
					setResult({ kind: "error", message: result._nay.message });
					return;
				}

				// A failed probe still saves. The member can test the server again from the list.
				const message =
					result._yay.outcome === "ok"
						? `Saved ${fill.name.trim()}. Found ${result._yay.toolCount ?? 0} tools.`
						: `Saved ${fill.name.trim()}, but the connection test failed: ${result._yay.message ?? result._yay.outcome}`;
				// An old test result describes the server before this save.
				const customServerId = result._yay.customServerId;
				setTestResults((current) =>
					Object.fromEntries(Object.entries(current).filter(([id]) => id !== customServerId)),
				);

				// With one server in the text, a good save empties the editor. With more, the other cards stay.
				if (draftCount === 1) {
					replaceText("");
					setEditing(null);
					setNotice(message);
					return;
				}

				setResult({ kind: "saved", message });
			})
			.catch((error: unknown) => {
				console.error("[RouteMcpServers.handleSave] Failed to save MCP server", { error, membershipId, draftKey });
				setResult({ kind: "error", message: "Could not save the server. Try again." });
			})
			.finally(() => {
				setSavingDraftKey(null);
			});
	});

	const handleTest = useFn((server: RouteMcpServers_SavedServer) => {
		const customServerId = server.customServerId;
		if (testResults[customServerId]?.kind === "pending") {
			return;
		}

		setTestResults((current) => ({ ...current, [customServerId]: { kind: "pending" } }));
		app_convex
			.action(app_convex_api.mcp_custom_servers.test_connection, { membershipId, customServerId })
			.then((result) => {
				const testResult: RouteMcpServers_TestResult = result._nay
					? { kind: "error", message: result._nay.message }
					: result._yay.outcome === "ok"
						? { kind: "ok", message: `Connected. Found ${result._yay.toolCount ?? 0} tools.` }
						: { kind: "error", message: `Test failed: ${result._yay.message ?? result._yay.outcome}` };
				setTestResults((current) => ({ ...current, [customServerId]: testResult }));
			})
			.catch((error: unknown) => {
				console.error("[RouteMcpServers.handleTest] Failed to test MCP server", { error, customServerId });
				setTestResults((current) => ({
					...current,
					[customServerId]: { kind: "error", message: "Could not test the server. Try again." },
				}));
			});
	});

	const handleEdit = useFn((server: RouteMcpServers_SavedServer) => {
		replaceText(
			mcp_custom_config_to_text({
				name: server.name,
				url: server.url,
				headers: server.headers.map((header) => ({
					name: header.name,
					parts: header.parts.map((part) =>
						part.kind === "text" ? part : { kind: "secret" as const, secretName: part.secretName },
					),
				})),
			}),
		);
		setEditing({
			customServerId: server.customServerId,
			name: server.name,
			url: server.url,
			hasConnection: server.connection !== null,
			textHeaderNames: server.headers
				.filter((header) => header.parts.every((part) => part.kind === "text"))
				.map((header) => header.name),
		});
		setNotice(null);
	});

	const handleSetEnabled = useFn((server: RouteMcpServers_SavedServer, enabled: boolean) => {
		app_convex
			.mutation(app_convex_api.mcp_custom_servers.set_enabled, {
				membershipId,
				customServerId: server.customServerId,
				enabled,
			})
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[RouteMcpServers.handleSetEnabled] Failed to change MCP server", {
					error,
					customServerId: server.customServerId,
				});
				toast.error("Could not change the server. Try again.");
			});
	});

	const handleDisconnect = useFn((server: RouteMcpServers_PluginServer) => {
		app_convex
			.mutation(app_convex_api.plugins_mcp_oauth.disconnect, { membershipId, target: server.target })
			.then((result) => {
				if (result._nay) {
					toast.error(result._nay.message);
				}
			})
			.catch((error: unknown) => {
				console.error("[RouteMcpServers.handleDisconnect] Failed to disconnect MCP server", {
					error,
					target: server.target,
				});
				toast.error("Could not disconnect. Try again.");
			});
	});

	const handleDelete = useFn(() => {
		if (!deleteTarget || deletePending) {
			return;
		}

		const target = deleteTarget;
		setDeletePending(true);
		setDeleteError(null);
		app_convex
			.mutation(app_convex_api.mcp_custom_servers.remove, { membershipId, customServerId: target.customServerId })
			.then((result) => {
				if (result._nay) {
					setDeleteError(result._nay.message);
					return;
				}

				setDeleteTarget(null);
				// The edited server is gone, so a later Save must not try to update it.
				if (editing?.customServerId === target.customServerId) {
					replaceText("");
					setEditing(null);
				}
			})
			.catch((error: unknown) => {
				console.error("[RouteMcpServers.handleDelete] Failed to delete MCP server", {
					error,
					customServerId: target.customServerId,
				});
				setDeleteError("Could not delete the server. Try again.");
			})
			.finally(() => {
				setDeletePending(false);
			});
	});

	if (customServers === undefined || pluginConnections === undefined) {
		return (
			<main
				className={cn("RouteMcpServers" satisfies RouteMcpServers_ClassNames, "app-scrollable" satisfies AppClassName)}
				role="status"
				aria-live="polite"
			>
				<div className={"RouteMcpServers-content" satisfies RouteMcpServers_ClassNames}>
					<div className={"RouteMcpServers-loading" satisfies RouteMcpServers_ClassNames}>
						<Server aria-hidden />
						Loading MCP servers...
					</div>
				</div>
			</main>
		);
	}

	return (
		<main
			className={cn("RouteMcpServers" satisfies RouteMcpServers_ClassNames, "app-scrollable" satisfies AppClassName)}
		>
			<div className={"RouteMcpServers-content" satisfies RouteMcpServers_ClassNames}>
				<header className={"RouteMcpServersHeader" satisfies RouteMcpServers_ClassNames}>
					<h1 className={"RouteMcpServersHeader-title" satisfies RouteMcpServers_ClassNames}>MCP servers</h1>
					<p className={"RouteMcpServersHeader-description" satisfies RouteMcpServers_ClassNames}>
						MCP servers are outside services. When the chat agent calls one of their tools, the chat sends that call's
						data to the server.
					</p>
				</header>

				<RouteMcpServersPluginServers servers={pluginConnections.servers} onDisconnect={handleDisconnect} />

				<RouteMcpServersSavedServers
					servers={customServers.servers}
					canUse={customServers.canUse}
					saving={savingDraftKey !== null}
					testResults={testResults}
					onTest={handleTest}
					onEdit={handleEdit}
					onSetEnabled={handleSetEnabled}
					onDelete={(server) => {
						setDeleteError(null);
						setDeleteTarget(server);
					}}
				/>

				<RouteMcpServersAdd
					canUse={customServers.canUse}
					text={text}
					editing={editing}
					savingDraftKey={savingDraftKey}
					saveResults={saveResults}
					notice={notice}
					onTextChange={handleTextChange}
					onCancelEdit={handleCancelEdit}
					onSave={handleSave}
				/>
			</div>

			<RouteMcpServersDeleteModal
				target={deleteTarget}
				pending={deletePending}
				error={deleteError}
				onClose={() => {
					if (!deletePending) setDeleteTarget(null);
				}}
				onConfirm={handleDelete}
			/>
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/mcp-servers/")({
	component: RouteMcpServers,
});

export { Route };
// #endregion root
