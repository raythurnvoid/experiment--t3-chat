import { memo } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { MyLinkSurface, type MyLinkSurface_Props } from "./my-link-surface.tsx";

export type MyLink_Props = LinkProps & Omit<MyLinkSurface_Props, "children" | "ref">;

export const MyLink = memo(function MyLink(props: MyLink_Props) {
	const { className, style, variant = "default", children, ...rest } = props;

	return (
		<Link {...rest}>
			<MyLinkSurface className={className} style={style} variant={variant}>
				{typeof children === "function" ? children({ isActive: false, isTransitioning: false }) : children}
			</MyLinkSurface>
		</Link>
	);
});
