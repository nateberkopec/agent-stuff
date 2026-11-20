import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import datasafe from "../../extensions/datasafe/index.ts";

const fixtureModel = {
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function record(entry: Record<string, string | null>) {
	appendFileSync(join(getAgentDir(), "harness-log.jsonl"), `${JSON.stringify(entry)}\n`);
}

globalThis.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	const body = Value.Check(Type.String(), init?.body) ? init.body : null;
	record({ type: "fetch", url, body });

	return new Response(JSON.stringify({ error: { message: "harness rejection" } }), { status: 400 });
};

export default async function harness(pi: ExtensionAPI) {
	const extras = (process.env.DATASAFE_HARNESS_PROVIDERS ?? "").split(",");

	if (extras.includes("foreign")) {
		pi.registerProvider("foreign", {
			api: "openai-completions",
			apiKey: "fixture-not-a-secret",
			baseUrl: "https://foreign.example/v1",
			models: [{ id: "foreign-model", name: "Foreign model", ...fixtureModel }],
		});
	}

	await datasafe(pi);
}
