import "./my-input.css";
import type { ComponentPropsWithRef } from "react";
import { createContext, memo, use, useLayoutEffect, useRef } from "react";
import type { ExtractStrict } from "type-fest";

import { useUiId } from "@/lib/ui.tsx";
import { cn, forward_ref, type XCustomEventLike } from "@/lib/utils.ts";
import { MyIcon } from "./my-icon.tsx";

// #region context
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
// #endregion context

// #region label
type MyInputLabel_ClassNames = "MyInputLabel";

export type MyInputLabel_Props = Omit<
	ComponentPropsWithRef<"label">,
	ExtractStrict<keyof ComponentPropsWithRef<"label">, "id">
>;

export const MyInputLabel = memo(function MyInputLabel(props: MyInputLabel_Props) {
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
});
// #endregion label

// #region helper text
type MyInputHelperText_ClassNames = "MyInputHelperText";

export type MyInputHelperText_Props = Omit<
	ComponentPropsWithRef<"div">,
	ExtractStrict<keyof ComponentPropsWithRef<"div">, "id">
>;

export const MyInputHelperText = memo(function MyInputHelperText(props: MyInputHelperText_Props) {
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
});
// #endregion helper text

// #region icon
export type MyInputIcon_ClassNames = "MyInputIcon";

export type MyInputIcon_Props = ComponentPropsWithRef<typeof MyIcon>;

export const MyInputIcon = memo(function MyInputIcon(props: MyInputIcon_Props) {
	const { className, ...rest } = props;

	return <MyIcon className={cn("MyInputIcon" satisfies MyInputIcon_ClassNames, className)} {...rest} />;
});
// #endregion icon

// #region background
export type MyInputBackground_ClassNames = "MyInputBackground";

export type MyInputBackground_Props = ComponentPropsWithRef<"div">;

