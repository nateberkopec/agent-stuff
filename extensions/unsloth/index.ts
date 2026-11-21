import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const SNAPSHOT_PREFIX = "pi-prefix-";

const STALE_SNAPSHOT_MS = 5_000;

const Payload = Type.Object({
	model: Type.String(),
	messages: Type.Array(Type.Object({ role: Type.String(), content: Type.Optional(Type.Unknown()) })),
	tools: Type.Optional(Type.Array(Type.Unknown())),
	max_tokens: Type.Optional(Type.Number()),
	stream: Type.Optional(Type.Boolean()),
	stream_options: Type.Optional(Type.Object({})),
});

type Payload = Static<typeof Payload>;

interface Engine {
	base: string;
	key: string;
	slotDir: string;
	snapshot: string;
}

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

async function postChat(body: Payload): Promise<void> {
	const response = await fetch(`${BASE}/v1/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${readFileSync(KEY_FILE, "utf8").trim()}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) throw new Error(`Unsloth chat: HTTP ${response.status}`);

	await response.arrayBuffer();
}

async function loaded(id: string): Promise<boolean> {
	try {
		const catalog = await getJson("/v1/models", AbortSignal.timeout(5000));

		return Value.Check(Catalog, catalog) && catalog.data.some((model) => model.id === id && model.loaded === true);
	} catch {
		return false;
	}
}

function findEngine(): Engine | undefined {
	const processes = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" }).stdout.split("\n");
	const launch = processes.find((line) => line.includes("/llama-server ") && line.includes("--slot-save-path "));
	const port = launch?.match(/--port (\d+)/)?.[1];
	const keyFile = launch?.match(/--api-key-file (\S+)/)?.[1];
	const slotDir = launch?.match(/--slot-save-path (\S+)/)?.[1];

	if (!launch || !port || !keyFile || !slotDir) return undefined;

	const flags = launch.replace(/--(port|fit-target) \d+/g, "").replace(/--api-key-file \S+/, "");

	return {
		base: `http://127.0.0.1:${port}`,
		key: readFileSync(keyFile, "utf8").trim(),
		slotDir,
		snapshot: `${SNAPSHOT_PREFIX}${createHash("sha256").update(flags).digest("hex").slice(0, 12)}.bin`,
	};
}

async function slotAction(engine: Engine, action: "save" | "restore"): Promise<boolean> {
	const response = await fetch(`${engine.base}/slots/0?action=${action}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${engine.key}`, "Content-Type": "application/json" },
		body: JSON.stringify({ filename: engine.snapshot }),
	});

	await response.arrayBuffer();

	return response.ok;
}

async function prime(payload: Payload): Promise<void> {
	await postChat({ model: payload.model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
	const engine = findEngine();

	if (!engine) return;

	const restored = await slotAction(engine, "restore");
	const firstUser = payload.messages.findIndex((message) => message.role === "user");
	const started = Date.now();

	await postChat({
		...payload,
		messages: payload.messages.slice(0, firstUser + 1),
		max_tokens: 1,
		stream: false,
		stream_options: undefined,
	});

	if (restored && Date.now() - started < STALE_SNAPSHOT_MS) return;

	for (const file of readdirSync(engine.slotDir)) {
		if (file.startsWith(SNAPSHOT_PREFIX) && file !== engine.snapshot) rmSync(join(engine.slotDir, file));
	}

	await slotAction(engine, "save");
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

	pi.on("before_provider_request", async (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER || (await loaded(ctx.model.id))) return;

		ctx.ui.setStatus(PROVIDER, "loading Unsloth model…");

		try {
			await ensureServer();

			if (Value.Check(Payload, event.payload)) await prime(event.payload);
		} finally {
			ctx.ui.setStatus(PROVIDER, undefined);
		}
	});
}
