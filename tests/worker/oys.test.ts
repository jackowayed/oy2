import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { jsonRequest } from "./testHelpers";
import {
	createTestEnv,
	getStreakDateBoundaries,
	seedFriendship,
	seedLastOyInfo,
	seedSession,
	seedUser,
	seedOy,
} from "./testUtils";

function toPem(pkcs8: ArrayBuffer) {
	const base64 = Buffer.from(pkcs8).toString("base64");
	const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
	return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

async function createRsaPrivateKeyPem() {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
	return toPem(pkcs8);
}

async function createEcPrivateKeyPem() {
	const pair = await crypto.subtle.generateKey(
		{
			name: "ECDSA",
			namedCurve: "P-256",
		},
		true,
		["sign", "verify"],
	);
	const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
	return toPem(pkcs8);
}

describe("oys and los", () => {
	it("prevents sending to non-friends", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Sender" });
		const target = seedUser(db, { username: "Target" });
		seedSession(db, user.id, "send-token");
		const { res, json } = await jsonRequest(env, "/api/oy", {
			method: "POST",
			headers: { "x-session-token": "send-token" },
			body: { toUserId: target.id },
		});
		assert.equal(res.status, 403);
		assert.equal(json.error, "You can only send Oys to friends");
	});

	it("creates oy, notifications, and last oy info updates", async () => {
		const { env, db } = createTestEnv();
		const sender = seedUser(db, { username: "Sender" });
		const receiver = seedUser(db, { username: "Receiver" });
		seedSession(db, sender.id, "oy-token");
		seedFriendship(db, sender.id, receiver.id);
		seedFriendship(db, receiver.id, sender.id);
		const { res, json } = await jsonRequest(env, "/api/oy", {
			method: "POST",
			headers: { "x-session-token": "oy-token" },
			body: { toUserId: receiver.id },
		});
		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.oys.length, 1);
		assert.equal(db.notifications.length, 1);
		assert.equal(db.lastOyInfo.length, 2);
		const lastOyInfo = db.lastOyInfo.find(
			(row) => row.user_id === sender.id && row.friend_id === receiver.id,
		);
		assert.equal(lastOyInfo?.last_oy_type, "oy");
	});

	it("increments streak when sending oy day after last oy", async () => {
		const { env, db } = createTestEnv();
		const sender = seedUser(db, { username: "Sender" });
		const receiver = seedUser(db, { username: "Receiver" });
		seedSession(db, sender.id, "streak-inc-token");
		const { startOfTodayNY, startOfYesterdayNY } = getStreakDateBoundaries();
		const streakStartDate = startOfYesterdayNY - 2 * 24 * 60 * 60;
		const lastOyCreatedAt = startOfYesterdayNY + 60;
		seedFriendship(db, sender.id, receiver.id);
		seedFriendship(db, receiver.id, sender.id);
		seedLastOyInfo(db, {
			userId: sender.id,
			friendId: receiver.id,
			lastOyCreatedAt,
			streakStartDate,
		});
		const { res, json } = await jsonRequest(env, "/api/oy", {
			method: "POST",
			headers: { "x-session-token": "streak-inc-token" },
			body: { toUserId: receiver.id },
		});
		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		const lastOyInfo = db.lastOyInfo.find(
			(row) => row.user_id === sender.id && row.friend_id === receiver.id,
		);
		assert.equal(json.streak, 4);
		assert.equal(lastOyInfo?.streak_start_date, streakStartDate);
	});

	it("keeps streak same when sending oy on same day", async () => {
		const { env, db } = createTestEnv();
		const sender = seedUser(db, { username: "Sender" });
		const receiver = seedUser(db, { username: "Receiver" });
		seedSession(db, sender.id, "streak-same-token");
		const { startOfTodayNY } = getStreakDateBoundaries();
		const streakStartDate = startOfTodayNY - 4 * 24 * 60 * 60;
		const lastOyCreatedAt = startOfTodayNY + 60;
		seedFriendship(db, sender.id, receiver.id);
		seedFriendship(db, receiver.id, sender.id);
		seedLastOyInfo(db, {
			userId: sender.id,
			friendId: receiver.id,
			lastOyCreatedAt,
			streakStartDate,
		});
		const { res, json } = await jsonRequest(env, "/api/oy", {
			method: "POST",
			headers: { "x-session-token": "streak-same-token" },
			body: { toUserId: receiver.id },
		});
		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		const lastOyInfo = db.lastOyInfo.find(
			(row) => row.user_id === sender.id && row.friend_id === receiver.id,
		);
		assert.equal(json.streak, 5);
		assert.equal(lastOyInfo?.streak_start_date, streakStartDate);
	});

	it("resets streak to 1 when sending oy after gap", async () => {
		const { env, db } = createTestEnv();
		const sender = seedUser(db, { username: "Sender" });
		const receiver = seedUser(db, { username: "Receiver" });
		seedSession(db, sender.id, "streak-reset-token");
		const { startOfTodayNY } = getStreakDateBoundaries();
		const lastOyCreatedAt = startOfTodayNY - 3 * 24 * 60 * 60;
		const streakStartDate = startOfTodayNY - 10 * 24 * 60 * 60;
		seedFriendship(db, sender.id, receiver.id);
		seedFriendship(db, receiver.id, sender.id);
		seedLastOyInfo(db, {
			userId: sender.id,
			friendId: receiver.id,
			lastOyCreatedAt,
			streakStartDate,
		});
		const { res, json } = await jsonRequest(env, "/api/oy", {
			method: "POST",
			headers: { "x-session-token": "streak-reset-token" },
			body: { toUserId: receiver.id },
		});
		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		const lastOyInfo = db.lastOyInfo.find(
			(row) => row.user_id === sender.id && row.friend_id === receiver.id,
		);
		assert.equal(json.streak, 1);
		assert.equal(lastOyInfo?.streak_start_date, startOfTodayNY);
	});

	it("creates location payloads and notification URLs for los", async () => {
		const { env, db } = createTestEnv();
		const sender = seedUser(db, { username: "Locator" });
		const receiver = seedUser(db, { username: "Tracker" });
		seedSession(db, sender.id, "lo-token");
		seedFriendship(db, sender.id, receiver.id);
		seedFriendship(db, receiver.id, sender.id);
		const { res, json } = await jsonRequest(env, "/api/lo", {
			method: "POST",
			headers: { "x-session-token": "lo-token" },
			body: { toUserId: receiver.id, location: { lat: 12.3, lon: 45.6 } },
		});
		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		const notificationPayload = JSON.parse(db.notifications[0].payload);
		assert.ok(notificationPayload.url.includes("expand=location"));
		assert.equal(notificationPayload.fromUserId, sender.id);
		assert.ok(Number.isFinite(notificationPayload.createdAt));
	});

	it("returns counterpart nickname on oys list", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Sender" });
		const friend = seedUser(db, { username: "Receiver" });
		seedSession(db, user.id, "oys-nickname-token");
		seedFriendship(db, user.id, friend.id, { nickname: "Bestie" });
		seedFriendship(db, friend.id, user.id);
		seedOy(db, {
			fromUserId: user.id,
			toUserId: friend.id,
			type: "oy",
		});

		const { res, json } = await jsonRequest(env, "/api/oys", {
			headers: { "x-session-token": "oys-nickname-token" },
		});
		const body = json as {
			oys: Array<{ counterpart_nickname: string | null }>;
		};

		assert.equal(res.status, 200);
		assert.equal(body.oys.length, 1);
		assert.equal(body.oys[0].counterpart_nickname, "Bestie");
	});

	it("uses custom sound and channel for Android native push", async () => {
		const { env, db } = createTestEnv();
		const sender = seedUser(db, { username: "AndroidSender" });
		const receiver = seedUser(db, { username: "AndroidReceiver" });
		seedSession(db, sender.id, "android-oy-token");
		seedSession(db, receiver.id, "android-receiver-token");
		seedFriendship(db, sender.id, receiver.id);
		seedFriendship(db, receiver.id, sender.id);
		env.FCM_PROJECT_ID = "test-project";
		env.FCM_CLIENT_EMAIL = "test@example.com";
		env.FCM_PRIVATE_KEY = await createRsaPrivateKeyPem();

		await jsonRequest(env, "/api/push/native/subscribe", {
			method: "POST",
			headers: { "x-session-token": "android-receiver-token" },
			body: {
				token: "android-device-token",
				platform: "android",
			},
		});

		let fcmSendBody: Record<string, unknown> | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://oauth2.googleapis.com/token") {
				return Response.json({
					access_token: "fcm-access-token",
					expires_in: 3600,
				});
			}
			if (
				url ===
				"https://fcm.googleapis.com/v1/projects/test-project/messages:send"
			) {
				fcmSendBody = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				return Response.json({});
			}
			return new Response("unexpected fetch", { status: 500 });
		};

		try {
			const { res, json } = await jsonRequest(env, "/api/oy", {
				method: "POST",
				headers: { "x-session-token": "android-oy-token" },
				body: { toUserId: receiver.id },
			});

			assert.equal(res.status, 200);
			assert.equal(json.success, true);
			assert.ok(fcmSendBody);
			const message = (fcmSendBody?.message ?? {}) as {
				android?: { notification?: { channel_id?: string; sound?: string } };
			};
			assert.equal(
				message.android?.notification?.channel_id,
				"oy_notifications_v1",
			);
			assert.equal(message.android?.notification?.sound, "oy");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("uses custom sound for iOS native push", async () => {
		const { env, db } = createTestEnv();
		const sender = seedUser(db, { username: "IosSender" });
		const receiver = seedUser(db, { username: "IosReceiver" });
		seedSession(db, sender.id, "ios-oy-token");
		seedSession(db, receiver.id, "ios-receiver-token");
		seedFriendship(db, sender.id, receiver.id);
		seedFriendship(db, receiver.id, sender.id);
		env.APPLE_PRIVATE_KEY = await createEcPrivateKeyPem();

		await jsonRequest(env, "/api/push/native/subscribe", {
			method: "POST",
			headers: { "x-session-token": "ios-receiver-token" },
			body: {
				token: "ios-device-token",
				platform: "ios",
				apnsEnvironment: "sandbox",
			},
		});

		let apnsPayload: Record<string, unknown> | null = null;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url === "https://api.sandbox.push.apple.com/3/device/ios-device-token") {
				apnsPayload = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				return Response.json({});
			}
			return new Response("unexpected fetch", { status: 500 });
		};

		try {
			const { res, json } = await jsonRequest(env, "/api/oy", {
				method: "POST",
				headers: { "x-session-token": "ios-oy-token" },
				body: { toUserId: receiver.id },
			});

			assert.equal(res.status, 200);
			assert.equal(json.success, true);
			assert.ok(apnsPayload);
			const aps = (apnsPayload?.aps ?? {}) as { sound?: string };
			assert.equal(aps.sound, "oy.wav");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("returns recent oys ordered and supports cursors", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Viewer" });
		const other = seedUser(db, { username: "Other" });
		seedSession(db, user.id, "oys-token");
		seedOy(db, {
			fromUserId: other.id,
			toUserId: user.id,
			type: "oy",
			createdAt: 100,
		});
		seedOy(db, {
			fromUserId: user.id,
			toUserId: other.id,
			type: "oy",
			createdAt: 120,
		});
		seedOy(db, {
			fromUserId: other.id,
			toUserId: user.id,
			type: "oy",
			createdAt: 110,
		});
		const { res, json } = await jsonRequest(env, "/api/oys", {
			headers: { "x-session-token": "oys-token" },
		});
		const body = json as {
			oys: Array<{ created_at: number }>;
			nextCursor: unknown;
		};
		assert.equal(res.status, 200);
		assert.equal(body.oys.length, 3);
		assert.equal(body.oys[0].created_at, 120);
		assert.equal(body.nextCursor, null);

		for (let i = 0; i < 31; i += 1) {
			seedOy(db, {
				fromUserId: other.id,
				toUserId: user.id,
				type: "oy",
				createdAt: 200 + i,
			});
		}
		const { json: paged } = await jsonRequest(env, "/api/oys", {
			headers: { "x-session-token": "oys-token" },
		});
		const pagedBody = paged as {
			oys: Array<unknown>;
			nextCursor: unknown;
		};
		assert.equal(pagedBody.oys.length, 30);
		assert.ok(pagedBody.nextCursor);
	});

	describe("lo history", () => {
		it("requires authentication", async () => {
			const { env } = createTestEnv();
			const { res } = await jsonRequest(env, "/api/lo/history?friendId=1&direction=inbound");
			assert.equal(res.status, 401);
		});

		it("rejects missing friendId", async () => {
			const { env, db } = createTestEnv();
			const me = seedUser(db, { username: "Me" });
			seedSession(db, me.id, "history-token");
			const { res } = await jsonRequest(env, "/api/lo/history?direction=inbound", {
				headers: { "x-session-token": "history-token" },
			});
			assert.equal(res.status, 400);
		});

		it("rejects invalid direction", async () => {
			const { env, db } = createTestEnv();
			const me = seedUser(db, { username: "Me" });
			const friend = seedUser(db, { username: "Friend" });
			seedSession(db, me.id, "history-token2");
			const { res } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${friend.id}&direction=sideways`,
				{ headers: { "x-session-token": "history-token2" } },
			);
			assert.equal(res.status, 400);
		});

		it("returns inbound lo history only from the specified friend", async () => {
			const { env, db } = createTestEnv();
			const me = seedUser(db, { username: "Me" });
			const friend = seedUser(db, { username: "Friend" });
			const otherFriend = seedUser(db, { username: "OtherFriend" });
			seedSession(db, me.id, "inbound-token");

			// Los from friend → me (should appear)
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":1.0,"lon":2.0}', createdAt: 100 });
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":1.1,"lon":2.1}', createdAt: 200 });
			// Lo from otherFriend → me (must NOT appear)
			seedOy(db, { fromUserId: otherFriend.id, toUserId: me.id, type: "lo", payload: '{"lat":9.9,"lon":9.9}', createdAt: 150 });
			// Lo from me → friend (must NOT appear in inbound)
			seedOy(db, { fromUserId: me.id, toUserId: friend.id, type: "lo", payload: '{"lat":8.8,"lon":8.8}', createdAt: 180 });

			const { res, json } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${friend.id}&direction=inbound`,
				{ headers: { "x-session-token": "inbound-token" } },
			);
			const body = json as { locations: Array<{ lat: number; lon: number; intensity: number }> };
			assert.equal(res.status, 200);
			assert.equal(body.locations.length, 2);
			// Oldest first (intensity 0), newest last (intensity 1)
			assert.equal(body.locations[0].intensity, 0);
			assert.equal(body.locations[1].intensity, 1);
			// Verify coordinates match friend's los only
			const lats = body.locations.map((l) => l.lat);
			assert.ok(lats.includes(1.0));
			assert.ok(lats.includes(1.1));
			assert.ok(!lats.includes(9.9)); // otherFriend excluded
			assert.ok(!lats.includes(8.8)); // outbound excluded
		});

		it("returns outbound lo history only to the specified friend", async () => {
			const { env, db } = createTestEnv();
			const me = seedUser(db, { username: "Me" });
			const friend = seedUser(db, { username: "Friend" });
			const otherFriend = seedUser(db, { username: "OtherFriend" });
			seedSession(db, me.id, "outbound-token");

			// Los from me → friend (should appear)
			seedOy(db, { fromUserId: me.id, toUserId: friend.id, type: "lo", payload: '{"lat":3.0,"lon":4.0}', createdAt: 100 });
			seedOy(db, { fromUserId: me.id, toUserId: friend.id, type: "lo", payload: '{"lat":3.1,"lon":4.1}', createdAt: 200 });
			// Lo from me → otherFriend (must NOT appear)
			seedOy(db, { fromUserId: me.id, toUserId: otherFriend.id, type: "lo", payload: '{"lat":9.9,"lon":9.9}', createdAt: 150 });
			// Lo from friend → me (must NOT appear in outbound)
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":8.8,"lon":8.8}', createdAt: 180 });

			const { res, json } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${friend.id}&direction=outbound`,
				{ headers: { "x-session-token": "outbound-token" } },
			);
			const body = json as { locations: Array<{ lat: number; lon: number; intensity: number }> };
			assert.equal(res.status, 200);
			assert.equal(body.locations.length, 2);
			const lats = body.locations.map((l) => l.lat);
			assert.ok(lats.includes(3.0));
			assert.ok(lats.includes(3.1));
			assert.ok(!lats.includes(9.9)); // sent to wrong friend excluded
			assert.ok(!lats.includes(8.8)); // inbound excluded
		});

		it("excludes plain oys and los without payload", async () => {
			const { env, db } = createTestEnv();
			const me = seedUser(db, { username: "Me" });
			const friend = seedUser(db, { username: "Friend" });
			seedSession(db, me.id, "payload-token");

			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":5.0,"lon":6.0}', createdAt: 100 });
			// Plain oy (type oy, no payload) — must not appear
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "oy", payload: null, createdAt: 200 });
			// Lo with null payload — must not appear
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: null, createdAt: 300 });

			const { res, json } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${friend.id}&direction=inbound`,
				{ headers: { "x-session-token": "payload-token" } },
			);
			const body = json as { locations: Array<{ lat: number; lon: number }> };
			assert.equal(res.status, 200);
			assert.equal(body.locations.length, 1);
			assert.equal(body.locations[0].lat, 5.0);
		});

		it("encodes intensity correctly: single point gets 1, oldest 0 newest 1 for multiple", async () => {
			const { env, db } = createTestEnv();
			const me = seedUser(db, { username: "Me" });
			const friend = seedUser(db, { username: "Friend" });
			seedSession(db, me.id, "intensity-token");

			// Single lo
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":1.0,"lon":1.0}', createdAt: 100 });
			const { json: singleJson } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${friend.id}&direction=inbound`,
				{ headers: { "x-session-token": "intensity-token" } },
			);
			const single = singleJson as { locations: Array<{ intensity: number }> };
			assert.equal(single.locations.length, 1);
			assert.equal(single.locations[0].intensity, 1);

			// Three los total (including the one already seeded): oldest, middle, newest
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":2.0,"lon":2.0}', createdAt: 200 });
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":3.0,"lon":3.0}', createdAt: 300 });
			const { json: multiJson } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${friend.id}&direction=inbound`,
				{ headers: { "x-session-token": "intensity-token" } },
			);
			const multi = multiJson as { locations: Array<{ intensity: number; lat: number }> };
			assert.equal(multi.locations.length, 3);
			// Sorted oldest→newest, so index 0 = oldest (createdAt 100, intensity 0)
			assert.equal(multi.locations[0].lat, 1.0);
			assert.equal(multi.locations[0].intensity, 0);
			// Index 2 = newest (createdAt 300, intensity 1)
			assert.equal(multi.locations[2].lat, 3.0);
			assert.equal(multi.locations[2].intensity, 1);
			// Middle intensity is between 0 and 1
			assert.ok(multi.locations[1].intensity > 0 && multi.locations[1].intensity < 1);
		});

		it("filters to locations at or before the given before timestamp, renormalizing intensity", async () => {
			const { env, db } = createTestEnv();
			const me = seedUser(db, { username: "Me" });
			const friend = seedUser(db, { username: "Friend" });
			seedSession(db, me.id, "before-token");

			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":1.0,"lon":1.0}', createdAt: 100 });
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":2.0,"lon":2.0}', createdAt: 200 });
			seedOy(db, { fromUserId: friend.id, toUserId: me.id, type: "lo", payload: '{"lat":3.0,"lon":3.0}', createdAt: 300 });

			// before=200 should return only createdAt 100 and 200, with intensity re-normalized
			const { res, json } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${friend.id}&direction=inbound&before=200`,
				{ headers: { "x-session-token": "before-token" } },
			);
			const body = json as { locations: Array<{ lat: number; intensity: number }> };
			assert.equal(res.status, 200);
			assert.equal(body.locations.length, 2);
			assert.equal(body.locations[0].lat, 1.0);
			assert.equal(body.locations[0].intensity, 0); // oldest
			assert.equal(body.locations[1].lat, 2.0);
			assert.equal(body.locations[1].intensity, 1); // newest = the current lo, always 1
		});

		it("cannot fetch another user's location history by spoofing friendId", async () => {
			const { env, db } = createTestEnv();
			const me = seedUser(db, { username: "Me" });
			const alice = seedUser(db, { username: "Alice" });
			const bob = seedUser(db, { username: "Bob" });
			seedSession(db, me.id, "spoof-token");

			// Lo from alice → bob (neither party is me)
			seedOy(db, { fromUserId: alice.id, toUserId: bob.id, type: "lo", payload: '{"lat":7.0,"lon":8.0}', createdAt: 100 });

			// Requesting inbound with friendId=alice means: from_user_id=alice, to_user_id=me
			// alice→bob should NOT appear since to_user_id=bob ≠ me
			const { res: inRes, json: inJson } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${alice.id}&direction=inbound`,
				{ headers: { "x-session-token": "spoof-token" } },
			);
			const inBody = inJson as { locations: unknown[] };
			assert.equal(inRes.status, 200);
			assert.equal(inBody.locations.length, 0);

			// Requesting outbound with friendId=bob means: from_user_id=me, to_user_id=bob
			// alice→bob should NOT appear since from_user_id=alice ≠ me
			const { res: outRes, json: outJson } = await jsonRequest(
				env,
				`/api/lo/history?friendId=${bob.id}&direction=outbound`,
				{ headers: { "x-session-token": "spoof-token" } },
			);
			const outBody = outJson as { locations: unknown[] };
			assert.equal(outRes.status, 200);
			assert.equal(outBody.locations.length, 0);
		});
	});

	it("excludes oys between blocked users from fetch results", async () => {
		const { env, db } = createTestEnv();
		const me = seedUser(db, { username: "Viewer" });
		const other = seedUser(db, { username: "BlockedUser" });
		seedSession(db, me.id, "oys-block-token");

		seedOy(db, {
			fromUserId: other.id,
			toUserId: me.id,
			type: "oy",
			createdAt: 200,
		});
		seedOy(db, {
			fromUserId: me.id,
			toUserId: other.id,
			type: "oy",
			createdAt: 210,
		});

		await jsonRequest(env, `/api/friends/${other.id}/block`, {
			method: "POST",
			headers: { "x-session-token": "oys-block-token" },
		});

		const { res, json } = await jsonRequest(env, "/api/oys", {
			headers: { "x-session-token": "oys-block-token" },
		});
		const body = json as { oys: Array<unknown> };
		assert.equal(res.status, 200);
		assert.equal(body.oys.length, 0);
	});
	describe("oy everyone", () => {
		it("requires authentication", async () => {
			const { env } = createTestEnv();
			const { res, json } = await jsonRequest(env, "/api/oy/all", {
				method: "POST",
			});
			assert.equal(res.status, 401);
			assert.equal(json.error, "Not authenticated");
		});

		it("sends an oy to every friend", async () => {
			const { env, db } = createTestEnv();
			const sender = seedUser(db, { username: "Sender" });
			const first = seedUser(db, { username: "First" });
			const second = seedUser(db, { username: "Second" });
			const stranger = seedUser(db, { username: "Stranger" });
			seedSession(db, sender.id, "oy-all-token");
			for (const friend of [first, second]) {
				seedFriendship(db, sender.id, friend.id);
				seedFriendship(db, friend.id, sender.id);
			}

			const { res, json } = await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-token" },
			});
			assert.equal(res.status, 200);
			assert.equal(json.sent, 2);
			assert.deepEqual(
				(json.recipients as Array<{ username: string }>)
					.map((recipient) => recipient.username)
					.sort(),
				["First", "Second"],
			);
			assert.equal(db.oys.length, 2);
			assert.deepEqual(
				db.oys.map((oy) => oy.to_user_id).sort(),
				[first.id, second.id].sort(),
			);
			assert.equal(db.notifications.length, 2);
			assert.equal(
				db.oys.some((oy) => oy.to_user_id === stranger.id),
				false,
			);
		});

		it("looks like an ordinary oy to recipients", async () => {
			const { env, db } = createTestEnv();
			const sender = seedUser(db, { username: "Sender" });
			const receiver = seedUser(db, { username: "Receiver" });
			seedSession(db, sender.id, "oy-all-payload-token");
			seedFriendship(db, sender.id, receiver.id);
			seedFriendship(db, receiver.id, sender.id);

			await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-payload-token" },
			});

			const payload = JSON.parse(db.notifications[0].payload) as {
				title: string;
				body: string;
				type: string;
			};
			assert.equal(payload.title, "Oy!");
			assert.equal(payload.body, "Sender sent you an Oy!");
			assert.equal(payload.type, "oy");
			assert.equal(db.oys[0].type, "oy");
		});

		it("skips blocked friends", async () => {
			const { env, db } = createTestEnv();
			const sender = seedUser(db, { username: "Sender" });
			const friend = seedUser(db, { username: "Friend" });
			const blocked = seedUser(db, { username: "Blocked" });
			seedSession(db, sender.id, "oy-all-block-token");
			for (const other of [friend, blocked]) {
				seedFriendship(db, sender.id, other.id);
				seedFriendship(db, other.id, sender.id);
			}
			await jsonRequest(env, `/api/friends/${blocked.id}/block`, {
				method: "POST",
				headers: { "x-session-token": "oy-all-block-token" },
			});

			const { json } = await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-block-token" },
			});
			assert.equal(json.sent, 1);
			assert.equal(db.oys.length, 1);
			assert.equal(db.oys[0].to_user_id, friend.id);
		});

		it("succeeds without sending anything when you have no friends", async () => {
			const { env, db } = createTestEnv();
			const sender = seedUser(db, { username: "Lonely" });
			seedSession(db, sender.id, "oy-all-empty-token");

			const { res, json } = await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-empty-token" },
			});
			assert.equal(res.status, 200);
			assert.equal(json.sent, 0);
			assert.equal(db.oys.length, 0);
		});

		it("sends to the 50 most recent friends and skips the rest", async () => {
			const { env, db } = createTestEnv();
			const sender = seedUser(db, { username: "Sender" });
			seedSession(db, sender.id, "oy-all-cap-token");
			const friends = Array.from({ length: 52 }, (_, index) => {
				const friend = seedUser(db, {
					username: `Friend${String(index).padStart(2, "0")}`,
				});
				seedFriendship(db, sender.id, friend.id);
				seedFriendship(db, friend.id, sender.id);
				// Higher index means a more recent Oy between the two of you.
				seedLastOyInfo(db, {
					userId: sender.id,
					friendId: friend.id,
					lastOyCreatedAt: 1000 + index,
				});
				return friend;
			});

			const { res, json } = await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-cap-token" },
			});
			assert.equal(res.status, 200);
			assert.equal(json.sent, 50);
			assert.equal(db.oys.length, 50);

			const recipients = json.recipients as Array<{ id: number }>;
			// Most recent first, and the two stalest friends are left out.
			assert.equal(recipients[0].id, friends[51].id);
			assert.equal(recipients[49].id, friends[2].id);
			const oyedIds = new Set(db.oys.map((oy) => oy.to_user_id));
			assert.equal(oyedIds.has(friends[0].id), false);
			assert.equal(oyedIds.has(friends[1].id), false);
		});

		it("orders recipients by oy recency, never-oyed friends last", async () => {
			const { env, db } = createTestEnv();
			const sender = seedUser(db, { username: "Sender" });
			const stale = seedUser(db, { username: "Stale" });
			const recent = seedUser(db, { username: "Recent" });
			const never = seedUser(db, { username: "Never" });
			seedSession(db, sender.id, "oy-all-order-token");
			for (const friend of [stale, recent, never]) {
				seedFriendship(db, sender.id, friend.id);
				seedFriendship(db, friend.id, sender.id);
			}
			seedLastOyInfo(db, {
				userId: sender.id,
				friendId: stale.id,
				lastOyCreatedAt: 100,
			});
			seedLastOyInfo(db, {
				userId: sender.id,
				friendId: recent.id,
				lastOyCreatedAt: 900,
			});

			const { json } = await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-order-token" },
			});
			assert.deepEqual(
				(json.recipients as Array<{ username: string }>).map(
					(recipient) => recipient.username,
				),
				["Recent", "Stale", "Never"],
			);
		});

		it("rate limits repeat broadcasts", async () => {
			const { env, db } = createTestEnv();
			const sender = seedUser(db, { username: "Sender" });
			const receiver = seedUser(db, { username: "Receiver" });
			seedSession(db, sender.id, "oy-all-rate-token");
			seedFriendship(db, sender.id, receiver.id);
			seedFriendship(db, receiver.id, sender.id);

			await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-rate-token" },
			});
			const { res, json } = await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-rate-token" },
			});
			assert.equal(res.status, 429);
			assert.equal(json.error, "You just Oyed everyone. Give them a minute.");
			assert.ok((json.retryAfterSeconds as number) > 0);
			assert.equal(db.oys.length, 1);
		});

		it("does not burn the cooldown when there is nobody to oy", async () => {
			const { env, db } = createTestEnv();
			const sender = seedUser(db, { username: "Sender" });
			seedSession(db, sender.id, "oy-all-no-burn-token");

			await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-no-burn-token" },
			});

			const receiver = seedUser(db, { username: "Receiver" });
			seedFriendship(db, sender.id, receiver.id);
			seedFriendship(db, receiver.id, sender.id);
			const { res, json } = await jsonRequest(env, "/api/oy/all", {
				method: "POST",
				headers: { "x-session-token": "oy-all-no-burn-token" },
			});
			assert.equal(res.status, 200);
			assert.equal(json.sent, 1);
		});
	});
});
