import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCookieValue, getSessionToken, request } from "./testHelpers";
import { createTestEnv, seedPasskey, seedUser } from "./testUtils";

function encodeBase64Url(input: string | Uint8Array): string {
	const bytes =
		typeof input === "string" ? new TextEncoder().encode(input) : input;
	return Buffer.from(bytes)
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function createAppleIdToken({
	privateKey,
	sub,
	email,
	aud,
	kid,
}: {
	privateKey: CryptoKey;
	sub: string;
	email?: string;
	aud: string;
	kid: string;
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = encodeBase64Url(JSON.stringify({ alg: "RS256", kid }));
	const payload = encodeBase64Url(
		JSON.stringify({
			iss: "https://appleid.apple.com",
			aud,
			sub,
			email,
			exp: now + 3600,
			iat: now,
		}),
	);
	const signingInput = `${header}.${payload}`;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

describe("oauth", () => {
	it("starts google oauth with state in KV", async () => {
		const { env, kv } = createTestEnv();
		const res = await request(env, "/api/auth/oauth/google");
		assert.equal(res.status, 302);
		const location = res.headers.get("location");
		assert.ok(location);
		const url = new URL(location ?? "");
		const state = url.searchParams.get("state");
		assert.ok(state);
		const stored = await kv.get(`oauth_state:${state}`);
		assert.ok(stored);
	});

	it("handles google callbacks for existing users", async (t) => {
		const { env, kv, db } = createTestEnv();
		const user = seedUser(db, {
			username: "OAuthUser",
			oauthProvider: "google",
			oauthSub: "sub-123",
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "https://oauth2.googleapis.com/token") {
				return {
					ok: true,
					json: async () => ({ id_token: "token-123" }),
				} as Response;
			}
			if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
				return {
					ok: true,
					json: async () => ({
						aud: env.GOOGLE_CLIENT_ID,
						sub: "sub-123",
						email: "oauth@example.com",
					}),
				} as Response;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const startRes = await request(env, "/api/auth/oauth/google");
		const startLocation = startRes.headers.get("location") ?? "";
		const state = new URL(startLocation).searchParams.get("state") ?? "";

		const res = await request(
			env,
			`/api/auth/oauth/callback?state=${state}&code=auth-code`,
		);
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), "/?passkey_setup=1");
		assert.ok(getSessionToken(res));
		assert.equal(db.sessions.length, 1);
		assert.equal(db.sessions[0].user_id, user.id);
		assert.equal(await kv.get(`oauth_state:${state}`), null);
	});

	it("authenticates existing users with native apple sign-in", async (t) => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, {
			username: "appleuser",
			oauthProvider: "apple",
			oauthSub: "apple-sub-123",
		});

		const { publicKey, privateKey } = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
		jwk.kid = "apple-test-kid";
		const token = await createAppleIdToken({
			privateKey,
			sub: "apple-sub-123",
			email: "apple@example.com",
			aud: env.APPLE_NATIVE_CLIENT_ID ?? env.APPLE_CLIENT_ID,
			kid: String(jwk.kid),
		});

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "https://appleid.apple.com/auth/keys") {
				return {
					ok: true,
					json: async () => ({ keys: [jwk] }),
				} as Response;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const res = await request(env, "/api/auth/oauth/apple/native", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ idToken: token }),
		});

		assert.equal(res.status, 200);
		const body = (await res.json()) as { needsPasskeySetup: boolean };
		assert.equal(body.needsPasskeySetup, true);
		assert.ok(getSessionToken(res));
		assert.equal(db.sessions.length, 1);
		assert.equal(db.sessions[0].user_id, user.id);
	});

	it("authenticates native google sign-in with an iOS client audience", async (t) => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, {
			username: "googleiosuser",
			oauthProvider: "google",
			oauthSub: "google-ios-sub-123",
		});

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
				return {
					ok: true,
					json: async () => ({
						aud: env.GOOGLE_IOS_CLIENT_ID,
						sub: "google-ios-sub-123",
						email: "google-ios@example.com",
					}),
				} as Response;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const res = await request(env, "/api/auth/oauth/google/native", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ idToken: "ios-id-token" }),
		});

		assert.equal(res.status, 200);
		const body = (await res.json()) as { needsPasskeySetup: boolean };
		assert.equal(body.needsPasskeySetup, true);
		assert.ok(getSessionToken(res));
		assert.equal(db.sessions.length, 1);
		assert.equal(db.sessions[0].user_id, user.id);
	});

	it("rejects native apple sign-in when token audience is web client id", async (t) => {
		const { env, db } = createTestEnv();
		seedUser(db, {
			username: "appleuser2",
			oauthProvider: "apple",
			oauthSub: "apple-sub-999",
		});

		const { publicKey, privateKey } = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
		jwk.kid = "apple-test-kid-web-aud";
		const token = await createAppleIdToken({
			privateKey,
			sub: "apple-sub-999",
			email: "apple2@example.com",
			aud: env.APPLE_CLIENT_ID,
			kid: String(jwk.kid),
		});

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "https://appleid.apple.com/auth/keys") {
				return {
					ok: true,
					json: async () => ({ keys: [jwk] }),
				} as Response;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const res = await request(env, "/api/auth/oauth/apple/native", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ idToken: token }),
		});

		assert.equal(res.status, 401);
		const body = (await res.json()) as { error: string };
		assert.equal(body.error, "Invalid ID token");
		assert.equal(db.sessions.length, 0);
	});

	it("creates pending apple oauth state when native apple login needs username", async (t) => {
		const { env, kv } = createTestEnv();

		const { publicKey, privateKey } = await crypto.subtle.generateKey(
			{
				name: "RSASSA-PKCS1-v1_5",
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: "SHA-256",
			},
			true,
			["sign", "verify"],
		);
		const jwk = (await crypto.subtle.exportKey("jwk", publicKey)) as JsonWebKey;
		jwk.kid = "apple-test-kid-2";
		const token = await createAppleIdToken({
			privateKey,
			sub: "apple-sub-new",
			email: "new-apple@example.com",
			aud: env.APPLE_NATIVE_CLIENT_ID ?? env.APPLE_CLIENT_ID,
			kid: String(jwk.kid),
		});

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "https://appleid.apple.com/auth/keys") {
				return {
					ok: true,
					json: async () => ({ keys: [jwk] }),
				} as Response;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		};
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const res = await request(env, "/api/auth/oauth/apple/native", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				idToken: token,
				name: "Native Apple User",
			}),
		});

		assert.equal(res.status, 200);
		const body = (await res.json()) as { needsUsername: boolean };
		assert.equal(body.needsUsername, true);
		const pendingId = getCookieValue(res, "oauth_pending");
		assert.ok(pendingId);
		const pending = await kv.get(`oauth_pending:${pendingId}`);
		assert.ok(pending);
		assert.match(String(pending), /"provider":"apple"/);
		assert.match(String(pending), /"name":"Native Apple User"/);
	});

	it("claims placeholder users during oauth completion", async () => {
		const { env, kv, db } = createTestEnv();
		const user = seedUser(db, { username: "Placeholder" });
		await kv.put(
			"oauth_pending:pending-claim",
			JSON.stringify({
				provider: "google",
				sub: "google-sub-claim",
				email: "claim@example.com",
			}),
		);

		const res = await request(env, "/api/auth/oauth/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-oauth-pending": "pending-claim",
			},
			body: JSON.stringify({ username: "Placeholder" }),
		});

		assert.equal(res.status, 200);
		const body = (await res.json()) as { claimed: boolean };
		assert.equal(body.claimed, true);
		assert.equal(user.oauth_provider, "google");
		assert.equal(user.oauth_sub, "google-sub-claim");
		assert.equal(user.email, "claim@example.com");
		assert.equal(db.sessions.length, 1);
		assert.equal(await kv.get("oauth_pending:pending-claim"), null);
	});

	it("claims email-linked users during oauth completion when oauth email matches", async () => {
		const { env, kv, db } = createTestEnv();
		const user = seedUser(db, {
			username: "EmailLinked",
			email: "Existing@Example.com",
		});
		await kv.put(
			"oauth_pending:pending-email-linked",
			JSON.stringify({
				provider: "google",
				sub: "google-sub-email-linked",
				email: "existing@example.com",
			}),
		);

		const res = await request(env, "/api/auth/oauth/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-oauth-pending": "pending-email-linked",
			},
			body: JSON.stringify({ username: "EmailLinked" }),
		});

		assert.equal(res.status, 200);
		const body = (await res.json()) as { claimed: boolean };
		assert.equal(body.claimed, true);
		assert.equal(user.oauth_provider, "google");
		assert.equal(user.oauth_sub, "google-sub-email-linked");
		assert.equal(user.email, "Existing@Example.com");
		assert.equal(db.sessions.length, 1);
		assert.equal(await kv.get("oauth_pending:pending-email-linked"), null);
	});

	it("rejects email-linked users during oauth completion when oauth email differs", async () => {
		const { env, kv, db } = createTestEnv();
		const user = seedUser(db, {
			username: "EmailLinked",
			email: "existing@example.com",
		});
		await kv.put(
			"oauth_pending:pending-email-linked",
			JSON.stringify({
				provider: "google",
				sub: "google-sub-email-linked",
				email: "new@example.com",
			}),
		);

		const res = await request(env, "/api/auth/oauth/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-oauth-pending": "pending-email-linked",
			},
			body: JSON.stringify({ username: "EmailLinked" }),
		});

		assert.equal(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.equal(body.error, "Username already taken");
		assert.equal(user.oauth_provider, null);
		assert.equal(user.oauth_sub, null);
		assert.equal(user.email, "existing@example.com");
		assert.equal(db.sessions.length, 0);
	});

	it("claims passkey users during oauth completion when oauth email matches", async () => {
		const { env, kv, db } = createTestEnv();
		const user = seedUser(db, {
			username: "PasskeyEmailLinked",
			email: "passkey@example.com",
		});
		seedPasskey(db, { userId: user.id });
		await kv.put(
			"oauth_pending:pending-passkey-email",
			JSON.stringify({
				provider: "google",
				sub: "google-sub-passkey-email",
				email: "PASSKEY@example.com",
			}),
		);

		const res = await request(env, "/api/auth/oauth/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-oauth-pending": "pending-passkey-email",
			},
			body: JSON.stringify({ username: "PasskeyEmailLinked" }),
		});

		assert.equal(res.status, 200);
		const body = (await res.json()) as { claimed: boolean };
		assert.equal(body.claimed, true);
		assert.equal(user.oauth_provider, "google");
		assert.equal(user.oauth_sub, "google-sub-passkey-email");
		assert.equal(user.email, "passkey@example.com");
		assert.equal(db.sessions.length, 1);
	});

	it("rejects passkey users during oauth completion without matching email proof", async () => {
		const { env, kv, db } = createTestEnv();
		const user = seedUser(db, { username: "PasskeyOnly" });
		seedPasskey(db, { userId: user.id });
		await kv.put(
			"oauth_pending:pending-passkey-only",
			JSON.stringify({
				provider: "google",
				sub: "google-sub-passkey-only",
				email: "passkey-only@example.com",
			}),
		);

		const res = await request(env, "/api/auth/oauth/complete", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-oauth-pending": "pending-passkey-only",
			},
			body: JSON.stringify({ username: "PasskeyOnly" }),
		});

		assert.equal(res.status, 400);
		const body = (await res.json()) as { error: string };
		assert.equal(body.error, "Username already taken");
		assert.equal(user.oauth_provider, null);
		assert.equal(user.oauth_sub, null);
		assert.equal(db.sessions.length, 0);
	});
});
