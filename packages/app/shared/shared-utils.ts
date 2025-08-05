export function generate_timestamp_uuid<T extends string>(snakeCasePrefix: T): `${T}-${number}-${string}` {
	return `${snakeCasePrefix}-${Date.now()}-${crypto.randomUUID()}`;
}
