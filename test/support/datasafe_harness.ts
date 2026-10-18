import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import datasafe from "../../extensions/datasafe/index.ts";

const Route = Type.Object({
	status: Type.Optional(Type.Number()),
	body: Type.Optional(Type.String()),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const Routes = Type.Record(Type.String(), Route);

const fixtureModel = {
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function record(entry: Record<string, string | number | boolean | string[] | null>) {
	appendFileSync(join(getAgentDir(), "harness-log.jsonl"), `${JSON.stringify(entry)}\n`);
}

function route(url: string) {
	const path = join(getAgentDir(), "harness-routes.json");
	const routes = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

	if (!Value.Check(Routes, routes)) throw new Error("harness-routes.json is malformed");

	return routes[url] ?? { status: 400, body: JSON.stringify({ error: { message: "harness rejection" } }) };
}

globalThis.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
	const body = Value.Check(Type.String(), init?.body) ? init.body : null;
	record({ type: "fetch", url, ifNoneMatch: headers.get("if-none-match"), body });
	const { status, body: responseBody, headers: responseHeaders } = route(url);

	return new Response(status === 304 ? null : (responseBody ?? ""), {
		status: status ?? 200,
		headers: responseHeaders,
	});
};

function reply(model: Model<Api>, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function registerScriptedMeridian(pi: ExtensionAPI) {
	pi.registerProvider("meridian", {
		api: "datasafe-harness",
		apiKey: "fixture-not-a-secret",
		baseUrl: "http://127.0.0.1:3456",
		models: [{ id: "claude-harness", name: "Claude harness", ...fixtureModel }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			const answered = context.messages.at(-1)?.role === "toolResult";

			const message = reply(
				model,
				answered
					? [{ type: "text", text: "done" }]
					: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: {} }],
			);

			queueMicrotask(() => {
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				stream.end();
			});

			return stream;
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Records the model catalog visible when a subagent would launch.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const models = ctx.modelRegistry.getAvailable().map(({ provider, id }) => `${provider}/${id}`);
			record({ type: "subagent", models });

			return { content: [{ type: "text", text: "recorded" }], details: {} };
		},
	});
}

export default async function harness(pi: ExtensionAPI) {
	const extras = (process.env.DATASAFE_HARNESS_PROVIDERS ?? "").split(",");

	if (extras.includes("meridian")) registerScriptedMeridian(pi);

	if (extras.includes("foreign")) {
		pi.registerProvider("foreign", {
			api: "openai-completions",
			apiKey: "fixture-not-a-secret",
			baseUrl: "https://foreign.example/v1",
			models: [{ id: "foreign-model", name: "Foreign model", ...fixtureModel }],
		});
	}

	if (process.env.DATASAFE_HARNESS_PAYLOAD) {
		const overrides = JSON.parse(process.env.DATASAFE_HARNESS_PAYLOAD);

		pi.on("before_provider_request", (event) =>
			Value.Check(Type.Object({}), event.payload) ? { ...event.payload, ...overrides } : event.payload,
		);
	}

	pi.registerCommand("refresh-models", {
		description: "Refresh model catalogs with network access",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/);
			const providers = words.filter((word) => word !== "--force");

			const result = await ctx.modelRegistry.refresh({
				providers,
				allowNetwork: true,
				force: words.includes("--force"),
			});

			record({
				type: "refresh",
				errors: [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`),
			});
		},
	});

	await datasafe(pi);
}
