import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.tsx";
import { cn } from "@/lib/utils.ts";
import usePresence from "@convex-dev/presence/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { useAuth } from "@/lib/auth.ts";
import { app_presence_GLOBAL_ROOM_ID } from "../../shared/shared-presence-constants.ts";

const CLASS_NAMES = {
	root: "OnlinePresenceIndicator",
	button: "OnlinePresenceIndicator-button",
	tooltip: "OnlinePresenceIndicator-tooltip",
	list: "OnlinePresenceIndicator-list",
	item: "OnlinePresenceIndicator-item",
} as const;

export type OnlinePresenceIndicator_Props = React.ComponentProps<"button"> & {
	roomId?: string;
};

export function OnlinePresenceIndicator(props: OnlinePresenceIndicator_Props) {
	const defaultRoomId = app_presence_GLOBAL_ROOM_ID;
	const { id, className, roomId = defaultRoomId, children, ...rest } = props;
	const auth = useAuth();

	const presenceState = usePresence({
		presence: app_convex_api.presence,
		roomId,
		userId: auth.userId ?? "",
		disconnectOnDocumentHidden: false,
	});
	const users = presenceState ?? [];
	const count = users.filter((u) => u.online).length;

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						id={id}
						className={cn(CLASS_NAMES.root, CLASS_NAMES.button, "px-2 py-1 text-sm", className)}
						{...rest}
					>
						online: {count}
					</button>
				</TooltipTrigger>
				<TooltipContent className={cn(CLASS_NAMES.tooltip)} side="bottom" align="start">
					<div className={cn(CLASS_NAMES.list, "flex max-h-80 min-w-56 flex-col gap-2 overflow-auto p-1")}>
						{users.map((u) => (
							<div key={u.userId} className={cn(CLASS_NAMES.item, "flex items-center gap-2 opacity-100")}>
								<Avatar className="h-6 w-6">
									<AvatarImage src={u.image ?? ""} alt={u.name ?? "Anonymous"} />
									<AvatarFallback>{(u.name ?? "AN").slice(0, 2).toUpperCase()}</AvatarFallback>
								</Avatar>
								<span className="text-sm">{u.name ?? u.userId}</span>
							</div>
						))}
					</div>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
