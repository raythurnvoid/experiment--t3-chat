import type { LiteralUnion } from "type-fest";

export type Currency = "EUR" | "USD";

export function format_cents(cents: number, currency: LiteralUnion<Currency, string>) {
	return new Intl.NumberFormat(undefined, {
		style: "currency",
		currency,
	}).format(cents / 100);
}
