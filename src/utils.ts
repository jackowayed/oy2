import { Capacitor } from "@capacitor/core";

const nativeApiOrigin = Capacitor.DEBUG
	? "https://dev.oyme.site"
	: "https://oyme.site";

export function resolveApiUrl(path: string): string {
	if (Capacitor.isNativePlatform() && path.startsWith("/api/")) {
		return `${nativeApiOrigin}${path}`;
	}
	return path;
}

const NATIVE_SESSION_TOKEN_KEY = "native_session_token";

export function setNativeSessionToken(token: string | null): void {
	if (!Capacitor.isNativePlatform()) return;
	if (token) {
		localStorage.setItem(NATIVE_SESSION_TOKEN_KEY, token);
	} else {
		localStorage.removeItem(NATIVE_SESSION_TOKEN_KEY);
	}
}

export function getNativeSessionToken(): string | null {
	if (!Capacitor.isNativePlatform()) return null;
	return localStorage.getItem(NATIVE_SESSION_TOKEN_KEY);
}

const OAUTH_PENDING_ID_KEY = "oauth_pending_id";

export function setOauthPendingId(id: string | null): void {
	if (id) {
		sessionStorage.setItem(OAUTH_PENDING_ID_KEY, id);
	} else {
		sessionStorage.removeItem(OAUTH_PENDING_ID_KEY);
	}
}

export function getOauthPendingId(): string | null {
	return sessionStorage.getItem(OAUTH_PENDING_ID_KEY);
}

const EMAIL_PENDING_ID_KEY = "email_pending_id";

export function setEmailPendingId(id: string | null): void {
	if (id) {
		sessionStorage.setItem(EMAIL_PENDING_ID_KEY, id);
	} else {
		sessionStorage.removeItem(EMAIL_PENDING_ID_KEY);
	}
}

export function getEmailPendingId(): string | null {
	return sessionStorage.getItem(EMAIL_PENDING_ID_KEY);
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
	const url = resolveApiUrl(path);
	if (Capacitor.isNativePlatform() && path.startsWith("/api/")) {
		const token = getNativeSessionToken();
		if (token) {
			const headers = new Headers(init?.headers);
			if (!headers.has("Authorization")) {
				headers.set("Authorization", `Bearer ${token}`);
			}
			return fetch(url, { ...init, headers });
		}
	}
	return fetch(url, init);
}

export function urlBase64ToUint8Array(base64String: string) {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const rawData = window.atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; ++i) {
		outputArray[i] = rawData.charCodeAt(i);
	}
	return outputArray;
}

export function formatTime(timestamp: number) {
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;

	if (diff < 60) return "Just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

export function onAppVisible(callback: () => void) {
	const handleVisibility = () => {
		if (document.visibilityState === "visible") {
			callback();
		}
	};

	document.addEventListener("visibilitychange", handleVisibility);
	window.addEventListener("focus", handleVisibility);

	return () => {
		document.removeEventListener("visibilitychange", handleVisibility);
		window.removeEventListener("focus", handleVisibility);
	};
}

const UNITS_KEY = "use_imperial";

export function getUseImperial(): boolean {
	return localStorage.getItem(UNITS_KEY) === "1";
}

export function setUseImperial(imperial: boolean): void {
	if (imperial) {
		localStorage.setItem(UNITS_KEY, "1");
	} else {
		localStorage.removeItem(UNITS_KEY);
	}
}

export function calculateDistance(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
	imperial = false,
): string {
	const R = 6371; // Radius of the earth in km
	const dLat = deg2rad(lat2 - lat1);
	const dLon = deg2rad(lon2 - lon1);
	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(deg2rad(lat1)) *
			Math.cos(deg2rad(lat2)) *
			Math.sin(dLon / 2) *
			Math.sin(dLon / 2);
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	const d = R * c; // Distance in km

	const fmtDecimal = (n: number) =>
		n.toLocaleString(undefined, {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		});
	const fmtInt = (n: number) => Math.round(n).toLocaleString();

	if (imperial) {
		const miles = d * 0.621371;
		if (miles < 0.1) {
			return `${fmtInt(miles * 5280)}ft`;
		}
		return `${fmtDecimal(miles)}mi`;
	}
	if (d < 1) {
		return `${fmtInt(d * 1000)}m`;
	}
	return `${fmtDecimal(d)}km`;
}

function deg2rad(deg: number) {
	return deg * (Math.PI / 180);
}

export function formatAltitude(meters: number, imperial = false): string {
	const fmtDecimal = (n: number) =>
		n.toLocaleString(undefined, {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		});
	const fmtInt = (n: number) => Math.round(n).toLocaleString();

	if (imperial) {
		const feet = meters * 3.28084;
		if (feet < 5280) {
			return `${fmtInt(Math.round(feet / 10) * 10)}ft up`;
		}
		return `${fmtDecimal(feet / 5280)}mi up`;
	}
	if (meters < 1000) {
		return `${fmtInt(Math.round(meters / 10) * 10)}m up`;
	}
	return `${fmtDecimal(meters / 1000)}km up`;
}

export function formatSpeed(metersPerSecond: number, imperial = false): string {
	if (imperial) {
		return `${Math.round(metersPerSecond * 2.23694).toLocaleString()}mph`;
	}
	return `${Math.round(metersPerSecond * 3.6).toLocaleString()}km/h`;
}

export function buildMapsDeepLink(lat: number, lon: number): string {
	const platform = Capacitor.getPlatform();
	if (platform === "ios") {
		return `maps://?ll=${lat},${lon}&q=${lat},${lon}`;
	}
	if (platform === "android") {
		return `geo:${lat},${lon}?q=${lat},${lon}`;
	}
	return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
}

export function openMapsDeepLink(lat: number, lon: number): void {
	const url = buildMapsDeepLink(lat, lon);
	window.open(url, "_blank", "noopener,noreferrer");
}
