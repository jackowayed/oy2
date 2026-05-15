import { Button } from "@kobalte/core/button";
import { For, type JSX, onMount, Show } from "solid-js";
import { appLogoText } from "../branding";
import { Screen } from "./Screen";
import "./ButtonStyles.css";
import "./FormControls.css";
import "./LoginScreen.css";
import "./VerifyCodeScreen.css";

type VerifyCodeScreenProps = {
	title: string;
	subtitle?: string;
	value: string;
	onValueChange: (value: string) => void;
	onSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent>;
	error?: string | null;
	loading?: boolean;
	submitLabel?: string;
	footer?: JSX.Element;
};

export function VerifyCodeScreen(props: VerifyCodeScreenProps) {
	let formRef: HTMLFormElement | undefined;
	let inputRef: HTMLInputElement | undefined;

	onMount(() => {
		inputRef?.focus();
	});

	const setInputSelectionToEnd = (input: HTMLInputElement) => {
		const end = input.value.length;
		input.setSelectionRange(end, end);
	};

	const handleInput: JSX.EventHandler<HTMLInputElement, InputEvent> = (
		event,
	) => {
		const nextValue = event.currentTarget.value.replace(/\D/g, "").slice(0, 6);
		event.currentTarget.value = nextValue;
		props.onValueChange(nextValue);
		setInputSelectionToEnd(event.currentTarget);
		if (nextValue.length === 6) {
			formRef?.requestSubmit();
		}
	};

	const handleKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent> = (
		event,
	) => {
		if (event.key !== "Backspace" && event.key !== "Delete") {
			return;
		}

		event.preventDefault();
		const input = event.currentTarget;
		const value = props.value;
		const selectionStart = input.selectionStart ?? value.length;
		const selectionEnd = input.selectionEnd ?? selectionStart;
		const hasSelection = selectionEnd > selectionStart;
		let nextValue = value;
		let nextSelection = selectionStart;

		if (hasSelection) {
			nextValue = value.slice(0, selectionStart) + value.slice(selectionEnd);
		} else if (event.key === "Backspace") {
			const removeIndex =
				selectionStart > 0 ? selectionStart - 1 : value.length - 1;
			if (removeIndex >= 0) {
				nextValue = value.slice(0, removeIndex) + value.slice(removeIndex + 1);
				nextSelection = removeIndex;
			}
		} else {
			const removeIndex =
				selectionStart < value.length ? selectionStart : value.length - 1;
			if (removeIndex >= 0) {
				nextValue = value.slice(0, removeIndex) + value.slice(removeIndex + 1);
				nextSelection = removeIndex;
			}
		}

		input.value = nextValue;
		props.onValueChange(nextValue);
		queueMicrotask(() => {
			const clampedSelection = Math.min(nextSelection, nextValue.length);
			input.setSelectionRange(clampedSelection, clampedSelection);
		});
	};

	const activeIndex = () => Math.min(props.value.length, 5);
	const submitText = () =>
		props.loading ? "Verifying..." : (props.submitLabel ?? "Verify");

	return (
		<Screen>
			<h1 class="login-logo">{appLogoText}</h1>
			<p class="login-tagline">{props.title}</p>
			<Show when={props.subtitle}>
				{(subtitle) => (
					<p class="login-tagline login-tagline-secondary">{subtitle()}</p>
				)}
			</Show>
			<form onSubmit={props.onSubmit} ref={formRef}>
				<div class="otp-field">
					<input
						type="text"
						name="otp"
						ref={inputRef}
						autocomplete="one-time-code"
						inputmode="numeric"
						maxlength={6}
						autofocus
						required
						class="otp-input"
						value={props.value}
						onFocus={(event) => setInputSelectionToEnd(event.currentTarget)}
						onClick={(event) => setInputSelectionToEnd(event.currentTarget)}
						onInput={handleInput}
						onKeyDown={handleKeyDown}
						aria-label="Verification code"
						disabled={props.loading}
					/>
					<div class="otp-boxes" aria-hidden="true">
						<For each={[0, 1, 2, 3, 4, 5]}>
							{(index) => (
								<span
									class="otp-box"
									classList={{
										"otp-box-filled": index < props.value.length,
										"otp-box-active": index === activeIndex(),
									}}
								>
									{props.value[index] || ""}
								</span>
							)}
						</For>
					</div>
				</div>
				<Show when={props.error}>
					{(error) => <p class="form-error">{error()}</p>}
				</Show>
				<Button type="submit" class="btn-primary" disabled={props.loading}>
					{submitText()}
				</Button>
			</form>
			<Show when={props.footer}>{(footer) => footer()}</Show>
		</Screen>
	);
}
