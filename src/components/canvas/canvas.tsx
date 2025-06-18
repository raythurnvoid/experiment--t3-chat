import { useCanvasStore } from "../../stores/canvas-store";
import { ArtifactRenderer } from "./artifact-renderer";
import { QuickStart } from "./quick-start";
import { cn } from "../../lib/utils";

export function Canvas() {
	const { artifact } = useCanvasStore();

	return (
		<div className={cn("Canvas", "h-full w-full")}>
			{artifact ? <ArtifactRenderer /> : <QuickStart />}
		</div>
	);
}
