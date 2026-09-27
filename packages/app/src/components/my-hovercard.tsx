import "./my-hovercard.css";
import {
	Hovercard,
	HovercardAnchor,
	HovercardArrow,
	HovercardDisclosure,
	HovercardProvider,
	type HovercardAnchorProps,
	type HovercardArrowProps,
	type HovercardProps,
	type HovercardProviderProps,
} from "native-popovers/hovercard";
import { useFn } from "@/hooks/utils-hooks.ts";
import { memo, type ReactNode, useRef } from "react";
import { cn } from "@/lib/utils.ts";

// #region MyHoverCard
export type MyHoverCard_Props = HovercardProviderProps;

export const MyHoverCard = memo(function MyHoverCard(props: MyHoverCard_Props) {
	const { children, ...rest } = props;

	return <HovercardProvider {...rest}>{children}</HovercardProvider>;
});
// #endregion MyHoverCard

// #region action
export type MyHovercardAction_ClassNames =
	| "MyHovercardAction"
	| "MyHovercardAction-anchor"
	| "MyHovercardAction-disclosure";

export type MyHovercardAction_Props = {
	"aria-label": string;
	children?: ReactNode;
} & Omit<HovercardAnchorProps, "render" | "children">;

type AnchorOnFocus = HovercardAnchorProps["onFocus"];

/**
 * Hover-only trigger that opens the hovercard on pointer hover. Renders a non-focusable anchor
 * so there is a single tab stop: the sr-only disclosure button, which opens the card via keyboard.
 */
export const MyHovercardAction = memo(function MyHovercardAction(props: MyHovercardAction_Props) {
	const { ref, id, className, "aria-label": ariaLabel, onFocus, children, ...rest } = props;

	const disclosureRef = useRef<HTMLElement | null>(null);

	const handleFocus = useFn<NonNullable<AnchorOnFocus>>((e) => {
		disclosureRef.current?.focus();
		onFocus?.(e);
	});

	return (
		<>
			<HovercardAnchor
				ref={ref}
				id={id}
				className={cn("MyHovercardAction" satisfies MyHovercardAction_ClassNames, className)}
				aria-label={ariaLabel}
				onFocus={handleFocus}
				render={<div />}
				{...rest}
			>
				{children}
			</HovercardAnchor>
			{/* Keep the disclosure right after the anchor: my-hovercard.css styles the anchor from it. */}
			<HovercardDisclosure
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

export type MyHoverCardContent_Props = HovercardProps;

/**
 * The card. When it closes with focus inside, the library moves focus back to the disclosure,
 * because the anchor cannot take focus.
 */
export const MyHoverCardContent = memo(function MyHoverCardContent(props: MyHoverCardContent_Props) {
	const { ref, id, className, gutter = 8, children, ...rest } = props;

	return (
		<Hovercard
			ref={ref}
			id={id}
			className={cn("MyHoverCardContent" satisfies MyHoverCardContent_ClassNames, className)}
			gutter={gutter}
			{...rest}
		>
			{children}
		</Hovercard>
	);
});
// #endregion Content

// #region Arrow
export type MyHoverCardArrow_ClassNames = "MyHoverCardArrow";

export type MyHoverCardArrow_Props = HovercardArrowProps;

export const MyHoverCardArrow = memo(function MyHoverCardArrow(props: MyHoverCardArrow_Props) {
	const { ref, id, className, ...rest } = props;

	return (
		<HovercardArrow
			ref={ref}
			id={id}
			className={cn("MyHoverCardArrow" satisfies MyHoverCardArrow_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion Arrow
