import { ConvexError, v, type GenericValidator, type Value } from "convex/values";

type ConvexError_Data<
	TCause extends Value | undefined = Value | undefined,
	TData extends Value | undefined = Value | undefined,
> = {
	message: string;
	cause?: TCause;
	data?: TData;
};

export function convex_error(args: ConvexError_Data): ConvexError<ConvexError_Data> {
	return new ConvexError({
		message: args.message,
		cause: args.cause,
		data: args.data,
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
