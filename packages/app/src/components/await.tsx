import { use } from "react";

export type AwaitProps<T> = {
	promise: Promise<T>;
	children: (data: T) => React.ReactNode;
};

export function Await<T>(props: AwaitProps<T>) {
	const value = use(props.promise);
	return props.children(value);
}
