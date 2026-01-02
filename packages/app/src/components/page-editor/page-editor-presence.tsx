import "./page-editor-presence.css";
import { cn, compute_fallback_user_name, sx } from "@/lib/utils.ts";
import {
	MyAvatar,
	MyAvatarFallback,
	MyAvatarImage,
	MyAvatarLoading,
	MyAvatarSkeleton,
} from "@/components/my-avatar.tsx";
import { MyTooltip, MyTooltipArrow, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";

// #region PageEditorPresence
export type PageEditorPresence_ClassNames =
	| "PageEditorPresence"
	| "PageEditorPresence-avatar"
	| "PageEditorPresence-avatar-border"
	| "PageEditorPresence-avatar-overflow"
	| "PageEditorPresence-avatar-overflow-text"
	| "PageEditorPresence-tooltip-list"
	| "PageEditorPresence-tooltip-item"
	| "PageEditorPresence-tooltip-item-avatar"
	| "PageEditorPresence-tooltip-item-name";

export type PageEditorPresence_CssVars = {
	"--PageEditorPresence-avatar-border-color": string;
	"--PageEditorPresence-avatar-z-index": string;
};

export type PageEditorPresence_User = {
	userId: string;
	isSelf: boolean;
	name?: string;
	image?: string;
	color: string;
};

export type PageEditorPresence_Props = {
	users: PageEditorPresence_User[];
};

export function PageEditorPresence(props: PageEditorPresence_Props) {
	const { users } = props;

	if (users.length === 0) {
		return null;
	}

	const visibleUsers = users.slice(0, 4);
	const overflowCount = users.length - 4;

	return (
		<MyTooltip timeout={0} placement="bottom-start">
			<MyTooltipTrigger>
				<div className={cn("PageEditorPresence" satisfies PageEditorPresence_ClassNames)}>
					{visibleUsers.map((user, index) => (
						<MyAvatar
							key={user.userId}
							className={cn("PageEditorPresence-avatar" satisfies PageEditorPresence_ClassNames)}
							size="24px"
							style={sx({
								"--PageEditorPresence-avatar-z-index": String(visibleUsers.length - index),
							} satisfies Partial<PageEditorPresence_CssVars>)}
						>
							<MyAvatarImage src={user.image ?? undefined} alt={user.name ?? "Anonymous"} />
							<MyAvatarFallback>{compute_fallback_user_name(user.userId)}</MyAvatarFallback>
							<MyAvatarLoading>
								<MyAvatarSkeleton />
							</MyAvatarLoading>
							<span
								className={cn("PageEditorPresence-avatar-border" satisfies PageEditorPresence_ClassNames)}
								style={sx({
									"--PageEditorPresence-avatar-border-color": user.color,
								} satisfies Partial<PageEditorPresence_CssVars>)}
							></span>
						</MyAvatar>
					))}
					{overflowCount > 0 && (
						<MyAvatar
							className={cn("PageEditorPresence-avatar-overflow" satisfies PageEditorPresence_ClassNames)}
							size="24px"
							style={sx({
								"--PageEditorPresence-avatar-z-index": "0",
							} satisfies Partial<PageEditorPresence_CssVars>)}
						>
							<span className={cn("PageEditorPresence-avatar-overflow-text" satisfies PageEditorPresence_ClassNames)}>
								+{overflowCount}
							</span>
							<span className={cn("PageEditorPresence-avatar-border" satisfies PageEditorPresence_ClassNames)}></span>
						</MyAvatar>
					)}
				</div>
			</MyTooltipTrigger>
			<MyTooltipContent gutter={4}>
				<MyTooltipArrow />
				<div className={cn("PageEditorPresence-tooltip-list" satisfies PageEditorPresence_ClassNames)}>
					{users.map((user) => (
						<div
							key={user.userId}
							className={cn("PageEditorPresence-tooltip-item" satisfies PageEditorPresence_ClassNames)}
						>
							<MyAvatar
								className={cn("PageEditorPresence-tooltip-item-avatar" satisfies PageEditorPresence_ClassNames)}
								size="24px"
							>
								<MyAvatarImage src={user.image ?? undefined} alt={user.name ?? "Anonymous"} />
								<MyAvatarFallback>{compute_fallback_user_name(user.userId)}</MyAvatarFallback>
								<MyAvatarLoading>
									<MyAvatarSkeleton />
								</MyAvatarLoading>
							</MyAvatar>
							<span className={cn("PageEditorPresence-tooltip-item-name" satisfies PageEditorPresence_ClassNames)}>
								{user.name ?? user.userId}
							</span>
						</div>
					))}
				</div>
			</MyTooltipContent>
		</MyTooltip>
	);
}
// #endregion PageEditorPresence
