import "./plugin-page.css";

import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Puzzle } from "lucide-react";
import { memo, useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";

import { FileEditorSidebarAgent } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-agent.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import { PluginsHeaderBreadcrumb } from "@/components/plugins-header-breadcrumb.tsx";
import {
	PluginsUiFrame,
	type PluginsUiFrame_AgentToolResult,
	type PluginsUiFrame_Props,
	type PluginsUiFrame_Ref,
} from "@/components/plugins-ui-frame.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { Id } from "../../../../../../convex/_generated/dataModel.ts";

// #region root
type RoutePluginsPluginPage_ClassNames =
	| "RoutePluginsPluginPage"
	| "RoutePluginsPluginPage-loading"
	| "RoutePluginsPluginPage-missing"
	| "RoutePluginsPluginPage-panel"
	| "RoutePluginsPluginPage-agent";

/**
 * May this page move focus right now?
 *
 * Yes when the member's focus is already inside the page region. Yes too when focus sits on the
 * document body, because that is where the browser leaves it after the iframe holding it is removed,
 * and yes when the document reports no focused element at all. No while the member is typing
 * somewhere else on the screen: the moves below run on timers and on live query updates that the
 * member never asked for.
 */
function can_take_focus(region: HTMLElement | null) {
	const focused = document.activeElement;
	return focused === null || focused === document.body || region?.contains(focused) === true;
}

function RoutePluginsPluginPage() {
	const { pluginName, pageId } = Route.useParams();
	const { membershipId } = AppTenantProvider.useContext();
	const uiPages = useQuery(app_convex_api.plugins_ui_installed.list_ui_pages, { membershipId });
	const mainRef = useRef<HTMLElement | null>(null);
	// The frame the member was looking at before this render. Null means there was no frame yet.
	const previousFrameIdentityRef = useRef<string | null>(null);
	// Names the "page is gone" message, so the focused page region can point at it.
	const missingMessageId = `RoutePluginsPluginPage-${useId()}-description`;
	// Incremented by Retry. It is part of the frame key below, so each attempt gets a fresh frame.
	const [attempt, setAttempt] = useState(0);
	// A random id for this tab. The chat sends it, and only the frame of this tab runs the agent's
	// page tool calls. Retry keeps it, so the new frame takes the calls of the same chat.
	const [pageInstanceId] = useState(() => crypto.randomUUID());

	const plugin = uiPages?.find((item) => item.pluginName === pluginName) ?? null;
	const page = plugin?.pages.find((item) => item.id === pageId) ?? null;
	// The query is live, so an admin uninstalling or disabling the plugin, or an upgrade that drops
	// this page, takes the frame away while the member is looking at it.
	const isPageMissing = uiPages !== undefined && (!plugin || !page);

	const pluginVersionId = plugin?.pluginVersionId ?? null;
	// Which frame the member is looking at: the tenant, the installed plugin version, and the page.
	// Retry is left out on purpose, so the focus rescue below can tell a frame the member replaced
	// from the same frame tried again.
	const frameIdentity = `${membershipId}:${pluginVersionId ?? "missing"}:${pageId ?? "missing"}`;
	// Any identity or Retry change creates a new iframe and nonce. The key also keys the child below,
	// so React throws that child away and builds a new one for every new frame.
	//
	// That remount is what keeps the frame's error and handshake honest. This route does not remount
	// when the page id changes, and the key can come back to a value it already had: the member
	// opens page A, then page B, then A again. State kept in the route and matched against this key
	// would then be handed to a brand-new frame, which would show A's old error over a frame that
	// never failed, or hide the starting placeholder over a frame that never started.
	const frameKey = `${frameIdentity}:${attempt}`;
	// The identity of the frame on screen right now, and null while there is no frame: the first
	// load, and after the page disappears. The rescue below reads both states.
	const renderedFrameIdentity = plugin && page ? frameIdentity : null;

	const handleRetry = useFn(() => {
		// The press is about to unmount this button, and focus would fall back to the document body:
		// a keyboard member would lose their place and have to tab from the top of the page. So take
		// focus to the page region the frame comes back into while the button is still there, and let
		// the next Tab reach the frame.
		mainRef.current?.focus();
		setAttempt((current) => current + 1);
	});

	// The page vanishing is as abrupt as a session error, so give it the same care. Announce the
	// message, and move focus to the page region so a member whose focus died with the iframe is not
	// left on the document body with nothing announced. There is nothing to retry here.
	useEffect(() => {
		if (isPageMissing && can_take_focus(mainRef.current)) {
			mainRef.current?.focus();
		}
	}, [isPageMissing]);

	// An admin installing a newer version changes the version id, and the member picking another page
	// of the same plugin changes the page id. Either one builds a brand-new frame, so the browser
	// throws away the iframe the member's focus was in and leaves that focus on the document body.
	// The region they are standing in then has nothing to tab to: the breadcrumb goes to the app
	// header through a portal, and the new frame is inert until it starts, which takes up to the
	// 15-second startup deadline. So put them on the page region, the same place Retry uses, and let
	// the next Tab reach the frame once it is running.
	useEffect(() => {
		const previousFrameIdentity = previousFrameIdentityRef.current;
		previousFrameIdentityRef.current = renderedFrameIdentity;

		// Only a frame that replaced another frame. A first load leaves focus on the body too, and
		// pulling the member into the region there would be a new annoyance instead of a fix. The two
		// identities are equal too when React runs this effect a second time for the same frame, which
		// Fast Refresh does in a development build.
		if (previousFrameIdentity === null || renderedFrameIdentity === null) return;
		if (previousFrameIdentity === renderedFrameIdentity) return;
		// The upgrade is somebody else's action arriving on a live query, so the member may be typing
		// elsewhere on the screen by now.
		if (!can_take_focus(mainRef.current)) return;

		mainRef.current?.focus();
	}, [renderedFrameIdentity]);

	const breadcrumb = (
		<PluginsHeaderBreadcrumb
			trail={["plugins"]}
			current={plugin && page ? `${plugin.displayName} / ${page.title}` : pluginName}
		/>
	);

	if (uiPages === undefined) {
		return (
			// A plain landmark with no live region. `role="status"` on this element would replace the
			// implicit `main` role, so a member moving by landmark would find no main content while the
			// query is open. It would also announce nothing: a live region speaks a change to its
			// contents, and here the region and its text always arrive in the same commit. The frame
			// branch below announces the wait instead, from a region that mounts empty and is filled on
			// the next commit.
			<main className={"RoutePluginsPluginPage" satisfies RoutePluginsPluginPage_ClassNames}>
				{breadcrumb}
				<div className={"RoutePluginsPluginPage-loading" satisfies RoutePluginsPluginPage_ClassNames}>
					<Puzzle aria-hidden />
					Loading plugin page...
				</div>
			</main>
		);
	}

	if (!plugin || !page) {
		return (
			// The region has no name of its own, so the message describes it. A member sent here by an
			// uninstall lands on the region and hears what happened instead of silence.
			<main
				ref={mainRef}
				tabIndex={-1}
				aria-describedby={missingMessageId}
				className={"RoutePluginsPluginPage" satisfies RoutePluginsPluginPage_ClassNames}
			>
				{breadcrumb}
				<div
					id={missingMessageId}
					className={"RoutePluginsPluginPage-missing" satisfies RoutePluginsPluginPage_ClassNames}
					role="alert"
				>
					This plugin page is not available.
				</div>
			</main>
		);
	}

	const frame = (
		<RoutePluginsPluginPageFrame
			key={frameKey}
			regionRef={mainRef}
			pluginName={pluginName}
			pluginVersionId={plugin.pluginVersionId}
			pageId={pageId}
			pageTitle={page.title}
			entry={page.entry}
			hasAgent={page.hasAgent}
			pageInstanceId={pageInstanceId}
			onRetry={handleRetry}
		/>
	);

	return (
		// tabIndex -1 makes this region the target Retry hands focus to. It stays out of the tab order,
		// so nothing changes for a member who never hit an error. The label is what names the region,
		// so a screen reader says where the focus landed.
		<main
			ref={mainRef}
			tabIndex={-1}
			aria-label={page.title}
			className={"RoutePluginsPluginPage" satisfies RoutePluginsPluginPage_ClassNames}
		>
			{breadcrumb}
			{/* A page with agent tools shows the chat agent on the right, like the Browser route. The
			    chat sends this page with each message, so the agent can call the page's tools. */}
			{page.hasAgent ? (
				<MyPanelGroup direction="horizontal">
					<MyPanel id="route-plugins-plugin-page-frame" order={1} defaultSize={70} minSize={40}>
						<div className={"RoutePluginsPluginPage-panel" satisfies RoutePluginsPluginPage_ClassNames}>
							{frame}
						</div>
					</MyPanel>
					<MyPanelResizeHandle aria-label="Resize plugin page and agent panel" />
					<MyPanel id="route-plugins-plugin-page-agent" order={2} defaultSize={30} minSize={20}>
						<section
							className={"RoutePluginsPluginPage-agent" satisfies RoutePluginsPluginPage_ClassNames}
							aria-label="Agent"
						>
							<FileEditorSidebarAgent isActive pluginPage={{ pluginName, pageId, pageInstanceId }} />
						</section>
					</MyPanel>
				</MyPanelGroup>
			) : (
				frame
			)}
		</main>
	);
}

const Route = createFileRoute("/w/$organizationName/$workspaceName/plugins/$pluginName_/pages/$pageId")({
	component: RoutePluginsPluginPage,
});

export { Route };
// #endregion root

// #region frame
type RoutePluginsPluginPageFrame_ClassNames =
	| "RoutePluginsPluginPageFrame"
	| "RoutePluginsPluginPageFrame-starting"
	| "RoutePluginsPluginPageFrame-error";

type RoutePluginsPluginPageFrame_Props = {
	/**
	 * The `<main>` the route renders. The focus move below asks whether focus is still inside it.
	 */
	regionRef: RefObject<HTMLElement | null>;
	pluginName: string;
	pluginVersionId: PluginsUiFrame_Props["pluginVersionId"];
	pageId: string;
	pageTitle: string;
	entry: string;
	/**
	 * True when the page declares agent tools. The frame then runs the calls the chat agent sends.
	 */
	hasAgent: boolean;
	/**
	 * This tab's random id. The frame takes only the calls the chat of this tab sent.
	 */
	pageInstanceId: string;
	onRetry: () => void;
};

/**
 * How long the plugin page has to answer one agent tool call. The chat tool on the server waits a
 * little longer, so the page's error reaches the model instead of a server timeout.
 */
const AGENT_TOOL_FRAME_TIMEOUT_MS = 25_000;

/**
 * Take one agent tool call for this tab, run it in the plugin frame, and save the answer.
 *
 * A refused claim means the call already ended or was taken, so there is nothing to do.
 */
async function relay_agent_tool_call(args: {
	membershipId: Id<"organizations_workspaces_users">;
	call: { callId: Id<"plugins_page_tool_calls">; toolName: string; inputJson: string };
	runInFrame: (call: { callId: string; toolName: string; input: unknown }) => Promise<PluginsUiFrame_AgentToolResult>;
}) {
	const { membershipId, call, runInFrame } = args;

	const claimed = await app_convex.mutation(app_convex_api.plugins_page_tools.claim_call, {
		membershipId,
		callId: call.callId,
	});
	if (claimed._nay) {
		return;
	}

	const answer = await runInFrame({ callId: call.callId, toolName: call.toolName, input: JSON.parse(call.inputJson) });
	let result: { ok: true; outputJson: string } | { ok: false; error: string };
	if (answer.ok) {
		try {
			result = { ok: true, outputJson: JSON.stringify(answer.output ?? null) };
		} catch {
			result = { ok: false, error: "The page answered with a value that is not JSON" };
		}
	} else {
		result = { ok: false, error: answer.error };
	}

	const completed = await app_convex.mutation(app_convex_api.plugins_page_tools.complete_call, {
		membershipId,
		callId: call.callId,
		result,
	});
	if (completed._nay) {
		console.error("[RoutePluginsPluginPageFrame.relay_agent_tool_call] Failed to save the page answer", {
			error: completed._nay,
			callId: call.callId,
		});
	}
}

/**
 * One plugin frame and the two things the member sees around it: the alert when the frame fails,
 * and the placeholder until the frame starts.
 *
 * The route keys this component with the frame key, so its state belongs to exactly one frame. A
 * frame that goes away takes that state with it, and the frame replacing it starts clean.
 */
const RoutePluginsPluginPageFrame = memo(function RoutePluginsPluginPageFrame(
	props: RoutePluginsPluginPageFrame_Props,
) {
	const { regionRef, pluginName, pluginVersionId, pageId, pageTitle, entry, hasAgent, pageInstanceId, onRetry } = props;
	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const retryButtonRef = useRef<HTMLButtonElement | null>(null);
	const frameRef = useRef<PluginsUiFrame_Ref | null>(null);
	// Calls this tab already tried to claim. The live query can list a call again before its claim
	// lands, and a second claim from the same tab would only be refused.
	const seenCallIdsRef = useRef(new Set<string>());
	// The waiting call for each answer the frame sends back, by call id.
	const agentToolWaitersRef = useRef(new Map<string, (result: PluginsUiFrame_AgentToolResult) => void>());
	// Names the message inside the alert, so the Retry button can point at it and say what failed.
	const errorMessageId = `RoutePluginsPluginPageFrame-${useId()}-error`;
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [isFrameStarted, setIsFrameStarted] = useState(false);
	// False for the first commit, so the status region below enters the page empty. See the effect
	// that turns it true.
	const [hasStatusRegionMounted, setHasStatusRegionMounted] = useState(false);

	const statusMessage = hasStatusRegionMounted
		? isFrameStarted
			? "The plugin page is ready."
			: "Starting the plugin page..."
		: "";

	// Only a running frame takes calls. Until the frame starts, the calls stay pending. A frame that
	// failed takes none, so Retry's new frame can take them.
	const pendingAgentToolCalls = useQuery(
		app_convex_api.plugins_page_tools.list_pending,
		hasAgent && isFrameStarted && sessionError === null ? { membershipId, pluginName, pageId, pageInstanceId } : "skip",
	);

	const mintSession = useFn(() =>
		app_convex.action(app_convex_api.plugins_ui.mint_page_session, {
			membershipId,
			pluginName,
		}),
	);

	const getInitContext = useFn<PluginsUiFrame_Props["getInitContext"]>(() => ({
		kind: "page",
		pluginName,
		pageId,
		pageTitle,
		organizationId,
		workspaceId,
	}));

	const handleAgentToolResult = useFn((result: PluginsUiFrame_AgentToolResult) => {
		agentToolWaitersRef.current.get(result.callId)?.(result);
	});

	const runAgentToolCallInFrame = useFn(
		(call: { callId: string; toolName: string; input: unknown }) =>
			new Promise<PluginsUiFrame_AgentToolResult>((resolve) => {
				const waiters = agentToolWaitersRef.current;
				const timeout = setTimeout(() => {
					finish({ callId: call.callId, ok: false, error: "The page did not answer in time" });
				}, AGENT_TOOL_FRAME_TIMEOUT_MS);
				const finish = (result: PluginsUiFrame_AgentToolResult) => {
					clearTimeout(timeout);
					waiters.delete(call.callId);
					resolve(result);
				};

				waiters.set(call.callId, finish);
				if (!frameRef.current?.postAgentToolCall(call)) {
					finish({ callId: call.callId, ok: false, error: "The page is not running" });
				}
			}),
	);

	// The server writes a call doc for each agent tool call. Run each new one here.
	useEffect(() => {
		for (const call of pendingAgentToolCalls ?? []) {
			if (seenCallIdsRef.current.has(call.callId)) {
				continue;
			}
			seenCallIdsRef.current.add(call.callId);

			relay_agent_tool_call({ membershipId, call, runInFrame: runAgentToolCallInFrame }).catch((error: unknown) => {
				console.error("[RoutePluginsPluginPageFrame] Unexpected agent tool call error", {
					error,
					callId: call.callId,
				});
			});
		}
	}, [pendingAgentToolCalls, membershipId, runAgentToolCallInFrame]);

	// The error replaces the iframe, and any focus that was inside it, so move focus to the one
	// available action. The move is not unconditional. The error can appear on a timer nobody is
	// watching, such as the frame startup deadline or a refused session renewal, and the member may
	// be typing somewhere else by then. So ask where focus is first.
	useEffect(() => {
		if (sessionError !== null && can_take_focus(regionRef.current)) {
			retryButtonRef.current?.focus();
		}
	}, [sessionError]);

	// A polite live region that arrives in the page already holding its text is the case screen
	// readers do not announce, and the member would then wait with nothing said. So the region below
	// is rendered empty first and this effect fills it on the next commit, which is a change inside a
	// region that is already there. That is the change a screen reader speaks.
	useEffect(() => {
		setHasStatusRegionMounted(true);
	}, []);

	if (sessionError !== null) {
		return (
			<div
				className={"RoutePluginsPluginPageFrame-error" satisfies RoutePluginsPluginPageFrame_ClassNames}
				role="alert"
			>
				{/* Focus moves onto Retry as this alert appears, and a screen reader then describes the
				    focused button. Its whole name is "Retry", so the member would hear nothing about what
				    failed. aria-describedby ties the message to the button and gives them the reason. */}
				<span id={errorMessageId}>{sessionError}</span>
				<MyButton ref={retryButtonRef} aria-describedby={errorMessageId} onClick={onRetry}>
					Retry
				</MyButton>
			</div>
		);
	}

	return (
		<>
			{/* The iframe paints nothing of its own, and the handshake with the plugin gets up to 15
			    seconds, so without this the member watches an empty region. The placeholder covers the
			    frame instead of standing above it, so the plugin gets its final height from the first
			    paint. That matters here: the host reports the handshake in the same tick it posts init,
			    so a placeholder taking its own space would resize the iframe while the plugin is
			    running its init handler. The frame stays mounted under the cover, because unmounting it
			    would kill the handshake this is waiting for.

			    This element is the page's live region as well, so it stays in the page once the frame
			    starts and only drops the cover styling. That is what lets the end of the wait be
			    announced: a member who heard the wait start is otherwise never told the plugin painted,
			    because a start that fails is announced by the alert above and a start that works says
			    nothing. It also has to sit outside the inert wrapper below, because `inert` takes an
			    element out of the accessibility tree and an inert live region announces nothing. */}
			<div
				className={
					isFrameStarted
						? "sr-only"
						: ("RoutePluginsPluginPageFrame-starting" satisfies RoutePluginsPluginPageFrame_ClassNames)
				}
				role="status"
				aria-live="polite"
				aria-atomic="true"
			>
				{isFrameStarted ? null : <Puzzle aria-hidden />}
				{statusMessage}
			</div>
			{/* `inert` while the cover is up. The iframe underneath is still a tab stop and still takes
			    clicks, so without this a member could land inside a page they have just been told is
			    not running yet. It goes on this wrapper and not on the frame, because `PluginsUiFrame`
			    renders the iframe from its own fixed prop list and forwards nothing else. */}
			<div
				className={"RoutePluginsPluginPageFrame" satisfies RoutePluginsPluginPageFrame_ClassNames}
				inert={!isFrameStarted}
			>
				<PluginsUiFrame
					ref={frameRef}
					membershipId={membershipId}
					pluginName={pluginName}
					pluginVersionId={pluginVersionId}
					entry={entry}
					title={pageTitle}
					kindLabel="plugin page"
					mintSession={mintSession}
					getInitContext={getInitContext}
					onStarted={() => setIsFrameStarted(true)}
					onAgentToolResult={handleAgentToolResult}
					// The state setter is the handler: the frame hands over the sentence and this
					// component shows it. A setter identity never changes, and the frame's bridge effect
					// lists `onError` in its dependencies, so a changing one would tear the frame down.
					onError={setSessionError}
				/>
			</div>
		</>
	);
});
// #endregion frame
