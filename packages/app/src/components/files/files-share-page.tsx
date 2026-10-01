import "./files-share-page.css";

import { CatchBoundary } from "@tanstack/react-router";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useQuery } from "convex/react";
import {
	createContext,
	memo,
	use,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type SyntheticEvent,
} from "react";

import { FilesShareFrame, FilesShareUnavailable } from "@/components/files/files-share-frame.tsx";
import { MyButton, type MyButton_ClassNames } from "@/components/my-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import {
	files_share_rich_text_get_extensions,
	files_share_rich_text_parse_json,
	type files_share_rich_text_MediaKind,
} from "../../../shared/files-share-rich-text.ts";
import { files_format_size, files_is_inline_media_content_type } from "../../../shared/files.ts";

// The public page of a file link. It loads without sign-in and uses only the public view and the
// signing action, never tenant, auth, or Files editor hooks.

type FilesSharePage_View = NonNullable<
	app_convex_FunctionReturnType<typeof app_convex_api.files_share_links.get_share_link_view>
>;

/**
 * What the page asks a signed URL for: the shared file, or one media of the document by its index.
 */
type FilesSharePage_TargetKey = "file" | number;

type FilesSharePage_MediaState =
	| { status: "loading" }
	| { status: "ready"; url: string; issuedAt: number }
	| { status: "failed" }
	| { status: "waiting" };

type FilesSharePageMedia_ContextValue = {
	view: FilesSharePage_View;
	states: ReadonlyMap<FilesSharePage_TargetKey, FilesSharePage_MediaState>;
	onMediaError: (key: FilesSharePage_TargetKey, url: string) => void;
	onRetry: (key: FilesSharePage_TargetKey) => void;
};

const FilesSharePageMediaContext = createContext<FilesSharePageMedia_ContextValue | null>(null);

/**
 * The media kind of a shared file that the page may show in its own viewer. Only the inline-safe
 * image and video types qualify, never a plain `image/*` prefix, so SVG downloads instead.
 */
function inline_media_kind(contentType: string | null) {
	if (contentType === null || !files_is_inline_media_content_type(contentType)) {
		return null;
	}

	return contentType.toLowerCase().startsWith("video/") ? "video" : "image";
}

// #region signed urls
/**
 * How long a signed URL works. Keep it equal to `SIGNED_URL_TTL_SECONDS` in `convex/files_share_links.ts`.
 */
const SIGNED_URL_TTL_MS = 15 * 60 * 1000;

/**
 * A media error this close to the URL's end counts as an expired URL. The page measures the age with its
 * own clock, so a wrong computer clock cannot make every URL look expired.
 */
const SIGNED_URL_EXPIRY_MARGIN_MS = 60 * 1000;

const EMPTY_MEDIA_STATES: ReadonlyMap<FilesSharePage_TargetKey, FilesSharePage_MediaState> = new Map();

/**
 * Ask for and keep the signed URLs of one page view.
 *
 * Each request keeps the view generation it was made for. A result is dropped when the view changed
 * meanwhile (a new revision, the link turned off, or unmount), so a late result never brings back
 * media that the server has since refused. A `stale` answer marks that revision: the page then waits
 * for the live query to deliver a different revision, and asks with the old one again only if the
 * query later delivers it again.
 */
