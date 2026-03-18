import "./my-switch.css";

import { memo, type ComponentPropsWithRef, type Ref } from "react";

import { cn } from "@/lib/utils.ts";

// #region root
export type MySwitch_ClassNames = "MySwitch" | "MySwitchControl" | "MySwitchTrack" | "MySwitchThumb";

export type MySwitch_Props = Omit<ComponentPropsWithRef<"input">, "children" | "className" | "style" | "type"> & {
	ref?: Ref<HTMLInputElement>;
	id?: string;
	className?: string;
	style?: ComponentPropsWithRef<"div">["style"];
	onCheckedChange?: (checked: boolean) => void;
};

export const MySwitch = memo(function MySwitch(props: MySwitch_Props) {
	const { ref, id, className, style, onChange, onCheckedChange, ...rest } = props;

	const handleChange: ComponentPropsWithRef<"input">["onChange"] = (event) => {
		onChange?.(event);
		onCheckedChange?.(event.currentTarget.checked);
	};

	return (
		<div className={cn("MySwitch" satisfies MySwitch_ClassNames, className)} style={style}>
			<div className={cn("MySwitchTrack" satisfies MySwitch_ClassNames)} aria-hidden>
				<div className={cn("MySwitchThumb" satisfies MySwitch_ClassNames)} />
			</div>
			<input
				ref={ref}
				id={id}
				type="checkbox"
				role="switch"
				className={cn("MySwitchControl" satisfies MySwitch_ClassNames)}
				onChange={handleChange}
				{...rest}
			/>
		</div>
	);
});
// #endregion root
