import "./my-avatar.css";
import {
	createContext,
	use,
	useLayoutEffect,
	useRef,
	useState,
	type ComponentProps,
	type ComponentPropsWithRef,
} from "react";
import { cn, forward_ref } from "@/lib/utils.ts";
import { MySkeleton, type MySkeleton_Props } from "./ui/my-skeleton.tsx";

type ImageLoadingStatus = "loading" | "loaded" | "fallback";

// #region Context
type AvatarContext_Value = {
	imageStatus: ImageLoadingStatus | null;
	setImageStatus: (status: ImageLoadingStatus) => void;
};

const AvatarContext = createContext<AvatarContext_Value | null>(null);
// #endregion Context

// #region Image
export type MyAvatarImage_ClassNames = "MyAvatarImage";

export type MyAvatarImage_Props = ComponentPropsWithRef<"img"> & {
	/**
	 * Delay the fallback state by 100 milliseconds.
	 *
	 * @default true
	 */
	fallbackDelay?: boolean;
};

export function MyAvatarImage(props: MyAvatarImage_Props) {
	const { ref, className, src, srcSet, fallbackDelay = true, ...rest } = props;

	const context = use(AvatarContext);
	if (!context) {
		throw new Error("MyAvatarImage must be used within MyAvatar");
	}

	const imageRef = useRef<HTMLImageElement | null>(null);

	const updateStateTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useLayoutEffect(() => {
		if (!imageRef.current) return;

		if (!src && !srcSet) {
			if (fallbackDelay) {
				updateStateTimeout.current = setTimeout(() => {
					context.setImageStatus("fallback");
				}, 100);
			} else {
				context.setImageStatus("fallback");
			}
		} else if (imageRef.current.complete) {
			context.setImageStatus("loaded");
		} else {
			if (fallbackDelay) {
				updateStateTimeout.current = setTimeout(() => {
					context.setImageStatus("loading");
				}, 100);
			} else {
				context.setImageStatus("loading");
			}
		}

		return () => {
			clearTimeout(updateStateTimeout.current);
		};
	}, [src, srcSet]);

	const handleLoad: ComponentProps<"img">["onLoad"] = () => {
		clearTimeout(updateStateTimeout.current);
		context.setImageStatus("loaded");
	};

	const handleError: ComponentProps<"img">["onError"] = () => {
		clearTimeout(updateStateTimeout.current);
		context.setImageStatus("fallback");
	};

	return (
		<img
			ref={(inst) => {
				forward_ref(inst, ref, imageRef);
			}}
			className={cn("MyAvatarImage" satisfies MyAvatarImage_ClassNames, className)}
			src={src}
			srcSet={srcSet}
			onLoad={handleLoad}
			onError={handleError}
			{...rest}
		/>
	);
}
// #endregion Image

// #region Loading
export type MyAvatarLoading_ClassNames = "MyAvatarLoading";

export type MyAvatarLoading_Props = ComponentPropsWithRef<"span"> & {
	/**
	 * @default true
	 */
	inert?: boolean;
};

export function MyAvatarLoading(props: MyAvatarLoading_Props) {
	const { ref, id, className, children, inert = true, ...rest } = props;

	const context = use(AvatarContext);
	if (!context) {
		throw new Error("MyAvatarLoading must be used within MyAvatar");
	}

	return (
		context.imageStatus === "loading" && (
			<span
				ref={ref}
				className={cn("MyAvatarLoading" satisfies MyAvatarLoading_ClassNames, className)}
				inert={inert}
				{...rest}
			>
				{children}
			</span>
		)
	);
}
// #endregion Loading

// #region Skeleton
export type MyAvatarSkeleton_ClassNames = "MyAvatarSkeleton";

export type MyAvatarSkeleton_Props = MySkeleton_Props;

export function MyAvatarSkeleton(props: MyAvatarSkeleton_Props) {
	const { className } = props;

	return <MySkeleton className={cn("MyAvatarSkeleton" satisfies MyAvatarSkeleton_ClassNames, className)} />;
}
// #endregion Skeleton

// #region Fallback
export type MyAvatarFallback_ClassNames = "MyAvatarFallback";

export type MyAvatarFallback_Props = ComponentPropsWithRef<"span"> & {
	/**
	 * @default true
	 */
	inert?: boolean;
};

export function MyAvatarFallback(props: MyAvatarFallback_Props) {
	const { ref, id, className, children, inert = true, ...rest } = props;

	const context = use(AvatarContext);
	if (!context) {
		throw new Error("MyAvatarFallback must be used within MyAvatar");
	}

	return (
		context.imageStatus === "fallback" && (
			<span
				ref={ref}
				className={cn("MyAvatarFallback" satisfies MyAvatarFallback_ClassNames, className)}
				inert={inert}
				{...rest}
			>
				{children}
			</span>
		)
	);
}

// #endregion Fallback

// #region MyAvatar
export type MyAvatar_ClassNames = "MyAvatar" | "MyAvatar-loaded" | "MyAvatar-loading" | "MyAvatar-fallback";

export type MyAvatar_CssVars = {
	"--MyAvatar-size": string;
};

export type MyAvatar_Props = ComponentPropsWithRef<"span"> & {
	style?: React.CSSProperties & Partial<MyAvatar_CssVars>;
	/**
	 * Size of the avatar. Can be any CSS length value.
	 *
	 * It controls the `--MyAvatar-size` CSS custom property.
	 *
	 * The default size set in the `MyAvatar` class is `32px`.
	 *
	 * @example "32px" | "24px" | "2rem"
	 */
	size?: string;
};

export function MyAvatar(props: MyAvatar_Props) {
	const { ref, className, style, size, children, ...rest } = props;

	const [imageStatus, setImageStatus] = useState<ImageLoadingStatus | null>(null);

	return (
		<AvatarContext.Provider
			value={{
				imageStatus,
				setImageStatus,
			}}
		>
			<span
				ref={ref}
				className={cn(
					"MyAvatar" satisfies MyAvatar_ClassNames,
					imageStatus === "loaded" && ("MyAvatar-loaded" satisfies MyAvatar_ClassNames),
					imageStatus === "loading" && ("MyAvatar-loading" satisfies MyAvatar_ClassNames),
					imageStatus === "fallback" && ("MyAvatar-fallback" satisfies MyAvatar_ClassNames),
					className,
				)}
				style={{
					...({
						"--MyAvatar-size": size,
					} satisfies Partial<MyAvatar_CssVars>),
					...style,
				}}
				{...rest}
			>
				{children}
			</span>
		</AvatarContext.Provider>
	);
}
// #endregion MyAvatar