function useFilesSharePageSignedUrls(props: { token: string; view: FilesSharePage_View | null | undefined }) {
	const { token, view } = props;

	const revision = view?.revision ?? null;
	const autoTargets: FilesSharePage_TargetKey[] = !view
		? []
		: view.content.kind === "binary"
			? inline_media_kind(view.contentType)
				? ["file"]
				: []
			: view.media.flatMap((item) => (item.available ? [item.index] : []));
	const autoTargetsKey = autoTargets.join(",");

	const [signed, setSigned] = useState<{
		revision: string | null;
		stale: boolean;
		states: ReadonlyMap<FilesSharePage_TargetKey, FilesSharePage_MediaState>;
	}>({ revision: null, stale: false, states: EMPTY_MEDIA_STATES });

	// Read these only in handlers and effects, never while rendering.
	const currentRef = useRef<{ revision: string; generation: number; active: boolean } | null>(null);
	const generationRef = useRef(0);
	const staleRevisionsRef = useRef(new Set<string>());
	const inFlightRef = useRef(new Set<string>());

	const setStates = (
		forRevision: string,
		keys: readonly FilesSharePage_TargetKey[],
		state: (key: FilesSharePage_TargetKey) => FilesSharePage_MediaState,
	) => {
		setSigned((previous) => {
			const states = new Map(previous.revision === forRevision ? previous.states : EMPTY_MEDIA_STATES);
			for (const key of keys) {
				states.set(key, state(key));
			}
			return { revision: forRevision, stale: previous.revision === forRevision && previous.stale, states };
		});
	};

	const request = useFn((keys: readonly FilesSharePage_TargetKey[], onReady: ((url: string) => void) | null) => {
		const current = currentRef.current;
		if (!current?.active || staleRevisionsRef.current.has(current.revision)) {
			return;
		}

		const pendingKeys = keys.filter((key) => !inFlightRef.current.has(`${current.generation}:${key}`));
		if (pendingKeys.length === 0) {
			return;
		}

		for (const key of pendingKeys) {
			inFlightRef.current.add(`${current.generation}:${key}`);
		}
		setStates(current.revision, pendingKeys, () => ({ status: "loading" }));

		// A revision answered `stale` takes no more results, even from a request that was already running.
		const isCurrent = () =>
			currentRef.current?.active === true &&
			currentRef.current.generation === current.generation &&
			!staleRevisionsRef.current.has(current.revision);

		app_convex
			.action(app_convex_api.files_share_links.create_share_link_download_urls, {
				token,
				revision: current.revision,
				targets: pendingKeys.map((key) =>
					key === "file" ? { kind: "file" as const } : { kind: "embed" as const, index: key },
				),
			})
			.then((result) => {
				if (!isCurrent()) {
					return;
				}

				if (result._nay) {
					const retryAfterMs = result._nay.data?.retryAfterMs;
					if (retryAfterMs === undefined) {
						setStates(current.revision, pendingKeys, () => ({ status: "failed" }));
						return;
					}

					// The link's download budget is shared by every visitor. Keep the document visible, wait
					// for the budget, then offer Retry. Never retry by itself, so the page cannot loop.
					setStates(current.revision, pendingKeys, () => ({ status: "waiting" }));
					setTimeout(() => {
						if (isCurrent()) {
							setStates(current.revision, pendingKeys, () => ({ status: "failed" }));
						}
					}, retryAfterMs);
					return;
				}

				if (result._yay.status === "stale") {
					staleRevisionsRef.current.add(current.revision);
					setSigned({ revision: current.revision, stale: true, states: EMPTY_MEDIA_STATES });
					return;
				}

				const issuedAt = Date.now();
				const urls = new Map<FilesSharePage_TargetKey, string>(
					result._yay.urls.map((entry) => [entry.target.kind === "file" ? "file" : entry.target.index, entry.url]),
				);
				setStates(current.revision, pendingKeys, (key) => {
					const url = urls.get(key);
					return url ? { status: "ready", url, issuedAt } : { status: "failed" };
				});

				const url = urls.get(pendingKeys[0]!);
				if (onReady && url) {
					onReady(url);
				}
			})
			.catch((error: unknown) => {
				// Log no details: the error can name the link.
				console.error("[useFilesSharePageSignedUrls.request] Failed to sign URLs", {
					errorName: error instanceof Error ? error.name : null,
				});
				if (isCurrent()) {
					setStates(current.revision, pendingKeys, () => ({ status: "failed" }));
				}
			})
			.finally(() => {
				for (const key of pendingKeys) {
					inFlightRef.current.delete(`${current.generation}:${key}`);
				}
			});
	});

	const states = signed.revision === revision ? signed.states : EMPTY_MEDIA_STATES;

	const handleMediaError = useFn((key: FilesSharePage_TargetKey, url: string) => {
		const state = states.get(key);
		if (revision === null || state?.status !== "ready" || state.url !== url) {
			return;
		}

		// Ask again once for a URL that has run out. `request` replaces the URL at once, so a second error of
		// the same URL does nothing, and the new URL gets its own single refresh when it runs out. Any other
		// error shows Retry.
		if (Date.now() - state.issuedAt >= SIGNED_URL_TTL_MS - SIGNED_URL_EXPIRY_MARGIN_MS) {
			request([key], null);
			return;
		}

		setStates(revision, [key], () => ({ status: "failed" }));
	});

	const handleRetry = useFn((key: FilesSharePage_TargetKey) => {
		request([key], null);
	});

	/**
	 * Download the shared file. Only a click calls this, so an attachment-only file is never signed
	 * while the page just shows it.
	 */
	const download = useFn((onReady: (url: string) => void) => {
		request(["file"], onReady);
	});

	useEffect(() => {
		if (revision === null) {
			currentRef.current = null;
			return;
		}

		// A new revision starts a new generation. Strict Mode runs this effect twice for one revision, so
		// keep the generation then, and the in-flight check stops the second request.
		if (currentRef.current?.revision === revision) {
			currentRef.current.active = true;
		} else {
			generationRef.current += 1;
			currentRef.current = { revision, generation: generationRef.current, active: true };

			// A revision can become current again, for example when an archived image is restored. The live
			// query says so only by delivering it again, so forget every `stale` answer then.
			staleRevisionsRef.current.clear();

			// The same revision can come back after another view. A request of the older generation then drops
			// its result, so its "loading" or "waiting" mark would stay for good and keep Download disabled.
			// Clear those marks and the old `stale` flag. The media shown on the page are asked for again below.
			setSigned((previous) => {
				if (previous.revision !== revision) {
					return previous;
				}
				if (previous.stale) {
					return { revision, stale: false, states: EMPTY_MEDIA_STATES };
				}
				if (![...previous.states.values()].some((state) => state.status === "loading" || state.status === "waiting")) {
					return previous;
				}

				const states = new Map(
					[...previous.states].filter(([, state]) => state.status !== "loading" && state.status !== "waiting"),
				);
				return { ...previous, states };
			});
		}

		if (autoTargetsKey !== "") {
			request(
				autoTargetsKey.split(",").map((key) => (key === "file" ? key : Number(key))),
				null,
			);
		}

		return () => {
			// Drop every late result after a view change or unmount.
			if (currentRef.current) {
				currentRef.current.active = false;
			}
		};
	}, [revision, autoTargetsKey, request]);

	return {
		states,
		isStale: signed.revision === revision && signed.stale,
		handleMediaError,
		handleRetry,
		download,
	};
}
// #endregion signed urls

