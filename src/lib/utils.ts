import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Useful to make it easier to concat class names in react components
 **/
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/**
 * Clamp a value between a minimum and maximum.
 *
 * @example
 *
 * ```ts
 * math_clamp(10, 0, 100); // 10
 * math_clamp(200, 0, 100); // 100
 * math_clamp(-10, 0, 100); // 0
 * ```
 **/
export function math_clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}
