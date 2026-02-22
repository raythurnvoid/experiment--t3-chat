import "./online-presence-indicator.css";
import { cn, compute_fallback_user_name } from "@/lib/utils.ts";
import { AppAuthProvider } from "@/components/app-auth.tsx";
import { app_presence_GLOBAL_ROOM_ID } from "../../shared/shared-presence-constants.ts";
import { app_presence_set_enabled, usePresence, usePresenceEnabled, usePresenceList } from "../hooks/presence-hooks.ts";
import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "./my-avatar.tsx";
import { MyTooltip, MyTooltipArrow, MyTooltipContent, MyTooltipTrigger } from "./my-tooltip.tsx";

export type OnlinePresenceIndicator_ClassNames =
	| "OnlinePresenceIndicator"
	| "OnlinePresenceIndicator-status"
	| "OnlinePresenceIndicator-button"
	| "OnlinePresenceIndicator-list"
	| "OnlinePresenceIndicator-item"
	| "OnlinePresenceIndicator-item-avatar"
	| "OnlinePresenceIndicator-item-name";

type OnlinePresenceIndicatorUsers_Props = {
	userId: string;
};

function OnlinePresenceIndicatorUsers(props: OnlinePresenceIndicatorUsers_Props) {
	const { userId } = props;

	const presence = usePresence({
		roomId: app_presence_GLOBAL_ROOM_ID,
		userId: userId,
		disconnectOnDocumentHidden: false,
	});

	const presenceList = usePresenceList({
		roomToken: presence.roomToken,
		userId: userId,
	});

	const users = (presenceList?.users ?? [])
		.map((user) => {
			if (user.online === false) {
				return null;
			}

			return user;
		})
		.filter((user) => user != null);

	return (
		<MyTooltip timeout={0} placement="bottom-start">
			<MyTooltipTrigger>
				<span className={cn("OnlinePresenceIndicator-status" satisfies OnlinePresenceIndicator_ClassNames)}>
					online: {users.length}
				</span>
			</MyTooltipTrigger>
			<MyTooltipContent gutter={4}>
				<MyTooltipArrow />
				<div className={cn("OnlinePresenceIndicator-list" satisfies OnlinePresenceIndicator_ClassNames)}>
					{users.map((user) => (
						<div
							key={user.userId}
							className={cn("OnlinePresenceIndicator-item" satisfies OnlinePresenceIndicator_ClassNames)}
						>
							<MyAvatar
								className={cn("OnlinePresenceIndicator-item-avatar" satisfies OnlinePresenceIndicator_ClassNames)}
								size="24px"
							>
								<MyAvatarImage src={user.anagraphic.avatarUrl} alt={user.anagraphic.displayName} />
								<MyAvatarFallback>{compute_fallback_user_name(user.userId)}</MyAvatarFallback>
							</MyAvatar>
							<span className={cn("OnlinePresenceIndicator-item-name" satisfies OnlinePresenceIndicator_ClassNames)}>
								{user.anagraphic.displayName}
							</span>
						</div>
					))}
				</div>
			</MyTooltipContent>
		</MyTooltip>
	);
}

export function OnlinePresenceIndicator() {
	const authenticated = AppAuthProvider.useAuthenticated();
	const presenceEnabled = usePresenceEnabled();

	const handleClickTogglePresence = () => {
		app_presence_set_enabled(!presenceEnabled);
	};

	return (
		<div className={cn("OnlinePresenceIndicator" satisfies OnlinePresenceIndicator_ClassNames)}>
			{presenceEnabled ? (
				<OnlinePresenceIndicatorUsers userId={authenticated.userId} />
			) : (
				<span className={cn("OnlinePresenceIndicator-status" satisfies OnlinePresenceIndicator_ClassNames)}>
					presence: off
				</span>
			)}
			<button
				type="button"
				className={cn("OnlinePresenceIndicator-button" satisfies OnlinePresenceIndicator_ClassNames)}
				onClick={handleClickTogglePresence}
			>
				{presenceEnabled ? "Disable" : "Enable"}
			</button>
		</div>
	);
}
