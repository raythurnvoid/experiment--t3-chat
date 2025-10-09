import { Link } from "@tanstack/react-router";
import { MyLinkSurface, type MyLinkSurface_Props } from "./my-link-surface.tsx";

export type MyLink_Props = React.ComponentProps<typeof Link> & Omit<MyLinkSurface_Props, "children">;

export function MyLink(props: MyLink_Props) {
	const { className, style, variant = "default", size = "default", children, ...rest } = props;

	return (
		<Link {...rest}>
			<MyLinkSurface className={className} style={style} variant={variant} size={size}>
				{typeof children === "function" ? children({ isActive: false, isTransitioning: false }) : children}
			</MyLinkSurface>
		</Link>
	);
}
