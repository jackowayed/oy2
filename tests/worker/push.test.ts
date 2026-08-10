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

	it("blocks web subscription hijack of another user's endpoint", async () => {
		const { env, db } = createTestEnv();
		const victim = seedUser(db, { username: "Victim" });
		const attacker = seedUser(db, { username: "Attacker" });
		seedSession(db, victim.id, "victim-push-token");
		seedSession(db, attacker.id, "attacker-push-token");

		const endpoint = "https://example.com/victim-endpoint";
		await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "victim-push-token" },
			body: {
				endpoint,
				keys: { p256dh: "victim-p256", auth: "victim-auth" },
			},
		});

		const { res, json } = await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "attacker-push-token" },
			body: {
				endpoint,
				keys: { p256dh: "attacker-p256", auth: "attacker-auth" },
			},
		});

		// Response gives nothing away: the block looks like an ordinary success.
		assert.equal(res.status, 200);
		assert.equal(json.success, true);

		// The victim's row is left completely untouched.
		assert.equal(db.pushSubscriptions.length, 1);
		const row = db.pushSubscriptions.find((sub) => sub.endpoint === endpoint);
		assert.equal(row?.user_id, victim.id);
		assert.equal(row?.keys_p256dh, "victim-p256");
		assert.equal(row?.keys_auth, "victim-auth");
	});

	it("blocks native subscription hijack of another user's token", async () => {
		const { env, db } = createTestEnv();
		const victim = seedUser(db, { username: "NativeVictim" });
		const attacker = seedUser(db, { username: "NativeAttacker" });
		seedSession(db, victim.id, "victim-native-token");
		seedSession(db, attacker.id, "attacker-native-token");

		const token = "shared-native-token";
		await jsonRequest(env, "/api/push/native/subscribe", {
			method: "POST",
			headers: { "x-session-token": "victim-native-token" },
			body: { token, platform: "ios", apnsEnvironment: "sandbox" },
		});

		const { res, json } = await jsonRequest(env, "/api/push/native/subscribe", {
			method: "POST",
			headers: { "x-session-token": "attacker-native-token" },
			body: { token, platform: "android" },
		});

		// Response gives nothing away: the block looks like an ordinary success.
		assert.equal(res.status, 200);
		assert.equal(json.success, true);

		// The victim's row is left completely untouched.
		assert.equal(db.pushSubscriptions.length, 1);
		const row = db.pushSubscriptions.find((sub) => sub.native_token === token);
		assert.equal(row?.user_id, victim.id);
		assert.equal(row?.platform, "ios");
		assert.equal(row?.apns_environment, "sandbox");
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
