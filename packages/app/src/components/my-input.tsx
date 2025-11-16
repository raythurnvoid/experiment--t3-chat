import "./my-input.css";
import type { ComponentPropsWithRef } from "react";
import { createContext, use, useId } from "react";

import { cn } from "@/lib/utils.ts";
import { MyIcon } from "./my-icon.tsx";

/**
 * Context for MyInput to share IDs between components
 */
interface MyInputContext {
	rootId: string;
	inputId: string;
	labelId: string;
	helperTextId: string;
}

/**
 * Context used to share the input field IDs with child components.
 */
const MyInputContext = createContext<MyInputContext | null>(null);

type MyInput_ClassNames = "MyInput" | "MyInput-variant-surface";

export type MyInput_Props = ComponentPropsWithRef<"div"> & {
	variant?: "default" | "surface";
};

export function MyInput(props: MyInput_Props) {
	const { className, variant = "default", children, ...rest } = props;

	const reactId = useId();
	const rootId = `MyInput-${reactId}`;
	const inputId = `${rootId}-input`;
	const labelId = `${rootId}-label`;
	const helperTextId = `${rootId}-helper-text`;

	const contextValue = {
		rootId,
		inputId,
		labelId,
		helperTextId,
	};

	return (
		<MyInputContext.Provider value={contextValue}>
			<div
				id={rootId}
				className={cn(
					"MyInput" satisfies MyInput_ClassNames,
					variant === "surface" && ("MyInput-variant-surface" satisfies MyInput_ClassNames),
					className,
				)}
				{...rest}
			>
				{children}
			</div>
		</MyInputContext.Provider>
	);
}

type MyInputLabel_ClassNames = "MyInputLabel";

export type MyInputLabel_Props = Omit<ComponentPropsWithRef<"label">, "id">;

export function MyInputLabel(props: MyInputLabel_Props) {
	const { ref, className, children, ...rest } = props;

	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputLabel must be used within MyInput");
	}

	return (
		<label
			ref={ref}
			id={context.labelId}
			htmlFor={context.inputId}
			className={cn("MyInputLabel" satisfies MyInputLabel_ClassNames, className)}
			{...rest}
		>
			{children}
		</label>
	);
}

type MyInputHelperText_ClassNames = "MyInputHelperText";

export type MyInputHelperText_Props = Omit<ComponentPropsWithRef<"div">, "id">;

export function MyInputHelperText(props: MyInputHelperText_Props) {
	const { ref, className, children, ...rest } = props;

	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputHelperText must be used within MyInput");
	}

	return (
		<div
			ref={ref}
			id={context.helperTextId}
			className={cn("MyInputHelperText" satisfies MyInputHelperText_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}

export type MyInputIcon_ClassNames = "MyInputIcon";

export type MyInputIcon_Props = ComponentPropsWithRef<typeof MyIcon>;

export function MyInputIcon(props: MyInputIcon_Props) {
	const { className, ...rest } = props;

	return <MyIcon className={cn("MyInputIcon" satisfies MyInputIcon_ClassNames, className)} {...rest} />;
}

export type MyInputBox_ClassNames = "MyInputBox";

export type MyInputBox_Props = ComponentPropsWithRef<"div">;

export function MyInputBox(props: MyInputBox_Props) {
	const { ref, className, children, ...rest } = props;

	return (
		<div ref={ref} className={cn("MyInputBox" satisfies MyInputBox_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MyInputArea_ClassNames = "MyInputArea";

export type MyInputArea_Props = ComponentPropsWithRef<"div"> & {
	/**
	 * When `true`, clicking anywhere on the input area will focus the input element,
	 * unless the click target is a button or a link.
	 *
	 * @default true
	 */
	focusForwarding?: boolean;
};

export function MyInputArea(props: MyInputArea_Props) {
	const { ref, className, style, focusForwarding = true, onPointerDown, children, ...rest } = props;
	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputArea must be used within MyInput");
	}

	const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (focusForwarding) {
			// Don't focus if click target is a button or link or is the input itself
			const target = event.target as HTMLElement;
			const targetIsInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
			const targetIsButton =
				target.tagName === "BUTTON" || Boolean(target.closest("button")) || target.getAttribute("role") === "button";
			const targetIsLink = target.tagName === "A" || Boolean(target.closest("a"));

			if (!targetIsInput && !targetIsButton && !targetIsLink) {
				const inputElement = document.getElementById(context.inputId) as HTMLInputElement | HTMLTextAreaElement | null;
				if (inputElement) {
					event.preventDefault();
					inputElement.focus();
				}
			}
		}

		onPointerDown?.(event);
	};

	return (
		<div
			ref={ref}
			className={cn("MyInputArea" satisfies MyInputArea_ClassNames, className)}
			style={style}
			onPointerDown={handlePointerDown}
			{...rest}
		>
			{children}
		</div>
	);
}

export type MyInputControl_ClassNames = "MyInputControl";

export type MyInputControl_Props = Omit<ComponentPropsWithRef<"input">, "size" | "id">;

export function MyInputControl(props: MyInputControl_Props) {
	const { ref, className, ...rest } = props;

	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputControl must be used within MyInput");
	}

	return (
		<input
			ref={ref}
			id={context.inputId}
			className={cn("MyInputControl" satisfies MyInputControl_ClassNames, className)}
			{...rest}
		/>
	);
}

type MyInputTextAreaControl_ClassNames = "MyInputTextAreaControl";

export type MyInputTextAreaControl_Props = Omit<ComponentPropsWithRef<"textarea">, "size" | "id">;

export function MyInputTextAreaControl(props: MyInputTextAreaControl_Props) {
	const { ref, className, ...rest } = props;

	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputTextAreaControl must be used within MyInput");
	}

	return (
		<textarea
			ref={ref}
			id={context.inputId}
			className={cn("MyInputTextAreaControl" satisfies MyInputTextAreaControl_ClassNames, className)}
			{...rest}
		/>
	);
}
