import type { Api, Model, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { catalogIsFresh, guardCatalog, type RequestPayload } from "./guard.ts";
import { intersectRegionalModels, restoreRegionalModels } from "./openrouter_catalog.ts";

const BASE_URL = "https://us.openrouter.ai/api/v1";

const MODELS_URL = `${BASE_URL}/models`;

function denyCollection(payload: RequestPayload) {
	return { ...payload, provider: { ...payload.provider, data_collection: "deny" } };
}

export function createOpenRouterUSProvider(raw: Provider): Provider {
	const builtInModels = raw.getModels();
	let currentModels: Model<Api>[] = [];

	const show = (models: Model<Api>[]) => ({
		update: () => {
			currentModels = models;
		},
	});

	const refreshModels = async (context: RefreshModelsContext) => {
		const cached = restoreRegionalModels(builtInModels, context.stored?.models, BASE_URL);

		if (cached.length > 0) await context.publish(show(cached));

		if (!context.allowNetwork || (!context.force && cached.length > 0 && catalogIsFresh(context.stored?.checkedAt)))
			return;

		const headers = context.stored?.etag ? { "If-None-Match": context.stored.etag } : undefined;
		const response = await fetch(MODELS_URL, { headers, signal: context.signal });

		if (response.status === 304) {
			if (cached.length === 0) throw new Error("OpenRouter US model discovery returned 304 without a cached catalog");
			const etag = response.headers.get("etag") ?? context.stored?.etag;
			await context.publish({ ...show(cached), persist: { models: cached, checkedAt: Date.now(), etag } });

			return;
		}

		if (!response.ok) throw new Error(`OpenRouter US model discovery failed with HTTP ${response.status}`);

		const models = intersectRegionalModels(builtInModels, await response.json(), BASE_URL);
		const etag = response.headers.get("etag") ?? undefined;
		await context.publish({ ...show(models), persist: { models, checkedAt: Date.now(), etag } });
	};

	return guardCatalog(raw, {
		baseUrl: BASE_URL,
		getModels: () => currentModels,
		refreshModels,
		transform: denyCollection,
	});
}
