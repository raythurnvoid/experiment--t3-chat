import "./my-resizable-panel-group.css";

import { memo, type ComponentPropsWithRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { cn } from "@/lib/utils.ts";

export type MyPanel_CloseBehavior = "unmount" | "hidden";
export type MyPanelResizeHandle_Orientation = "vertical" | "horizontal";

// #region panel group
export type MyPanelGroup_ClassNames = "MyPanelGroup";

export type MyPanelGroup_Props = ComponentPropsWithRef<typeof PanelGroup>;

export const MyPanelGroup = memo(function MyPanelGroup(props: MyPanelGroup_Props) {
	const { className, ...rest } = props;

	return <PanelGroup className={cn("MyPanelGroup" satisfies MyPanelGroup_ClassNames, className)} {...rest} />;
});
// #endregion panel group

// #region panel
export type MyPanel_ClassNames = "MyPanel" | "MyPanel-state-open" | "MyPanel-state-closed";

export type MyPanel_Props = ComponentPropsWithRef<typeof Panel> & {
	isOpen?: boolean;
	closeBehavior?: MyPanel_CloseBehavior;
};

export const MyPanel = memo(function MyPanel(props: MyPanel_Props) {
	const { className, style, isOpen = true, closeBehavior = "unmount", children, ...rest } = props;

	if (!isOpen && closeBehavior === "unmount") {
		return null;
	}

	const hiddenStyle = !isOpen && closeBehavior === "hidden" ? { ...style, display: "none" } : style;

	return (
		<Panel
			className={cn(
				"MyPanel" satisfies MyPanel_ClassNames,
				isOpen && ("MyPanel-state-open" satisfies MyPanel_ClassNames),
				!isOpen && ("MyPanel-state-closed" satisfies MyPanel_ClassNames),
				className,
			)}
			style={hiddenStyle}
			{...rest}
		>
			<MyPanelInfiniteBackground />
			{children}
		</Panel>
	);
});
// #endregion panel

// #region background
export type MyPanelInfiniteBackground_ClassNames = "MyPanelInfiniteBackground";

export type MyPanelInfiniteBackground_Props = ComponentPropsWithRef<"div">;

export const MyPanelInfiniteBackground = memo(function MyPanelInfiniteBackground(props: MyPanelInfiniteBackground_Props) {
	const { className, ...rest } = props;

	return (
		<div
			aria-hidden="true"
			className={cn("MyPanelInfiniteBackground" satisfies MyPanelInfiniteBackground_ClassNames, className)}
			{...rest}
		></div>
	);
});
// #endregion background

// #region handle
export type MyPanelResizeHandle_ClassNames =
	| "MyPanelResizeHandleContainer"
	| "MyPanelResizeHandleContainer-orientation-vertical"
	| "MyPanelResizeHandleContainer-orientation-horizontal"
	| "MyPanelResizeHandleContainer-state-open"
	| "MyPanelResizeHandleContainer-state-closed"
	| "MyPanelResizeHandle"
	| "MyPanelResizeHandle-orientation-vertical"
	| "MyPanelResizeHandle-orientation-horizontal";

export type MyPanelResizeHandle_Props = ComponentPropsWithRef<typeof PanelResizeHandle> & {
	containerClassName?: string;
	isOpen?: boolean;
	closeBehavior?: MyPanel_CloseBehavior;
	orientation?: MyPanelResizeHandle_Orientation;
};

export const MyPanelResizeHandle = memo(function MyPanelResizeHandle(props: MyPanelResizeHandle_Props) {
	const {
		className,
		containerClassName,
		isOpen = true,
		closeBehavior = "unmount",
		orientation = "vertical",
		...rest
	} = props;

	if (!isOpen && closeBehavior === "unmount") {
		return null;
	}

	const containerHiddenStyle = !isOpen && closeBehavior === "hidden" ? { display: "none" } : undefined;

	return (
		<div
			className={cn(
				"MyPanelResizeHandleContainer" satisfies MyPanelResizeHandle_ClassNames,
				orientation === "vertical" &&
					("MyPanelResizeHandleContainer-orientation-vertical" satisfies MyPanelResizeHandle_ClassNames),
				orientation === "horizontal" &&
					("MyPanelResizeHandleContainer-orientation-horizontal" satisfies MyPanelResizeHandle_ClassNames),
				isOpen && ("MyPanelResizeHandleContainer-state-open" satisfies MyPanelResizeHandle_ClassNames),
				!isOpen && ("MyPanelResizeHandleContainer-state-closed" satisfies MyPanelResizeHandle_ClassNames),
				containerClassName,
			)}
			style={containerHiddenStyle}
		>
			<PanelResizeHandle
				className={cn(
					"MyPanelResizeHandle" satisfies MyPanelResizeHandle_ClassNames,
					orientation === "vertical" && ("MyPanelResizeHandle-orientation-vertical" satisfies MyPanelResizeHandle_ClassNames),
					orientation === "horizontal" &&
						("MyPanelResizeHandle-orientation-horizontal" satisfies MyPanelResizeHandle_ClassNames),
					className,
				)}
				{...rest}
			/>
		</div>
	);
});
// #endregion handle
