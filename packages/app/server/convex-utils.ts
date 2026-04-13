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
