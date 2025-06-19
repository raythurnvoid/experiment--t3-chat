import { ArtifactRenderer } from "./artifact-renderer.tsx";
import { QuickStart } from "./quick-start.tsx";
import { useCanvasStore } from "../../stores/canvas-store.ts";
import { memo } from "react";

export const Canvas = memo(() => {
	const { getCurrentArtifact } = useCanvasStore();
	const currentArtifact = getCurrentArtifact();

	return (
		<div className="Canvas h-full">
			{currentArtifact ? <ArtifactRenderer /> : <QuickStart />}
		</div>
	);
});
