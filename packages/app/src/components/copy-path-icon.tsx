import { createLucideIcon } from "lucide-react";

/**
 * Lucide has no icon for copying a path. This one copies the Windows 11 "Copy as path" icon: a
 * rounded box with `\\..` inside, drawn on Lucide's 24px grid with its stroke.
 *
 * Use it for every action that copies the path of a file or folder.
 */
export const CopyPathIcon = createLucideIcon("copy-path", [
	["rect", { x: "2", y: "5", width: "20", height: "14", rx: "3", key: "box" }],
	["path", { d: "m6 8 2 8", key: "slash-1" }],
	["path", { d: "m10 8 2 8", key: "slash-2" }],
	["path", { d: "M15 16h.01", key: "dot-1" }],
	["path", { d: "M18 16h.01", key: "dot-2" }],
]);
