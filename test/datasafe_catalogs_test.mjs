import assert from "node:assert/strict";
import { test } from "node:test";
import {
	agent,
	eventually,
	FIREWORKS_DOCS,
	FIREWORKS_US,
	json,
	OPENROUTER_US,
	storedModel,
} from "./support/datasafe.mjs";

const HAIKU = "anthropic/claude-haiku-4.5";

const GEMINI = "google/gemini-2.5-pro";

const KIMI = "accounts/fireworks/routers/kimi-k3-us";

const MUSE = "accounts/fireworks/models/muse-spark-open";

const OFFLINE_SESSION = [[], { providers: [] }];

const only = (provider, ids) =>
	ids.filter((id) => id.startsWith(`${provider}/`)).map((id) => id.slice(provider.length + 1));

const storedIds = (a, provider) => a.stored()[provider].models.map(({ id }) => id);

const docs = (rows) =>
	[
		"# US-only Serverless",
		"",
		"## Available models",
		"",
		"| Model | `model` ID |",
		"| --- | --- |",
		...rows.map(([name, id]) => `| ${name} | \`${id}\` |`),
		"",
		"## How to use it",
	].join("\n");

const apiModel = (id, overrides = {}) => ({
	id,
	context_length: 200_000,
	supports_chat: true,
	supports_image_input: false,
	...overrides,
});

const fireworksRoutes = (rows, apiModels) => ({
	[FIREWORKS_DOCS]: { body: docs(rows) },
	[`${FIREWORKS_US}/models`]: json({ data: apiModels }),
});

const documented = [
	["Kimi K3", KIMI],
	["Muse Spark Open", MUSE],
];

const metadata = [
	apiModel("accounts/fireworks/models/kimi-k3", { supports_image_input: true }),
	apiModel(MUSE, { context_length: 100_000 }),
	apiModel("accounts/fireworks/models/not-in-docs"),
];

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

test("Fireworks restores only cached US-only models at the US endpoint", (t) => {
	const a = agent(t, {
		"models-store.json": {
			fireworks: {
				models: [
					storedModel("fireworks", "accounts/fireworks/models/kimi-k3"),
					storedModel("fireworks", MUSE, { baseUrl: "https://api.fireworks.ai/inference/v1" }),
					storedModel("fireworks", KIMI),
				],
				checkedAt: 1,
			},
		},
	});

	assert.deepEqual(only("fireworks", a.listModels("fireworks")), [KIMI]);
});

test("Fireworks discovery publishes the documented US-only table joined with API metadata", async (t) => {
	const a = agent(t, { "harness-routes.json": fireworksRoutes(documented, metadata) });
	const session = a.rpc(...OFFLINE_SESSION);

	assert.deepEqual(await a.refresh(session, "fireworks"), []);
	assert.deepEqual(only("fireworks", await session.models()), [KIMI, MUSE]);

	const [kimi, muse] = a.stored().fireworks.models;

	assert.deepEqual(kimi.input, ["text", "image"]);
	assert.equal(kimi.maxTokens, 131_072);
	assert.deepEqual(muse.input, ["text"]);
	assert.equal(muse.contextWindow, 100_000);
	assert.equal(muse.maxTokens, 100_000);

	a.write("harness-routes.json", fireworksRoutes(documented, [metadata[0], { ...metadata[1], supports_chat: false }]));

	assert.deepEqual(await a.refresh(session, "fireworks --force"), []);
	assert.deepEqual(only("fireworks", await session.models()), [KIMI]);
});

test("Fireworks discovery refuses unsafe or incomplete catalogs and keeps the cached one", async (t) => {
	const store = { fireworks: { models: [storedModel("fireworks", KIMI)], checkedAt: 0 } };
	const a = agent(t, { "models-store.json": store });
	const session = a.rpc(...OFFLINE_SESSION);
	const unsafe = (id) => fireworksRoutes([documented[0], ["Unsafe", id]], metadata);

	const failures = [
		[unsafe("accounts/other/models/not-us"), /unsafe model ID/],
		[unsafe("accounts/fireworks/models/kimi-k3"), /unsafe model ID/],
		[unsafe("accounts/fireworks/routers/muse-spark-open"), /unsafe model ID/],
		[fireworksRoutes([documented[0], documented[0]], metadata), /duplicate model IDs/],
		[fireworksRoutes([], metadata), /empty or malformed/],
		[{ ...fireworksRoutes(documented, metadata), [FIREWORKS_DOCS]: { body: "# Moved" } }, /no Available models/],
		[
			{ ...fireworksRoutes(documented, metadata), [FIREWORKS_DOCS]: { status: 500 } },
			/documentation returned HTTP 500/,
		],
		[fireworksRoutes(documented, [metadata[0]]), /no usable chat metadata for US-only model: .*muse-spark-open/],
		[fireworksRoutes(documented, [metadata[0], { ...metadata[1], context_length: 0 }]), /muse-spark-open/],
		[fireworksRoutes(documented, [metadata[0], { ...metadata[1], supports_chat: "false" }]), /malformed catalog/],
		[
			fireworksRoutes(
				documented,
				metadata.map((model) => ({ ...model, supports_chat: false })),
			),
			/no usable chat models/,
		],
	];

	for (const [routes, error] of failures) {
		a.write("harness-routes.json", routes);
		const [message] = await a.refresh(session, "fireworks --force");

		assert.match(message, error);
		assert.deepEqual(only("fireworks", await session.models()), [KIMI]);
		assert.deepEqual(a.stored(), store);
	}
});

test("Fireworks discovery honors the one-hour cache", async (t) => {
	const cached = (checkedAt) => ({ fireworks: { models: [storedModel("fireworks", KIMI)], checkedAt } });

	const a = agent(t, {
		"models-store.json": cached(Date.now()),
		"harness-routes.json": fireworksRoutes(documented, metadata),
	});

	const session = a.rpc(...OFFLINE_SESSION);

	assert.deepEqual(await a.refresh(session, "fireworks"), []);
	assert.deepEqual(a.fetches(), []);

	a.write("models-store.json", cached(0));

	assert.deepEqual(await a.refresh(session, "fireworks"), []);
	assert.deepEqual(only("fireworks", await session.models()), [KIMI, MUSE]);
});

test("subagent launches see catalog changes persisted by other Pi processes", async (t) => {
	const catalog = (fireworks, openrouter, checkedAt) => ({
		fireworks: { models: [storedModel("fireworks", fireworks)], checkedAt },
		openrouter: { models: [storedModel("openrouter", openrouter)], checkedAt },
	});

	const old = "accounts/fireworks/routers/old-us";
	const a = agent(t, { "models-store.json": catalog(old, HAIKU, 1) });
	const session = a.rpc(["--provider", "meridian", "--model", "claude-harness"], { providers: ["meridian"] });

	assert.ok((await session.models()).includes(`fireworks/${old}`));
	a.write("models-store.json", catalog(KIMI, GEMINI, 2));
	assert.ok((await session.models()).includes(`fireworks/${old}`), "the running registry is stale before launch");

	await session.prompt("launch a subagent");
	const { models } = a.log().find(({ type }) => type === "subagent");

	assert.deepEqual([...only("fireworks", models), ...only("openrouter", models)], [KIMI, GEMINI]);
});
