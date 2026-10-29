import assert from "node:assert/strict";
import { test } from "node:test";
import { agent } from "./support/datasafe.mjs";

const providersOf = (ids) => [...new Set(ids.map((id) => id.split("/")[0]))].sort();

const customProvider = {
	providers: {
		custom: {
			baseUrl: "https://custom.example/v1",
			apiKey: "fake",
			api: "openai-completions",
			models: [{ id: "custom-model", contextWindow: 8192, maxTokens: 1024 }],
		},
	},
};

test("usa-no-train lists only profile providers and refuses to select others", (t) => {
	const a = agent(t, { "models.json": customProvider });

	assert.deepEqual(providersOf(a.listModels()), ["openai", "vercel-ai-gateway"]);

	const { output } = a.prompt(["--provider", "anthropic", "--model", "claude-sonnet-4-6"]);

	assert.match(output, /Unknown provider "anthropic"/);
	assert.deepEqual(a.fetches(), []);
});

test("unrestricted exposes built-in and configured providers", (t) => {
	const a = agent(t, { "models.json": customProvider });
	const providers = providersOf(a.listModels(undefined, { mode: "unrestricted" }));

	for (const provider of ["anthropic", "custom", "openai", "openrouter"]) {
		assert.ok(providers.includes(provider), provider);
	}
});

test("catalog updates for pinned providers stay visible and usable", (t) => {
	const a = agent(t, {
		"models-store.json": {
			openai: {
				models: [
					{
						id: "gpt-catalog-update",
						name: "Catalog update",
						provider: "openai",
						api: "openai-responses",
						baseUrl: "https://api.openai.com/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 1024,
					},
				],
				checkedAt: Date.now(),
				lastModified: Date.now(),
			},
		},
	});

	assert.ok(a.listModels("gpt-catalog-update").includes("openai/gpt-catalog-update"));

	const { output } = a.prompt(["--provider", "openai", "--model", "gpt-catalog-update"]);

	assert.doesNotMatch(output, /Datasafe blocked/);
	assert.match(a.fetches()[0].url, /^https:\/\/api\.openai\.com\/v1\/responses/);
});

test("an unknown profile fails closed to usa-no-train", (t) => {
	const a = agent(t);

	assert.deepEqual(providersOf(a.listModels(undefined, { mode: "not-a-profile" })), ["openai", "vercel-ai-gateway"]);
});

test("a missing default model falls back to a model inside the profile", (t) => {
	const expected = {
		"usa-no-train": /^https:\/\/(api\.openai\.com|ai-gateway\.vercel\.sh)\//,
		unrestricted: /^https:\/\//,
	};

	for (const [mode, host] of Object.entries(expected)) {
		const a = agent(t, { "settings.json": { defaultProvider: "xai", defaultModel: "missing-model" } });
		const { output } = a.prompt([], { mode });
		const fetches = a.fetches();

		assert.doesNotMatch(output, /Datasafe blocked/, mode);
		assert.equal(fetches.length, 1, mode);
		assert.match(fetches[0].url, host, mode);
	}
});

test("resuming a session whose model left the profile falls back to a compliant model", (t) => {
	const a = agent(t);
	const session = ["--session-dir", `${a.dir}/sessions`];

	a.pi([...session, "--provider", "anthropic", "--model", "claude-sonnet-4-6", "-p", "secret"], {
		mode: "unrestricted",
	});
	const { output } = a.pi([...session, "--continue", "-p", "remember?"]);
	const urls = a.fetches().map(({ url }) => url);

	assert.doesNotMatch(output, /Datasafe blocked/);
	assert.equal(urls.length, 2);
	assert.match(urls[0], /^https:\/\/api\.anthropic\.com\//);
	assert.match(urls[1], /^https:\/\/api\.openai\.com\//);
});

test("requests to providers registered by other extensions outside the profile never leave the machine", (t) => {
	const a = agent(t);
	const { status } = a.prompt(["--provider", "foreign", "--model", "foreign-model"], { providers: ["foreign"] });

	assert.notEqual(status, 0);
	assert.deepEqual(a.fetches(), []);
});
