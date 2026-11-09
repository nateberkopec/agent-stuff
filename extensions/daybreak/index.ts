import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { WireValue } from "../shared/wire_value.ts";

const PROVIDER = "openai";

const SUFFIX = "-daybreak";

const STALE_MS = 3 * 24 * 60 * 60 * 1000;

const Entry = Type.Object({
	model: Type.String(),
	program: Type.Union([Type.Literal("daybreak_blue"), Type.Literal("daybreak_red")]),
});

const State = Type.Object({ models: Type.Array(Entry) });

const Payload = Type.Intersect([Type.Record(Type.String(), WireValue), Type.Object({ model: Type.String() })]);

function statePath() {
	return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "daybreak/models.json");
}

function readState(path: string) {
	try {
		const state = JSON.parse(readFileSync(path, "utf8"));

		if (!Value.Check(State, state)) throw new Error(`${path} does not match the Daybreak state schema`);

		return { models: state.models, stale: Date.now() - statSync(path).mtimeMs > STALE_MS };
	} catch (error) {
		if (Value.Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) return { models: [], stale: false };
		throw error;
	}
}

export default function daybreak(pi: ExtensionAPI) {
	const path = statePath();
	const { models, stale } = readState(path);
	const programs = new Map<string, string>();

	const catalog = builtinProviders()
		.find((provider) => provider.id === PROVIDER)
		?.getModels();

	for (const { model: id, program } of models) {
		const physical = catalog?.find((model) => model.id === id);

		if (!physical) continue;
		programs.set(id + SUFFIX, program);
		pi.registerVirtualModel({
			provider: PROVIDER,
			id: id + SUFFIX,
			name: `${physical.name} · Daybreak`,
			thinkingLevels: getSupportedThinkingLevels(physical),
			contextWindow: physical.contextWindow,
			maxTokens: physical.maxTokens,
			input: physical.input,
			route(request, ctx) {
				const model = ctx.modelRegistry.find(PROVIDER, id);

				if (!model) throw new Error(`Daybreak target ${PROVIDER}/${id} is not in the model catalog`);

				return { model, thinkingLevel: request.thinkingLevel };
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (stale) ctx.ui.notify(`Daybreak models are more than 3 days old; check daybreak-sync (${path})`, "warning");
	});

	pi.on("before_provider_request", (event, ctx) => {
		const selected = ctx.model;
		const program = selected?.provider === PROVIDER ? programs.get(selected.id) : undefined;

		if (!selected || !program) return undefined;
		const target = selected.id.slice(0, -SUFFIX.length);

		if (!Value.Check(Payload, event.payload) || event.payload.model !== target) {
			ctx.ui.notify(`Daybreak blocked a request for ${selected.id} that does not target ${target}`, "error");
			ctx.abort();

			return null;
		}

		return { ...event.payload, access_programs: { cyber: program } };
	});
}
