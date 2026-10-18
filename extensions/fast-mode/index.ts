/**
 * OpenAI and OpenAI Codex fast mode: priority requests for supported Responses
 * models, with session state, configurable model overrides, and rate-card pricing.
 */

import {
	getAgentDir,
	type ExtensionAPI,
	type SessionEntry,
	type ExtensionContext,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
	calculateCost,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	registerSessionResourceCleanup,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	TranscriptContext,
	Model,
	Usage,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { Type } from "typebox";
import { Value } from "typebox/value";
import { WireValue } from "../shared/wire_value.ts";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type PriorityStreamOptions = SimpleStreamOptions & {
	serviceTier?: "priority";
	reasoningEffort?: SimpleStreamOptions["reasoning"];
};

const CONFIG_BASENAME = "pi-fast-mode.json";

// Footer statuses are rendered alphabetically by key; keep fast mode ahead of MCP.
const STATUS_KEY = "fast-mode";

const COMMAND_FAST = "fast";

const SESSION_STATE_TYPE = "fast-mode-state";

/** Official Codex fast-mode credit multipliers per model (OpenAI Codex rate card). */
const OFFICIAL_FAST_MULTIPLIER = new Map([
	["gpt-6.1-sol", 2.5],
	["gpt-6-astra", 2.5],
	["gpt-5.6-sol", 2.5],
	["gpt-5.6-terra", 2.5],
	["gpt-5.6-luna", 2.5],
	["gpt-5.5", 2.5],
	["gpt-5.4", 2],
]);

/**
 * How a fast tier is applied for one API. One spec per API; everything else in
 * the extension is driven off these.
 */
interface ProviderOverlay {
	/** Provider whose models on `api` should receive the overlay. */
	provider: string;
	api: Api;
	/** Default `provider/model` allowlist entries shipped for this API. */
	defaultModels: readonly string[];
	/** Invoke the raw pi-ai stream for this API (no tier applied). */
	streamRaw: (
		model: Model<Api>,
		context: TranscriptContext,
		options: PriorityStreamOptions,
	) => AssistantMessageEventStream;
}

const PROVIDER_OVERLAYS: readonly ProviderOverlay[] = [
	{
		provider: "openai-codex",
		api: "openai-codex-responses",
		defaultModels: [
			"openai-codex/gpt-5.6-sol",
			"openai-codex/gpt-5.6-terra",
			"openai-codex/gpt-5.6-luna",
			"openai-codex/gpt-6.1-sol",
			"openai-codex/gpt-6-astra",
		],
		streamRaw: (model, context, options) => openAICodexResponsesApi().stream(model, context, options),
	},
	{
		provider: "openai",
		api: "openai-responses",
		defaultModels: ["openai/gpt-6.1-sol", "openai/gpt-6-sol", "openai/gpt-6-astra", "openai/gpt-6-luna"],
		streamRaw: (model, context, options) => openAIResponsesApi().stream(model, context, options),
	},
];

const DEFAULT_MODELS = PROVIDER_OVERLAYS.flatMap((overlay) => overlay.defaultModels).flatMap((key) => {
	const model = parseModelKey(key);

	return model ? [model] : [];
});

interface SupportedModel {
	provider: string;
	id: string;
}

interface ConfigFile {
	/** Record /fast changes in each session's history. */
	persistState?: boolean;
	/** Default fast-mode state for new sessions. */
	active?: boolean;
	serviceTier?: "priority";
	allowlist?: SupportedModel[];
	blocklist?: SupportedModel[];
	multipliers?: Record<string, number>;
}

interface ResolvedConfig {
	configPath: string;
	persistState: boolean;
	active: boolean;
	allowlist: SupportedModel[];
	blocklist: SupportedModel[];
	multipliers: Record<string, number>;
}

interface RuntimeState {
	active: boolean;
}

const DEFAULT_CONFIG: Omit<ResolvedConfig, "configPath"> = {
	persistState: true,
	active: false,
	allowlist: [],
	blocklist: [],
	multipliers: {},
};

const StoredState = Type.Object({ active: Type.Boolean(), serviceTier: Type.String() });

const ConfigInput = Type.Object({
	persistState: Type.Optional(WireValue),
	active: Type.Optional(WireValue),
	serviceTier: Type.Optional(WireValue),
	allowlist: Type.Optional(WireValue),
	blocklist: Type.Optional(WireValue),
	multipliers: Type.Optional(WireValue),
});

/** Restore the latest fast-mode state on the active session branch. */
function readSessionState(entries: readonly SessionEntry[]): RuntimeState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];

		if (entry.type === "custom" && entry.customType === SESSION_STATE_TYPE && Value.Check(StoredState, entry.data)) {
			return { active: entry.data.active && entry.data.serviceTier === "priority" };
		}
	}

	return undefined;
}

