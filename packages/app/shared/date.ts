/**
 * 1 minute in milliseconds
 */
export const date_MS_MINUTE = 60 * 1000;
/**
 * 1 hour in milliseconds
 */
export const date_MS_HOUR = 60 * date_MS_MINUTE;
/**
 * 1 day in milliseconds
 */
export const date_MS_DAY = 24 * date_MS_HOUR;
/**
 * 1 week in milliseconds
 */
export const date_MS_WEEK = 7 * date_MS_DAY;
/**
 * 30 days in milliseconds
 */
export const date_MS_DAYS_30 = 30 * date_MS_DAY;

/**
 * Get the start of the week (Monday 00:00:00 UTC) for a given timestamp.
 *
 * Monday is the first day of the week.
 */
export function date_get_week_start_timestamp(timestamp: number): number {
	const date = new Date(timestamp);
	const day = date.getUTCDay();
	const diff = day === 0 ? 6 : day - 1;
	date.setUTCDate(date.getUTCDate() - diff);
	date.setUTCHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * Get the start of the day (00:00:00 UTC) for a given timestamp
 */
export function date_get_day_start_timestamp(timestamp: number): number {
	const date = new Date(timestamp);
	date.setUTCHours(0, 0, 0, 0);
	return date.getTime();
}

/**
 * Get the start of the hour (XX:00:00 UTC) for a given timestamp
 */
export function date_get_hour_start_timestamp(timestamp: number): number {
	const date = new Date(timestamp);
	date.setUTCMinutes(0, 0, 0);
	return date.getTime();
}
