import type { Api, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { cachedUSModels, fetchUSModels, FIREWORKS_BASE_URL } from "./fireworks_catalog.ts";
import { catalogIsFresh, guardCatalog } from "./guard.ts";

export function createFireworksUSProvider(raw: Provider): Provider {
	let currentModels: Model<Api>[] = [];

	const show = (models: Model<Api>[]) => ({
		update: () => {
			currentModels = models;
		},
	});

	const refreshModels = async (context: RefreshModelsContext) => {
		const cached = cachedUSModels(context.stored?.models ?? []);

		if (cached.length > 0 && !(await context.publish(show(cached)))) return;

		if (!context.allowNetwork || context.signal.aborted) return;

		if (!context.force && cached.length > 0 && catalogIsFresh(context.stored?.checkedAt)) return;

		const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;

		if (!apiKey) throw new Error("Fireworks model discovery requires an API key");

		const models = await fetchUSModels(apiKey, context.signal);

		if (context.signal.aborted) return;
		await context.publish({ ...show(models), persist: { models, checkedAt: Date.now() } });
	};

	return guardCatalog(raw, {
		name: "Fireworks US-only",
		baseUrl: FIREWORKS_BASE_URL,
		getModels: () => currentModels,
		refreshModels,
	});
}
