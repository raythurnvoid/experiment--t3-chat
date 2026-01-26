import { Button } from "../ui/button.tsx";
import { FileText, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils.ts";
import { useMutation } from "convex/react";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/utils.ts";

export interface QuickStart_Props {
	onOpenEditor: (pageId: app_convex_Id<"pages">) => void;
}

export function QuickStart(props: QuickStart_Props) {
	const { onOpenEditor } = props;
	const createPageQuick = useMutation(app_convex_api.ai_docs_temp.create_page_quick);

	const handleCreatePage = async () => {
		try {
			const page = await createPageQuick({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
			});
			onOpenEditor(page.page_id);
		} catch (error) {
			console.error("Failed to create page:", error);
		}
	};

	return (
		<div
			className={cn(
				"QuickStart",
				"flex h-full items-center justify-center overflow-auto bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800",
			)}
		>
			<div className={cn("QuickStart-container", "mx-auto max-w-2xl p-8 text-center")}>
				<div className={cn("QuickStart-header", "mb-8")}>
					<Sparkles
						className={cn("QuickStart-header-icon", "mx-auto mb-4 h-16 w-16 text-blue-600 dark:text-blue-400")}
					/>
					<h1 className={cn("QuickStart-header-title", "mb-2 text-3xl font-bold text-gray-900 dark:text-gray-100")}>
						Welcome to Canvas
					</h1>
					<p className={cn("QuickStart-header-description", "text-lg text-gray-600 dark:text-gray-300")}>
						Create text content with AI assistance
					</p>
				</div>

				<div className={cn("QuickStart-content", "space-y-6")}>
					<div className={cn("QuickStart-options", "flex justify-center")}>
						{/* Text option */}
						<div
							className={cn(
								"QuickStart-option",
								"QuickStart-option-text",
								"max-w-md rounded-lg border-2 border-gray-200 bg-white p-6 transition-colors hover:border-blue-300 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-blue-600",
							)}
						>
							<FileText
								className={cn("QuickStart-option-icon", "mx-auto mb-4 h-12 w-12 text-blue-600 dark:text-blue-400")}
							/>
							<h3
								className={cn("QuickStart-option-title", "mb-2 text-xl font-semibold text-gray-900 dark:text-gray-100")}
							>
								Start with Text
							</h3>
							<p className={cn("QuickStart-option-description", "mb-4 text-gray-600 dark:text-gray-300")}>
								Create documents, articles, or any text-based content with rich formatting
							</p>
							<Button onClick={handleCreatePage} className={cn("QuickStart-option-button", "w-full")} variant="outline">
								Create new Page
							</Button>
						</div>
					</div>

					<div className={cn("QuickStart-hint", "text-sm text-gray-500 dark:text-gray-400")}>
						You can also start a conversation and let AI create content for you
					</div>
				</div>
			</div>
		</div>
	);
}
