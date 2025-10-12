/**
 * 1 second.
 *
 * Convex might returns dates in the future by more or less 1 second.
 *
 * This would prevent to show invalid dates in the UI.
 */
const PAST_TIME_TOLERANCE = 1000;

/**
 * Format a timestamp as a relative time string
 * @param updatedAt - Timestamp in milliseconds
 * @returns Relative time string (e.g., "2h ago", "Yesterday", "15 Dec", "15 Dec 2023")
 */
export function format_relative_time(updatedAt: number): string {
	const now = Date.now();
	const diff = now - updatedAt;

	// Handle invalid or future timestamps
	if (diff < 0 - PAST_TIME_TOLERANCE || !Number.isFinite(updatedAt)) {
		return "Unknown";
	}

	// Less than 1 minute
	if (diff < 60 * 1000) {
		return "Just now";
	}

	// Less than 1 hour
	if (diff < 60 * 60 * 1000) {
		const minutes = Math.floor(diff / (60 * 1000));
		return `${minutes}m`;
	}

	// Less than 24 hours
	if (diff < 24 * 60 * 60 * 1000) {
		const hours = Math.floor(diff / (60 * 60 * 1000));
		return `${hours}h`;
	}

	// Less than 7 days
	if (diff < 7 * 24 * 60 * 60 * 1000) {
		const days = Math.floor(diff / (24 * 60 * 60 * 1000));
		if (days === 1) {
			return "Yesterday";
		}
		return `${days}d`;
	}

	// More than 7 days - show date with slash format
	const date = new Date(updatedAt);
	const today = new Date();
	const isThisYear = date.getFullYear() === today.getFullYear();

	// Extract date parts
	const day = date.getDate();
	const month = date.getMonth();
	const year = date.getFullYear();

	// Month names
	const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

	if (isThisYear) {
		// Format: day month (e.g., "15 Dec")
		return `${day} ${monthNames[month]}`;
	}

	// Format: day month year (e.g., "15 Dec 2023")
	return `${day} ${monthNames[month]} ${year}`;
}

/**
 * Determines if the relative time format should include "(ago)" suffix
 * @param updatedAt - Timestamp in milliseconds
 * @returns true if "(ago)" should be shown, false otherwise
 */
export function should_show_ago_suffix(updatedAt: number): boolean {
	const now = Date.now();
	const diff = now - updatedAt;

	// Handle invalid or future timestamps
	if (diff < 0 || !Number.isFinite(updatedAt)) {
		return false;
	}

	// Less than 1 minute - "Just now" doesn't need "(ago)"
	if (diff < 60 * 1000) {
		return false;
	}

	// Less than 7 days - relative formats like "2h", "3d", "Yesterday" need "(ago)"
	if (diff < 7 * 24 * 60 * 60 * 1000) {
		return true;
	}

	// More than 7 days - absolute dates like "15 Dec" or "15 Dec 2023" don't need "(ago)"
	return false;
}

/**
 * Determines if the relative time format should include "(at)" prefix
 * @param updatedAt - Timestamp in milliseconds
 * @returns true if "(at)" should be shown, false otherwise
 */
export function should_show_at_prefix(updatedAt: number): boolean {
	const now = Date.now();
	const diff = now - updatedAt;

	// Handle invalid or future timestamps
	if (diff < 0 || !Number.isFinite(updatedAt)) {
		return false;
	}

	// Less than 1 minute - "Just now" doesn't need "(at)"
	if (diff < 60 * 1000) {
		return false;
	}

	// Less than 7 days - relative formats like "2h", "3d", "Yesterday" don't need "(at)"
	if (diff < 7 * 24 * 60 * 60 * 1000) {
		return false;
	}

	// More than 7 days - absolute dates like "15 Dec" or "15 Dec 2023" need "(at)"
	return true;
}
