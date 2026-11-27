import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const PROVIDER = "splash";

const MODEL = "unsloth/Inkling-2-Mini-GGUF:UD-Q4_K_XL";

const PORT = 8888;

const BASE = `http://127.0.0.1:${PORT}`;

const STATE_DIR = join(homedir(), ".splash/pi");

const SERVE_ARGS = [
	"serve",
	"--model",
	MODEL,
	"--port",
	String(PORT),
	"--max-context",
	"128K",
	"--persistent-cache",
	"--no-webui",
];

const Catalog = Type.Object({
	data: Type.Array(
		Type.Object({
			id: Type.String(),
			context_length: Type.Number(),
			input_modalities: Type.Array(Type.String()),
			reasoning: Type.Object({ efforts: Type.Array(Type.String()) }),
		}),
	),
});

type Entry = Static<typeof Catalog>["data"][number];

async function ready(): Promise<boolean> {
	try {
		return (await fetch(`${BASE}/ready`, { signal: AbortSignal.timeout(1500) })).ok;
	} catch {
		return false;
	}
}

function spawnServer(): void {
	mkdirSync(STATE_DIR, { recursive: true });
	const log = openSync(join(STATE_DIR, "serve.log"), "a");

	spawn("lockf", ["-kst", "0", join(STATE_DIR, "serve.lock"), "mise", "exec", "--", "splash", ...SERVE_ARGS], {
		cwd: homedir(),
		detached: true,
		stdio: ["ignore", log, log],
	}).unref();
	closeSync(log);
}

async function ensureServer(signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + 600_000;

	for (let attempt = 0; !(await ready()); attempt++) {
		signal?.throwIfAborted();

		if (Date.now() > deadline) throw new Error(`Splash did not start; see ${join(STATE_DIR, "serve.log")}`);

		if (attempt % 20 === 0) spawnServer();

		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

function toModel(entry: Entry): ProviderModelConfig {
	const level = (name: string) => (entry.reasoning.efforts.includes(name) ? name : null);

	return {
		id: entry.id,
		name: entry.id,
		reasoning: true,
		thinkingLevelMap: {
			off: "none",
			minimal: level("minimal"),
			low: level("low"),
			medium: level("medium"),
			high: level("high"),
			xhigh: level("xhigh"),
		},
		input: entry.input_modalities.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.context_length,
		maxTokens: Math.min(32_000, Math.floor(entry.context_length / 4)),
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			supportsMidConvoSystemMessages: true,
			maxTokensField: "max_tokens",
			thinkingFormat: "openai",
		},
	};
}

const fallback: Entry = {
	id: MODEL,
	context_length: 131_072,
	input_modalities: ["text", "image"],
	reasoning: { efforts: ["minimal", "low", "medium", "high", "xhigh"] },
};

export default function splash(pi: ExtensionAPI) {
	if (process.platform !== "darwin" || process.arch !== "arm64") return;

	pi.registerProvider(PROVIDER, {
		name: "Splash",
		baseUrl: `${BASE}/v1`,
		apiKey: "local",
		api: "openai-completions",
		async refreshModels({ signal }) {
			if (!(await ready())) return [toModel(fallback)];

			const catalog = await (await fetch(`${BASE}/v1/models`, { signal })).json();

			if (!Value.Check(Catalog, catalog)) throw new Error("Splash returned an unexpected model list");

			return catalog.data.map(toModel);
		},
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER || (await ready())) return;

		ctx.ui.setStatus(PROVIDER, "starting Splash…");

		try {
			await ensureServer();
		} finally {
			ctx.ui.setStatus(PROVIDER, undefined);
		}
	});
}
