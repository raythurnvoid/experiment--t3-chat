import { createContext } from "react";

export const ChannelsLayoutContext = createContext<{
	sidebarVisible: boolean;
	drawerOpen: boolean;
	openSidebar: () => void;
} | null>(null);
