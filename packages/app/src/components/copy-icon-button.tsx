import type { Ref } from "react";
import { Check, Copy } from "lucide-react";

import { MyIconButton, MyIconButtonIcon, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { useAutoRevertingState } from "@/hooks/utils-hooks.ts";
import { cn, copy_to_clipboard, type copy_to_clipboard_Result } from "@/lib/utils.ts";

export type CopyIconButton_ClassNames = "CopyIconButton" | "CopyIconButton-icon";

export type CopyIconButton_Props = Omit<MyIconButton_Props, "children" | "tooltip" | "onClick" | "disabled" | "ref"> & {
	ref?: Ref<HTMLButtonElement>;
	text?: string | undefined;
	tooltipCopy: string;
	tooltipCopied?: string;
	tooltipFailed?: string;
	disabled?: boolean;
	iconClassName?: string | undefined;
};

export function CopyIconButton(props: CopyIconButton_Props) {
	const {
		ref,
		id,
		className,
		text,
		tooltipCopy,
		tooltipCopied = "Copied",
		tooltipFailed = "Copy failed",
		disabled,
		iconClassName,
		...rest
	} = props;

	const [copyState, setCopyState] = useAutoRevertingState<copy_to_clipboard_Result | undefined>(undefined);

	const computedDisabled = disabled ?? !text;

	const handleCopy = () => {
		if (computedDisabled || !text) {
			return;
		}

		setCopyState(undefined);
		copy_to_clipboard({ text })
			.then((res) => setCopyState(res))
			.catch(console.error);
	};

	return (
		<MyIconButton
			ref={ref}
			id={id}
			tooltip={copyState === undefined ? tooltipCopy : copyState._yay ? tooltipCopied : tooltipFailed}
			disabled={computedDisabled}
			onClick={handleCopy}
			className={cn("CopyIconButton" satisfies CopyIconButton_ClassNames, className)}
			{...rest}
		>
			{copyState?._yay ? (
				<MyIconButtonIcon className={cn("CopyIconButton-icon" satisfies CopyIconButton_ClassNames, iconClassName)}>
					<Check />
				</MyIconButtonIcon>
			) : (
				<MyIconButtonIcon className={cn("CopyIconButton-icon" satisfies CopyIconButton_ClassNames, iconClassName)}>
					<Copy />
				</MyIconButtonIcon>
			)}
		</MyIconButton>
	);
}
