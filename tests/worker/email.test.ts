import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCookieValue, getSessionToken, jsonRequest } from "./testHelpers";
import {
	createTestEnv,
	seedEmailChangeCode,
	seedEmailLoginCode,
	seedEmailSendRate,
	seedSession,
	seedUser,
} from "./testUtils";

describe("email auth", () => {
	it("sends verification codes for valid emails", async (t) => {
		const { env, db } = createTestEnv();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			({ ok: true, json: async () => ({}) }) as Response;
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const email = "person@example.com";
		const { res, json } = await jsonRequest(env, "/api/auth/email/send-code", {
			method: "POST",
			body: { email },
		});
		assert.equal(res.status, 200);
		assert.equal(json.status, "code_sent");
		const stored = db.emailLoginCodes.find((row) => row.email === email);
		assert.ok(stored);
		assert.equal(stored?.code.length, 6);
	});

	it("resends the active verification code for an email", async (t) => {
		const { env, db } = createTestEnv();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			({ ok: true, json: async () => ({}) }) as Response;
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const email = "resend@example.com";
		const first = await jsonRequest(env, "/api/auth/email/send-code", {
			method: "POST",
			body: { email },
		});
		assert.equal(first.res.status, 200);
		const firstCode = db.emailLoginCodes.find(
			(row) => row.email === email,
		)?.code;
		assert.ok(firstCode);

		const second = await jsonRequest(env, "/api/auth/email/send-code", {
			method: "POST",
			body: { email },
		});
		assert.equal(second.res.status, 200);
		const secondCode = db.emailLoginCodes.find(
			(row) => row.email === email,
		)?.code;

		assert.equal(secondCode, firstCode);

		const { res, json } = await jsonRequest(env, "/api/auth/email/verify", {
			method: "POST",
			body: { email, code: firstCode },
		});
		assert.equal(res.status, 200);
		assert.equal(json.status, "choose_username");
	});

	it("skips code delivery for hardcoded demo emails", async (t) => {
		const { env, db } = createTestEnv();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => {
			throw new Error("fetch should not be called for demo emails");
		};
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const email = "demo1@example.com";
		const { res, json } = await jsonRequest(env, "/api/auth/email/send-code", {
			method: "POST",
			body: { email },
		});
		assert.equal(res.status, 200);
		assert.equal(json.status, "code_sent");
		assert.equal(
			db.emailLoginCodes.find((row) => row.email === email),
			undefined,
		);
	});

	it("rate limits repeated code requests within the window", async (t) => {
		const { env } = createTestEnv();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			({ ok: true, json: async () => ({}) }) as Response;
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const email = "flooder@example.com";
		const statuses: number[] = [];
		for (let i = 0; i < 4; i += 1) {
			const { res } = await jsonRequest(env, "/api/auth/email/send-code", {
				method: "POST",
				body: { email },
			});
			statuses.push(res.status);
		}
		assert.deepEqual(statuses, [200, 200, 200, 429]);
	});

	it("authenticates existing users with valid codes", async () => {
		const { env, db } = createTestEnv();
		const email = "signedin@example.com";
		const user = seedUser(db, { username: "SignedIn", email });
		seedEmailLoginCode(db, { email, code: "123456" });

		const { res, json } = await jsonRequest(env, "/api/auth/email/verify", {
			method: "POST",
			body: { email, code: "123456" },
		});
		const body = json as { status: string; user: { id: number } };
		assert.equal(res.status, 200);
		assert.equal(body.status, "authenticated");
		assert.equal(body.user.id, user.id);
		assert.ok(getSessionToken(res));
	});

	it("authenticates existing demo users without codes", async () => {
		const { env, db } = createTestEnv();
		const email = "demo2@example.com";
		const user = seedUser(db, { username: "DemoTwo", email });

		const { res, json } = await jsonRequest(env, "/api/auth/email/verify", {
			method: "POST",
			body: { email },
		});
		const body = json as { status: string; user: { id: number } };
		assert.equal(res.status, 200);
		assert.equal(body.status, "authenticated");
		assert.equal(body.user.id, user.id);
		assert.ok(getSessionToken(res));
	});

	it("rejects concurrent wrong guesses beyond the attempt cap", async () => {
		const { env, db } = createTestEnv();
		const email = "bruteforce@example.com";
		seedEmailLoginCode(db, { email, code: "654321" });

		const attempts = await Promise.all(
			Array.from({ length: 50 }, () =>
				jsonRequest(env, "/api/auth/email/verify", {
					method: "POST",
					body: { email, code: "111111" },
				}),
			),
		);

		const invalidCount = attempts.filter(
			({ json }) => json.error === "Invalid code",
		).length;
		const mergedCount = attempts.filter(
			({ json }) =>
				json.error === "Code expired or not found. Please request a new code.",
		).length;

		// At most MAX_CODE_ATTEMPTS (5) guesses may spend an attempt; the rest are
		// refused with the merged expired/too-many message.
		assert.ok(invalidCount <= 5);
		assert.equal(mergedCount, 50 - invalidCount);
		assert.ok(attempts.every(({ res }) => res.status === 400));

		// A subsequent sequential wrong guess is still refused.
		const { res, json } = await jsonRequest(env, "/api/auth/email/verify", {
			method: "POST",
			body: { email, code: "222222" },
		});
		assert.equal(res.status, 400);
		assert.equal(
			json.error,
			"Code expired or not found. Please request a new code.",
		);
	});

	it("consumes a login code exactly once under concurrency", async () => {
		const { env, db } = createTestEnv();
		const email = "singleuse@example.com";
		seedUser(db, { username: "SingleUse", email });
		seedEmailLoginCode(db, { email, code: "424242" });

		const results = await Promise.all([
			jsonRequest(env, "/api/auth/email/verify", {
				method: "POST",
				body: { email, code: "424242" },
			}),
			jsonRequest(env, "/api/auth/email/verify", {
				method: "POST",
				body: { email, code: "424242" },
			}),
		]);

		const successes = results.filter(({ res }) => res.status === 200);
		assert.equal(successes.length, 1);
		assert.equal(
			(successes[0].json as { status: string }).status,
			"authenticated",
		);
		assert.equal(
			db.emailLoginCodes.find((row) => row.email === email),
			undefined,
		);
	});

	it("creates new users after completing registration", async () => {
		const { env, db } = createTestEnv();
		const email = "new@example.com";
		seedEmailLoginCode(db, { email, code: "654321" });

		const { res, json } = await jsonRequest(env, "/api/auth/email/verify", {
			method: "POST",
			body: { email, code: "654321" },
		});
		assert.equal(res.status, 200);
		assert.equal(json.status, "choose_username");
		const pendingId = getCookieValue(res, "email_pending");
		assert.ok(pendingId);

		const { res: completeRes, json: completeJson } = await jsonRequest(
			env,
			"/api/auth/email/complete",
			{
				method: "POST",
				headers: { cookie: `email_pending=${pendingId}` },
				body: { username: "new_user" },
			},
		);
		const completeBody = completeJson as { user: { id: number } };
		assert.equal(completeRes.status, 200);
		assert.ok(completeBody.user.id);
		assert.ok(getSessionToken(completeRes));
		assert.equal(db.users.length, 1);
		assert.equal(db.users[0].email, email);
	});

	it("creates and authenticates missing demo accounts without codes", async () => {
		const { env, db } = createTestEnv();
		const email = "demo3@example.com";

		const { res, json } = await jsonRequest(env, "/api/auth/email/verify", {
			method: "POST",
			body: { email },
		});
		const body = json as { status: string; needsPasskeySetup: boolean };
		assert.equal(res.status, 200);
		assert.equal(body.status, "authenticated");
		assert.equal(body.needsPasskeySetup, false);
		assert.equal(db.users.length, 1);
		assert.equal(db.users[0].email, email);
		assert.equal(db.users[0].username, "demo3_appstore");
		assert.ok(getSessionToken(res));
	});

	it("rejects profane usernames during email registration completion", async () => {
		const { env, db } = createTestEnv();
		const email = "new2@example.com";
		seedEmailLoginCode(db, { email, code: "111222" });

		const { res } = await jsonRequest(env, "/api/auth/email/verify", {
			method: "POST",
			body: { email, code: "111222" },
		});
		const pendingId = getCookieValue(res, "email_pending");
		assert.ok(pendingId);

		const { res: completeRes, json } = await jsonRequest(
			env,
			"/api/auth/email/complete",
			{
				method: "POST",
				headers: { cookie: `email_pending=${pendingId}` },
				body: { username: "shitname" },
			},
		);

		assert.equal(completeRes.status, 400);
		assert.equal(json.error, "Username contains disallowed language");
	});

	it("links email for authenticated users", async (t) => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Emailer" });
		seedSession(db, user.id, "email-token");
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			({ ok: true, json: async () => ({}) }) as Response;
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const email = "linked@example.com";
		const { res: sendRes, json: sendJson } = await jsonRequest(
			env,
			"/api/auth/email/add/send-code",
			{
				method: "POST",
				headers: { "x-session-token": "email-token" },
				body: { email },
			},
		);
		assert.equal(sendRes.status, 200);
		assert.equal(sendJson.status, "code_sent");

		const stored = db.emailChangeCodes.find((row) => row.user_id === user.id);
		assert.equal(stored?.target_email, email);
		assert.ok(stored?.code);

		const { res: verifyRes, json: verifyJson } = await jsonRequest(
			env,
			"/api/auth/email/add/verify",
			{
				method: "POST",
				headers: { "x-session-token": "email-token" },
				body: { code: stored?.code },
			},
		);
		assert.equal(verifyRes.status, 200);
		assert.equal(verifyJson.status, "email_updated");
		assert.equal(verifyJson.email, email);
		assert.equal(db.users[0].email, email);
		assert.equal(
			db.emailChangeCodes.find((row) => row.user_id === user.id),
			undefined,
		);
	});

	it("binds the server-stored target email, ignoring stale attempts", async () => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Rebinder", email: "old@example.com" });
		seedSession(db, user.id, "rebind-token");
		seedEmailChangeCode(db, {
			userId: user.id,
			targetEmail: "target@example.com",
			code: "909090",
		});

		const { res, json } = await jsonRequest(
			env,
			"/api/auth/email/add/verify",
			{
				method: "POST",
				headers: { "x-session-token": "rebind-token" },
				body: { code: "909090" },
			},
		);
		assert.equal(res.status, 200);
		assert.equal(json.status, "email_updated");
		assert.equal(json.email, "target@example.com");
		assert.equal(db.users[0].email, "target@example.com");
	});

	it("shares the send-rate window across login and change-email endpoints", async (t) => {
		const { env, db } = createTestEnv();
		const user = seedUser(db, { username: "Sharer" });
		seedSession(db, user.id, "share-token");
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			({ ok: true, json: async () => ({}) }) as Response;
		t.after(() => {
			globalThis.fetch = originalFetch;
		});

		const email = "shared@example.com";
		// Pretend three code emails already went out this window for this address.
		seedEmailSendRate(db, { email, sends: 3 });

		const { res } = await jsonRequest(
			env,
			"/api/auth/email/add/send-code",
			{
				method: "POST",
				headers: { "x-session-token": "share-token" },
				body: { email },
			},
		);
		assert.equal(res.status, 429);
	});
});
