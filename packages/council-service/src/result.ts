/**
 * The repo's errors-as-values shape, declared locally because this package is dependency-free on
 * purpose and must not import across package roots. Same contract as
 * `packages/common/src/errors-as-values-utils.ts`: exactly one of `_yay`/`_nay` is present, and a
 * caller handles both branches.
 */

export type council_Nay = {
	name?: string;
	message: string;
	cause?: unknown;
};

export type council_Result<Yay, Nay extends council_Nay = council_Nay> =
	| { _yay: Yay; _nay?: undefined }
	| { _yay?: undefined; _nay: Nay };

export function Result<Yay, Nay extends council_Nay = council_Nay>(
	value: { _yay: Yay } | { _nay: Nay },
): council_Result<Yay, Nay> {
	return value as council_Result<Yay, Nay>;
}
