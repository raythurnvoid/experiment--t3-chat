import "@/components/my-button.css";
import "./my-button-group.css";
import type { ComponentPropsWithRef } from "react";
import { createContext, use, useId } from "react";

import type { MyButton_ClassNames } from "@/components/my-button.tsx";
import { cn } from "@/lib/utils.ts";

// #region Context
type MyButtonGroupContext = {
	name: string;
	value: string;
	onValueChange: (value: string) => void;
	disabled: boolean;
};

const MyButtonGroupContext = createContext<MyButtonGroupContext | null>(null);
// #endregion Context

// #region group
export type MyButtonGroup_ClassNames = "MyButtonGroup";

export type MyButtonGroup_Props = ComponentPropsWithRef<"div"> & {
	value: string;
	onValueChange: (value: string) => void;
	disabled?: boolean;
};

export function MyButtonGroup(props: MyButtonGroup_Props) {
	const { className, value, onValueChange, disabled = false, children, ...rest } = props;

	const reactId = useId();
	const name = `MyButtonGroup-${reactId}`;

	return (
		<MyButtonGroupContext.Provider value={{ name, value, onValueChange, disabled }}>
			<div
				className={cn("MyButtonGroup" satisfies MyButtonGroup_ClassNames, className)}
				role="radiogroup"
				aria-disabled={disabled || undefined}
				{...rest}
			>
				{children}
			</div>
		</MyButtonGroupContext.Provider>
	);
}
// #endregion group

// #region item
export type MyButtonGroupItem_ClassNames =
	| "MyButtonGroupItem"
	| "MyButtonGroupItem-input"
	| "MyButtonGroupItem-button";

export type MyButtonGroupItem_Props = Omit<
	ComponentPropsWithRef<"input">,
	"type" | "name" | "checked" | "defaultChecked"
> & {
	value: string;
	inputClassName?: string;
	className?: string;
	children?: React.ReactNode;
};

export function MyButtonGroupItem(props: MyButtonGroupItem_Props) {
	const { className, inputClassName, value, disabled, id, onChange, children, ...rest } = props;

	const context = use(MyButtonGroupContext);
	if (!context) {
		throw new Error("MyButtonGroupItem must be used within MyButtonGroup");
	}

	const reactId = useId();
	const inputId = id ?? `MyButtonGroupItem-${reactId}`;
	const isChecked = context.value === value;
	const isDisabled = Boolean(context.disabled || disabled);

	const handleChange: ComponentPropsWithRef<"input">["onChange"] = (event) => {
		onChange?.(event);
		if (!event.defaultPrevented) {
			context.onValueChange(value);
		}
	};

	return (
		<span className={cn("MyButtonGroupItem" satisfies MyButtonGroupItem_ClassNames)}>
			<input
				id={inputId}
				className={cn("MyButtonGroupItem-input" satisfies MyButtonGroupItem_ClassNames, inputClassName)}
				type="radio"
				name={context.name}
				value={value}
				checked={isChecked}
				disabled={isDisabled}
				onChange={handleChange}
				{...rest}
			/>
			<label
				htmlFor={inputId}
				className={cn(
					"MyButtonGroupItem-button" satisfies MyButtonGroupItem_ClassNames,
					"MyButton" satisfies MyButton_ClassNames,
					isChecked
						? ("MyButton-variant-secondary" satisfies MyButton_ClassNames)
						: ("MyButton-variant-outline" satisfies MyButton_ClassNames),
					className,
				)}
			>
				{children}
			</label>
		</span>
	);
}
// #endregion item
