import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signAuthJwt } from "../../worker/lib";
import { jsonRequest } from "./testHelpers";
import {
	createTestEnv,
	seedNotificationDelivery,
	seedSession,
	seedUser,
} from "./testUtils";

describe("admin", () => {
	const signTestJwt = (
		env: ReturnType<typeof createTestEnv>["env"],
		user: ReturnType<typeof seedUser>,
		sessionId: string,
	) => signAuthJwt({ env } as never, user, sessionId);

	it("returns admin stats", async () => {
		const { env, db } = createTestEnv();
		const now = Math.floor(Date.now() / 1000);
		const admin = seedUser(db, {
			username: "Admin",
			admin: 1,
			lastSeen: now,
		});
		seedSession(db, admin.id, "admin-token");
		const user = seedUser(db, { username: "User", lastSeen: now });
		seedSession(db, user.id, "user-session");
		seedNotificationDelivery(db, {
			notificationId: 1,
			endpoint: "https://example.com",
			attempt: 1,
			success: 1,
		});
		const { res, json } = await jsonRequest(env, "/api/admin/stats", {
			headers: { "x-session-token": "admin-token" },
		});
		const body = json as {
			stats: { usersCount: number; subscriptionsCount: number };
			activeUsers: Array<unknown>;
		};
		assert.equal(res.status, 200);
		assert.equal(body.stats.usersCount, 2);
		assert.equal(body.stats.subscriptionsCount, 0);
		assert.equal(body.activeUsers.length, 2);
	});

	it("requires admin for push health", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "User" });
		seedSession(db, user.id, "user-token");

		const { res } = await jsonRequest(env, "/api/admin/push/health", {
			headers: { "x-session-token": "user-token" },
		});
		assert.equal(res.status, 403);
	});

	it("re-checks admin status against the database", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "FormerAdmin", admin: 0 });
		const jwt = await signTestJwt(
			env,
			{ ...user, admin: 1 },
			"forged-admin-session",
		);

		const { res, json } = await jsonRequest(env, "/api/admin/stats", {
			headers: { "x-session-token": jwt },
		});

		assert.equal(res.status, 403);
		assert.equal(json.error, "Not authorized");
	});


	it("returns push health status", async () => {
		const { env, db } = createTestEnv();
		const now = Math.floor(Date.now() / 1000);
		const admin = seedUser(db, {
			username: "Admin",
			admin: 1,
			lastSeen: now,
		});
		seedSession(db, admin.id, "admin-token");

		const { res, json } = await jsonRequest(env, "/api/admin/push/health", {
			headers: { "x-session-token": "admin-token" },
		});
		const body = json as {
			ok: boolean;
			fcm: { configured: boolean; ok: boolean };
			apns: { configured: boolean; ok: boolean };
		};
		assert.equal(res.status, 200);
		assert.equal(body.ok, false);
		assert.equal(body.fcm.configured, false);
		assert.equal(body.fcm.ok, false);
		assert.equal(body.apns.configured, true);
		assert.equal(body.apns.ok, false);
	});
});
