/**
 * Format a timestamp as a relative time string
 * @param updatedAt - Timestamp in milliseconds
 * @returns Relative time string (e.g., "2h ago", "Yesterday", "15 Dec", "15 Dec 2023")
 */
export function formatRelativeTime(updatedAt: number): string {
	const now = Date.now();
	const diff = now - updatedAt;

	// Handle invalid or future timestamps
	if (diff < 0 || !Number.isFinite(updatedAt)) {
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
