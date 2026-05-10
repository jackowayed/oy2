import { Capacitor } from "@capacitor/core";
import { Geolocation as CapacitorGeolocation } from "@capacitor/geolocation";
import { Button } from "@kobalte/core/button";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { Oy, OyPayload } from "../types";
import {
	calculateDistance,
	formatAltitude,
	formatSpeed,
	formatTime,
	onAppVisible,
	openMapsDeepLink,
} from "../utils";
import { LocationMap } from "./LocationMap";
import "./OysList.css";

type OysListProps = {
	oys: Oy[];
	currentUserId: number;
	openLocations: () => Set<number>;
	onToggleLocation: (oyId: number) => void;
	hasMore: () => boolean;
	loadingMore: () => boolean;
	loading: () => boolean;
	onLoadMore: () => void;
};

export function OysList(props: OysListProps) {
	const [timeTick, setTimeTick] = createSignal(Date.now());
	const [myLocation, setMyLocation] = createSignal<{
		lat: number;
		lon: number;
	} | null>(null);

	const intervalId = window.setInterval(() => {
		setTimeTick(Date.now());
	}, 60000);
	onCleanup(() => window.clearInterval(intervalId));
	onCleanup(onAppVisible(() => setTimeTick(Date.now())));

	let sentinel: HTMLDivElement | undefined;
	const setSentinel = (el: HTMLDivElement) => {
		sentinel = el;
	};

	onMount(() => {
		const getCurrentLocation = async () => {
			try {
				if (Capacitor.isNativePlatform()) {
					if (!Capacitor.isPluginAvailable("Geolocation")) {
						throw new Error("Native geolocation plugin unavailable");
					}

					const position = await CapacitorGeolocation.getCurrentPosition();
					setMyLocation({
						lat: position.coords.latitude,
						lon: position.coords.longitude,
					});
					return;
				}

				if (!("geolocation" in navigator)) {
					return;
				}

				navigator.geolocation.getCurrentPosition(
					(position) => {
						setMyLocation({
							lat: position.coords.latitude,
							lon: position.coords.longitude,
						});
					},
					(err) => {
						console.warn("Geolocation failed:", err);
					},
				);
			} catch (err) {
				console.warn("Geolocation failed:", err);
			}
		};

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries[0]?.isIntersecting && props.hasMore()) {
					props.onLoadMore();
				}
			},
			{ rootMargin: "200px" },
		);

		if (sentinel) {
			observer.observe(sentinel);
		}

		void getCurrentLocation();

		onCleanup(() => {
			observer.disconnect();
		});
	});

	const formatRelativeTime = (timestamp: number) => {
		timeTick();
		return formatTime(timestamp);
	};
	const displayName = (username: string, nickname: string | null) =>
		nickname ? `${username} (${nickname})` : username;

	return (
		<div class="oys-list stack">
			<Show
				when={props.oys.length > 0}
				fallback={
					<p class="oys-empty-state empty-state">
						{props.loading() ? "Loading Oys..." : "No Oys yet!"}
					</p>
				}
			>
				<For each={props.oys}>
					{(oy) => {
						const isLocation = oy.type === "lo" && !!oy.payload;
						const payload = oy.payload as OyPayload;
						const isOutbound = oy.from_user_id === props.currentUserId;
						const title = isOutbound
							? isLocation
								? `Lo to ${displayName(oy.to_username, oy.counterpart_nickname)}`
								: `Oy to ${displayName(oy.to_username, oy.counterpart_nickname)}`
							: isLocation
								? `Lo from ${displayName(oy.from_username, oy.counterpart_nickname)}`
								: `Oy from ${displayName(oy.from_username, oy.counterpart_nickname)}`;

						const location = myLocation();
						const distance =
							isLocation && location
								? calculateDistance(
										location.lat,
										location.lon,
										payload.lat,
										payload.lon,
									)
								: null;

						const subtitleParts: string[] = [];
						if (isLocation && payload?.city) {
							subtitleParts.push(payload.city);
						}
						subtitleParts.push(formatRelativeTime(oy.created_at));
						if (distance) {
							subtitleParts.push(`${distance} away`);
						}
						// Altitude is reported relative to the WGS84 ellipsoid, which
						// deviates from sea level by up to ~100m; GPS vertical noise adds
						// another ~20-50m. A 250m floor clears that band so a phone at the
						// beach doesn't randomly show "100m up", while still catching
						// mountain towns (Denver ~1600m) and ski lifts. The altitudeAccuracy
						// filter excludes Wi-Fi/IP-derived fixes, which typically have null
						// or huge accuracy values.
						if (
							isLocation &&
							payload?.altitude != null &&
							payload.altitude > 250 &&
							payload.altitudeAccuracy != null &&
							payload.altitudeAccuracy < 50
						) {
							subtitleParts.push(formatAltitude(payload.altitude));
						}
						// GPS reports spurious speeds of 0-2 m/s when stationary. A 2.5 m/s
						// (~9 km/h) floor cuts that noise while still showing joggers,
						// cyclists, cars, and trains. Brisk walking (~1.4 m/s) is excluded.
						if (isLocation && payload?.speed != null && payload.speed > 2.5) {
							subtitleParts.push(formatSpeed(payload.speed));
						}
						const subtitle = subtitleParts.join(" · ");
						const isOpen = () => props.openLocations().has(oy.id);

						return (
							<Button
								class={`oys-list-item card${
									isLocation ? " oys-list-item-location" : ""
								}${isOutbound ? " oys-list-item-outbound" : " oys-list-item-inbound"}`}
								onClick={() => isLocation && props.onToggleLocation(oy.id)}
								data-oy-id={oy.id}
								aria-expanded={isLocation ? isOpen() : undefined}
								disabled={!isLocation}
							>
								<div class="oys-list-item-content stack stack-sm">
									<div
										class={`oys-list-item-header${isLocation ? " oys-list-item-header-location" : ""}`}
									>
										<div class="oys-list-item-text stack stack-sm">
											<div class="oys-list-item-title item-title">{title}</div>
											<div class="oys-list-item-subtitle item-subtitle">
												{subtitle}
											</div>
										</div>
										<Show when={isLocation}>
											<div class="oys-list-item-toggle-slot">
												<span class="oys-location-toggle">
													<span class="oys-location-button">
														<span
															class={`oys-location-arrow${
																isOpen() ? " is-open" : ""
															}`}
														/>
													</span>
												</span>
											</div>
										</Show>
									</div>
									<Show when={isLocation}>
										{/* biome-ignore lint/a11y/noStaticElementInteractions: nested inside the parent oy card button */}
										{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation toggles the panel via the parent oy card button */}
										<div
											class="oys-list-item-map-slot"
											onClick={(event) => {
												event.stopPropagation();
												openMapsDeepLink(payload.lat, payload.lon);
											}}
										>
											<div
												class={`oys-location-panel${isOpen() ? " open" : ""}`}
											>
												<LocationMap
													lat={payload.lat}
													lon={payload.lon}
													open={isOpen()}
												/>
											</div>
										</div>
									</Show>
								</div>
							</Button>
						);
					}}
				</For>
			</Show>
			<Show when={props.hasMore()}>
				<div class="oys-list-footer" ref={setSentinel}>
					<span class="oys-list-footer-text">
						{props.loadingMore() ? "Loading more..." : "Scroll for more"}
					</span>
				</div>
			</Show>
		</div>
	);
}
