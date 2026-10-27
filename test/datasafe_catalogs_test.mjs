import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, eventually, json, OPENROUTER_US, storedModel } from "./support/datasafe.mjs";

const HAIKU = "anthropic/claude-haiku-4.5";

const GEMINI = "google/gemini-2.5-pro";

const OFFLINE_SESSION = [[], { providers: [] }];

const only = (provider, ids) =>
	ids.filter((id) => id.startsWith(`${provider}/`)).map((id) => id.slice(provider.length + 1));

const storedIds = (a, provider) => a.stored()[provider].models.map(({ id }) => id);

test("OpenRouter starts closed without a catalog and restores only US-endpoint caches", (t) => {
	const cold = agent(t);

	assert.deepEqual(only("openrouter", cold.listModels("openrouter")), []);

	const us = agent(t, {
		"models-store.json": { openrouter: { models: [storedModel("openrouter", HAIKU)], checkedAt: 1 } },
	});

	assert.deepEqual(only("openrouter", us.listModels("openrouter")), [HAIKU]);

	const global = agent(t, {
		"models-store.json": {
			openrouter: {
				models: [
					storedModel("openrouter", HAIKU),
					storedModel("openrouter", GEMINI, { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }),
				],
				checkedAt: 1,
			},
		},
	});

	assert.deepEqual(only("openrouter", global.listModels("openrouter")), []);
});

test("OpenRouter refreshes in the background after startup without delaying --list-models", async (t) => {
	const a = agent(t, {
		"models-store.json": { openrouter: { models: [storedModel("openrouter", HAIKU)], checkedAt: 0 } },
		"harness-routes.json": { [`${OPENROUTER_US}/models`]: json({ data: [{ id: HAIKU }, { id: GEMINI }] }) },
	});

	assert.deepEqual(only("openrouter", a.listModels("openrouter", { offline: false })), [HAIKU]);
	assert.deepEqual(a.fetches(), []);

	const session = a.rpc([], { offline: false });

	await eventually(async () => assert.deepEqual(only("openrouter", await session.models()).sort(), [HAIKU, GEMINI]));
	assert.equal(await session.close(), 0);
	assert.deepEqual(storedIds(a, "openrouter").sort(), [HAIKU, GEMINI]);
	assert.deepEqual(only("openrouter", a.listModels("openrouter")).sort(), [HAIKU, GEMINI]);
	assert.ok(a.fetches().some(({ url }) => url === `${OPENROUTER_US}/models`));
});

test("OpenRouter discovery honors the one-hour cache and revalidates with its ETag", async (t) => {
	const cached = (checkedAt) => ({ openrouter: { models: [storedModel("openrouter", HAIKU)], checkedAt, etag: "v1" } });
	const a = agent(t, { "models-store.json": cached(Date.now()) });
	const session = a.rpc(...OFFLINE_SESSION);

	assert.deepEqual(await a.refresh(session, "openrouter"), []);
	assert.deepEqual(a.fetches(), []);

	a.write("models-store.json", cached(0));
	a.write("harness-routes.json", { [`${OPENROUTER_US}/models`]: { status: 304, headers: { etag: "v2" } } });

	assert.deepEqual(await a.refresh(session, "openrouter"), []);
	assert.equal(a.fetches()[0].ifNoneMatch, "v1");
	assert.equal(a.stored().openrouter.etag, "v2");
	assert.ok(a.stored().openrouter.checkedAt > 0);
	assert.deepEqual(only("openrouter", await session.models()), [HAIKU]);
});

test("OpenRouter discovery failures keep the cached catalog", async (t) => {
	const store = { openrouter: { models: [storedModel("openrouter", HAIKU)], checkedAt: 0 } };
	const a = agent(t, { "models-store.json": store });
	const session = a.rpc(...OFFLINE_SESSION);

	const failures = [
		[{ status: 500 }, /HTTP 500/],
		[json({ data: [{ id: "unknown/model" }] }), /matched no built-in models/],
		[json({ data: [{ name: "no id" }] }), /without an id/],
		[json({ models: [] }), /invalid response/],
	];

	for (const [response, error] of failures) {
		a.write("harness-routes.json", { [`${OPENROUTER_US}/models`]: response });
		const [message] = await a.refresh(session, "openrouter");

		assert.match(message, error);
		assert.deepEqual(only("openrouter", await session.models()), [HAIKU]);
		assert.deepEqual(a.stored(), store);
	}
});

test("subagent launches see catalog changes persisted by other Pi processes", async (t) => {
	const catalog = (openrouter, checkedAt) => ({
		openrouter: { models: [storedModel("openrouter", openrouter)], checkedAt },
	});

	const a = agent(t, { "models-store.json": catalog(HAIKU, 1) });
	const session = a.rpc(["--provider", "meridian", "--model", "claude-harness"], { providers: ["meridian"] });

	assert.ok((await session.models()).includes(`openrouter/${HAIKU}`));
	a.write("models-store.json", catalog(GEMINI, 2));
	assert.ok((await session.models()).includes(`openrouter/${HAIKU}`), "the running registry is stale before launch");

	await session.prompt("launch a subagent");
	const { models } = a.log().find(({ type }) => type === "subagent");

	assert.deepEqual(only("openrouter", models), [GEMINI]);
});
