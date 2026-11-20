import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { pinEndpoints, type Policy } from "./guard.ts";
import { resolveProfile } from "./profiles.ts";
import { vertexPolicy } from "./vertex.ts";

const policies = new Map<string, Policy>([["google-vertex", vertexPolicy]]);

async function configuredProviderIds(): Promise<string[]> {
	try {
		const config = JSON.parse(await readFile(join(getAgentDir(), "models.json"), "utf8"));

		return Object.keys(config.providers ?? {});
	} catch (error) {
		if (Value.Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) return [];
		throw error;
	}
}

export default async function datasafe(pi: ExtensionAPI) {
	const profile = resolveProfile(process.env.PI_DATASAFE_MODE);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui" && profile.status) ctx.ui.setStatus("datasafe", profile.status);
	});

	if (profile.providers === "all") return;
	const allowed = new Set(profile.providers);
	const builtins = builtinProviders();

	for (const provider of builtins) {
		if (!allowed.has(provider.id)) pi.registerProvider(provider.id, { models: [] });
		else pi.registerProvider(provider.id, pinEndpoints(provider, policies.get(provider.id)));
	}

	for (const id of await configuredProviderIds()) {
		if (!allowed.has(id) && !builtins.some((provider) => provider.id === id)) {
			pi.registerProvider(id, { models: [] });
		}
	}

	pi.on("before_provider_request", (_event, ctx) => {
		const provider = ctx.model?.provider;

		if (provider && allowed.has(provider)) return;
		ctx.ui.notify(`Datasafe blocked ${provider ?? "an unknown provider"} outside the ${profile.name} profile`, "error");
		ctx.abort();

		return null;
	});
}