function parseModelKey(value: string): SupportedModel | undefined {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");

	if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
	const provider = trimmed.slice(0, slash).trim();
	const id = trimmed.slice(slash + 1).trim();

	return provider && id ? { provider, id } : undefined;
}

function parseModels(value: WireValue): SupportedModel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const models = new Map<string, SupportedModel>();

	for (const entry of value) {
		if (!Value.Check(Type.String(), entry)) continue;
		const model = parseModelKey(entry);

		if (model) models.set(`${model.provider}/${model.id}`, model);
	}

	return [...models.values()];
}

function parseMultipliers(value: WireValue): Record<string, number> | undefined {
	if (!Value.Check(Type.Record(Type.String(), WireValue), value)) return undefined;
	const multipliers: Record<string, number> = {};

	for (const [key, multiplier] of Object.entries(value)) {
		const model = parseModelKey(key);

		if (model && Value.Check(Type.Number({ exclusiveMinimum: 0 }), multiplier) && Number.isFinite(multiplier)) {
			multipliers[`${model.provider}/${model.id}`] = multiplier;
		}
	}

	return multipliers;
}

function configPaths(cwd: string) {
	return {
		project: join(cwd, ".pi", "extensions", CONFIG_BASENAME),
		global: join(getAgentDir(), "extensions", CONFIG_BASENAME),
	};
}

function readConfig(path: string): ConfigFile | undefined {
	if (!existsSync(path)) return undefined;

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));

		if (!Value.Check(ConfigInput, parsed)) return {};
		const config: ConfigFile = {};

		if (Value.Check(Type.Boolean(), parsed.persistState)) config.persistState = parsed.persistState;

		if (Value.Check(Type.Boolean(), parsed.active)) config.active = parsed.active;

		if (parsed.serviceTier === "priority") config.serviceTier = parsed.serviceTier;
		const allowlist = parseModels(parsed.allowlist);

		if (allowlist !== undefined) config.allowlist = allowlist;
		const blocklist = parseModels(parsed.blocklist);

		if (blocklist !== undefined) config.blocklist = blocklist;
		const multipliers = parseMultipliers(parsed.multipliers);

		if (multipliers !== undefined) config.multipliers = multipliers;

		return config;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[${STATUS_KEY}] Failed to read ${path}: ${message}`);

		return undefined;
	}
}

function writeConfig(path: string, active: boolean): void {
	try {
		const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

		if (!Value.Check(Type.Record(Type.String(), WireValue), raw)) throw new Error("Expected a config object");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ ...raw, active }, null, 2)}\n`, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`[${STATUS_KEY}] Failed to write ${path}: ${message}`, { cause: error });
	}
}

function resolveConfig(cwd: string, trusted: boolean): ResolvedConfig {
	const paths = configPaths(cwd);
	const globalConfig = readConfig(paths.global) ?? {};
	const projectConfig = trusted ? (readConfig(paths.project) ?? {}) : {};

	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...projectConfig,
		configPath: trusted && existsSync(paths.project) ? paths.project : paths.global,
	};
}

function contains(list: readonly SupportedModel[], model: Pick<Model<Api>, "provider" | "id">): boolean {
	return list.some((entry) => entry.provider === model.provider && entry.id === model.id);
}

/** True when fast mode is active and the model survives the default/allow/block override. */
function isFastModeActive(
	model: Pick<Model<Api>, "provider" | "id" | "api"> | undefined,
	state: RuntimeState,
	config: ResolvedConfig,
): boolean {
	return (
		state.active &&
		model !== undefined &&
		PROVIDER_OVERLAYS.some((overlay) => overlay.provider === model.provider && overlay.api === model.api) &&
		fastModeMultiplier(model, config) !== undefined &&
		(contains(DEFAULT_MODELS, model) || contains(config.allowlist, model)) &&
		!contains(config.blocklist, model)
	);
}

function fastModeMultiplier(model: Pick<Model<Api>, "provider" | "id">, config: ResolvedConfig): number | undefined {
	return config.multipliers[`${model.provider}/${model.id}`] ?? OFFICIAL_FAST_MULTIPLIER.get(model.id);
}

