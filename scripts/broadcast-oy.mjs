#!/usr/bin/env node
/**
 * Send an Oy to every one of your friends.
 *
 * Standalone: no dependencies, no build step. Copy this file anywhere and run
 * it with Node 20+.
 *
 *   node broadcast-oy.mjs login          # email-code sign in, saves a token
 *   node broadcast-oy.mjs friends        # list who would receive an Oy
 *   node broadcast-oy.mjs send           # send an Oy to everyone
 *   node broadcast-oy.mjs send --dry-run
 *
 * Options (all commands):
 *   --base-url <url>     API origin (default https://oyme.site, or OY_BASE_URL)
 *   --token <jwt>        session token (default OY_TOKEN, else the token file)
 *   --token-file <path>  where to read/write the token (default ~/.oy-cli.json)
 *
 * Options (send):
 *   --dry-run            print the recipients, send nothing
 *   --only a,b,c         only these usernames
 *   --exclude a,b,c      skip these usernames
 *   --delay <ms>         pause between sends (default 250)
 *   --yes                skip the confirmation prompt
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const DEFAULT_BASE_URL = "https://oyme.site";
const DEFAULT_TOKEN_FILE = join(homedir(), ".oy-cli.json");

function parseArgs(argv) {
	const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "send";
	const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;
	const flags = {};
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (!arg.startsWith("--")) {
			throw new UserError(`Unexpected argument: ${arg}`);
		}
		const name = arg.slice(2);
		if (name === "dry-run" || name === "yes") {
			flags[name] = true;
			continue;
		}
		const value = rest[++i];
		if (value === undefined) {
			throw new UserError(`Missing value for --${name}`);
		}
		flags[name] = value;
	}
	return { command, flags };
}

class UserError extends Error {}

function baseUrlFrom(flags) {
	return (
		flags["base-url"] ??
		process.env.OY_BASE_URL ??
		DEFAULT_BASE_URL
	).replace(/\/$/, "");
}

function tokenFileFrom(flags) {
	return flags["token-file"] ?? process.env.OY_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
}

async function readStoredToken(path) {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (!raw) {
		return null;
	}
	return JSON.parse(raw).token ?? null;
}

async function resolveToken(flags) {
	const token =
		flags.token ??
		process.env.OY_TOKEN ??
		(await readStoredToken(tokenFileFrom(flags)));
	if (!token) {
		throw new UserError(
			"No session token. Run `node broadcast-oy.mjs login`, or set OY_TOKEN.",
		);
	}
	return token;
}

async function api(baseUrl, path, { method = "GET", token, body } = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	const text = await response.text();
	const data = text ? JSON.parse(text) : {};
	if (!response.ok) {
		throw new UserError(
			`${method} ${path} failed (${response.status}): ${data.error ?? text}`,
		);
	}
	return data;
}

async function prompt(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(question);
	rl.close();
	return answer.trim();
}

async function login(flags) {
	const baseUrl = baseUrlFrom(flags);
	const email = flags.email ?? (await prompt("Email: "));

	await api(baseUrl, "/api/auth/email/send-code", {
		method: "POST",
		body: { email },
	});
	console.log(`Sent a verification code to ${email}.`);

	const code = await prompt("Code: ");
	const result = await api(baseUrl, "/api/auth/email/verify", {
		method: "POST",
		body: { email, code },
	});

	if (result.status !== "authenticated") {
		throw new UserError(
			"That email has no Oy account yet. Sign up in the app first, then run login again.",
		);
	}

	const tokenFile = tokenFileFrom(flags);
	await writeFile(
		tokenFile,
		`${JSON.stringify({ baseUrl, token: result.sessionToken }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	console.log(
		`Logged in as ${result.user.username}. Token saved to ${tokenFile}.`,
	);
}

function splitList(value) {
	return value
		? value
				.split(",")
				.map((entry) => entry.trim().toLowerCase())
				.filter(Boolean)
		: [];
}

async function loadRecipients(baseUrl, token, flags) {
	const { friends } = await api(baseUrl, "/api/friends?no-cache=true", {
		token,
	});
	const only = new Set(splitList(flags.only));
	const exclude = new Set(splitList(flags.exclude));

	const recipients = friends.filter(
		(friend) =>
			(only.size === 0 || only.has(friend.username.toLowerCase())) &&
			!exclude.has(friend.username.toLowerCase()),
	);

	for (const username of only) {
		const matched = recipients.some(
			(friend) => friend.username.toLowerCase() === username,
		);
		if (!matched) {
			throw new UserError(`Not in your friends list: ${username}`);
		}
	}
	return recipients;
}

function describe(friend) {
	return friend.nickname
		? `${friend.username} (${friend.nickname})`
		: friend.username;
}

async function listFriends(flags) {
	const baseUrl = baseUrlFrom(flags);
	const token = await resolveToken(flags);
	const recipients = await loadRecipients(baseUrl, token, flags);
	for (const friend of recipients) {
		console.log(`${friend.id}\t${describe(friend)}`);
	}
	console.log(`\n${recipients.length} friend(s).`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(flags) {
	const baseUrl = baseUrlFrom(flags);
	const token = await resolveToken(flags);
	const delay = Number(flags.delay ?? 250);
	const recipients = await loadRecipients(baseUrl, token, flags);

	if (recipients.length === 0) {
		console.log("No friends to Oy.");
		return;
	}

	console.log(`Oying ${recipients.length} friend(s) on ${baseUrl}:`);
	for (const friend of recipients) {
		console.log(`  - ${describe(friend)}`);
	}

	if (flags["dry-run"]) {
		console.log("\nDry run, nothing sent.");
		return;
	}

	if (!flags.yes) {
		const answer = await prompt("\nSend? [y/N] ");
		if (answer.toLowerCase() !== "y") {
			console.log("Aborted.");
			return;
		}
	}

	const failures = [];
	for (const [index, friend] of recipients.entries()) {
		if (index > 0 && delay > 0) {
			await sleep(delay);
		}
		try {
			const result = await api(baseUrl, "/api/oy", {
				method: "POST",
				token,
				body: { toUserId: friend.id },
			});
			console.log(`oy -> ${describe(friend)} (streak ${result.streak})`);
		} catch (error) {
			failures.push({ friend, error });
			console.error(`failed -> ${describe(friend)}: ${error.message}`);
		}
	}

	console.log(
		`\nSent ${recipients.length - failures.length}/${recipients.length}.`,
	);
	if (failures.length > 0) {
		process.exitCode = 1;
	}
}

const commands = { login, friends: listFriends, send };

async function main() {
	const { command, flags } = parseArgs(process.argv.slice(2));
	const handler = commands[command];
	if (!handler) {
		throw new UserError(
			`Unknown command: ${command}. Expected one of: ${Object.keys(commands).join(", ")}.`,
		);
	}
	await handler(flags);
}

main().catch((error) => {
	console.error(error instanceof UserError ? error.message : error);
	process.exit(1);
});
