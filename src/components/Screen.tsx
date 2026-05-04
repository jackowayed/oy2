import type { JSX } from "solid-js";
import "./Screen.css";

type ScreenProps = {
	children: JSX.Element;
	size?: "default" | "wide";
};

export function Screen(props: ScreenProps) {
	return (
		<div class="app-screen">
			<div
				class={`app-container ${
					props.size === "wide" ? "app-container-wide" : ""
				}`.trim()}
			>
				{props.children}
			</div>
		</div>
	);
}
