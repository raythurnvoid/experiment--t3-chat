import type { LiteralUnion } from "type-fest";

export type simple_animations_AnimateOptions = {
	/**
	 * Equivalent to CSS `animation-duration`.
	 */
	duration: number;
	/**
	 * Equivalent to CSS `animation-delay`.
	 *
	 * @default 0
	 */
	delay?: number;
	/**
	 * Delay after the animation is finished.
	 *
	 * @default 0
	 */
	endDelay?: number;
	/**
	 * Equivalent to CSS `animation-timing-function`.
	 *
	 * @default 'linear'
	 */
	easing?: LiteralUnion<"ease-out" | "ease-in" | "ease-in-out" | "linear", string>;
	/**
	 * Equivalent to CSS `animation-fill-mode`.
	 *
	 * Defaults to `both`, useful when multiple animations needs to run and
	 * the properties of the current animation shouldn't be lost.
	 *
	 * Remember to cancel animation with fill `both` to avoid unexpected behavior.
	 *
	 * @default 'both'
	 */
	fill?: "backwards" | "forwards" | "both" | "none";
};

/**
 * Use a WeakMap to prevent memory leaks when elements are removed from the DOM.
 *
 * Use a WeakRef to let the browser GC the animations even if the element is not
 * removed from the DOM.
 */
const animations_cache = new WeakMap<HTMLElement, Map<string, WeakRef<Animation>>>();

/**
 * Animate an element and cache the animation.
 *
 * The first time the animation is played, a new `Animation` object is created
 * and saved internally. Subsequent calls with the same `id` will return the
 * cached animation.
 *
 * Changes to the keyframes or options will not affect the cached animation.
 *
 * @param element - Element to animate.
 * @param id - Unique identifier for the animation. Used to cache the animation.
 * @param keyframes - Equivalent to CSS `@keyframes`.
 * @param options - Equivalent to CSS `animation` properties.
 */
export function simple_animations_animate_and_cache(
	/**
	 * Element to animate.
	 */
	element: HTMLElement,
	/**
	 * Unique identifier for the animation.
	 */
	id: string,
	/**
	 * Equivalent to CSS `@keyframes`.
	 */
	keyframes: Keyframe[],
	options: simple_animations_AnimateOptions,
) {
	if (!animations_cache.has(element)) {
		animations_cache.set(element, new Map());
	}

	const cachedAnimation = animations_cache.get(element)?.get(id)?.deref();
	if (cachedAnimation) {
		// If the animation was removed by the browser, we need to call `animate` again
		if (cachedAnimation.replaceState === "removed") {
			const keyframeEffect = cachedAnimation.effect as KeyframeEffect;
			const animation = element.animate(keyframeEffect.getKeyframes(), {
				...keyframeEffect.getTiming(),
				id,
			});
			animations_cache.get(element)?.set(id, new WeakRef(animation));
			return animation;
		} else {
			cachedAnimation.play();
			return cachedAnimation;
		}
	}

	const finalDelay = options.delay ?? 0;
	const finalEndDelay = options.endDelay ?? 0;
	const finalFill = options.fill ?? "both";
	const finalEasing = options.easing ?? "linear";

	const animation = element.animate(keyframes, {
		duration: options.duration,
		delay: finalDelay,
		endDelay: finalEndDelay,
		easing: finalEasing,
		fill: finalFill,
		id,
	});

	animations_cache.get(element)?.set(id, new WeakRef(animation));

	return animation;
}

function create_group_noop_cached_animation(
	id: string,
	options: {
		duration: number;
	},
) {
	return simple_animations_animate_and_cache(document.body, id, [{}], {
		duration: options.duration,
		fill: "none",
	});
}

export function simple_animations_cached_group(
	id: string,
	options: {
		duration?: number;
		animations: () => (Animation | null | undefined)[];
		onFinish?: (animations: (Animation | null | undefined)[]) => void;
	},
) {
	const animations = options.animations();

	const groupDuration =
		options.duration ?? (animations.length > 0 ? Math.max(0, ...animations.map(get_animation_tot_duration)) : 0);

	const animationGroup = create_group_noop_cached_animation(id, {
		duration: groupDuration,
	});

	animations.push(animationGroup);

	animationGroup.onfinish = () => {
		animationGroup.cancel();
		options.onFinish?.(animations);
	};

	return animations;
}

function get_animation_tot_duration(animation: Animation | null | undefined) {
	if (!animation) return 0;

	const keyframeEffect = animation.effect as KeyframeEffect;
	const rawDuration = keyframeEffect.getTiming().duration ?? 0;
	const duration =
		(typeof CSSNumericValue !== "undefined" && rawDuration instanceof CSSNumericValue) ||
		typeof rawDuration === "string"
			? 0
			: (rawDuration as number);
	const delay = keyframeEffect.getTiming().delay ?? 0;
	const endDelay = keyframeEffect.getTiming().endDelay ?? 0;

	return duration + delay + endDelay;
}

let id_counter = 0;

/**
 * Create a unique identifier for a simple animation that will be cached.
 *
 * Useful to create ids for `simpleAnimations_animateAndCache`.
 *
 * @param label A human readable label for the animation.
 *
 * @returns Unique identifier for the animation with the format
 * `simple_animation::<unique_counter>::<input_label>`.
 */
export function simple_animations_create_id(label: string) {
	return `simple_animation::${id_counter++}::${label}`;
}

const animations_registry = new WeakMap<
	HTMLElement,
	Map<
		string,
		{
			keyframes: Keyframe[];
			options: simple_animations_AnimateOptions;
		}
	>
>();

export function simple_animations_register_animation(
	element: HTMLElement,
	id: string /**
	 * Equivalent to CSS `@keyframes`.
	 */,
	keyframes: Keyframe[],
	options: simple_animations_AnimateOptions,
) {}
