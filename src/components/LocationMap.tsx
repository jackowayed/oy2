import { createEffect } from "solid-js";
import type { LoHistoryPoint } from "../map";
import { initLocationMap } from "../map";
import "./LocationMap.css";

type LocationMapProps = {
	lat: number;
	lon: number;
	open: boolean;
	history?: LoHistoryPoint[];
};

export function LocationMap(props: LocationMapProps) {
	let container: HTMLDivElement | undefined;

	createEffect(() => {
		if (props.open && container) {
			initLocationMap(container, props.lat, props.lon, props.history);
		}
	});

	return (
		<div
			class="oys-location-map"
			ref={(el) => {
				container = el as HTMLDivElement;
			}}
			role="presentation"
		/>
	);
}
