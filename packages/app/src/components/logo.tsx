import { cn } from "../lib/utils.ts";

export interface Logo_Props {
	className?: string;
}

export function Logo({ className }: Logo_Props) {
	return (
		<div
			className={cn(
				"Logo",
				"flex h-[23px] w-[73px] items-center justify-center bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-lg font-bold text-transparent hover:from-blue-700 hover:to-purple-700",
				className,
			)}
		>
			<h1 className={cn("Logo-text", "text-xl font-bold tracking-tight")}>rt0_chat</h1>
		</div>
	);
}
