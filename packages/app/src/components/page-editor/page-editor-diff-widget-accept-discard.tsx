import "./page-editor-diff-widget-accept-discard.css";
import { Check, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { MyTooltip, MyTooltipArrow, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";

// #region PageEditorDiffWidgetAcceptDiscard
export type PageEditorDiffWidgetAcceptDiscard_ClassNames =
	| "PageEditorDiffWidgetAcceptDiscard"
	| "PageEditorDiffWidgetAcceptDiscard-accept-button"
	| "PageEditorDiffWidgetAcceptDiscard-discard-button"
	| "PageEditorDiffWidgetAcceptDiscard-icon";

export type PageEditorDiffWidgetAcceptDiscard_Props = {
	onAccept: () => void;
	onDiscard: () => void;
};

export function PageEditorDiffWidgetAcceptDiscard(props: PageEditorDiffWidgetAcceptDiscard_Props) {
	const { onAccept, onDiscard } = props;

	const handleMouseDown = (e: React.MouseEvent) => {
		e.preventDefault();
	};

	const handleClickAccept = (e: React.MouseEvent) => {
		e.preventDefault();
		onAccept();
	};

	const handleClickDiscard = (e: React.MouseEvent) => {
		e.preventDefault();
		onDiscard();
	};

	return (
		<>
			<MyTooltip timeout={0} placement="top">
				<MyTooltipTrigger>
					<button
						type="button"
						className={cn(
							"PageEditorDiffWidgetAcceptDiscard-accept-button" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
						)}
						aria-label="Accept change"
						onMouseDown={handleMouseDown}
						onClick={handleClickAccept}
					>
						<Check
							className={cn(
								"PageEditorDiffWidgetAcceptDiscard-icon" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
							)}
						/>
					</button>
				</MyTooltipTrigger>
				<MyTooltipContent gutter={6}>
					<MyTooltipArrow />
					Accept change
				</MyTooltipContent>
			</MyTooltip>

			<MyTooltip timeout={0} placement="top">
				<MyTooltipTrigger>
					<button
						type="button"
						className={cn(
							"PageEditorDiffWidgetAcceptDiscard-discard-button" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
						)}
						aria-label="Discard change"
						onMouseDown={handleMouseDown}
						onClick={handleClickDiscard}
					>
						<Undo2
							className={cn(
								"PageEditorDiffWidgetAcceptDiscard-icon" satisfies PageEditorDiffWidgetAcceptDiscard_ClassNames,
							)}
						/>
					</button>
				</MyTooltipTrigger>
				<MyTooltipContent gutter={6}>
					<MyTooltipArrow />
					Discard change
				</MyTooltipContent>
			</MyTooltip>
		</>
	);
}
// #endregion PageEditorDiffWidgetAcceptDiscard
