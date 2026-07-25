import type { Doc as app_convex_Doc, Id as app_convex_Id } from "convex/_generated/dataModel.js";
import type { FunctionReference, FunctionArgs } from "convex/server";

export type app_convex_Error<F extends FunctionReference<"mutation">> =
	FunctionArgs<F> extends { _errors?: infer E } ? NonNullable<E> : never;

export { api as app_convex_api } from "../convex/_generated/api.js";

export type { app_convex_Doc, app_convex_Id };

/** Convex document ids are long lowercase alphanumeric strings, with no separators and no uppercase. */
const APP_CONVEX_ID_REGEX = /^[a-z0-9]{20,}$/;

/**
 * Guess whether a string is a Convex document id.
 *
 * This reads the shape only: it cannot say which table the id belongs to, and it cannot tell a
 * real id from a lookalike. Callers that need certainty confirm the guess against real data.
 */
export function app_convex_is_id_like(value: string) {
	return APP_CONVEX_ID_REGEX.test(value);
}
