import "./file-editor-presence.css";
import { cn, compute_fallback_user_name, sx } from "@/lib/utils.ts";
import {
	MyAvatar,
	MyAvatarFallback,
	MyAvatarImage,
	MyAvatarLoading,
	MyAvatarSkeleton,
} from "@/components/my-avatar.tsx";
import { MyTooltip, MyTooltipArrow, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";

// #region FileEditorPresence
export type FileEditorPresence_ClassNames =
	| "FileEditorPresence"
	| "FileEditorPresence-avatar"
	| "FileEditorPresence-avatar-border"
	| "FileEditorPresence-avatar-overflow"
	| "FileEditorPresence-avatar-overflow-text"
	| "FileEditorPresence-tooltip-list"
	| "FileEditorPresence-tooltip-item"
	| "FileEditorPresence-tooltip-item-avatar"
	| "FileEditorPresence-tooltip-item-name";

export type FileEditorPresence_CssVars = {
	"--FileEditorPresence-avatar-border-color": string;
	"--FileEditorPresence-avatar-z-index": string;
};

export type FileEditorPresence_User = {
	userId: string;
	isSelf: boolean;
	anagraphic: { displayName: string; avatarUrl?: string };
	color: string;
};

export type FileEditorPresence_Props = {
	users: FileEditorPresence_User[];
};

export function FileEditorPresence(props: FileEditorPresence_Props) {
	const { users } = props;

	if (users.length === 0) {
		return null;
	}

	const visibleUsers = users.slice(0, 4);
	const overflowCount = users.length - 4;

	return (
		<MyTooltip timeout={0} placement="bottom-start">
			<MyTooltipTrigger>
				<div className={cn("FileEditorPresence" satisfies FileEditorPresence_ClassNames)}>
					{visibleUsers.map((user, index) => (
						<MyAvatar
							key={user.userId}
							className={cn("FileEditorPresence-avatar" satisfies FileEditorPresence_ClassNames)}
							size="24px"
							style={sx({
								"--FileEditorPresence-avatar-z-index": String(visibleUsers.length - index),
							} satisfies Partial<FileEditorPresence_CssVars>)}
						>
							<MyAvatarImage
								src={user.anagraphic.avatarUrl ?? undefined}
								alt={user.anagraphic.displayName ?? "Anonymous"}
							/>
							<MyAvatarFallback>{compute_fallback_user_name(user.userId)}</MyAvatarFallback>
							<MyAvatarLoading>
								<MyAvatarSkeleton />
							</MyAvatarLoading>
							<span
								className={cn("FileEditorPresence-avatar-border" satisfies FileEditorPresence_ClassNames)}
								style={sx({
									"--FileEditorPresence-avatar-border-color": user.color,
								} satisfies Partial<FileEditorPresence_CssVars>)}
							></span>
						</MyAvatar>
					))}
					{overflowCount > 0 && (
						<MyAvatar
							className={cn("FileEditorPresence-avatar-overflow" satisfies FileEditorPresence_ClassNames)}
							size="24px"
							style={sx({
								"--FileEditorPresence-avatar-z-index": "0",
							} satisfies Partial<FileEditorPresence_CssVars>)}
						>
							<span className={cn("FileEditorPresence-avatar-overflow-text" satisfies FileEditorPresence_ClassNames)}>
								+{overflowCount}
							</span>
							<span className={cn("FileEditorPresence-avatar-border" satisfies FileEditorPresence_ClassNames)}></span>
						</MyAvatar>
					)}
				</div>
			</MyTooltipTrigger>
			<MyTooltipContent gutter={4}>
				<MyTooltipArrow />
				<div className={cn("FileEditorPresence-tooltip-list" satisfies FileEditorPresence_ClassNames)}>
					{users.map((user) => (
						<div
							key={user.userId}
							className={cn("FileEditorPresence-tooltip-item" satisfies FileEditorPresence_ClassNames)}
						>
							<MyAvatar
								className={cn("FileEditorPresence-tooltip-item-avatar" satisfies FileEditorPresence_ClassNames)}
								size="24px"
							>
								<MyAvatarImage
									src={user.anagraphic.avatarUrl ?? undefined}
									alt={user.anagraphic.displayName ?? "Anonymous"}
								/>
								<MyAvatarFallback>{compute_fallback_user_name(user.userId)}</MyAvatarFallback>
								<MyAvatarLoading>
									<MyAvatarSkeleton />
								</MyAvatarLoading>
							</MyAvatar>
							<span className={cn("FileEditorPresence-tooltip-item-name" satisfies FileEditorPresence_ClassNames)}>
								{user.anagraphic.displayName ?? user.userId}
							</span>
						</div>
					))}
				</div>
			</MyTooltipContent>
		</MyTooltip>
	);
}
// #endregion FileEditorPresence
