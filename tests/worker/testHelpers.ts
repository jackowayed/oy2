import app from "../../worker/index";
import { createExecutionContext, createTestEnv } from "./testUtils";

type RequestOptions = {
	method?: string;
	body?: Record<string, unknown>;
	headers?: Record<string, string>;
};

export const jsonRequest = async (
	env: ReturnType<typeof createTestEnv>["env"],
	path: string,
	{ method = "GET", body, headers = {} }: RequestOptions = {},
) => {
	const requestInit: RequestInit = {
		method,
		headers,
	};
	if (body) {
		requestInit.body = JSON.stringify(body);
		requestInit.headers = {
			...headers,
			"content-type": "application/json",
		};
	}
	const req = new Request(`http://localhost${path}`, requestInit);
	const ctx = createExecutionContext();
	const res = await app.request(
		req,
		undefined,
		env as Parameters<typeof app.request>[2],
		ctx,
	);
	const json = (await res.json()) as Record<string, unknown>;
	await Promise.all(ctx.waitUntilPromises);
	return { res, json };
};

export const request = async (
	env: ReturnType<typeof createTestEnv>["env"],
	path: string,
	{
		method = "GET",
		body,
		headers = {},
	}: {
		method?: string;
		body?: string | URLSearchParams;
		headers?: Record<string, string>;
	} = {},
) => {
	const requestInit: RequestInit = {
		method,
		headers,
	};
	if (body) {
		requestInit.body =
			body instanceof URLSearchParams ? body.toString() : body;
		requestInit.headers = headers;
	}
	const req = new Request(`http://localhost${path}`, requestInit);
	const ctx = createExecutionContext();
	const res = await app.request(
		req,
		undefined,
		env as Parameters<typeof app.request>[2],
		ctx,
	);
	await Promise.all(ctx.waitUntilPromises);
	return res;
};

export const getSessionToken = (res: Response) => {
	const setCookie = getSetCookieHeader(res);
	if (!setCookie) {
		return null;
	}
	const match = /(?:^|,)\s*session=([^;]+)/.exec(setCookie);
	return match ? match[1] : null;
};

const getSetCookieHeader = (res: Response) => {
	const headers = res.headers as Headers & { getSetCookie?: () => string[] };
	const values = headers.getSetCookie?.();
	if (values?.length) {
		return values.join(", ");
	}
	const entryValues = [...res.headers.entries()]
		.filter(([name]) => name.toLowerCase() === "set-cookie")
		.map(([, value]) => value);
	return entryValues.length
		? entryValues.join(", ")
		: res.headers.get("set-cookie");
};

export const getCookieValue = (res: Response, name: string) => {
	const setCookie = getSetCookieHeader(res);
	if (!setCookie) {
		return null;
	}
	const match = new RegExp(`(?:^|,)\\s*${name}=([^;]+)`).exec(setCookie);
	return match ? match[1] : null;
};
