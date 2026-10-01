import { HotkeysProvider, useHotkey as tanstack_useHotkey, type UseHotkeyOptions } from "@tanstack/react-hotkeys";
import type { HotkeyCallback, RegisterableHotkey } from "@tanstack/react-hotkeys";

export type AppHotkeysProvider_Props = {
	children: React.ReactNode;
};

export const AppHotkeysProvider = Object.assign(
	function AppHotkeysProvider(props: AppHotkeysProvider_Props) {
		const { children } = props;

		return (
			<HotkeysProvider
				defaultOptions={{
					hotkey: {
						ignoreInputs: true,
					},
				}}
			>
				{children}
			</HotkeysProvider>
		);
	},
	{
		useHotkey(args: {
			hotkey: RegisterableHotkey;
			callback: HotkeyCallback;
			options?: UseHotkeyOptions;
		}) {
			const { hotkey, callback, options } = args;

			tanstack_useHotkey(hotkey, callback, {
				ignoreInputs: true,
				...options,
			});
		},
	},
);
