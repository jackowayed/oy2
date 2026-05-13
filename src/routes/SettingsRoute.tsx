import { onCleanup, onMount } from "solid-js";
import { useAppContext } from "../AppContext";
import { AppHeader } from "../components/AppHeader";
import { Screen } from "../components/Screen";
import { SettingsScreen } from "../components/SettingsScreen";
import type { User } from "../types";

export function SettingsRoute() {
	const {
		currentUser,
		logout,
		deleteAccount,
		handleSetupNotifications,
		api,
		useImperial,
		setUseImperial,
	} = useAppContext();
	const user = () => currentUser() as User;

	onMount(() => {
		const previousTitle = document.title;
		document.title = "Settings - Oy";
		onCleanup(() => {
			document.title = previousTitle;
		});
	});

	return (
		<Screen>
			<AppHeader backHref="/" user={user()} onLogout={logout} />
			<SettingsScreen
				user={user()}
				useImperial={useImperial()}
				onSetUseImperial={setUseImperial}
				onSetupNotifications={handleSetupNotifications}
				onDeleteAccount={deleteAccount}
				api={api}
			/>
		</Screen>
	);
}
