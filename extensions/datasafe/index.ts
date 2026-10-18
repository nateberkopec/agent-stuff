import type { Provider } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createFireworksUSProvider } from "./fireworks.ts";
import { pinEndpoints, type Policy } from "./guard.ts";
import { createOpenRouterUSProvider } from "./openrouter.ts";
import { resolveProfile } from "./profiles.ts";
import { vercelUSPolicy } from "./vercel.ts";
import { vertexUSPolicy } from "./vertex.ts";

const regionalCatalogs = new Map<string, (raw: Provider) => Provider>([
	["fireworks", createFireworksUSProvider],
	["openrouter", createOpenRouterUSProvider],
]);

const policies = new Map<string, Policy>([
	["google-vertex", vertexUSPolicy],
	["vercel-ai-gateway", vercelUSPolicy],
]);

async function configuredProviderIds(): Promise<string[]> {
	try {
		const config = JSON.parse(await readFile(join(getAgentDir(), "models.json"), "utf8"));

		return Object.keys(config.providers ?? {});
	} catch (error) {
		if (Value.Check(Type.Object({ code: Type.Literal("ENOENT") }), error)) return [];
		throw error;
	}
}

async function refreshRegionalCatalogs(ctx: ExtensionContext, allowed: ReadonlySet<string>) {
	const providers = [...regionalCatalogs.keys()].filter((id) => allowed.has(id));

	if (providers.length === 0) return;
	const result = await ctx.modelRegistry.refresh({ providers, allowNetwork: false, signal: ctx.signal });

	if (result.aborted) throw new Error("Datasafe could not refresh the subagent model catalog");

	for (const [provider, error] of result.errors) {
		throw new Error(`Datasafe could not refresh ${provider} before subagent launch`, { cause: error });
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
		const catalog = regionalCatalogs.get(provider.id);

		if (!allowed.has(provider.id)) pi.registerProvider(provider.id, { models: [] });
		else if (catalog) pi.registerProvider(catalog(provider));
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

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "subagent") await refreshRegionalCatalogs(ctx, allowed);
	});
}
