import { Button } from "@kobalte/core/button";
import { A } from "@solidjs/router";
import { createSignal, onCleanup } from "solid-js";
import { appLogoText } from "../branding";
import type { User } from "../types";
import "./ButtonStyles.css";
import "./AppHeader.css";

const SECRET_TAP_COUNT = 5;
const SECRET_TAP_WINDOW_MS = 3000;

type AppHeaderProps = {
	class?: string;
	backHref?: string;
	onSecretTap?: () => void;
} & (
	| {
			user: User;
			onLogout: () => void;
	  }
	| {
			user?: undefined;
			onLogout?: undefined;
	  }
);

export function AppHeader(props: AppHeaderProps) {
	const [menuOpen, setMenuOpen] = createSignal(false);
	const hasBackLink = Boolean(props.backHref);
	const backHref = props.backHref ?? "/";
	let tapCount = 0;
	let tapTimeoutId: number | undefined;

	const onTitleTap = () => {
		const onSecretTap = props.onSecretTap;
		if (!onSecretTap) {
			return;
		}
		window.clearTimeout(tapTimeoutId);
		tapCount += 1;
		if (tapCount >= SECRET_TAP_COUNT) {
			tapCount = 0;
			onSecretTap();
			return;
		}
		tapTimeoutId = window.setTimeout(() => {
			tapCount = 0;
		}, SECRET_TAP_WINDOW_MS);
	};
	onCleanup(() => window.clearTimeout(tapTimeoutId));

	return (
		<div class={`app-header ${props.class ?? ""}`.trim()}>
			<div
				class={`app-header-row ${hasBackLink ? "app-header-row-back" : ""}`.trim()}
			>
				{hasBackLink ? (
					<A class="app-back-link" href={backHref}>
						<span aria-hidden="true">←</span>
						<span>Back</span>
					</A>
				) : null}
				<h1 class="app-title">
					<button class="app-title-tap" type="button" onClick={onTitleTap}>
						{appLogoText}
					</button>
				</h1>
				{props.user ? (
					<button
						class="app-user-trigger"
						type="button"
						onClick={() => setMenuOpen((open) => !open)}
					>
						{props.user.username}
					</button>
				) : null}
			</div>
			{props.user && menuOpen() ? (
				<div class="app-user-panel">
					{props.user.admin ? (
						<A class="app-user-action" href="/admin">
							Admin
						</A>
					) : null}
					<A class="app-user-action" href="/settings">
						Settings
					</A>
					<A class="app-user-action" href="/legal">
						Legal
					</A>
					<Button class="app-user-action" onClick={props.onLogout}>
						Logout
					</Button>
				</div>
			) : null}
		</div>
	);
}
