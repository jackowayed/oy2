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

	it("updates existing endpoint subscriptions", async () => {
		const { env, db } = createTestEnv();
		const firstUser = seedUser(db, { username: "Pushy" });
		const secondUser = seedUser(db, { username: "Pushier" });
		seedSession(db, firstUser.id, "first-push-token");
		seedSession(db, secondUser.id, "second-push-token");

		const endpoint = "https://example.com/same-endpoint";
		await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "first-push-token" },
			body: {
				endpoint,
				keys: { p256dh: "old-p256", auth: "old-auth" },
			},
		});
		const { res, json } = await jsonRequest(env, "/api/push/subscribe", {
			method: "POST",
			headers: { "x-session-token": "second-push-token" },
			body: {
				endpoint,
				keys: { p256dh: "new-p256", auth: "new-auth" },
			},
		});

		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.pushSubscriptions.length, 1);
		assert.equal(db.pushSubscriptions[0]?.user_id, secondUser.id);
		assert.equal(db.pushSubscriptions[0]?.keys_p256dh, "new-p256");
		assert.equal(db.pushSubscriptions[0]?.keys_auth, "new-auth");
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
