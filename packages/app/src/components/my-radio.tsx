import "./my-radio.css";

import { memo, type ComponentPropsWithRef, type Ref } from "react";

import { cn } from "@/lib/utils.ts";

// #region root
export type MyRadio_ClassNames = "MyRadio";

export type MyRadio_Props = Omit<
	ComponentPropsWithRef<"input">,
	"children" | "name" | "type"
> & {
	ref?: Ref<HTMLInputElement>;
	/**
	 * Keep the radio group name unique across the app, for example by deriving it from React `useId()`.
	 */
	name: string;
};

export const MyRadio = memo(function MyRadio(props: MyRadio_Props) {
	const { ref, className, ...rest } = props;

	return <input ref={ref} className={cn("MyRadio" satisfies MyRadio_ClassNames, className)} type="radio" {...rest} />;
});
// #endregion root