// #region media
type FilesSharePageMedia_ClassNames =
	| "FilesSharePageMedia"
	| "FilesSharePageMedia-kind-image"
	| "FilesSharePageMedia-kind-video"
	| "FilesSharePageMedia-box"
	| "FilesSharePageMedia-element";

type FilesSharePageMedia_CustomAttributes = {
	"data-share-media-state": FilesSharePage_MediaState["status"] | "unavailable";
};

type FilesSharePageMedia_Props = {
	kind: files_share_rich_text_MediaKind;
	targetKey: FilesSharePage_TargetKey | null;
	alt: string | null;
};

/**
 * One image or video of the page. It shows only what the current view allows: a media that is not
 * available shows a fixed gray box, with no alt text, name, or reason.
 */
const FilesSharePageMedia = memo(function FilesSharePageMedia(props: FilesSharePageMedia_Props) {
	const { kind, targetKey, alt } = props;

	const context = use(FilesSharePageMediaContext);
	if (!context) {
		throw new Error("FilesSharePageMedia must be used within FilesSharePageMediaContext");
	}

	// Every state renders the same root span, so this node stays while the media loads again.
	const rootRef = useRef<HTMLSpanElement>(null);
	// Where a video was when it went away. Its URL ran out, or a new revision loads the media again. The next
	// video of the same media starts from here.
	const resumeRef = useRef<{ targetKey: FilesSharePage_TargetKey; time: number; playing: boolean } | null>(null);

	// Save the spot when the video element goes away. Keep one stable function, so React calls it only when
	// the element comes and goes. A video that never loaded its length saves nothing, so a second failed
	// load keeps the earlier spot.
	const handleVideoRef = useFn((video: HTMLVideoElement | null) => {
		if (!video || targetKey === null) {
			return;
		}

		return () => {
			// An error or a new revision removes the video. If it had focus, keep focus on this media.
			if (document.activeElement === video) {
				rootRef.current?.focus({ preventScroll: true });
			}

			// A ready state of 1 or more (`HAVE_METADATA`) means the video knows its length.
			if (video.readyState >= 1) {
				resumeRef.current = { targetKey, time: video.currentTime, playing: !video.paused };
			}
		};
	});

	const available =
		targetKey === "file" ||
		(targetKey !== null &&
			context.view.media.some((item) => item.index === targetKey && item.available && item.kind === kind));
	const state = available && targetKey !== null ? (context.states.get(targetKey) ?? { status: "loading" }) : null;

	const className = cn(
		"FilesSharePageMedia" satisfies FilesSharePageMedia_ClassNames,
		kind === "image"
			? ("FilesSharePageMedia-kind-image" satisfies FilesSharePageMedia_ClassNames)
			: ("FilesSharePageMedia-kind-video" satisfies FilesSharePageMedia_ClassNames),
	);
	const attributes = {
		"data-share-media-state": state?.status ?? "unavailable",
	} satisfies FilesSharePageMedia_CustomAttributes;

	if (state?.status === "ready" && targetKey !== null) {
		const handleError = () => {
			context.onMediaError(targetKey, state.url);
		};

		const handleVideoLoadedMetadata = (event: SyntheticEvent<HTMLVideoElement>) => {
			const resume = resumeRef.current;
			resumeRef.current = null;
			// Tiptap can reuse this view for another media, so use only a spot of the same media.
			if (resume?.targetKey !== targetKey) {
				return;
			}

			const video = event.currentTarget;
			video.currentTime = resume.time;
			if (resume.playing) {
				video.play().catch(() => {
					// The browser may refuse to play without a click. The visitor then presses play.
				});
			}
		};

		return (
			<span ref={rootRef} className={className} tabIndex={-1} {...attributes}>
				{kind === "image" ? (
					<img
						className={"FilesSharePageMedia-element" satisfies FilesSharePageMedia_ClassNames}
						src={state.url}
						alt={alt ?? ""}
						referrerPolicy="no-referrer"
						onError={handleError}
					/>
				) : (
					// React has no referrer prop for video. The page's `no-referrer` meta covers it.
					<video
						ref={handleVideoRef}
						className={"FilesSharePageMedia-element" satisfies FilesSharePageMedia_ClassNames}
						src={state.url}
						aria-label={alt ?? undefined}
						controls
						preload="metadata"
						onLoadedMetadata={handleVideoLoadedMetadata}
						onError={handleError}
					/>
				)}
			</span>
		);
	}

	const handleRetry = (key: FilesSharePage_TargetKey) => {
		// The button goes away while the media loads again. Keep focus on this media, not the page body.
		rootRef.current?.focus({ preventScroll: true });
		context.onRetry(key);
	};

	return (
		<span ref={rootRef} className={className} tabIndex={-1} {...attributes}>
			<span className={"FilesSharePageMedia-box" satisfies FilesSharePageMedia_ClassNames}>
				{state === null ? (
					`This ${kind} is not shared`
				) : state.status === "failed" && targetKey !== null ? (
					<>
						{`The ${kind} did not load.`}
						<MyButton variant="outline" onClick={() => handleRetry(targetKey)}>
							Retry media
						</MyButton>
					</>
				) : state.status === "waiting" ? (
					"Many people are opening this link. Retry will be available in a moment."
				) : (
					`Loading ${kind}`
				)}
			</span>
		</span>
	);
});

