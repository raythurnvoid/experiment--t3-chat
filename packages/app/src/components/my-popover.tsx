import "./my-floating-surface.css";
import "./my-popover.css";
import {
	Popover,
	PopoverDisclosure,
	PopoverDismiss,
	PopoverProvider,
	type PopoverDisclosureProps,
	type PopoverDismissProps,
	type PopoverProps,
	type PopoverProviderProps,
} from "native-popovers/popover";
import { memo } from "react";
import { cn } from "@/lib/utils.ts";
import type { ExtractStrict } from "type-fest";
import type { MyFloatingSurface_ClassNames } from "@/components/my-floating-surface.tsx";

export type MyPopover_ClassNames = "MyPopover";

export type MyPopover_Props = PopoverProviderProps;

export const MyPopover = memo(function MyPopover(props: MyPopover_Props) {
	const { children, ...rest } = props;

	return <PopoverProvider {...rest}>{children}</PopoverProvider>;
});

export type MyPopoverTrigger_ClassNames = "MyPopoverTrigger";

export type MyPopoverTrigger_Props = {
	children?: PopoverDisclosureProps["render"];
} & Omit<PopoverDisclosureProps, ExtractStrict<keyof PopoverDisclosureProps, "render" | "children">>;

export const MyPopoverTrigger = memo(function MyPopoverTrigger(props: MyPopoverTrigger_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<PopoverDisclosure
			ref={ref}
			id={id}
			className={cn("MyPopoverTrigger" satisfies MyPopoverTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
});

export type MyPopoverContent_ClassNames = "MyPopoverContent";

export type MyPopoverContent_Props = PopoverProps;

/**
 * The popover content. It has no portal: it stays in the DOM next to its trigger, and the browser
 * shows it in the top layer.
 */
export const MyPopoverContent = memo(function MyPopoverContent(props: MyPopoverContent_Props) {
	const { className, gutter = 4, children, ...rest } = props;

	return (
		<Popover
			className={cn(
				"MyPopoverContent" satisfies MyPopoverContent_ClassNames,
				"MyFloatingSurface" satisfies MyFloatingSurface_ClassNames,
				className,
			)}
			gutter={gutter}
			{...rest}
		>
			{children}
		</Popover>
	);
});

export type MyPopoverClose_ClassNames = "MyPopoverClose";

export type MyPopoverClose_Props = {
	children?: React.ReactNode;
	className?: string;
} & Omit<PopoverDismissProps, ExtractStrict<keyof PopoverDismissProps, "children" | "className">>;

export const MyPopoverClose = memo(function MyPopoverClose(props: MyPopoverClose_Props) {
	const { className, children, ...rest } = props;

	return (
		<PopoverDismiss className={cn("MyPopoverClose" satisfies MyPopoverClose_ClassNames, className)} {...rest}>
			{children}
		</PopoverDismiss>
	);
});
