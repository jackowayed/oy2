import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsonRequest } from "./testHelpers";
import { createTestEnv, seedSession, seedUser } from "./testUtils";

describe("push subscriptions", () => {
	it("validates subscription payloads", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Pushy" });
		seedSession(db, user.id, "push-token");
		const { res, json } = await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "push-token" },
			body: { endpoint: "https://example.com" },
		});
		assert.equal(res.status, 400);
		assert.equal(json.error, "Invalid subscription");
	});

	it("returns the VAPID public key", async () => {
		const { env } = createTestEnv();
		const { res, json } = await jsonRequest(env, "/api/push/vapid-public-key");
		assert.equal(res.status, 200);
		assert.equal(json.publicKey, "test-public");
	});

	it("subscribes and unsubscribes endpoints", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Pushy" });
		seedSession(db, user.id, "push-token");
		const { res, json } = await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "push-token" },
			body: {
				endpoint: "https://example.com",
				keys: { p256dh: "p256", auth: "auth" },
			},
		});
		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.pushSubscriptions.length, 1);

		const { res: unsubRes, json: unsubJson } = await jsonRequest(
			env,
			"/api/push/unsubscribe",
			{
				method: "POST",
				headers: { "x-session-token": "push-token" },
				body: { endpoint: "https://example.com" },
			},
		);
		assert.equal(unsubRes.status, 200);
		assert.equal(unsubJson.success, true);
		assert.equal(db.pushSubscriptions.length, 0);
	});

	it("re-subscribing to the same endpoint as the same user updates keys", async () => {
		const { env, db } = createTestEnv();
		const victim = seedUser(db, { username: "Pushy" });
		seedSession(db, victim.id, "victim-push-token");

		const endpoint = "https://example.com/same-endpoint";
		await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "victim-push-token" },
			body: {
				endpoint,
				keys: { p256dh: "old-p256", auth: "old-auth" },
			},
		});
		const { res, json } = await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "victim-push-token" },
			body: {
				endpoint,
				keys: { p256dh: "new-p256", auth: "new-auth" },
			},
		});

		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.pushSubscriptions.length, 1);
		assert.equal(db.pushSubscriptions[0]?.user_id, victim.id);
		assert.equal(db.pushSubscriptions[0]?.keys_p256dh, "new-p256");
		assert.equal(db.pushSubscriptions[0]?.keys_auth, "new-auth");
	});

	it("reassigns a web endpoint to the newest subscriber (device hand-off)", async () => {
		const { env, db } = createTestEnv();
		const first = seedUser(db, { username: "First" });
		const second = seedUser(db, { username: "Second" });
		seedSession(db, first.id, "first-push-token");
		seedSession(db, second.id, "second-push-token");

		const endpoint = "https://example.com/shared-endpoint";
		await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "first-push-token" },
			body: {
				endpoint,
				keys: { p256dh: "first-p256", auth: "first-auth" },
			},
		});

		// A different account signing in on the same browser re-submits the same
		// browser-issued endpoint. It must take over the subscription so the
		// person now at the device receives their notifications (and stops
		// delivering the previous account's to this device).
		const { res, json } = await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "second-push-token" },
			body: {
				endpoint,
				keys: { p256dh: "second-p256", auth: "second-auth" },
			},
		});

		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.pushSubscriptions.length, 1);
		const row = db.pushSubscriptions.find((sub) => sub.endpoint === endpoint);
		assert.equal(row?.user_id, second.id);
		assert.equal(row?.keys_p256dh, "second-p256");
		assert.equal(row?.keys_auth, "second-auth");
	});

	it("reassigns a native token to the newest subscriber (device hand-off)", async () => {
		const { env, db } = createTestEnv();
		const first = seedUser(db, { username: "NativeFirst" });
		const second = seedUser(db, { username: "NativeSecond" });
		seedSession(db, first.id, "first-native-token");
		seedSession(db, second.id, "second-native-token");

		const token = "shared-native-token";
		await jsonRequest(env, "/api/push/native/subscribe", {
			method: "POST",
			headers: { "x-session-token": "first-native-token" },
			body: { token, platform: "ios", apnsEnvironment: "sandbox" },
		});

		const { res, json } = await jsonRequest(env, "/api/push/native/subscribe", {
			method: "POST",
			headers: { "x-session-token": "second-native-token" },
			body: { token, platform: "android" },
		});

		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.pushSubscriptions.length, 1);
		const row = db.pushSubscriptions.find((sub) => sub.native_token === token);
		assert.equal(row?.user_id, second.id);
		assert.equal(row?.platform, "android");
	});

	it("inserts a fresh endpoint for the subscribing user", async () => {
		const { env, db } = createTestEnv();
		const victim = seedUser(db, { username: "Victim" });
		const attacker = seedUser(db, { username: "Attacker" });
		seedSession(db, victim.id, "victim-push-token");
		seedSession(db, attacker.id, "attacker-push-token");

		await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "victim-push-token" },
			body: {
				endpoint: "https://example.com/victim-endpoint",
				keys: { p256dh: "victim-p256", auth: "victim-auth" },
			},
		});

		const attackerEndpoint = "https://example.com/attacker-endpoint";
		const { res, json } = await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "attacker-push-token" },
			body: {
				endpoint: attackerEndpoint,
				keys: { p256dh: "attacker-p256", auth: "attacker-auth" },
			},
		});

		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.pushSubscriptions.length, 2);
		const row = db.pushSubscriptions.find(
			(sub) => sub.endpoint === attackerEndpoint,
		);
		assert.equal(row?.user_id, attacker.id);
		assert.equal(row?.keys_p256dh, "attacker-p256");
	});

	it("subscribes and unsubscribes native tokens", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "NativePushy" });
		seedSession(db, user.id, "native-push-token");

		const { res, json } = await jsonRequest(env, "/api/push/native/subscribe", {
			method: "POST",
			headers: { "x-session-token": "native-push-token" },
			body: {
				token: "native-token-1",
				platform: "ios",
				apnsEnvironment: "sandbox",
			},
		});
		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(
			db.pushSubscriptions.filter((sub) => sub.platform !== "web").length,
			1,
		);
		assert.equal(db.pushSubscriptions[0]?.apns_environment, "sandbox");

		const { res: unsubRes, json: unsubJson } = await jsonRequest(
			env,
			"/api/push/native/unsubscribe",
			{
				method: "POST",
				headers: { "x-session-token": "native-push-token" },
				body: { token: "native-token-1" },
			},
		);
		assert.equal(unsubRes.status, 200);
		assert.equal(unsubJson.success, true);
		assert.equal(
			db.pushSubscriptions.filter((sub) => sub.platform !== "web").length,
			0,
		);
	});

	it("rejects invalid native APNs environment combinations", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "NativePushyInvalid" });
		seedSession(db, user.id, "native-push-invalid-token");

		const { res, json } = await jsonRequest(env, "/api/push/native/subscribe", {
			method: "POST",
			headers: { "x-session-token": "native-push-invalid-token" },
			body: {
				token: "native-token-2",
				platform: "android",
				apnsEnvironment: "sandbox",
			},
		});

		assert.equal(res.status, 400);
		assert.equal(json.error, "Invalid native subscription");
	});
});