type FilesSharePageImageNodeView_ClassNames = "FilesSharePageImageNodeView";

const FilesSharePageImageNodeView = memo(function FilesSharePageImageNodeView(props: NodeViewProps) {
	const { node } = props;

	return (
		<NodeViewWrapper
			as="span"
			className={"FilesSharePageImageNodeView" satisfies FilesSharePageImageNodeView_ClassNames}
		>
			<FilesSharePageMedia
				kind="image"
				targetKey={node.attrs.index as number | null}
				alt={node.attrs.alt as string | null}
			/>
		</NodeViewWrapper>
	);
});

type FilesSharePageVideoNodeView_ClassNames = "FilesSharePageVideoNodeView";

const FilesSharePageVideoNodeView = memo(function FilesSharePageVideoNodeView(props: NodeViewProps) {
	const { node } = props;

	return (
		<NodeViewWrapper className={"FilesSharePageVideoNodeView" satisfies FilesSharePageVideoNodeView_ClassNames}>
			<FilesSharePageMedia
				kind="video"
				targetKey={node.attrs.index as number | null}
				alt={node.attrs.alt as string | null}
			/>
		</NodeViewWrapper>
	);
});
// #endregion media

// #region rich text
/**
 * The public schema with the page's own media views. Same nodes, marks, and attribute checks as the
 * server, so the page renders exactly the document the server checked.
 */
