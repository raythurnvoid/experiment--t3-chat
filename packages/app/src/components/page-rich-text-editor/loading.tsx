import React from "react";

export default function Loading() {
	return (
		<div className="Loading absolute flex h-full w-full flex-1 items-center justify-center p-4">
			<div className="Loading-spinner h-8 w-8 animate-spin rounded-full border-b-2 border-foreground"></div>
		</div>
	);
}
