import type { Accessor, JSX } from "solid-js";
import { createSignal, onCleanup, onMount } from "solid-js";
import { PullIndicator } from "./PullIndicator";
import "./SwipeableTabs.css";

type SwipeableTabsProps = {
	value: () => string;
	onChange: (next: string) => void;
	order: readonly string[];
	children: JSX.Element;
	onRefresh?: () => void;
	refreshing?: Accessor<boolean>;
	refreshableTabs?: readonly string[];
};

const PULL_MAX = 128;
const PULL_K = 0.4;
const SHOW_INDICATOR_THRESHOLD = 50;
const TRIGGER_THRESHOLD = 100;
const LOADING_OFFSET = 48;
// Minimum movement before committing to an axis. Without this, tiny
// initial finger jitter can lock the gesture into "x" and block native
// vertical scroll for the entire touch.
const AXIS_DECISION_THRESHOLD = 12;
// Half-angle (from the horizontal) of the cone that counts as a swipe.
// Movement steeper than this defaults to vertical scroll.
const SWIPE_CONE_DEGREES = 22;
const SWIPE_CONE_TAN = Math.tan((SWIPE_CONE_DEGREES * Math.PI) / 180);
// Velocity window: last few samples must also lean horizontal, so a slow
// diagonal drift doesn't get locked into "x" just because the cumulative
// delta happened to land inside the cone.
const VELOCITY_WINDOW_MS = 60;

function appr(x: number) {
	return PULL_MAX * (1 - Math.exp((-PULL_K * x) / PULL_MAX));
}