const get_page_extensions = ((/* iife */) => {
	function value() {
		const extensions = files_share_rich_text_get_extensions();
		return Object.values({
			...extensions,
			// A wide table scrolls sideways in its own box, so tag it for the app scrollbar style.
			table: extensions.table.extend({
				renderHTML() {
					return ["table", { class: "app-scrollable" satisfies AppClassName }, ["tbody", 0]];
				},
			}),
			// Put the label in the page text, so a reader or a test can find it.
			frontmatter: extensions.frontmatter.extend({
				renderHTML() {
					return [
						"pre",
						{ "data-frontmatter": "" },
						[
							"span",
							{ class: "FilesSharePageRichText-frontmatter-label" satisfies FilesSharePageRichText_ClassNames },
							"Front matter",
						],
						["code", 0],
					];
				},
			}),
			image: extensions.image.extend({
				addNodeView() {
					return ReactNodeViewRenderer(FilesSharePageImageNodeView, { as: "span" });
				},
			}),
			video: extensions.video.extend({
				addNodeView() {
					return ReactNodeViewRenderer(FilesSharePageVideoNodeView);
				},
			}),
		});
	}

	let cache: ReturnType<typeof value> | undefined;

	return function get_page_extensions() {
		return (cache ??= value());
	};
})();

type FilesSharePageRichText_ClassNames = "FilesSharePageRichText" | "FilesSharePageRichText-frontmatter-label";

type FilesSharePageRichText_Props = {
	doc: ProseMirrorNode;
};

const FilesSharePageRichText = memo(function FilesSharePageRichText(props: FilesSharePageRichText_Props) {
	const { doc } = props;

	const editor = useEditor(
		{
			extensions: get_page_extensions(),
			editable: false,
			injectCSS: false,
			immediatelyRender: false,
		},
		[],
	);

	useLayoutEffect(() => {
		// Put in the server's checked document as it is. Autolink is off, so nothing adds marks to it.
		editor?.commands.setContent(doc.toJSON(), { emitUpdate: false });

		return () => {
			// Before replacement or unmount, keep focus on the stable page content.
			if (editor?.view.dom.contains(document.activeElement)) {
				editor.view.dom.closest<HTMLElement>("main")?.focus({ preventScroll: true });
			}
		};
	}, [editor, doc]);

	return (
		<EditorContent
			editor={editor}
			className={cn(
				"FilesSharePageRichText" satisfies FilesSharePageRichText_ClassNames,
				"app-doc" satisfies AppClassName,
			)}
		/>
	);
});
// #endregion rich text

// #region download
type FilesSharePageDownload_ClassNames = "FilesSharePageDownload" | "FilesSharePageDownload-message";

type FilesSharePageDownload_Props = {
	size: number;
	state: FilesSharePage_MediaState | null;
	isStale: boolean;
	onDownload: () => void;
};

const FilesSharePageDownload = memo(function FilesSharePageDownload(props: FilesSharePageDownload_Props) {
	const { size, state, isStale, onDownload } = props;
	const isDisabled = isStale || state?.status === "loading" || state?.status === "waiting";

	const handleClick = () => {
		if (isDisabled) {
			return;
		}
		onDownload();
	};

	return (
		<div className={"FilesSharePageDownload" satisfies FilesSharePageDownload_ClassNames}>
			<p className={"FilesSharePageDownload-message" satisfies FilesSharePageDownload_ClassNames}>
				{files_format_size(size)}
			</p>
			{/* Use `aria-disabled`, not `disabled`. The button turns off right after a keyboard press, and a
			    really disabled button loses focus to the page body. */}
			<MyButton
				variant="accent"
				className={cn(isDisabled && ("MyButton-state-disabled" satisfies MyButton_ClassNames))}
				aria-disabled={isDisabled || undefined}
				onClick={handleClick}
			>
				Download
			</MyButton>
			{isStale ? (
				<p role="status" className={"FilesSharePageDownload-message" satisfies FilesSharePageDownload_ClassNames}>
					The file changed. Loading the new version.
				</p>
			) : state?.status === "failed" ? (
				<p role="alert" className={"FilesSharePageDownload-message" satisfies FilesSharePageDownload_ClassNames}>
					The download did not start. Try again.
				</p>
			) : state?.status === "waiting" ? (
				<p role="status" className={"FilesSharePageDownload-message" satisfies FilesSharePageDownload_ClassNames}>
					Many people are opening this link. Try again in a moment.
				</p>
			) : null}
		</div>
	);
});
// #endregion download

