import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils.ts";

type InfiniteScrollSentinel_ClassNames = "InfiniteScrollSentinel";

export type InfiniteScrollSentinel_Props = Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> & {
	root?: Element | null;
	rootMargin?: `${number}px ${number}px ${number}px ${number}px` | `${number}px ${number}px` | `${number}px`;
	threshold?: number | number[];
	onIntersection: (args: { entry: IntersectionObserverEntry; observer: IntersectionObserver }) => void;
};

export function InfiniteScrollSentinel(props: InfiniteScrollSentinel_Props) {
	const { className, onIntersection, root, rootMargin, style, threshold, ...rest } = props;
	const onIntersectionRef = useRef(onIntersection);
	const sentinelRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		onIntersectionRef.current = onIntersection;
	}, [onIntersection]);

	useEffect(() => {
		const sentinelElement = sentinelRef.current;
		if (!sentinelElement) {
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (!entry) {
					return;
				}

				onIntersectionRef.current({ entry, observer });
			},
			{ root, rootMargin, threshold },
		);

		observer.observe(sentinelElement);
		return () => observer.disconnect();
	}, [root, rootMargin, threshold]);

	return (
		<div
			ref={sentinelRef}
			aria-hidden="true"
			className={cn("InfiniteScrollSentinel" satisfies InfiniteScrollSentinel_ClassNames, className)}
			style={{ height: 1, ...style }}
			{...rest}
		/>
	);
}
