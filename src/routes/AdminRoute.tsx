import { useAppContext } from "../AppContext";
import { AdminDashboard } from "../components/AdminDashboard";
import { AppHeader } from "../components/AppHeader";
import { Screen } from "../components/Screen";
import type { User } from "../types";

export function AdminRoute() {
	const { currentUser, api, logout } = useAppContext();
	const user = () => currentUser() as User;

	return (
		<Screen size="wide">
			<AppHeader backHref="/" user={user()} onLogout={logout} />
			<AdminDashboard user={user()} api={api} />
		</Screen>
	);
}
