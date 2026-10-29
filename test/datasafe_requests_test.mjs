import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, storedModel } from "./support/datasafe.mjs";

const HAIKU = "anthropic/claude-haiku-4.5";

const catalogs = () => ({
	"models-store.json": {
		openrouter: { models: [storedModel("openrouter", HAIKU)], checkedAt: Date.now() },
	},
});

function send(t, provider, model, options) {
	const a = agent(t, catalogs());
	const { output } = a.prompt(["--provider", provider, "--model", model], options);
	const fetches = a.fetches();

	return { output, fetches, request: fetches.at(-1) && { ...fetches.at(-1), body: JSON.parse(fetches.at(-1).body) } };
}

test("OpenRouter requests use the US endpoint and deny data collection without dropping routing", (t) => {
	const { request } = send(t, "openrouter", HAIKU, {
		payload: { provider: { order: ["anthropic"], data_collection: "allow" } },
	});

	assert.match(request.url, /^https:\/\/us\.openrouter\.ai\/api\/v1\/messages/);
	assert.deepEqual(request.body.provider, { order: ["anthropic"], data_collection: "deny" });
});

test("Vercel requests pin US inference and disallow prompt training without dropping gateway options", (t) => {
	const { request } = send(t, "vercel-ai-gateway", HAIKU, {
		payload: { providerOptions: { gateway: { order: ["anthropic"], disallowPromptTraining: false } } },
	});

	assert.match(request.url, /^https:\/\/ai-gateway\.vercel\.sh\//);
	assert.deepEqual(request.body.providerOptions.gateway, {
		order: ["anthropic"],
		inferenceRegion: { scope: "zone", geoRegion: "us" },
		disallowPromptTraining: true,
	});
});

test("models.json endpoint overrides cannot redirect allowed providers", (t) => {
	const cases = [
		["openrouter", HAIKU],
		["vercel-ai-gateway", HAIKU],
		["openai", "gpt-4o-mini"],
	];

	for (const [provider, model] of cases) {
		const a = agent(t, {
			...catalogs(),
			"models.json": { providers: { [provider]: { baseUrl: "https://evil.example/v1" } } },
		});

		const { output } = a.prompt(["--provider", provider, "--model", model]);

		assert.match(output, new RegExp(`Datasafe blocked ${provider} model or endpoint`), provider);
		assert.deepEqual(a.fetches(), [], provider);
	}
});

test("Vertex requests require a US region over application default credentials", (t) => {
	const vertex = (auth) => {
		const a = agent(t, {
			"adc.json": { type: "service_account", project_id: "project", private_key: "not-a-key" },
			...(auth && { "auth.json": { "google-vertex": { type: "api_key", env: auth } } }),
		});

		const env = { GOOGLE_APPLICATION_CREDENTIALS: `${a.dir}/adc.json`, GOOGLE_CLOUD_PROJECT: "project" };

		return (extra) => {
			const { output } = a.prompt(["--provider", "google-vertex", "--model", "gemini-2.5-pro"], {
				extra: { ...env, ...extra },
			});

			assert.deepEqual(a.fetches(), []);

			return output;
		};
	};

	const fromEnv = vertex();
	const fromCredential = (location) => vertex({ GOOGLE_CLOUD_PROJECT: "project", GOOGLE_CLOUD_LOCATION: location })();

	assert.match(fromEnv({ GOOGLE_CLOUD_LOCATION: "europe-west4" }), /outside a US region: europe-west4/);
	assert.match(fromEnv({ GOOGLE_CLOUD_LOCATION: "global" }), /outside a US region: global/);
	assert.match(fromEnv({ GOOGLE_CLOUD_API_KEY: "key", GOOGLE_CLOUD_LOCATION: "us-central1" }), /API-key mode/);
	assert.match(fromCredential("europe-west4"), /outside a US region: europe-west4/);

	for (const location of ["us", "us-central1"]) {
		assert.doesNotMatch(fromEnv({ GOOGLE_CLOUD_LOCATION: location }), /Datasafe blocked/, location);
		assert.doesNotMatch(fromCredential(location), /Datasafe blocked/, location);
	}
});
