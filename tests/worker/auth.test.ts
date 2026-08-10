import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signAuthJwt } from "../../worker/lib";
import {
	getCookieValue,
	getSessionToken,
	jsonRequest,
	request,
} from "./testHelpers";
import { createTestEnv, seedSession, seedUser } from "./testUtils";

describe("auth", () => {
	const signTestJwt = (
		env: ReturnType<typeof createTestEnv>["env"],
		user: ReturnType<typeof seedUser>,
		sessionId: string,
		options: { expiresAt?: number } = {},
	) => signAuthJwt({ env } as never, user, sessionId, options);

	it("returns the current session user", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Zed" });
		seedSession(db, user.id, "session-token");
		const { res, json } = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": "session-token" },
		});
		const body = json as { user: { username: string } };
		assert.equal(res.status, 200);
		assert.equal(body.user.username, "Zed");
	});

	it("allows native app CORS preflight headers", async () => {
		const { env } = createTestEnv();
		const res = await request(env, "/api/auth/session", {
			method: "OPTIONS",
			headers: {
				origin: "https://oyme.site",
				"access-control-request-method": "GET",
				"access-control-request-headers":
					"authorization,x-oauth-pending,x-email-pending,content-type",
			},
		});

		assert.equal(res.status, 204);
		assert.equal(res.headers.get("access-control-allow-origin"), "https://oyme.site");
		const allowHeaders =
			res.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
		assert.ok(allowHeaders.includes("authorization"));
		assert.ok(allowHeaders.includes("x-oauth-pending"));
		assert.ok(allowHeaders.includes("x-email-pending"));
		assert.ok(allowHeaders.includes("content-type"));
	});

	it("accepts a valid JWT without a session table lookup", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "JwtUser" });
		const jwt = await signTestJwt(env, user, "missing-session-row");

		const { res, json } = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwt },
		});

		const body = json as { user: { username: string } };
		assert.equal(res.status, 200);
		assert.equal(body.user.username, "JwtUser");
	});

	it("refreshes an expired JWT through the backing session row", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "RefreshMe" });
		seedSession(db, user.id, "refresh-session");
		const jwt = await signTestJwt(env, user, "refresh-session", {
			expiresAt: Math.floor(Date.now() / 1000) - 1,
		});

		const { res, json } = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwt },
		});

		const body = json as { user: { username: string } };
		assert.equal(res.status, 200);
		assert.equal(body.user.username, "RefreshMe");
		assert.match(getSessionToken(res) ?? "", /^[^.]+\.[^.]+\.[^.]+$/);
		assert.ok(getCookieValue(res, "auth_user"));
	});

	it("rejects an expired JWT when the backing session row is missing", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Expired" });
		const jwt = await signTestJwt(env, user, "deleted-session", {
			expiresAt: Math.floor(Date.now() / 1000) - 1,
		});

		const { res, json } = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwt },
		});

		assert.equal(res.status, 401);
		assert.equal(json.error, "Not authenticated");
	});

	it("rejects a tampered JWT", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Tamper" });
		const jwt = await signTestJwt(env, user, "tamper-session");
		const tampered = `${jwt.slice(0, -1)}${jwt.endsWith("a") ? "b" : "a"}`;

		const { res, json } = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": tampered },
		});

		assert.equal(res.status, 401);
		assert.equal(json.error, "Not authenticated");
	});

	it("logs out and clears sessions", async () => {
		const { env, db, kv } = createTestEnv();
		const user = seedUser(db, { username: "Tori" });
		seedSession(db, user.id, "logout-token");
		await kv.put("session:logout-token", JSON.stringify(user));
		const { res, json } = await jsonRequest(env, "/api/auth/logout", {
			method: "POST",
			headers: { "x-session-token": "logout-token" },
		});
		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.sessions.length, 0);
	});

	it("deletes account when authenticated", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "DeleteMe" });
		seedSession(db, user.id, "delete-token");

		const { res, json } = await jsonRequest(env, "/api/auth/account", {
			method: "DELETE",
			headers: { "x-session-token": "delete-token" },
		});

		assert.equal(res.status, 200);
		assert.equal(json.success, true);
		assert.equal(db.users.find((row) => row.id === user.id), undefined);
	});

	it("rate limits repeated account deletion attempts", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "DeleteSpammer" });
		const statuses: number[] = [];
		for (let i = 0; i < 4; i += 1) {
			// The delete removes the account + session, but account_delete_rate
			// (keyed by user id, no FK) survives and keeps counting. Re-establish
			// the account/session each round so all four calls are authenticated
			// with the same user id.
			if (!db.users.some((row) => row.id === user.id)) {
				db.users.push(user);
			}
			if (!db.sessions.some((row) => row.token === "delete-spam-token")) {
				seedSession(db, user.id, "delete-spam-token");
			}
			const { res } = await jsonRequest(env, "/api/auth/account", {
				method: "DELETE",
				headers: { "x-session-token": "delete-spam-token" },
			});
			statuses.push(res.status);
		}

		assert.deepEqual(statuses, [200, 200, 200, 429]);
		// The 4th attempt is blocked before the delete runs, so the account remains.
		assert.ok(db.users.some((row) => row.id === user.id));
	});

	it("rejects unauthenticated account deletion", async () => {
		const { env } = createTestEnv();
		const { res, json } = await jsonRequest(env, "/api/auth/account", {
			method: "DELETE",
		});

		assert.equal(res.status, 401);
		assert.equal(json.error, "Not authenticated");
	});

	it("revokes the current token on logout", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "LogoutRevoke" });
		seedSession(db, user.id, "revoke-logout");
		const jwt = await signTestJwt(env, user, "revoke-logout");

		const before = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwt },
		});
		assert.equal(before.res.status, 200);

		const logout = await jsonRequest(env, "/api/auth/logout", {
			method: "POST",
			headers: { "x-session-token": jwt },
		});
		assert.equal(logout.res.status, 200);
		assert.equal(logout.json.success, true);

		// The SAME unexpired JWT must now be rejected on the fast path.
		const after = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwt },
		});
		assert.equal(after.res.status, 401);
		assert.equal(after.json.error, "Not authenticated");
	});

	it("revokes the current token on account deletion", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "DeleteRevoke" });
		seedSession(db, user.id, "revoke-delete");
		const jwt = await signTestJwt(env, user, "revoke-delete");

		const before = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwt },
		});
		assert.equal(before.res.status, 200);

		const del = await jsonRequest(env, "/api/auth/account", {
			method: "DELETE",
			headers: { "x-session-token": jwt },
		});
		assert.equal(del.res.status, 200);
		assert.equal(del.json.success, true);

		const after = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwt },
		});
		assert.equal(after.res.status, 401);
		assert.equal(after.json.error, "Not authenticated");
	});

	it("revokes other device sessions on account deletion", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "MultiDevice" });
		seedSession(db, user.id, "device-a");
		seedSession(db, user.id, "device-b");
		const jwtA = await signTestJwt(env, user, "device-a");
		const jwtB = await signTestJwt(env, user, "device-b");

		// Delete the account using device A's JWT.
		const del = await jsonRequest(env, "/api/auth/account", {
			method: "DELETE",
			headers: { "x-session-token": jwtA },
		});
		assert.equal(del.res.status, 200);

		// Device B holds a different, still-unexpired sid; it must be revoked too.
		const other = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwtB },
		});
		assert.equal(other.res.status, 401);
		assert.equal(other.json.error, "Not authenticated");
	});

	it("logout only revokes the current device session", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "TwoDevices" });
		seedSession(db, user.id, "logout-a");
		seedSession(db, user.id, "logout-b");
		const jwtA = await signTestJwt(env, user, "logout-a");
		const jwtB = await signTestJwt(env, user, "logout-b");

		const logout = await jsonRequest(env, "/api/auth/logout", {
			method: "POST",
			headers: { "x-session-token": jwtA },
		});
		assert.equal(logout.res.status, 200);

		// Session A is revoked.
		const a = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwtA },
		});
		assert.equal(a.res.status, 401);

		// Session B on another device is untouched.
		const b = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwtB },
		});
		assert.equal(b.res.status, 200);
		assert.equal((b.json as { user: { username: string } }).user.username, "TwoDevices");
	});

	it("authenticates a valid JWT when nothing has been revoked", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "NeverRevoked" });
		seedSession(db, user.id, "clean-session");
		const jwt = await signTestJwt(env, user, "clean-session");

		const { res, json } = await jsonRequest(env, "/api/auth/session", {
			headers: { "x-session-token": jwt },
		});
		assert.equal(res.status, 200);
		assert.equal((json as { user: { username: string } }).user.username, "NeverRevoked");
	});

	it("rejects profane usernames in availability checks", async () => {
		const { env } = createTestEnv();
		const { res, json } = await jsonRequest(env, "/api/auth/username/check", {
			method: "POST",
			body: { username: "fuckface" },
		});

		assert.equal(res.status, 400);
		assert.equal(json.available, false);
		assert.equal(json.error, "Username contains disallowed language");
	});
});
