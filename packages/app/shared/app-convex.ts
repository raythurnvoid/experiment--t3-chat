import type { Doc as app_convex_Doc, Id as app_convex_Id } from "convex/_generated/dataModel.js";
import type { FunctionReference, FunctionArgs } from "convex/server";

export type app_convex_Error<F extends FunctionReference<"mutation">> =
	FunctionArgs<F> extends { _errors?: infer E } ? NonNullable<E> : never;

export { api as app_convex_api } from "convex/_generated/api.js";

export type { app_convex_Doc, app_convex_Id };
