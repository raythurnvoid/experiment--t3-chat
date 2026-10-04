import "./channels-pane-header.css";
import { memo, useContext, type ReactNode } from "react";
import { ArrowLeft, Menu } from "lucide-react";
import { MyIconButton } from "@/components/my-icon-button.tsx";

import { ChannelsLayoutContext } from "./channels-layout-context.ts";

type ChannelsPaneHeader_ClassNames = "ChannelsPaneHeader" | "ChannelsPaneHeader-title";

export const ChannelsPaneHeader = memo(function ChannelsPaneHeader(props: {
	title: ReactNode;
	showSidebarToggle?: boolean;
	onBack?: () => void;
	backLabel?: string;
	children?: ReactNode;
}) {
	const { title, showSidebarToggle = true, onBack, backLabel = "Back to channel", children } = props;
	const layout = useContext(ChannelsLayoutContext);
	return (
		<header className={"ChannelsPaneHeader" satisfies ChannelsPaneHeader_ClassNames}>
			{onBack ? (
				<MyIconButton tooltip={backLabel} onClick={onBack}>
					<ArrowLeft />
				</MyIconButton>
			) : showSidebarToggle && layout && !layout.sidebarVisible ? (
				<MyIconButton tooltip="Open channels" aria-expanded={layout.drawerOpen} onClick={layout.openSidebar}>
					<Menu />
				</MyIconButton>
			) : null}
			<div className={"ChannelsPaneHeader-title" satisfies ChannelsPaneHeader_ClassNames}>{title}</div>
			{children}
		</header>
	);
});
