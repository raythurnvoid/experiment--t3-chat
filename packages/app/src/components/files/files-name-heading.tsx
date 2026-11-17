import "./files-name-heading.css";

import { memo, useLayoutEffect, useRef, useState } from "react";
import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";

import { MyModalHeading } from "@/components/my-modal.tsx";
import { files_truncate_name_middle } from "@/lib/file-paths.ts";
import { APP_FONT_FAMILY } from "@/lib/ui.tsx";

// Pretext measures with these values, so a resize never calls `getComputedStyle`. Keep them in sync
// with `.MyModalHeading` in my-modal.css: weight 600 and size 1.25rem (20px).
const FILES_NAME_HEADING_FONT = `600 20px ${APP_FONT_FAMILY}`;
const FILES_NAME_HEADING_LETTER_SPACING = 0;

type FilesNameHeading_ClassNames = "FilesNameHeading";

type FilesNameHeading_Props = {
	/** Text before the name, for example `Move “`. */
	before: string;
	name: string;
	/** Text after the name, for example `” to Trash?`. */
	after: string;
};

/**
 * A dialog title that names one item on one line. A long name is cut in the middle, so its extension
 * stays visible. The dialog body shows the full path, and the heading keeps the full text as its
 * accessible name.
 */
export const FilesNameHeading = memo(function FilesNameHeading(props: FilesNameHeading_Props) {
	const { before, name, after } = props;

	const headingRef = useRef<HTMLHeadingElement>(null);
	const [label, setLabel] = useState(name);

	useLayoutEffect(() => {
		const headingElement = headingRef.current;
		if (!headingElement) {
			return;
		}

		let cancelled = false;

		const updateLabel = () => {
			// The heading stretches to the dialog header, so its width never follows the label.
			const width = headingElement.clientWidth;
			// Skip the measurement while the heading is not laid out (hidden, or the happy-dom tests).
			const nextLabel =
				width > 0
					? files_truncate_name_middle({
							name,
							fits: (candidate) => {
								const stats = measureLineStats(
									prepareWithSegments(`${before}${candidate}${after}`, FILES_NAME_HEADING_FONT, {
										letterSpacing: FILES_NAME_HEADING_LETTER_SPACING,
										whiteSpace: "normal",
									}),
									width,
								);
								return stats.lineCount <= 1 && stats.maxLineWidth <= width;
							},
						})
					: name;

			if (!cancelled) {
				setLabel(nextLabel);
			}
		};

		updateLabel();

		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => updateLabel());
		resizeObserver?.observe(headingElement);
		void document.fonts?.ready.then(() => updateLabel());

		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
		};
	}, [before, name, after]);

	return (
		<MyModalHeading
			ref={headingRef}
			className={"FilesNameHeading" satisfies FilesNameHeading_ClassNames}
			// Name the dialog with the full text, also when the visible name is cut.
			aria-label={`${before}${name}${after}`}
		>
			{before}
			{label}
			{after}
		</MyModalHeading>
	);
});
