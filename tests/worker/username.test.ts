import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeUsername, validateUsername } from "../../worker/lib";

describe("username validation", () => {
	it("normalizes to a trimmed, lowercased string", () => {
		assert.equal(normalizeUsername("  Zed  "), "zed");
		assert.equal(normalizeUsername(undefined), "");
		assert.equal(normalizeUsername(null), "");
		assert.equal(normalizeUsername(12), "12");
	});

	it("accepts letters, numbers, and underscores", () => {
		assert.equal(validateUsername("zed"), null);
		assert.equal(validateUsername("Zed_99"), null);
		assert.equal(validateUsername("a".repeat(20)), null);
	});

	it("rejects usernames outside the 2-20 character range", () => {
		assert.equal(validateUsername(""), "Username must be 2-20 characters");
		assert.equal(validateUsername("a"), "Username must be 2-20 characters");
		assert.equal(
			validateUsername("a".repeat(21)),
			"Username must be 2-20 characters",
		);
		assert.equal(
			validateUsername("a".repeat(300)),
			"Username must be 2-20 characters",
		);
	});

	it("rejects HTML, newlines, unicode, and whitespace", () => {
		const badCharsError =
			"Username can only contain letters, numbers, and underscores";
		assert.equal(validateUsername("<b>zed</b>"), badCharsError);
		assert.equal(validateUsername("zed\nOy from evil"), badCharsError);
		assert.equal(validateUsername("zed‮gnihsihp"), badCharsError);
		assert.equal(validateUsername("zed 🎉"), badCharsError);
		assert.equal(validateUsername("zed user"), badCharsError);
		assert.equal(validateUsername("zed-user"), badCharsError);
		assert.equal(validateUsername("zed@example.com"), badCharsError);
	});

	it("rejects profanity", () => {
		assert.equal(
			validateUsername("shitname"),
			"Username contains disallowed language",
		);
	});
});
