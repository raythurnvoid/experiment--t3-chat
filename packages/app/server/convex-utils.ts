import { v, type GenericValidator } from "convex/values";

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
