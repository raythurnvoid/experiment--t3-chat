import { v, type GenericValidator } from "convex/values";

export function v_result(args: {
	_yay: GenericValidator;
	_nay?: {
		/**
		 * Defaults to true to match this repo's Result conventions.
		 * Set to false for legacy paths that only expose `_nay.message`.
		 */
		includeName?: boolean;
		data?: GenericValidator;
	};
}) {
	const nayFields = {
		message: v.string(),
		...(args._nay?.includeName === false ? {} : { name: v.string() }),
		...(args._nay?.data ? { data: v.optional(args._nay.data) } : {}),
	};

	return v.union(v.object({ _yay: args._yay }), v.object({ _nay: v.object(nayFields) }));
}