export function SwipeableTabs(props: SwipeableTabsProps) {
	const [offset, setOffset] = createSignal(0);
	const [dragging, setDragging] = createSignal(false);
	const [pullY, setPullY] = createSignal(0);
	const [pullTransition, setPullTransition] = createSignal(false);
	let start: { x: number; y: number } | null = null;
	let axis: "x" | "y" | "pull" | null = null;
	let frame: number | undefined;
	let latestDelta = { x: 0, y: 0 };
	const samples: { t: number; x: number; y: number }[] = [];

	const maxOffset = 84;
	const offsetScale = 0.4;
	const swipeThreshold = 45;

	const canRefresh = () =>
		props.onRefresh &&
		(!props.refreshableTabs || props.refreshableTabs.includes(props.value()));

	const isRefreshing = () => props.refreshing?.() === true;
	const showIndicator = () =>
		pullY() > SHOW_INDICATOR_THRESHOLD || isRefreshing();
	const indicatorFlipped = () => pullY() > TRIGGER_THRESHOLD;

	const currentPullOffset = () => {
		if (isRefreshing()) {
			return LOADING_OFFSET;
		}
		return appr(pullY());
	};

	const isSwipeBlockedTarget = (target: HTMLElement | null) =>
		!!target?.closest(".oys-location-map");

	const isAtTop = () => {
		// Check global scroll position first
		if (window.scrollY > 1) {
			return false;
		}
		const scrollEl = scrollRef;
		return scrollEl ? scrollEl.scrollTop <= 1 : true;
	};

	const updateOffset = (deltaX: number) => {
		const scaled = deltaX * offsetScale;
		const clamped = Math.max(-maxOffset, Math.min(maxOffset, scaled));
		setOffset(clamped);
	};

	const finishSwipe = (deltaX: number, deltaY: number) => {
		setDragging(false);
		setOffset(0);

		if (axis !== "x") {
			axis = null;
			return;
		}

		axis = null;

		if (
			Math.abs(deltaX) < swipeThreshold ||
			Math.abs(deltaX) < Math.abs(deltaY)
		) {
			return;
		}

		const currentIndex = props.order.indexOf(props.value());
		const direction = deltaX > 0 ? -1 : 1;
		const nextTab = props.order[currentIndex + direction];
		if (nextTab) {
			props.onChange(nextTab);
		}
	};

	const beginDrag = (
		clientX: number,
		clientY: number,
		target: HTMLElement | null,
	) => {
		if (isSwipeBlockedTarget(target)) {
			return;
		}
		start = { x: clientX, y: clientY };
		axis = null;
		samples.length = 0;
		samples.push({ t: performance.now(), x: 0, y: 0 });
		setDragging(true);
	};

	const scheduleUpdate = () => {
		if (frame) {
			return;
		}
		frame = window.requestAnimationFrame(() => {
			frame = undefined;
			if (axis === "x") {
				updateOffset(latestDelta.x);
			}
		});
	};

	const handleMove = (
		deltaX: number,
		deltaY: number,
		event: { preventDefault: () => void },
	) => {
		const now = performance.now();
		samples.push({ t: now, x: deltaX, y: deltaY });
		while (samples.length > 1 && now - samples[0].t > VELOCITY_WINDOW_MS) {
			samples.shift();
		}

		// Determine axis on first significant movement.
		// We require both: (a) the cumulative vector is inside a horizontal
		// cone, and (b) recent velocity is also horizontal — so a slow
		// diagonal drift defaults to vertical scroll instead of latching x.
		if (!axis) {
			const absX = Math.abs(deltaX);
			const absY = Math.abs(deltaY);
			if (Math.max(absX, absY) < AXIS_DECISION_THRESHOLD) {
				return;
			}
			const cumulativeHorizontal = absY <= absX * SWIPE_CONE_TAN;
			const oldest = samples[0];
			const vx = deltaX - oldest.x;
			const vy = deltaY - oldest.y;
			const recentHorizontal = Math.abs(vy) <= Math.abs(vx) * SWIPE_CONE_TAN;
			if (cumulativeHorizontal && recentHorizontal) {
				axis = "x";
			} else if (deltaY > 0 && isAtTop() && canRefresh() && !isRefreshing()) {
				// Pulling down while at top - enter pull mode
				axis = "pull";
			} else {
				axis = "y";
			}
		}

		if (axis === "pull") {
			// In pull mode, update pull distance and prevent scroll
			event.preventDefault();
			if (deltaY > 0) {
				setPullY(deltaY);
			} else {
				// User pushed back up, exit pull mode
				setPullY(0);
				axis = "y";
			}
		} else if (axis === "x") {
			event.preventDefault();
			latestDelta = { x: deltaX, y: deltaY };
			scheduleUpdate();
		}
	};

	const finishPull = (deltaY: number) => {
		const shouldTrigger =
			deltaY > TRIGGER_THRESHOLD && canRefresh() && !isRefreshing();

		setPullTransition(true);
		setPullY(0);

		if (shouldTrigger && props.onRefresh) {
			props.onRefresh();
		}
	};

	const handleTransitionEnd = () => {
		setPullTransition(false);
	};

	const handlePointerStart = (event: PointerEvent) => {
		if (!event.isPrimary) {
			return;
		}
		if (event.pointerType === "mouse" && event.button !== 0) {
			return;
		}
		beginDrag(event.clientX, event.clientY, event.target as HTMLElement | null);
	};

	const handlePointerMove = (event: PointerEvent) => {
		if (!start) {
			return;
		}
		const deltaX = event.clientX - start.x;
		const deltaY = event.clientY - start.y;
		handleMove(deltaX, deltaY, event);
	};

	const handlePointerEnd = (event: PointerEvent) => {
		if (!start) {
			return;
		}
		const deltaX = event.clientX - start.x;
		const deltaY = event.clientY - start.y;
		start = null;

		if (axis === "pull") {
			finishPull(deltaY);
		}

		finishSwipe(deltaX, deltaY);
	};

	const handleTouchStart = (event: TouchEvent) => {
		const touch = event.touches[0];
		if (!touch) {
			return;
		}
		beginDrag(touch.clientX, touch.clientY, event.target as HTMLElement | null);
	};

	const handleTouchMove = (event: TouchEvent) => {
		if (!start) {
			return;
		}
		const touch = event.touches[0];
		if (!touch) {
			return;
		}
		const deltaX = touch.clientX - start.x;
		const deltaY = touch.clientY - start.y;
		handleMove(deltaX, deltaY, event);
	};

	// Horizontal trackpad swipe (two-finger). Trackpad gestures don't have
	// touchend, so we use a quiet-gap timer as end-of-gesture: while wheel
	// events keep arriving we live-track the offset for visual feedback,
	// and after a short pause we either commit a tab change or snap back.
	//
	// We classify each wheel event per-axis as user-input vs OS-inertia
	// (decaying momentum tail). Inertia events pass through to native
	// scroll without affecting the probe or activating a swipe; only
	// user-input events drive horizontal activation. This lets a fresh
	// horizontal flick survive both vertical inertia (settling after
	// scrolling) and horizontal inertia (after a committed swipe).
	let wheelAccumX = 0;
	let wheelProbeX = 0;
	let wheelProbeY = 0;
	let wheelEndTimer: number | undefined;
	let wheelActive = false;
	const WHEEL_END_GAP_MS = 120;
	const WHEEL_COMMIT_THRESHOLD = swipeThreshold;
	const WHEEL_PROBE_MIN_SIGNED_X = 20;
	const WHEEL_PROBE_MIN_SIGNED_Y = 20;
	// Inertia model: a new sample on an axis is classified as inertia
	// only if it continues the prior sample's sign, doesn't grow in
	// magnitude beyond a small ratio, and arrives within the typical
	// inertia frame interval. Anything else is fresh user input.
	const INERTIA_MAX_GROWTH_RATIO = 1.15;
	const INERTIA_MAX_GAP_MS = 60;
	const PROBE_STALENESS_MS = 150;
	// One commit per "gesture burst". A burst is a contiguous run of
	// wheel events; it ends when the trackpad goes silent for this long
	// or when the user flips direction.
	const GESTURE_BURST_GAP_MS = 90;
	let gestureCommitted = false;
	let postCommitSawDecay = false;
	let commitT = 0;
	let lastEventT = 0;
	// Minimum time after commit before the lock can release on a "user"
	// event. Within this window, the original flick can still oscillate
	// (one decay event between two growing events) and we don't want
	// that to look like a fresh gesture.
	const POST_COMMIT_MIN_HOLD_MS = 250;

	type AxisHistory = {
		lastT: number;
		lastSignedDelta: number;
	};
	const axisX: AxisHistory = { lastT: 0, lastSignedDelta: 0 };
	const axisY: AxisHistory = { lastT: 0, lastSignedDelta: 0 };
	let lastUserInputXT = 0;
	let lastUserInputYT = 0;

	const classifyAxis = (
		hist: AxisHistory,
		signedDelta: number,
		now: number,
	): "inertia" | "user" | "idle" => {
		const abs = Math.abs(signedDelta);
		if (abs < 0.5) {
			return "idle";
		}
		if (hist.lastSignedDelta === 0) {
			return "user";
		}
		const dt = now - hist.lastT;
		if (dt > INERTIA_MAX_GAP_MS) {
			return "user";
		}
		const sameSign =
			(hist.lastSignedDelta > 0 && signedDelta > 0) ||
			(hist.lastSignedDelta < 0 && signedDelta < 0);
		if (!sameSign) {
			return "user";
		}
		const priorAbs = Math.abs(hist.lastSignedDelta);
		if (abs > priorAbs * INERTIA_MAX_GROWTH_RATIO) {
			return "user";
		}
		return "inertia";
	};

	const armWheelEndTimer = (cb: () => void) => {
		if (wheelEndTimer !== undefined) {
			window.clearTimeout(wheelEndTimer);
		}
		wheelEndTimer = window.setTimeout(() => {
			wheelEndTimer = undefined;
			cb();
		}, WHEEL_END_GAP_MS);
	};

	const endWheelGesture = () => {
		wheelActive = false;
		wheelAccumX = 0;
		wheelProbeX = 0;
		wheelProbeY = 0;
		setOffset(0);
		// Defer dropping `is-dragging` to the next frame so the transform
		// reset is applied with transitions still disabled — otherwise the
		// CSS transition animates the prior offset back to 0 and looks
		// like a bounce.
		requestAnimationFrame(() => {
			setDragging(false);
		});
	};

	const commitTab = (signedDelta: number) => {
		const direction = signedDelta > 0 ? 1 : -1;
		const currentIndex = props.order.indexOf(props.value());
		const nextTab = props.order[currentIndex + direction];
		if (nextTab) {
			props.onChange(nextTab);
		}
	};

	const handleWheel = (event: WheelEvent) => {
		const now = performance.now();
		const priorAxisXSign = Math.sign(axisX.lastSignedDelta);
		const xClass = classifyAxis(axisX, event.deltaX, now);
		const yClass = classifyAxis(axisY, event.deltaY, now);
		// Update per-axis history for the next event regardless of how
		// we route this one.
		if (xClass !== "idle") {
			axisX.lastT = now;
			axisX.lastSignedDelta = event.deltaX;
			if (xClass === "user") {
				lastUserInputXT = now;
			}
		}
		if (yClass !== "idle") {
			axisY.lastT = now;
			axisY.lastSignedDelta = event.deltaY;
			if (yClass === "user") {
				lastUserInputYT = now;
			}
		}

		// Burst-end detection: a quiet gap or a direction flip ends the
		// current gesture burst, releasing the one-commit-per-burst lock.
		const gapSinceLast = lastEventT === 0 ? Infinity : now - lastEventT;
		lastEventT = now;
		const eventXSign = Math.sign(event.deltaX);
		const directionFlipped =
			xClass === "user" &&
			priorAxisXSign !== 0 &&
			eventXSign !== 0 &&
			eventXSign !== priorAxisXSign;
		if (gapSinceLast > GESTURE_BURST_GAP_MS || directionFlipped) {
			gestureCommitted = false;
			postCommitSawDecay = false;
		}

		// One commit per burst: after we've changed a tab, swallow the
		// rest of the same physical flick (including its inertial X tail)
		// until the burst ends.
		if (gestureCommitted) {
			// Track whether we've seen any inertia decay since the commit.
			// Without prior decay, "growing" events are just the still-
			// accelerating phase of the same flick and must stay locked.
			// Once we've seen decay, growth means a fresh user gesture.
			if (xClass === "inertia") {
				postCommitSawDecay = true;
			}
			const releaseLock =
				xClass === "user" &&
				postCommitSawDecay &&
				now - commitT > POST_COMMIT_MIN_HOLD_MS;
			if (!releaseLock) {
				if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
					event.preventDefault();
				}
				return;
			}
			gestureCommitted = false;
			postCommitSawDecay = false;
		}

		// If we're already actively dragging, every X event drives the
		// offset — including inertial X tail of the user's own ongoing
		// flick — so the visual stays smooth. We commit the moment the
		// accumulator crosses the threshold; subsequent inertia events
		// after commit get classified as inertia and will be ignored by
		// the probe gate the next time around (post-endWheelGesture).
		if (wheelActive) {
			event.preventDefault();
			wheelAccumX += event.deltaX;
			updateOffset(-wheelAccumX);
			if (Math.abs(wheelAccumX) >= WHEEL_COMMIT_THRESHOLD) {
				commitTab(wheelAccumX);
				gestureCommitted = true;
				postCommitSawDecay = false;
				commitT = now;
				endWheelGesture();
				return;
			}
			armWheelEndTimer(endWheelGesture);
			return;
		}

		// Drop stale probe contributions if the user has paused.
		if (
			wheelProbeX !== 0 &&
			lastUserInputXT > 0 &&
			now - lastUserInputXT > PROBE_STALENESS_MS
		) {
			wheelProbeX = 0;
		}
		if (
			wheelProbeY !== 0 &&
			lastUserInputYT > 0 &&
			now - lastUserInputYT > PROBE_STALENESS_MS
		) {
			wheelProbeY = 0;
		}

		// Only user-input contributes to the probe. Inertia X (after a
		// previous swipe) and inertia Y (settling after vertical scroll)
		// pass through to native scroll without polluting the probe.
		if (xClass === "user") {
			wheelProbeX += event.deltaX;
		}
		if (yClass === "user") {
			wheelProbeY += event.deltaY;
		}

		const absSignedX = Math.abs(wheelProbeX);
		const absSignedY = Math.abs(wheelProbeY);
		const horizontalDominant =
			absSignedX >= WHEEL_PROBE_MIN_SIGNED_X && absSignedX >= absSignedY;
		const verticalDominant =
			absSignedY >= WHEEL_PROBE_MIN_SIGNED_Y && absSignedY > absSignedX;

		if (verticalDominant) {
			wheelProbeX = 0;
			wheelProbeY = 0;
			return;
		}

		if (!horizontalDominant) {
			// Keep probe armed; let native scroll do its thing for now.
			if (xClass === "user" || yClass === "user") {
				armWheelEndTimer(endWheelGesture);
			}
			return;
		}

		event.preventDefault();
		wheelActive = true;
		setDragging(true);
		wheelAccumX = wheelProbeX;
		updateOffset(-wheelAccumX);
		if (Math.abs(wheelAccumX) >= WHEEL_COMMIT_THRESHOLD) {
			commitTab(wheelAccumX);
			gestureCommitted = true;
			postCommitSawDecay = false;
			commitT = now;
			endWheelGesture();
			return;
		}
		armWheelEndTimer(endWheelGesture);
	};

	const handleTouchEnd = (event: TouchEvent) => {
		if (!start) {
			return;
		}
		const touch = event.changedTouches[0];
		if (!touch) {
			return;
		}
		const deltaX = touch.clientX - start.x;
		const deltaY = touch.clientY - start.y;
		start = null;

		if (axis === "pull") {
			finishPull(deltaY);
		}

		finishSwipe(deltaX, deltaY);
	};

	let containerRef: HTMLDivElement | undefined;
	let scrollRef: HTMLDivElement | undefined;

	onMount(() => {
		const node = scrollRef;
		if (!node) {
			return;
		}
		const prefersTouch = "ontouchstart" in window;
		const supportsPointer = !prefersTouch && "PointerEvent" in window;
		if (supportsPointer) {
			node.addEventListener("pointerdown", handlePointerStart, {
				passive: true,
			});
			node.addEventListener("pointermove", handlePointerMove, {
				passive: false,
			});
			node.addEventListener("pointerup", handlePointerEnd, { passive: true });
			node.addEventListener("pointercancel", handlePointerEnd, {
				passive: true,
			});
		} else {
			node.addEventListener("touchstart", handleTouchStart, {
				passive: true,
			});
			node.addEventListener("touchmove", handleTouchMove, { passive: false });
			node.addEventListener("touchend", handleTouchEnd, { passive: true });
			node.addEventListener("touchcancel", handleTouchEnd, {
				passive: true,
			});
		}
		node.addEventListener("wheel", handleWheel, { passive: false });

		onCleanup(() => {
			if (supportsPointer) {
				node.removeEventListener("pointerdown", handlePointerStart);
				node.removeEventListener("pointermove", handlePointerMove);
				node.removeEventListener("pointerup", handlePointerEnd);
				node.removeEventListener("pointercancel", handlePointerEnd);
			} else {
				node.removeEventListener("touchstart", handleTouchStart);
				node.removeEventListener("touchmove", handleTouchMove);
				node.removeEventListener("touchend", handleTouchEnd);
				node.removeEventListener("touchcancel", handleTouchEnd);
			}
			node.removeEventListener("wheel", handleWheel);
		});
	});

	onCleanup(() => {
		if (frame) {
			window.cancelAnimationFrame(frame);
		}
		if (wheelEndTimer !== undefined) {
			window.clearTimeout(wheelEndTimer);
		}
	});

	return (
		<div class="swipeable-tabs-wrapper">
			<PullIndicator
				visible={showIndicator}
				flipped={indicatorFlipped}
				loading={isRefreshing}
			/>
			<div
				ref={containerRef}
				class={`swipeable-tabs${dragging() ? " is-dragging" : ""}${pullTransition() ? " is-pull-transitioning" : ""}`}
				style={{
					transform: `translateX(${offset()}px) translateY(${currentPullOffset()}px)`,
				}}
				onTransitionEnd={handleTransitionEnd}
			>
				<div ref={scrollRef} class="swipeable-tabs-scroll">
					{props.children}
				</div>
			</div>
		</div>
	);
}
