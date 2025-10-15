import "./my-select.css";
import * as Ariakit from "@ariakit/react";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import { MyButtonIcon } from "./my-button.tsx";
import { ChevronDownIcon } from "lucide-react";

export type MySelect_ClassNames = "MySelect";

export type MySelect_Props = {
	defaultValue?: string;
	value?: string;
	onChange?: (value: string) => void;
	children?: React.ReactNode;
};

export function MySelect(props: MySelect_Props) {
	const { children, ...rest } = props;

	return <Ariakit.SelectProvider {...rest}>{children}</Ariakit.SelectProvider>;
}

export type MySelectTrigger_ClassNames = "MySelectTrigger";

export type MySelectTrigger_Props = {
	children?: Ariakit.SelectProps["render"];
} & Omit<Ariakit.SelectProps, ExtractStrict<keyof Ariakit.SelectProps, "render" | "children">>;

export function MySelectTrigger(props: MySelectTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.Select
			ref={ref}
			className={cn("MySelectTrigger" satisfies MySelectTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
}

export type MySelectOpenIndicator_ClassNames = "MySelectOpenIndicator";

export type MySelectOpenIndicator_Props = {
	children?: Ariakit.SelectProps["render"];
} & Omit<Ariakit.SelectArrowProps, ExtractStrict<keyof Ariakit.SelectArrowProps, "render" | "children">>;

export function MySelectOpenIndicator(props: MySelectOpenIndicator_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.SelectArrow
			className={cn("MySelectOpenIndicator" satisfies MySelectOpenIndicator_ClassNames, className)}
			render={
				children ?? (
					<MyButtonIcon>
						<ChevronDownIcon />
					</MyButtonIcon>
				)
			}
			{...rest}
		></Ariakit.SelectArrow>
	);
}

export type MySelectPopover_ClassNames = "MySelectPopover";

export type MySelectPopover_Props = Ariakit.SelectPopoverProps;

export function MySelectPopover(props: MySelectPopover_Props) {
	const { className, portal = true, sameWidth = false, gutter = 4, children, ...rest } = props;

	return (
		<Ariakit.SelectPopover
			className={cn("MySelectPopover" satisfies MySelectPopover_ClassNames, className)}
			gutter={gutter}
			sameWidth={sameWidth}
			portal={portal}
			{...rest}
		>
			{children}
		</Ariakit.SelectPopover>
	);
}

export type MySelectItem_ClassNames = "MySelectItem";

export type MySelectItem_Props = Ariakit.SelectItemProps;

export function MySelectItem(props: MySelectItem_Props) {
	const { className, value, children, ...rest } = props;

	return (
		<Ariakit.SelectItem
			className={cn("MySelectItem" satisfies MySelectItem_ClassNames, className)}
			value={value}
			{...rest}
		>
			{children}
		</Ariakit.SelectItem>
	);
}

export type MySelectLabel_ClassNames = "MySelectLabel";

export type MySelectLabel_Props = Ariakit.SelectLabelProps;

export function MySelectLabel(props: MySelectLabel_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.SelectLabel className={cn("MySelectLabel" satisfies MySelectLabel_ClassNames, className)} {...rest}>
			{children}
		</Ariakit.SelectLabel>
	);
}
