import { ConvexError, v, type GenericValidator } from "convex/values";

export function convex_error<Cause, Data>(args: {
	message: string;
	cause?: Cause;
	data?: Data;
}): // @ts-expect-error
ConvexError<{ message: string; cause?: Cause; data?: Data }> {
	return new ConvexError({
		message: args.message,
		...((args.cause !== undefined && { cause: args.cause }) as any),
		...((args.data !== undefined && { data: args.data }) as any),
	});
}

/**
 * Build a Convex validator for the app's `Result(...)` contract.
 *
 * Always provide the `_yay` validator because every Result-returning Convex
 * function should have an explicit success shape. When there is no success
 * payload, use `v_result({ _yay: v.null() })` and return
 * `Result({ _yay: null })`.
 *
 * The `_nay` branch is included by default with `{ message, name? }`, so a
 * handler can return `Result({ _nay: { message: "..." } })` without providing
 * `_nay` options here. The only custom `_nay` field this helper validates is
 * `data`; use `v.union(...)` for that data validator when callers need multiple
 * error payload shapes. If you want to preserve a cause across the Convex
 * boundary, include the API-safe cause details inside `_nay.data` and validate
 * that shape here.
 */
export function v_result(args: {
	_yay: GenericValidator;
	_nay?: {
		data?: GenericValidator;
	};
}) {
	const nayFields = {
		message: v.string(),
		name: v.optional(v.string()),
		...(args._nay?.data ? { data: v.optional(args._nay.data) } : {}),
	};

	return v.union(v.object({ _yay: args._yay }), v.object({ _nay: v.object(nayFields) }));
}
