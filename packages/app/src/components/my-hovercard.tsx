import "./my-hovercard.css";
import * as Ariakit from "@ariakit/react";
import { useFn } from "@/hooks/utils-hooks.ts";
import { memo, type ReactNode, type Ref, useRef } from "react";
import { cn } from "@/lib/utils.ts";

// #region MyHoverCard
export type MyHoverCard_Props = Ariakit.HovercardProviderProps;

export const MyHoverCard = memo(function MyHoverCard(props: MyHoverCard_Props) {
	const { children, ...rest } = props;

	return <Ariakit.HovercardProvider {...rest}>{children}</Ariakit.HovercardProvider>;
});
// #endregion MyHoverCard

// #region action
export type MyHovercardAction_ClassNames =
	| "MyHovercardAction"
	| "MyHovercardAction-anchor"
	| "MyHovercardAction-disclosure";

export type MyHovercardAction_Props = {
	ref?: Ref<HTMLDivElement>;
	"aria-label": string;
	children?: ReactNode;
} & Omit<Ariakit.HovercardAnchorProps<"div">, "render" | "children">;

/**
 * Hover-only trigger that opens the hovercard on pointer hover. Renders a non-focusable div
 * so there is a single tab stop: the sr-only disclosure button, which opens the card via keyboard.
 */
type AnchorOnFocus = Ariakit.HovercardAnchorProps<"div">["onFocus"];

export const MyHovercardAction = memo(function MyHovercardAction(props: MyHovercardAction_Props) {
	const { ref, id, className, "aria-label": ariaLabel, onFocus, children, ...rest } = props;

	const disclosureRef = useRef<HTMLButtonElement | null>(null);

	const handleFocus = useFn<AnchorOnFocus>((e) => {
		disclosureRef.current?.focus();
		onFocus?.(e as Parameters<NonNullable<AnchorOnFocus>>[0]);
	});

	return (
		<>
			<Ariakit.HovercardAnchor
				id={id}
				className={cn("MyHovercardAction" satisfies MyHovercardAction_ClassNames, className)}
				aria-label={ariaLabel}
				onFocus={handleFocus}
				render={(anchorProps) => <div {...anchorProps}>{children}</div>}
				{...(rest as any)}
			/>
			<Ariakit.HovercardDisclosure
				ref={disclosureRef}
				className={cn("MyHovercardAction-disclosure" satisfies MyHovercardAction_ClassNames, "sr-only")}
				aria-label={ariaLabel}
			/>
		</>
	);
});
// #endregion action

// #region Content
export type MyHoverCardContent_ClassNames = "MyHoverCardContent";

export type MyHoverCardContent_Props = Ariakit.HovercardProps;

export const MyHoverCardContent = memo(function MyHoverCardContent(props: MyHoverCardContent_Props) {
	const { ref, id, className, portal = true, gutter = 8, children, ...rest } = props;

	return (
		<Ariakit.Hovercard
			ref={ref}
			id={id}
			className={cn("MyHoverCardContent" satisfies MyHoverCardContent_ClassNames, className)}
			portal={portal}
			gutter={gutter}
			{...rest}
		>
			{children}
		</Ariakit.Hovercard>
	);
});
// #endregion Content

// #region Arrow
export type MyHoverCardArrow_ClassNames = "MyHoverCardArrow";

export type MyHoverCardArrow_Props = Ariakit.PopoverArrowProps;

export const MyHoverCardArrow = memo(function MyHoverCardArrow(props: MyHoverCardArrow_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<Ariakit.PopoverArrow
			ref={ref}
			id={id}
			className={cn("MyHoverCardArrow" satisfies MyHoverCardArrow_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion Arrow