export const MyInputBackground = memo(function MyInputBackground(props: MyInputBackground_Props) {
	const { ref, className, children, ...rest } = props;

	return (
		<div ref={ref} className={cn("MyInputBackground" satisfies MyInputBackground_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion background

// #region box
export type MyInputBox_ClassNames = "MyInputBox";

export type MyInputBox_Props = ComponentPropsWithRef<"div">;

export const MyInputBox = memo(function MyInputBox(props: MyInputBox_Props) {
	const { ref, className, children, ...rest } = props;

	return (
		<div ref={ref} className={cn("MyInputBox" satisfies MyInputBox_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion box

// #region area
export type MyInputArea_ClassNames = "MyInputArea";

export type MyInputArea_Props = ComponentPropsWithRef<"div"> & {
	/**
	 * When `true`, clicking anywhere on the input area will focus the input element,
	 * unless the click target is a button or a link.
	 *
	 * @default true
	 */
	focusForwarding?: boolean;
	onFocusForward?: (event: XCustomEventLike<{ originalEvent: React.PointerEvent<HTMLDivElement> }>) => void;
};

export const MyInputArea = memo(function MyInputArea(props: MyInputArea_Props) {
	const { ref, className, style, focusForwarding = true, onPointerDown, onFocusForward, children, ...rest } = props;
	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputArea must be used within MyInput");
	}

	const handlePointerDown: ComponentPropsWithRef<"div">["onPointerDown"] = (event) => {
		onPointerDown?.(event);

		if (focusForwarding && !event.isDefaultPrevented()) {
			// Don't focus if click target is a button or link or is the input itself
			const target = event.target as HTMLElement;
			const targetIsInput =
				target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.closest("[contenteditable='true']");
			const targetIsButton =
				target.tagName === "BUTTON" || Boolean(target.closest("button")) || target.getAttribute("role") === "button";
			const targetIsLink = target.tagName === "A" || Boolean(target.closest("a"));

			if (!targetIsInput && !targetIsButton && !targetIsLink) {
				let canFocusOnInput = true;
				onFocusForward?.({
					detail: { originalEvent: event },
					isDefaultPrevented: () => !canFocusOnInput,
					preventDefault: () => {
						canFocusOnInput = false;
					},
				});

				if (canFocusOnInput) {
					const inputElement = document.getElementById(context.inputId) as
						| HTMLInputElement
						| HTMLTextAreaElement
						| null;

					if (inputElement) {
						event.preventDefault();
						inputElement.focus();
					}
				}
			}
		}
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
});
// #endregion area

// #region actions
export type MyInputActions_ClassNames = "MyInputActions";

export type MyInputActions_Props = ComponentPropsWithRef<"div">;

export const MyInputActions = memo(function MyInputActions(props: MyInputActions_Props) {
	const { ref, className, children, ...rest } = props;

	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputActions must be used within MyInput");
	}

	return (
		<div ref={ref} className={cn("MyInputActions" satisfies MyInputActions_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
});
// #endregion actions

// #region control
export type MyInputControl_ClassNames = "MyInputControl";

export type MyInputControl_Props = Omit<
	ComponentPropsWithRef<"input">,
	ExtractStrict<keyof ComponentPropsWithRef<"input">, "size" | "id">
> & {
	validationMessage?: string;
};

export const MyInputControl = memo(function MyInputControl(props: MyInputControl_Props) {
	const { ref, className, validationMessage, ...rest } = props;

	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputControl must be used within MyInput");
	}

	const inputRef = useRef<HTMLInputElement>(null);

	useLayoutEffect(() => {
		const inputElement = inputRef.current;
		if (!inputElement) {
			return;
		}

		// Keep DOM validity live even when the visible error waits for blur or submit.
		inputElement.setCustomValidity(validationMessage ?? "");
		return () => {
			inputElement.setCustomValidity("");
		};
	}, [validationMessage]);

	return (
		<input
			ref={(inst) => {
				forward_ref(inst, ref, inputRef);
			}}
			id={context.inputId}
			className={cn("MyInputControl" satisfies MyInputControl_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion control

// #region textarea control
export type MyInputTextAreaControl_ClassNames = "MyInputTextAreaControl";

export type MyInputTextAreaControl_Props = Omit<
	ComponentPropsWithRef<"textarea">,
	ExtractStrict<keyof ComponentPropsWithRef<"textarea">, "id">
> & {
	validationMessage?: string;
};

export const MyInputTextAreaControl = memo(function MyInputTextAreaControl(props: MyInputTextAreaControl_Props) {
	const { ref, className, validationMessage, ...rest } = props;

	const context = use(MyInputContext);
	if (!context) {
		throw new Error("MyInputTextAreaControl must be used within MyInput");
	}

	const textAreaRef = useRef<HTMLTextAreaElement>(null);

	useLayoutEffect(() => {
		const textAreaElement = textAreaRef.current;
		if (!textAreaElement) {
			return;
		}

		// Keep DOM validity live even when the visible error waits for blur or submit.
		textAreaElement.setCustomValidity(validationMessage ?? "");
		return () => {
			textAreaElement.setCustomValidity("");
		};
	}, [validationMessage]);

	return (
		<textarea
			ref={(inst) => {
				forward_ref(inst, ref, textAreaRef);
			}}
			id={context.inputId}
			className={cn("MyInputTextAreaControl" satisfies MyInputTextAreaControl_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion textarea control

// #region root
type MyInput_ClassNames =
	| "MyInput"
	| "MyInput-variant-floating"
	| "MyInput-variant-transparent"
	| "MyInput-layout-stacked";

export type MyInput_Props = ComponentPropsWithRef<"div"> & {
	/**
	 * `floating` is for a standalone popover surface where the input is the only control inside
	 * (for example link setter or bubble comment composer). It uses the same border and outer
	 * elevation as `MyMenuPopover` / `MyFloatingSurface`.
	 */
	variant?: "surface" | "floating" | "transparent";

	/**
	 * Use `stacked` when the input includes a label or helper outside the painted field.
	 */
	layout?: "inline" | "stacked";

	displayValidationMessage?: string;
};

export const MyInput = memo(function MyInput(props: MyInput_Props) {
	const { className, variant = "surface", layout = "inline", displayValidationMessage, children, ...rest } = props;

	const rootId = useUiId("MyInput");
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
					variant === "floating" && ("MyInput-variant-floating" satisfies MyInput_ClassNames),
					variant === "transparent" && ("MyInput-variant-transparent" satisfies MyInput_ClassNames),
					layout === "stacked" && ("MyInput-layout-stacked" satisfies MyInput_ClassNames),
					displayValidationMessage && "userInvalid",
					className,
				)}
				{...rest}
			>
				{children}
			</div>
		</MyInputContext.Provider>
	);
});
// #endregion root
