import "./app-ai-chat.css";

import { cn } from "../lib/utils.ts";
import { AiChat } from "@/components/ai-chat/ai-chat.tsx";

export interface AppAiChat_Props {
	className?: string;
}

export function AppAiChat(props: AppAiChat_Props) {
	const { className } = props;

	return (
		<div className={cn("AppAiChat", className)}>
			<AiChat />
		</div>
	);
}
