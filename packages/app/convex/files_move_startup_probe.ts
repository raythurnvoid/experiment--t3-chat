// Temporary startup control. Remove it after the measured experiment.
import { v } from "convex/values";
import { internalMutation } from "./functions.ts";

export const experimental_reuseContext = true;

console.info("Move startup module", { module: "files_move_startup_probe" });

export const profile_move_db_startup = internalMutation({
	args: { sample: v.number() },
	returns: v.null(),
	handler: async () => null,
});
