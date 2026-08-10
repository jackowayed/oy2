import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
	authUserPayload,
	createSession,
	setAuthCookies,
	updateLastSeen,
} from "../lib";
import { validateCleanUsername } from "../moderation";
import type { App, AppContext, User } from "../types";

const EMAIL_PENDING_PREFIX = "email_pending:";
const RATE_WINDOW_SECONDS = 60;
const CODE_TTL_SECONDS = 600;
const MAX_CODE_ATTEMPTS = 5;
const MAX_SENDS_PER_WINDOW = 3;
const DEMO_ACCOUNTS = {
	"demo1@example.com": "demo1_appstore",
	"demo2@example.com": "demo2_appstore",
	"demo3@example.com": "demo3_appstore",
} as const;

function generateVerificationCode(): string {
	const array = new Uint8Array(4);
	crypto.getRandomValues(array);
	const num =
		((array[0] << 24) | (array[1] << 16) | (array[2] << 8) | array[3]) >>> 0;
	return String(num % 1000000).padStart(6, "0");
}

async function generatePendingId(): Promise<string> {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateEmailHtml(code: string): string {
	return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 40px 20px; margin: 0;">
  <div style="max-width: 400px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
    <h1 style="font-size: 48px; font-weight: 900; color: #4b50f0; margin: 0 0 16px; letter-spacing: -1px;">Oy</h1>
    <h2 style="font-size: 20px; color: #333; margin: 0 0 24px; font-weight: 500;">Your verification code</h2>
    <div style="background: #f5f5f5; border-radius: 8px; padding: 20px; margin: 0 0 24px;">
      <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #4b50f0; font-family: monospace;">${code}</span>
    </div>
    <p style="font-size: 14px; color: #666; margin: 0 0 8px;">
      This code expires in 10 minutes.
    </p>
    <p style="font-size: 13px; color: #999; margin: 0;">
      If you didn't request this code, you can safely ignore this email.
    </p>
  </div>
</body>
</html>`;
}

function timingSafeEqualString(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let result = 0;
	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return result === 0;
}

async function sendEmailCode(
	c: AppContext,
	{ email, code }: { email: string; code: string },
): Promise<{ success: boolean; error?: string }> {
	try {
		const response = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${c.env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from: "Oy <noreply@oyme.site>",
				to: [email],
				subject: `${code} is your Oy verification code`,
				html: generateEmailHtml(code),
			}),
		});

		if (!response.ok) {
			const errorData = (await response.json()) as { message?: string };
			return {
				success: false,
				error: errorData.message || "Failed to send email",
			};
		}

		return { success: true };
	} catch (_err) {
		return { success: false, error: "Failed to send email" };
	}
}

function isValidEmail(email: string): boolean {
	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	return emailRegex.test(email) && email.length <= 254;
}

function isDemoEmail(email: string): boolean {
	return Object.hasOwn(DEMO_ACCOUNTS, email);
}

function getDemoUsername(email: string): string {
	return DEMO_ACCOUNTS[email as keyof typeof DEMO_ACCOUNTS];
}

export function registerEmailRoutes(app: App) {
	// Send verification code to email
	app.post("/api/auth/email/send-code", async (c: AppContext) => {
		const body = await c.req.json();
		const email = String(body.email || "")
			.trim()
			.toLowerCase();

		if (!email || !isValidEmail(email)) {
			return c.json({ error: "Invalid email address" }, 400);
		}

		if (isDemoEmail(email)) {
			return c.json({ status: "code_sent" });
		}

		const now = Math.floor(Date.now() / 1000);

		// Atomic send-rate limit (max MAX_SENDS_PER_WINDOW codes per email per window).
		const rate = await c.get("db").query<{ sends: number }>(
			`INSERT INTO email_send_rate (email, sends, window_started_at)
			 VALUES ($1, 1, $2)
			 ON CONFLICT (email) DO UPDATE SET
			   sends = CASE WHEN email_send_rate.window_started_at > $3
			                THEN email_send_rate.sends + 1 ELSE 1 END,
			   window_started_at = CASE WHEN email_send_rate.window_started_at > $3
			                            THEN email_send_rate.window_started_at ELSE $2 END
			 RETURNING sends`,
			[email, now, now - RATE_WINDOW_SECONDS],
		);
		if (rate.rows[0].sends > MAX_SENDS_PER_WINDOW) {
			return c.json(
				{
					error:
						"Too many requests. Please wait before requesting another code.",
				},
				429,
			);
		}

		// Reserve/reuse a code atomically without resetting attempts on reuse.
		const reserved = await c.get("db").query<{ code: string }>(
			`INSERT INTO email_login_codes (email, code, attempts, expires_at)
			 VALUES ($1, $2, 0, $3)
			 ON CONFLICT (email) DO UPDATE SET
			   code       = CASE WHEN email_login_codes.expires_at > $4 AND email_login_codes.attempts < $5
			                     THEN email_login_codes.code ELSE EXCLUDED.code END,
			   attempts   = CASE WHEN email_login_codes.expires_at > $4 AND email_login_codes.attempts < $5
			                     THEN email_login_codes.attempts ELSE 0 END,
			   expires_at = CASE WHEN email_login_codes.expires_at > $4 AND email_login_codes.attempts < $5
			                     THEN email_login_codes.expires_at ELSE EXCLUDED.expires_at END
			 RETURNING code`,
			[
				email,
				generateVerificationCode(),
				now + CODE_TTL_SECONDS,
				now,
				MAX_CODE_ATTEMPTS,
			],
		);

		const result = await sendEmailCode(c, {
			email,
			code: reserved.rows[0].code,
		});
		if (!result.success) {
			return c.json({ error: result.error || "Failed to send email" }, 500);
		}

		return c.json({ status: "code_sent" });
	});

	// Verify the code
	app.post("/api/auth/email/verify", async (c: AppContext) => {
		const body = await c.req.json();
		const email = String(body.email || "")
			.trim()
			.toLowerCase();
		const code = String(body.code || "").trim();

		if (!email) {
			return c.json({ error: "Email is required" }, 400);
		}

		if (!isDemoEmail(email) && !code) {
			return c.json({ error: "Email and code are required" }, 400);
		}

		if (!isDemoEmail(email)) {
			const now = Math.floor(Date.now() / 1000);
			// Atomically spend one attempt against a live code.
			const claim = await c.get("db").query<{ code: string }>(
				`UPDATE email_login_codes
				    SET attempts = attempts + 1
				  WHERE email = $1 AND attempts < $2 AND expires_at > $3
				 RETURNING code`,
				[email, MAX_CODE_ATTEMPTS, now],
			);
			if (!claim.rows[0]) {
				return c.json(
					{ error: "Code expired or not found. Please request a new code." },
					400,
				);
			}

			// Verify code (constant-time comparison)
			if (!timingSafeEqualString(code, claim.rows[0].code)) {
				return c.json({ error: "Invalid code" }, 400);
			}

			// Code is valid - consume it (single-use).
			const consumed = await c
				.get("db")
				.query("DELETE FROM email_login_codes WHERE email = $1", [email]);
			if (consumed.rowCount === 0) {
				return c.json({ error: "Invalid code" }, 400);
			}
		}

		// Check if user exists with this email
		const existingUser = await c
			.get("db")
			.query<User>("SELECT * FROM users WHERE LOWER(email) = $1", [email]);

		if (existingUser.rows[0]) {
			// Existing user - log them in
			const user = existingUser.rows[0];
			const sessionToken = await createSession(c, user);
			setAuthCookies(c, sessionToken, user);
			updateLastSeen(c, user.id);

			// Demo accounts never require passkey setup during App Store review
			if (isDemoEmail(email)) {
				return c.json({
					status: "authenticated",
					user: authUserPayload(user),
					needsPasskeySetup: false,
					sessionToken,
				});
			}

			// Check if they have a passkey
			const passkeys = await c
				.get("db")
				.query("SELECT id FROM passkeys WHERE user_id = $1 LIMIT 1", [user.id]);

			return c.json({
				status: "authenticated",
				user: authUserPayload(user),
				needsPasskeySetup: passkeys.rows.length === 0,
				sessionToken,
			});
		}

		if (isDemoEmail(email)) {
			const username = getDemoUsername(email);
			const inserted = await c
				.get("db")
				.query<User>(
					"INSERT INTO users (username, email) VALUES ($1, $2) RETURNING *",
					[username, email],
				);
			const user = inserted.rows[0];
			const sessionToken = await createSession(c, user);
			setAuthCookies(c, sessionToken, user);
			updateLastSeen(c, user.id);

			return c.json({
				status: "authenticated",
				user: authUserPayload(user),
				needsPasskeySetup: false,
				sessionToken,
			});
		}

		// New user - store pending email and redirect to username selection
		const pendingId = await generatePendingId();
		await c.env.OY2.put(
			`${EMAIL_PENDING_PREFIX}${pendingId}`,
			JSON.stringify({ email }),
			{ expirationTtl: 600 },
		);

		setCookie(c, "email_pending", pendingId, {
			httpOnly: true,
			secure: true,
			sameSite: "Strict",
			path: "/",
			maxAge: 600,
		});

		return c.json({ status: "choose_username", pendingId });
	});

	// Complete registration with username (for new email users)
	app.post("/api/auth/email/complete", async (c: AppContext) => {
		const pendingId =
			getCookie(c, "email_pending") || c.req.header("x-email-pending");
		if (!pendingId) {
			return c.json({ error: "No pending email registration" }, 400);
		}

		const pendingData = await c.env.OY2.get(
			`${EMAIL_PENDING_PREFIX}${pendingId}`,
		);
		if (!pendingData) {
			return c.json({ error: "Email session expired" }, 400);
		}

		const { email } = JSON.parse(pendingData) as { email: string };

		const body = await c.req.json();
		const trimmedUsername = String(body.username || "")
			.trim()
			.toLowerCase();

		if (!trimmedUsername) {
			return c.json({ error: "Username is required" }, 400);
		}
		const moderationError = validateCleanUsername(trimmedUsername);
		if (moderationError) {
			return c.json({ error: moderationError }, 400);
		}

		// Check if username exists
		const existing = await c
			.get("db")
			.query<User>("SELECT * FROM users WHERE LOWER(username) = $1", [
				trimmedUsername,
			]);

		if (existing.rows.length > 0) {
			const existingUser = existing.rows[0];

			// If user already has OAuth linked, they can't claim it via email
			if (existingUser.oauth_provider) {
				return c.json({ error: "Username already taken" }, 400);
			}

			// If user has a passkey, they've already claimed their account
			const passkeys = await c
				.get("db")
				.query("SELECT id FROM passkeys WHERE user_id = $1 LIMIT 1", [
					existingUser.id,
				]);
			if (passkeys.rows.length > 0) {
				return c.json({ error: "Username already taken" }, 400);
			}

			// If user already has an email set, they can't claim it with a different email
			if (existingUser.email && existingUser.email.toLowerCase() !== email) {
				return c.json({ error: "Username already taken" }, 400);
			}

			// Claim the existing user by adding email
			await c
				.get("db")
				.query(`UPDATE users SET email = $1 WHERE id = $2`, [
					email,
					existingUser.id,
				]);
			existingUser.email = email;

			// Clean up pending data
			await c.env.OY2.delete(`${EMAIL_PENDING_PREFIX}${pendingId}`);
			deleteCookie(c, "email_pending", { path: "/" });

			// Create session for claimed user
			const sessionToken = await createSession(c, existingUser);
			setAuthCookies(c, sessionToken, existingUser);
			updateLastSeen(c, existingUser.id);

			return c.json({
				user: authUserPayload(existingUser),
				claimed: true,
				needsPasskeySetup: true,
				sessionToken,
			});
		}

		// Create new user
		const result = await c.get("db").query<User>(
			`INSERT INTO users (username, email)
			 VALUES ($1, $2)
			 RETURNING *`,
			[trimmedUsername, email],
		);

		const user = result.rows[0];

		// Clean up pending data
		await c.env.OY2.delete(`${EMAIL_PENDING_PREFIX}${pendingId}`);
		deleteCookie(c, "email_pending", { path: "/" });

		// Create session
		const sessionToken = await createSession(c, user);
		setAuthCookies(c, sessionToken, user);
		updateLastSeen(c, user.id);

		return c.json({
			user: authUserPayload(user),
			needsPasskeySetup: true,
			sessionToken,
		});
	});

	// Send verification code to add email for authenticated users
	app.post("/api/auth/email/add/send-code", async (c: AppContext) => {
		const user = c.get("user");
		if (!user) {
			return c.json({ error: "Not authenticated" }, 401);
		}

		const body = await c.req.json();
		const email = String(body.email || "")
			.trim()
			.toLowerCase();

		if (!email || !isValidEmail(email)) {
			return c.json({ error: "Invalid email address" }, 400);
		}

		if (user.email?.toLowerCase() === email) {
			return c.json({ status: "already_set", email });
		}

		const existingUser = await c
			.get("db")
			.query<User>("SELECT * FROM users WHERE LOWER(email) = $1", [email]);
		if (existingUser.rows[0] && existingUser.rows[0].id !== user.id) {
			return c.json({ error: "Email already in use" }, 400);
		}

		const now = Math.floor(Date.now() / 1000);

		// Atomic send-rate limit, keyed by the target email (shared with login send-code).
		const rate = await c.get("db").query<{ sends: number }>(
			`INSERT INTO email_send_rate (email, sends, window_started_at)
			 VALUES ($1, 1, $2)
			 ON CONFLICT (email) DO UPDATE SET
			   sends = CASE WHEN email_send_rate.window_started_at > $3
			                THEN email_send_rate.sends + 1 ELSE 1 END,
			   window_started_at = CASE WHEN email_send_rate.window_started_at > $3
			                            THEN email_send_rate.window_started_at ELSE $2 END
			 RETURNING sends`,
			[email, now, now - RATE_WINDOW_SECONDS],
		);
		if (rate.rows[0].sends > MAX_SENDS_PER_WINDOW) {
			return c.json(
				{
					error:
						"Too many requests. Please wait before requesting another code.",
				},
				429,
			);
		}

		// Reserve/reuse a change-email code atomically without resetting attempts on
		// reuse; regenerate (and refresh target_email) when there is no live code for
		// this target.
		const reserved = await c.get("db").query<{ code: string }>(
			`INSERT INTO email_change_codes (user_id, target_email, code, attempts, expires_at)
			 VALUES ($1, $2, $3, 0, $4)
			 ON CONFLICT (user_id) DO UPDATE SET
			   code         = CASE WHEN email_change_codes.expires_at > $5 AND email_change_codes.attempts < $6 AND email_change_codes.target_email = EXCLUDED.target_email
			                       THEN email_change_codes.code ELSE EXCLUDED.code END,
			   attempts     = CASE WHEN email_change_codes.expires_at > $5 AND email_change_codes.attempts < $6 AND email_change_codes.target_email = EXCLUDED.target_email
			                       THEN email_change_codes.attempts ELSE 0 END,
			   target_email = CASE WHEN email_change_codes.expires_at > $5 AND email_change_codes.attempts < $6 AND email_change_codes.target_email = EXCLUDED.target_email
			                       THEN email_change_codes.target_email ELSE EXCLUDED.target_email END,
			   expires_at   = CASE WHEN email_change_codes.expires_at > $5 AND email_change_codes.attempts < $6 AND email_change_codes.target_email = EXCLUDED.target_email
			                       THEN email_change_codes.expires_at ELSE EXCLUDED.expires_at END
			 RETURNING code`,
			[
				user.id,
				email,
				generateVerificationCode(),
				now + CODE_TTL_SECONDS,
				now,
				MAX_CODE_ATTEMPTS,
			],
		);

		const result = await sendEmailCode(c, {
			email,
			code: reserved.rows[0].code,
		});
		if (!result.success) {
			return c.json({ error: result.error || "Failed to send email" }, 500);
		}

		return c.json({ status: "code_sent", email });
	});

	// Verify code and update email for authenticated users
	app.post("/api/auth/email/add/verify", async (c: AppContext) => {
		const user = c.get("user");
		if (!user) {
			return c.json({ error: "Not authenticated" }, 401);
		}

		const body = await c.req.json();
		const code = String(body.code || "").trim();
		if (!code) {
			return c.json({ error: "Code is required" }, 400);
		}

		const now = Math.floor(Date.now() / 1000);
		// Atomically spend one attempt against a live change-email code.
		const claim = await c
			.get("db")
			.query<{ target_email: string; code: string }>(
				`UPDATE email_change_codes
			    SET attempts = attempts + 1
			  WHERE user_id = $1 AND attempts < $2 AND expires_at > $3
			 RETURNING target_email, code`,
				[user.id, MAX_CODE_ATTEMPTS, now],
			);
		if (!claim.rows[0]) {
			return c.json(
				{ error: "Code expired or not found. Please request a new code." },
				400,
			);
		}

		if (!timingSafeEqualString(code, claim.rows[0].code)) {
			return c.json({ error: "Invalid code" }, 400);
		}

		// Code is valid - consume it (single-use).
		const consumed = await c
			.get("db")
			.query("DELETE FROM email_change_codes WHERE user_id = $1", [user.id]);
		if (consumed.rowCount === 0) {
			return c.json({ error: "Invalid code" }, 400);
		}

		// Trust the server-stored target, never the client, for which email to bind.
		const targetEmail = claim.rows[0].target_email;

		const existingUser = await c
			.get("db")
			.query<User>("SELECT * FROM users WHERE LOWER(email) = $1", [
				targetEmail,
			]);
		if (existingUser.rows[0] && existingUser.rows[0].id !== user.id) {
			return c.json({ error: "Email already in use" }, 400);
		}

		await c
			.get("db")
			.query("UPDATE users SET email = $1 WHERE id = $2", [
				targetEmail,
				user.id,
			]);

		return c.json({ status: "email_updated", email: targetEmail });
	});

	// Get pending email info (for username selection screen)
	app.get("/api/auth/email/pending", async (c: AppContext) => {
		const pendingId =
			getCookie(c, "email_pending") || c.req.header("x-email-pending");
		if (!pendingId) {
			return c.json({ error: "No pending email registration" }, 400);
		}

		const pendingData = await c.env.OY2.get(
			`${EMAIL_PENDING_PREFIX}${pendingId}`,
		);
		if (!pendingData) {
			return c.json({ error: "Email session expired" }, 400);
		}

		const { email } = JSON.parse(pendingData) as { email: string };

		return c.json({ provider: "email", email });
	});
}
