import assert from "node:assert/strict";
import { test } from "node:test";
import { agent } from "./support/datasafe.mjs";

const FLASH = "deepseek-ai/DeepSeek-V4.1-Flash";

test("Baseten requests use the built-in Model APIs endpoint", (t) => {
	const a = agent(t);
	const { output } = a.prompt(["--provider", "baseten", "--model", FLASH]);

	assert.doesNotMatch(output, /Datasafe blocked/);
	assert.match(a.fetches()[0].url, /^https:\/\/inference\.baseten\.co\/v1\//);
});

test("models.json endpoint overrides cannot redirect allowed providers", (t) => {
	const cases = [
		["baseten", FLASH],
		["openai", "gpt-4o-mini"],
	];

	for (const [provider, model] of cases) {
		const a = agent(t, { "models.json": { providers: { [provider]: { baseUrl: "https://evil.example/v1" } } } });

		const { output } = a.prompt(["--provider", provider, "--model", model]);

		assert.match(output, new RegExp(`Datasafe blocked ${provider} model or endpoint`), provider);
		assert.deepEqual(a.fetches(), [], provider);
	}
});

test("Vertex requests require a US or EU region over application default credentials", (t) => {
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

	assert.match(fromEnv({ GOOGLE_CLOUD_LOCATION: "asia-east1" }), /outside a US or EU region: asia-east1/);
	assert.match(fromEnv({ GOOGLE_CLOUD_LOCATION: "global" }), /outside a US or EU region: global/);
	assert.match(fromEnv({ GOOGLE_CLOUD_API_KEY: "key", GOOGLE_CLOUD_LOCATION: "us-central1" }), /API-key mode/);
	assert.match(fromCredential("asia-east1"), /outside a US or EU region: asia-east1/);

	for (const location of ["us", "us-central1", "eu", "europe-west4"]) {
		assert.doesNotMatch(fromEnv({ GOOGLE_CLOUD_LOCATION: location }), /Datasafe blocked/, location);
		assert.doesNotMatch(fromCredential(location), /Datasafe blocked/, location);
	}
});
