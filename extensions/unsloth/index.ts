import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const PROVIDER = "unsloth";

const PORT = 8888;

const IDLE_SECONDS = 600;

const BASE = `http://127.0.0.1:${PORT}`;

const UNSLOTH = join(homedir(), ".local/bin/unsloth");

const KEY_FILE = join(homedir(), ".unsloth/studio/auth/.cli_api_key_cli_99bb88401742");

const STATE_DIR = join(homedir(), ".unsloth/pi");

const CACHE_FILE = join(STATE_DIR, "models.json");

const SERVE = join(dirname(fileURLToPath(import.meta.url)), "serve");

const Catalog = Type.Object({
	data: Type.Array(
		Type.Object({
			id: Type.String(),
			loaded: Type.Optional(Type.Boolean()),
			context_length: Type.Optional(Type.Number()),
		}),
	),
});

const Props = Type.Object({
	modalities: Type.Optional(Type.Object({ vision: Type.Optional(Type.Boolean()) })),
	chat_template_caps: Type.Optional(Type.Object({ reasoning_effort_levels: Type.Optional(Type.Array(Type.String())) })),
});

const Spec = Type.Object({
	id: Type.String(),
	contextWindow: Type.Number(),
	levels: Type.Array(Type.String()),
	vision: Type.Boolean(),
	probed: Type.Boolean(),
});

type Spec = Static<typeof Spec>;

function readCache(): Spec[] {
	try {
		const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8"));

		return Value.Check(Type.Array(Spec), cached) ? cached : [];
	} catch {
		return [];
	}
}

async function getJson(path: string, signal: AbortSignal) {
	const response = await fetch(`${BASE}${path}`, {
		headers: { Authorization: `Bearer ${readFileSync(KEY_FILE, "utf8").trim()}` },
		signal,
	});

	if (!response.ok) throw new Error(`Unsloth ${path}: HTTP ${response.status}`);

	return response.json();
}

async function healthy(): Promise<boolean> {
	try {
		return (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
	} catch {
		return false;
	}
}

function spawnServer(): void {
	mkdirSync(STATE_DIR, { recursive: true });
	const log = openSync(join(STATE_DIR, "serve.log"), "a");
	const lock = join(STATE_DIR, "serve.lock");

	spawn("lockf", ["-kst", "0", lock, SERVE, String(PORT), String(IDLE_SECONDS), KEY_FILE], {
		detached: true,
		stdio: ["ignore", log, log],
	}).unref();
	closeSync(log);
}

async function ensureServer(signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + 60_000;

	for (let attempt = 0; !(await healthy()); attempt++) {
		signal?.throwIfAborted();

		if (Date.now() > deadline) throw new Error(`Unsloth did not start; see ${join(STATE_DIR, "serve.log")}`);

		if (attempt % 10 === 0) spawnServer();

		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

async function probe(id: string, contextWindow: number, signal: AbortSignal): Promise<Spec> {
	const props = await getJson("/v1/props", signal);

	if (!Value.Check(Props, props)) throw new Error("Unsloth returned unexpected server properties");

	return {
		id,
		contextWindow,
		levels: props.chat_template_caps?.reasoning_effort_levels ?? [],
		vision: props.modalities?.vision === true,
		probed: true,
	};
}

async function discover(signal: AbortSignal): Promise<Spec[]> {
	const cached = new Map(readCache().map((spec) => [spec.id, spec]));
	const catalog = await getJson("/v1/models", signal);

	if (!Value.Check(Catalog, catalog)) throw new Error("Unsloth returned an unexpected model list");

	const specs = await Promise.all(
		catalog.data.map(async (model) => {
			if (model.loaded && model.context_length) return probe(model.id, model.context_length, signal);

			return cached.get(model.id) ?? { id: model.id, contextWindow: 32_768, levels: [], vision: false, probed: false };
		}),
	);

	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(CACHE_FILE, JSON.stringify(specs, null, 2));

	return specs;
}

function toModel(spec: Spec): ProviderModelConfig {
	const reasoning = spec.levels.length > 0;
	const level = (name: string) => (spec.levels.includes(name) ? name : null);

	return {
		id: spec.id,
		name: spec.id,
		reasoning,
		thinkingLevelMap: {
			off: level("off"),
			minimal: level("minimal"),
			low: level("low"),
			medium: level("medium"),
			high: level("high"),
			xhigh: level("xhigh") ?? level("max"),
		},
		input: spec.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: spec.contextWindow,
		maxTokens: Math.min(32_000, Math.floor(spec.contextWindow / 4)),
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: reasoning,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
			thinkingFormat: "openai",
		},
	};
}

export default function unsloth(pi: ExtensionAPI) {
	if (process.platform !== "darwin" || !existsSync(UNSLOTH)) return;

	pi.registerProvider(PROVIDER, {
		name: "Unsloth",
		baseUrl: `${BASE}/v1`,
		apiKey: `!cat ${KEY_FILE}`,
		api: "openai-completions",
		async refreshModels({ signal }) {
			const cached = readCache();

			if (cached.length > 0 && !(await healthy())) return cached.map(toModel);

			await ensureServer(signal);

			return (await discover(signal)).map(toModel);
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER || readCache().every((spec) => spec.probed)) return;

		await ctx.modelRegistry.refresh({ providers: [PROVIDER] });
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER || (await healthy())) return;

		ctx.ui.setStatus(PROVIDER, "starting Unsloth…");

		try {
			await ensureServer();
		} finally {
			ctx.ui.setStatus(PROVIDER, undefined);
		}
	});
}
