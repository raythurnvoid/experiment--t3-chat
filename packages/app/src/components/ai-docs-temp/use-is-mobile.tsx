import { useState, useEffect } from "react";

export function useIsMobile() {
	const [is_mobile, set_is_mobile] = useState(false);

	useEffect(() => {
		const check_device = () => {
			set_is_mobile(window.innerWidth < 768);
		};

		check_device();
		window.addEventListener("resize", check_device);

		return () => {
			window.removeEventListener("resize", check_device);
		};
	}, []);

	return is_mobile;
}
