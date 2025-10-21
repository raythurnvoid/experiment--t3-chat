import "./my-modal.css";
import * as Ariakit from "@ariakit/react";
import type { ComponentPropsWithRef } from "react";
import { cn } from "@/lib/utils.ts";
import { MyIconButton } from "./my-icon-button.tsx";
import { X } from "lucide-react";
import type { ExtractStrict } from "type-fest";

export type MyModal_ClassNames = "MyModal";

export type MyModal_Props = Ariakit.DialogProviderProps;

export function MyModal(props: MyModal_Props) {
	const { children, ...rest } = props;

	return <Ariakit.DialogProvider {...rest}>{children}</Ariakit.DialogProvider>;
}

export type MyModalTrigger_ClassNames = "MyModalTrigger";

export type MyModalTrigger_Props = Omit<
	Ariakit.DialogDisclosureProps,
	ExtractStrict<keyof Ariakit.DialogDisclosureProps, "render" | "children">
> & {
	children?: Ariakit.DialogDisclosureProps["render"];
};

export function MyModalTrigger(props: MyModalTrigger_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.DialogDisclosure
			className={cn("MyModalTrigger" satisfies MyModalTrigger_ClassNames, className)}
			render={children}
			{...rest}
		/>
	);
}

export type MyModalBackdrop_ClassNames = "MyModalBackdrop";

export type MyModalBackdrop_Props = ComponentPropsWithRef<"div">;

export function MyModalBackdrop(props: MyModalBackdrop_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div id={id} ref={ref} className={cn("MyModalBackdrop" satisfies MyModalBackdrop_ClassNames, className)} {...rest}>
			{children}
		</div>
	);
}

export type MyModalPopover_ClassNames = "MyModalPopover";

export type MyModalPopover_Props = Omit<Ariakit.DialogProps, "modal" | "portal">;

export function MyModalPopover(props: MyModalPopover_Props) {
	const { className, children, backdrop, ...rest } = props;

	return (
		<Ariakit.Dialog
			className={cn("MyModalPopover" satisfies MyModalPopover_ClassNames, className)}
			portal={true}
			modal={true}
			backdrop={backdrop ?? <MyModalBackdrop />}
			{...rest}
		>
			{children}
		</Ariakit.Dialog>
	);
}

export type MyModalHeader_ClassNames = "MyModalHeader";

export type MyModalHeader_Props = ComponentPropsWithRef<"div">;

export function MyModalHeader(props: MyModalHeader_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<header id={id} ref={ref} className={cn("MyModalHeader" satisfies MyModalHeader_ClassNames, className)} {...rest}>
			{children}
		</header>
	);
}

export type MyModalScrollableArea_ClassNames = "MyModalScrollableArea";

export type MyModalScrollableArea_Props = ComponentPropsWithRef<"div">;

export function MyModalScrollableArea(props: MyModalScrollableArea_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			id={id}
			ref={ref}
			className={cn("MyModalScrollableArea" satisfies MyModalScrollableArea_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}

export type MyModalFooter_ClassNames = "MyModalFooter";

export type MyModalFooter_Props = ComponentPropsWithRef<"div">;

export function MyModalFooter(props: MyModalFooter_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<footer id={id} ref={ref} className={cn("MyModalFooter" satisfies MyModalFooter_ClassNames, className)} {...rest}>
			{children}
		</footer>
	);
}

export type MyModalHeading_ClassNames = "MyModalHeading";

export type MyModalHeading_Props = ComponentPropsWithRef<"h1">;

export function MyModalHeading(props: MyModalHeading_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.DialogHeading
			id={id}
			ref={ref}
			className={cn("MyModalHeading" satisfies MyModalHeading_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.DialogHeading>
	);
}

export type MyModalDescription_ClassNames = "MyModalDescription";

export type MyModalDescription_Props = ComponentPropsWithRef<"p">;

export function MyModalDescription(props: MyModalDescription_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<Ariakit.DialogDescription
			id={id}
			ref={ref}
			className={cn("MyModalDescription" satisfies MyModalDescription_ClassNames, className)}
			{...rest}
		>
			{children}
		</Ariakit.DialogDescription>
	);
}

export type MyModalCloseTrigger_ClassNames = "MyModalCloseTrigger";

export type MyModalCloseTrigger_Props = Omit<
	Ariakit.DialogDismissProps,
	ExtractStrict<keyof Ariakit.DialogDismissProps, "children" | "render">
> & {
	children?: Ariakit.DialogDismissProps["render"];
};

export function MyModalCloseTrigger(props: MyModalCloseTrigger_Props) {
	const { className, children, ...rest } = props;

	return (
		<Ariakit.DialogDismiss
			className={cn("MyModalCloseTrigger" satisfies MyModalCloseTrigger_ClassNames, className)}
			render={
				children ?? (
					<MyIconButton variant="ghost" tooltip="Close">
						<X />
					</MyIconButton>
				)
			}
			{...rest}
		></Ariakit.DialogDismiss>
	);
}
