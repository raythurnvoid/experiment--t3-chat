import "./my-popover.css";
import * as Ariakit from "@ariakit/react";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";

export type MyPopover_ClassNames = "MyPopover";

export type MyPopover_Props = Ariakit.PopoverProviderProps;

export function MyPopover(props: MyPopover_Props) {
	const { children, ...rest } = props;

	return <Ariakit.PopoverProvider {...rest}>{children}</Ariakit.PopoverProvider>;
}

export type MyPopoverTrigger_ClassNames = "MyPopoverTrigger";

export type MyPopoverTrigger_Props = {
	children?: Ariakit.PopoverDisclosureProps["render"];
} & Omit<Ariakit.PopoverDisclosureProps, ExtractStrict<keyof Ariakit.PopoverDisclosureProps, "render" | "children">>;

export function MyPopoverTrigger(props: MyPopoverTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.PopoverDisclosure
			ref={ref}
			id={id}
			className={cn("MyPopoverTrigger" satisfies MyPopoverTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
}

export type MyPopoverContent_ClassNames = "MyPopoverContent";

export type MyPopoverContent_Props = {
	children?: React.ReactNode;
	className?: string;
} & Omit<Ariakit.PopoverProps, "children" | "className">;

export function MyPopoverContent(props: MyPopoverContent_Props) {
	const { className, portal = true, gutter = 4, children, ...rest } = props;

	return (
		<Ariakit.Popover
			className={cn("MyPopoverContent" satisfies MyPopoverContent_ClassNames, className)}
			portal={portal}
			gutter={gutter}
			{...rest}
		>
			{children}
		</Ariakit.Popover>
	);
}

export type MyPopoverClose_ClassNames = "MyPopoverClose";

export type MyPopoverClose_Props = {
	children?: React.ReactNode;
	className?: string;
} & Omit<Ariakit.PopoverDismissProps, "children" | "className">;

export function MyPopoverClose(props: MyPopoverClose_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.PopoverDismiss className={cn("MyPopoverClose" satisfies MyPopoverClose_ClassNames, className)} {...rest}>
			{children}
		</Ariakit.PopoverDismiss>
	);
}