/**
 * Recompute displayed fast-mode cost: pi-ai's `calculateCost` is idempotent — it
 * reads only raw token counts and `model.cost`, never the previously stored
 * cost — so re-running it cleanly replaces any prior (multiplied) pricing, then
 * the official rate-card multiplier is applied. This depends on `model.cost`
 * and pi-ai's tier logic, not on pi-ai's internal multiplier table.
 */
function applyFastModePricing(model: Model<Api>, usage: Usage, multiplier: number): void {
	calculateCost(model, usage);
	// Codex does not charge for cache writes, even when the shared model metadata
	// contains an API cache-write rate.
	usage.cost.cacheWrite = 0;
	usage.cost.input = usage.cost.input * multiplier;
	usage.cost.output = usage.cost.output * multiplier;
	usage.cost.cacheRead = usage.cost.cacheRead * multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function scaleEventUsage(event: AssistantMessageEvent, model: Model<Api>, multiplier: number): void {
	if (event.type === "done") {
		applyFastModePricing(model, event.message.usage, multiplier);
	} else if (event.type === "error") {
		applyFastModePricing(model, event.error.usage, multiplier);
	}
}

/**
 * Wrap the raw stream, forwarding every event unchanged but recomputing the
 * fast-mode cost on the terminal done/error events.
 */
function withFastModePricing(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	multiplier: number,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		let message: AssistantMessage | undefined;

		try {
			for await (const event of stream) {
				message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
				scaleEventUsage(event, model, multiplier);
				out.push(event);
			}

			out.end(await stream.result());
		} catch (error) {
			const failed: AssistantMessage = {
				...(message ?? {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				}),
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			};

			applyFastModePricing(model, failed.usage, multiplier);
			out.push({ type: "error", reason: "error", error: failed });
			out.end(failed);
		}
	})();

	return out;
}

/**
 * Rebuild request options the way pi's provider layer expects: forward the
 * caller's options, keep reasoning as a concrete effort, cap maxTokens, and add
 * `serviceTier` only when a tier applies for this model. Mirrors the option
 * handling of the published pi-openai-service-tier extension.
 */
function buildFullOpenAIOptions(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	serviceTier: "priority" | undefined,
): PriorityStreamOptions {
	const result: PriorityStreamOptions = {
		...options,
		maxTokens: options?.maxTokens ?? (model.maxTokens > 0 ? Math.min(model.maxTokens, 32_000) : undefined),
	};

	if (options?.reasoning !== undefined) {
		const clampedReasoning = clampThinkingLevel(model, options.reasoning);
		result.reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
	}

	if (serviceTier) result.serviceTier = serviceTier;

	return result;
}