// #region page
type FilesSharePageContent_ClassNames =
	| "FilesSharePageContent"
	| "FilesSharePageContent-title"
	| "FilesSharePageContent-notice"
	| "FilesSharePageContent-plain-text";

type FilesSharePageContent_Props = {
	token: string;
};

const FilesSharePageContent = memo(function FilesSharePageContent(props: FilesSharePageContent_Props) {
	const { token } = props;

	const view = useQuery(app_convex_api.files_share_links.get_share_link_view, { token });
	const signedUrls = useFilesSharePageSignedUrls({ token, view });

	const richJson = view?.content.kind === "rich_text" ? view.content.json : null;
	// Keep one parsed document per JSON string. The editor puts in a new document only when this identity
	// changes, and parsing a large document again on every media update would be slow.
	const doc = useMemo(() => (richJson === null ? null : files_share_rich_text_parse_json(richJson)), [richJson]);

	const handleDownload = () => {
		signedUrls.download((url) => {
			// The URL answers with an attachment header, so the browser saves the file and stays here.
			window.location.assign(url);
		});
	};

	if (view === undefined) {
		return (
			<FilesShareFrame state="loading" className={"FilesSharePageContent" satisfies FilesSharePageContent_ClassNames}>
				<p role="status">Opening the shared file</p>
			</FilesShareFrame>
		);
	}

	// A document that fails the public schema check fails like a link that does not work.
	if (view === null || (view.content.kind === "rich_text" && doc === null)) {
		return <FilesShareUnavailable />;
	}

	const mediaKind = view.content.kind === "binary" ? inline_media_kind(view.contentType) : null;

	return (
		<FilesShareFrame state="ready" className={"FilesSharePageContent" satisfies FilesSharePageContent_ClassNames}>
			<h1 className={"FilesSharePageContent-title" satisfies FilesSharePageContent_ClassNames}>{view.name}</h1>
			<FilesSharePageMediaContext.Provider
				value={{
					view,
					states: signedUrls.states,
					onMediaError: signedUrls.handleMediaError,
					onRetry: signedUrls.handleRetry,
				}}
			>
				{doc !== null ? (
					<FilesSharePageRichText doc={doc} />
				) : view.content.kind === "plain_text" ? (
					<>
						{view.content.formattingFallback ? (
							<p className={"FilesSharePageContent-notice" satisfies FilesSharePageContent_ClassNames}>
								Shown as plain text because this file has a lot of formatting.
							</p>
						) : null}
						<pre
							className={cn(
								"FilesSharePageContent-plain-text" satisfies FilesSharePageContent_ClassNames,
								"app-font-monospace" satisfies AppClassName,
								"app-scrollable" satisfies AppClassName,
							)}
						>
							{view.content.text}
						</pre>
					</>
				) : mediaKind ? (
					<FilesSharePageMedia kind={mediaKind} targetKey="file" alt={null} />
				) : (
					<FilesSharePageDownload
						size={view.size}
						state={signedUrls.states.get("file") ?? null}
						isStale={signedUrls.isStale}
						onDownload={handleDownload}
					/>
				)}
			</FilesSharePageMediaContext.Provider>
		</FilesShareFrame>
	);
});

type FilesSharePage_Props = {
	token: string;
};

/**
 * The share page for one token. Give it `key={token}`, so a new token starts with a new state.
 */
export const FilesSharePage = memo(function FilesSharePage(props: FilesSharePage_Props) {
	const { token } = props;

	useLayoutEffect(() => {
		// Send no referrer from this page, so a media request or a clicked link never tells another site the
		// token. Set it before any media gets a URL, and put the app's policy back when the page closes.
		const meta = document.querySelector<HTMLMetaElement>('meta[name="referrer"]');
		if (!meta) {
			const created = document.createElement("meta");
			created.name = "referrer";
			created.content = "no-referrer";
			document.head.append(created);
			return () => created.remove();
		}

		const previous = meta.content;
		meta.content = "no-referrer";
		return () => {
			meta.content = previous;
		};
	}, []);

	return (
		<CatchBoundary
			getResetKey={() => token}
			errorComponent={FilesShareUnavailable}
			// Log nothing: a public error can hold the token or the shared text.
			onCatch={() => {}}
		>
			<FilesSharePageContent token={token} />
		</CatchBoundary>
	);
});
// #endregion page
