import "./files-share-frame.css";

import { memo, useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";

// This module stays small because the root route imports it for its share error message. The share
// page with its editor lives in `files-share-page.tsx`, which loads only on the share route.

// #region frame
type FilesShareFrame_ClassNames =
	| "FilesShareFrame"
	| "FilesShareFrame-header"
	| "FilesShareFrame-logo"
	| "FilesShareFrame-main"
	| "FilesShareFrame-footer";

type FilesShareFrame_CustomAttributes = {
	"data-share-page-state": "loading" | "ready" | "unavailable";
};

type FilesShareFrame_Props = {
	state: FilesShareFrame_CustomAttributes["data-share-page-state"];
	className: string;
	children: ReactNode;
};

/**
 * The public page layout: the app logo, the content, and a footer. It has no menus and no sign-in,
 * because the share page loads without the app's private providers.
 */
export const FilesShareFrame = memo(function FilesShareFrame(props: FilesShareFrame_Props) {
	const { state, className, children } = props;

	const mainRef = useRef<HTMLElement>(null);

	useEffect(() => {
		// Start keyboard focus on the content, since the page has no menus before it.
		mainRef.current?.focus({ preventScroll: true });
	}, []);

	return (
		<div
			className={cn(
				"FilesShareFrame" satisfies FilesShareFrame_ClassNames,
				className,
				"app-scrollable" satisfies AppClassName,
			)}
			{...({ "data-share-page-state": state } satisfies FilesShareFrame_CustomAttributes)}
		>
			<header className={"FilesShareFrame-header" satisfies FilesShareFrame_ClassNames}>
				<img
					className={"FilesShareFrame-logo" satisfies FilesShareFrame_ClassNames}
					src={`${import.meta.env.BASE_URL}press-logo.svg`}
					alt=""
				/>
				Press
			</header>
			<main ref={mainRef} className={"FilesShareFrame-main" satisfies FilesShareFrame_ClassNames} tabIndex={-1}>
				{children}
			</main>
			<footer className={"FilesShareFrame-footer" satisfies FilesShareFrame_ClassNames}>Shared with Press</footer>
		</div>
	);
});
// #endregion frame

// #region unavailable
type FilesShareUnavailable_ClassNames =
	| "FilesShareUnavailable"
	| "FilesShareUnavailable-title"
	| "FilesShareUnavailable-description";

/**
 * The one message for every link that does not work: a wrong token, a link that was turned off, a
 * moved or deleted file, or an error. It never tells which one, and never shows error details.
 */
export const FilesShareUnavailable = memo(function FilesShareUnavailable() {
	return (
		<FilesShareFrame state="unavailable" className={"FilesShareUnavailable" satisfies FilesShareUnavailable_ClassNames}>
			<h1 className={"FilesShareUnavailable-title" satisfies FilesShareUnavailable_ClassNames}>
				This link does not work.
			</h1>
			<p className={"FilesShareUnavailable-description" satisfies FilesShareUnavailable_ClassNames}>
				It may have been turned off, or the file was moved or deleted.
			</p>
		</FilesShareFrame>
	);
});
// #endregion unavailable