export default function piFastMode(pi: ExtensionAPI): void {
	let config: ResolvedConfig = { ...DEFAULT_CONFIG, configPath: configPaths(process.cwd()).global };
	let state: RuntimeState = { active: config.active };
	let registry: ModelRegistry | undefined;
	let sessionId: string | undefined;
	let unregisterCleanup: (() => void) | undefined;
	let generation = 0;
	const overlays = new Map<string, { inDispatchPath: () => boolean; release: () => void }>();

	function cleanup(): void {
		state = { active: false };
		generation += 1;

		for (const overlay of overlays.values()) overlay.release();
		overlays.clear();
		registry = undefined;
		sessionId = undefined;
		unregisterCleanup?.();
		unregisterCleanup = undefined;
	}

	function syncOverlays(ctx: ExtensionContext): void {
		const id = ctx.sessionManager.getSessionId();

		if (registry !== ctx.modelRegistry || sessionId !== id) {
			const active = state;
			cleanup();
			state = active;
			registry = ctx.modelRegistry;
			sessionId = id;
			unregisterCleanup = registerSessionResourceCleanup((disposedId) => {
				if (disposedId === undefined || disposedId === sessionId) cleanup();
			});
		}

		const currentRegistry = ctx.modelRegistry;
		const installedGeneration = generation;

		for (const spec of PROVIDER_OVERLAYS) {
			if (overlays.get(spec.provider)?.inDispatchPath()) continue;
			const original = currentRegistry.getRegisteredProviderConfig(spec.provider);

			if (
				currentRegistry.getRegisteredNativeProvider(spec.provider) ||
				original?.streamSimple ||
				original?.refreshModels ||
				original?.oauth?.modifyModels ||
				(original?.api !== undefined && original.api !== spec.api)
			)
				continue;

			const observer = (
				stream: NonNullable<ReturnType<ModelRegistry["getRegisteredProviderConfig"]>>["streamSimple"],
			) => {
				if (!stream) return undefined;

				const descriptor = Object.getOwnPropertyDescriptor(
					stream,
					Symbol.for("@nijaru/pi-provider-compaction/stream-observer"),
				);

				const marker: unknown = descriptor?.enumerable === false ? descriptor.value : undefined;

				if (
					!Value.Check(Type.Object({ delegate: Type.Unknown(), release: Type.Function([], Type.Void()) }), marker) ||
					marker.delegate !== streamSimple
				)
					return undefined;

				return marker;
			};

			const inDispatchPath = () => {
				const current = currentRegistry.getRegisteredProviderConfig(spec.provider);

				return (
					!currentRegistry.getRegisteredNativeProvider(spec.provider) &&
					current?.api === spec.api &&
					(current.streamSimple === streamSimple || observer(current.streamSimple) !== undefined)
				);
			};

			const streamSimple = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
				const multiplier = fastModeMultiplier(model, config);

				const active =
					installedGeneration === generation &&
					inDispatchPath() &&
					isFastModeActive(model, state, config) &&
					multiplier !== undefined;

				const stream = spec.streamRaw(
					model,
					context,
					buildFullOpenAIOptions(model, options, active ? "priority" : undefined),
				);

				return active ? withFastModePricing(stream, model, multiplier) : stream;
			};

			currentRegistry.registerProvider(spec.provider, { api: spec.api, streamSimple });
			overlays.set(spec.provider, {
				inDispatchPath,
				release() {
					observer(currentRegistry.getRegisteredProviderConfig(spec.provider)?.streamSimple)?.release();

					if (
						!inDispatchPath() ||
						currentRegistry.getRegisteredProviderConfig(spec.provider)?.streamSimple !== streamSimple
					)
						return;
					const restored = { ...currentRegistry.getRegisteredProviderConfig(spec.provider) };
					delete restored.streamSimple;

					if (original?.api === undefined) delete restored.api;
					else restored.api = original.api;
					currentRegistry.unregisterProvider(spec.provider);

					if (Object.keys(restored).length) currentRegistry.registerProvider(spec.provider, restored);
				},
			});
		}
	}

	function refreshConfig(ctx: ExtensionContext): void {
		config = resolveConfig(ctx.cwd || process.cwd(), ctx.isProjectTrusted());
	}

	function appendSessionState(): void {
		if (!config.persistState) return;
		pi.appendEntry(SESSION_STATE_TYPE, { ...state, serviceTier: "priority" });
	}

	function restoreSessionState(ctx: ExtensionContext, reason: string | undefined): void {
		const entries = ctx.sessionManager.getEntries();
		const saved = config.persistState ? readSessionState(ctx.sessionManager.getBranch()) : undefined;
		const contextEntries = ctx.sessionManager.buildContextEntries?.() ?? entries;

		const hasConversation = contextEntries.some(
			(entry) =>
				entry.type === "message" ||
				entry.type === "custom_message" ||
				entry.type === "compaction" ||
				entry.type === "branch_summary",
		);

		if (saved) {
			state = saved;

			return;
		}

		// A global default applies only to a new/empty session. An existing
		// session created before this extension recorded state stays off rather
		// than being changed retroactively by the global config.
		state = {
			active: reason === "new" || !hasConversation ? config.active : false,
		};
		appendSessionState();
	}

	function updateStatus(ctx: ExtensionContext, synchronize = true): void {
		if (synchronize) syncOverlays(ctx);

		const text =
			ctx.model && overlays.get(ctx.model.provider)?.inDispatchPath() && isFastModeActive(ctx.model, state, config)
				? `⚡ FAST · $ ${fastModeMultiplier(ctx.model, config)}×`
				: undefined;

		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function supportedListText(): string {
		const all = [...DEFAULT_MODELS, ...config.allowlist, ...config.blocklist];
		const keys = [...new Set(all.map((model) => `${model.provider}/${model.id}`))];

		return keys.join(", ") || "none";
	}

	function notifyStatus(ctx: ExtensionContext): void {
		const active = isFastModeActive(ctx.model, state, config);
		const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";

		if (active && ctx.model && !overlays.get(ctx.model.provider)?.inDispatchPath()) {
			ctx.ui.notify(
				`Fast mode is on, but inactive: another provider or stream owns ${ctx.model.provider}. Disable the competing provider extension and reload to use /fast.`,
				"warning",
			);

			return;
		}

		if (active) {
			ctx.ui.notify(
				`Fast mode: priority service tier for ${modelKey}. Cost accounting includes the priority multiplier.`,
				"info",
			);

			return;
		}

		if (state.active) {
			if (
				ctx.model &&
				fastModeMultiplier(ctx.model, config) === undefined &&
				PROVIDER_OVERLAYS.some((spec) => spec.provider === ctx.model?.provider && spec.api === ctx.model.api) &&
				(contains(DEFAULT_MODELS, ctx.model) || contains(config.allowlist, ctx.model)) &&
				!contains(config.blocklist, ctx.model)
			) {
				ctx.ui.notify(
					`Fast mode is on, but ${modelKey} has no established fast-mode rate, so priority was not requested. Set "multipliers": { "${modelKey}": <multiplier> } in ${config.configPath} after verifying its subscription rate.`,
					"warning",
				);

				return;
			}

			ctx.ui.notify(
				`Fast mode is on, but ${modelKey} is not tierable (missing API spec, not on the default/allowlist, or blocked). Mentioned models: ${supportedListText()}.`,
				"warning",
			);

			return;
		}

		ctx.ui.notify(`Fast mode is off. Current model: ${modelKey}.`, "info");
	}

	function setActive(ctx: ExtensionContext, active: boolean): void {
		refreshConfig(ctx);
		state = { ...state, active };
		appendSessionState();
		updateStatus(ctx);
		notifyStatus(ctx);
	}

	function setDefault(ctx: ExtensionContext, active: boolean): void {
		refreshConfig(ctx);
		writeConfig(config.configPath, active);
		refreshConfig(ctx);
		ctx.ui.notify(
			`Fast mode default: ${config.active ? "on" : "off"} for new sessions (${config.configPath}).`,
			"info",
		);
	}

	function notifyDefault(ctx: ExtensionContext): void {
		refreshConfig(ctx);
		ctx.ui.notify(
			`Fast mode default is ${config.active ? "on" : "off"} for new sessions (${config.configPath}).`,
			"info",
		);
	}

	pi.registerCommand(COMMAND_FAST, {
		description: "Toggle OpenAI fast mode; /fast [on|off|status|default]",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trimStart().toLowerCase();

			if (normalized.startsWith("default ")) {
				const subprefix = normalized.slice("default ".length).trim();
				const values = ["on", "off", "status"];
				const items = values.flatMap((value) => (value.startsWith(subprefix) ? [{ value, label: value }] : []));

				return items.length ? items : null;
			}

			const values = ["on", "off", "status", "default"];
			const items = values.flatMap((value) => (value.startsWith(normalized.trim()) ? [{ value, label: value }] : []));

			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const [scope, value, ...extra] = arg.split(/\s+/).filter(Boolean);

			if (scope === "default") {
				if (extra.length > 0) {
					ctx.ui.notify("Usage: /fast [on|off|status] or /fast default [on|off|status]", "error");

					return;
				}

				if (!value) {
					refreshConfig(ctx);

					return setDefault(ctx, !config.active);
				}

				if (value === "on") return setDefault(ctx, true);

				if (value === "off") return setDefault(ctx, false);

				if (value === "status") return notifyDefault(ctx);
				ctx.ui.notify("Usage: /fast [on|off|status] or /fast default [on|off|status]", "error");

				return;
			}

			if (!arg) return setActive(ctx, !state.active);

			if (arg === "on") return setActive(ctx, true);

			if (arg === "off") return setActive(ctx, false);

			if (arg === "status") {
				refreshConfig(ctx);
				updateStatus(ctx);

				return notifyStatus(ctx);
			}

			ctx.ui.notify("Usage: /fast [on|off|status] or /fast default [on|off|status]", "error");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		refreshConfig(ctx);
		restoreSessionState(ctx, event.reason);
		updateStatus(ctx);

		if (state.active) notifyStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshConfig(ctx);
		const saved = config.persistState ? readSessionState(ctx.sessionManager.getBranch()) : undefined;

		if (saved) {
			state = saved;
		} else if (config.persistState) {
			state = { active: false };
		}

		updateStatus(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", async (_event, ctx) => {
		updateStatus(ctx, false);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cleanup();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
