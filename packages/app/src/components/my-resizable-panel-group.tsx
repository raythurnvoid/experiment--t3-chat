import "./my-resizable-panel-group.css";

import { GripHorizontal, GripVertical } from "lucide-react";
import { createContext, memo, useContext, useRef, type ComponentPropsWithRef, type ComponentRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ExtractStrict } from "type-fest";

import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";

export type MyPanel_CloseBehavior = "unmount" | "hidden";
export type MyPanelResizeHandle_Orientation = "vertical" | "horizontal";

// #region panel group
export type MyPanelGroup_ClassNames = "MyPanelGroup";

type MyPanelGroup_ContextValue = {
	resetToDefaultLayout?: () => void;
};

const MyPanelGroupContext = createContext<MyPanelGroup_ContextValue | null>(null);

export type MyPanelGroup_Props = Omit<
	ComponentPropsWithRef<typeof PanelGroup>,
	ExtractStrict<keyof ComponentPropsWithRef<typeof PanelGroup>, "autoSaveId" | "ref" | "storage">
> & {
	defaultLayout?: number[];
	onLayoutReset?: (layout: number[]) => void;
};

export const MyPanelGroup = memo(function MyPanelGroup(props: MyPanelGroup_Props) {
	const { className, defaultLayout, onLayoutReset, ...rest } = props;
	const panelGroupRef = useRef<ComponentRef<typeof PanelGroup> | null>(null);

	const handleResetToDefaultLayout = useFn(() => {
		if (!defaultLayout) {
			return;
		}

		panelGroupRef.current?.setLayout(defaultLayout);
		onLayoutReset?.(defaultLayout);
	});

	return (
		<MyPanelGroupContext.Provider
			value={{
				resetToDefaultLayout: defaultLayout ? handleResetToDefaultLayout : undefined,
			}}
		>
			<PanelGroup
				className={cn("MyPanelGroup" satisfies MyPanelGroup_ClassNames, className)}
				ref={panelGroupRef}
				{...rest}
			/>
		</MyPanelGroupContext.Provider>
	);
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

// #region handle grip
type MyPanelResizeHandleGrip_ClassNames =
	| "MyPanelResizeHandleGrip"
	| "MyPanelResizeHandleGrip-pill"
	| "MyPanelResizeHandleGrip-icon"
	| "MyPanelResizeHandleGrip-orientation-vertical"
	| "MyPanelResizeHandleGrip-orientation-horizontal";

type MyPanelResizeHandleGrip_Props = {
	orientation: MyPanelResizeHandle_Orientation;
};

const MyPanelResizeHandleGrip = memo(function MyPanelResizeHandleGrip(props: MyPanelResizeHandleGrip_Props) {
	const { orientation } = props;
	const Icon = orientation === "vertical" ? GripVertical : GripHorizontal;

	return (
		<div
			aria-hidden="true"
			className={cn(
				"MyPanelResizeHandleGrip" satisfies MyPanelResizeHandleGrip_ClassNames,
				orientation === "vertical" &&
					("MyPanelResizeHandleGrip-orientation-vertical" satisfies MyPanelResizeHandleGrip_ClassNames),
				orientation === "horizontal" &&
					("MyPanelResizeHandleGrip-orientation-horizontal" satisfies MyPanelResizeHandleGrip_ClassNames),
			)}
		>
			<span className={"MyPanelResizeHandleGrip-pill" satisfies MyPanelResizeHandleGrip_ClassNames}>
				<Icon aria-hidden="true" className={"MyPanelResizeHandleGrip-icon" satisfies MyPanelResizeHandleGrip_ClassNames} />
			</span>
		</div>
	);
});
// #endregion handle grip

// #region handle
// Keep the separator physically narrow while giving fine pointers an 8px total hit target.
const DEFAULT_HIT_AREA = {
	coarse: 7,
	fine: 0,
} satisfies NonNullable<ComponentPropsWithRef<typeof PanelResizeHandle>["hitAreaMargins"]>;

export type MyPanelResizeHandle_ClassNames =
	| "MyPanelResizeHandleContainer"
	| "MyPanelResizeHandleContainer-orientation-vertical"
	| "MyPanelResizeHandleContainer-orientation-horizontal"
	| "MyPanelResizeHandleContainer-state-open"
	| "MyPanelResizeHandleContainer-state-closed"
	| "MyPanelResizeHandle"
	| "MyPanelResizeHandle-orientation-vertical"
	| "MyPanelResizeHandle-orientation-horizontal";

export type MyPanelResizeHandle_Props = Omit<
	ComponentPropsWithRef<typeof PanelResizeHandle>,
	ExtractStrict<keyof ComponentPropsWithRef<typeof PanelResizeHandle>, "onDoubleClick">
> & {
	containerClassName?: string;
	isOpen?: boolean;
	closeBehavior?: MyPanel_CloseBehavior;
	orientation?: MyPanelResizeHandle_Orientation;
};

export const MyPanelResizeHandle = memo(function MyPanelResizeHandle(props: MyPanelResizeHandle_Props) {
	const {
		className,
		containerClassName,
		hitAreaMargins,
		isOpen = true,
		closeBehavior = "unmount",
		orientation = "vertical",
		onDragging,
		onClick,
		children,
		...rest
	} = props;

	const panelGroupContext = useContext(MyPanelGroupContext);
	const lastClickAtRef = useRef<number | null>(null);

	const handleClick = useFn<NonNullable<ComponentPropsWithRef<typeof PanelResizeHandle>["onClick"]>>(() => {
		onClick?.();

		if (!panelGroupContext?.resetToDefaultLayout) {
			return;
		}

		// Use the library click callback so double-click actions work in the expanded hit area.
		const nextClickAt = performance.now();
		if (lastClickAtRef.current !== null && nextClickAt - lastClickAtRef.current <= 500) {
			lastClickAtRef.current = null;
			panelGroupContext.resetToDefaultLayout();
			return;
		}

		lastClickAtRef.current = nextClickAt;
	});

	if (!isOpen && closeBehavior === "unmount") {
		return null;
	}

	const containerHiddenStyle = !isOpen && closeBehavior === "hidden" ? { display: "none" } : undefined;
	const effectiveHitAreaMargins = hitAreaMargins ?? DEFAULT_HIT_AREA;

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
				aria-orientation={orientation}
				hitAreaMargins={effectiveHitAreaMargins}
				onClick={handleClick}
				onDragging={onDragging}
				{...rest}
			>
				{children}
				<MyPanelResizeHandleGrip orientation={orientation} />
			</PanelResizeHandle>
		</div>
	);
});
// #endregion handle
