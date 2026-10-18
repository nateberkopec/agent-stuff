import { isModelType, type AnyModel, type Api, type Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const FIREWORKS_BASE_URL = "https://us.api.fireworks.ai/inference/v1";

const FIREWORKS_US_DOCS_URL = "https://docs.fireworks.ai/serverless/us-only-serverless.md";

const FIREWORKS_MODELS_URL = `${FIREWORKS_BASE_URL}/models`;

const US_MODEL_ID = /^accounts\/fireworks\/(?:models|routers)\/[a-z0-9][a-z0-9._-]*-us$/;

type FireworksModel = Model<"openai-completions">;

type CatalogEntry = { id: string; name: string };

const ApiModel = Type.Object({
	id: Type.Optional(Type.String()),
	context_length: Type.Optional(Type.Number()),
	supports_chat: Type.Optional(Type.Boolean()),
	supports_image_input: Type.Optional(Type.Boolean()),
});

type ApiModel = Static<typeof ApiModel>;

const ApiCatalog = Type.Object({ data: Type.Array(ApiModel) });

function isUSModelId(id: string): boolean {
	return id === "accounts/fireworks/models/muse-spark-open" || US_MODEL_ID.test(id);
}

function parseUSModelCatalog(markdown: string): CatalogEntry[] {
	const heading = markdown.match(/^## Available models\s*$/m);

	if (heading?.index === undefined) {
		throw new Error("Fireworks US-only documentation has no Available models section");
	}

	const section = markdown.slice(heading.index + heading[0].length).split(/^##\s/m, 1)[0];

	const entries = [...section.matchAll(/^\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*$/gm)].map((match) => ({
		name: match[1].trim(),
		id: match[2].trim(),
	}));

	if (entries.length === 0) throw new Error("Fireworks US-only model table is empty or malformed");

	if (entries.some(({ id }) => !isUSModelId(id))) {
		throw new Error("Fireworks US-only model table contains an unsafe model ID");
	}

	if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
		throw new Error("Fireworks US-only model table contains duplicate model IDs");
	}

	return entries;
}

function metadataIdCandidates(usId: string): string[] {
	const baseId = usId.replace(/-us$/, "");

	const alternateKind = baseId.includes("/routers/")
		? baseId.replace("/routers/", "/models/")
		: baseId.replace("/models/", "/routers/");

	return [baseId, alternateKind];
}

function buildUSModels(entries: CatalogEntry[], apiModels: ApiModel[]): FireworksModel[] {
	const metadata = new Map<string, ApiModel>();

	for (const model of apiModels) if (model.id !== undefined) metadata.set(model.id, model);

	const models = entries.flatMap(({ id, name }): FireworksModel[] => {
		const details = metadataIdCandidates(id)
			.map((candidate) => metadata.get(candidate))
			.find(Boolean);

		if (details?.supports_chat === undefined || details.context_length === undefined || details.context_length <= 0) {
			throw new Error(`Fireworks returned no usable chat metadata for US-only model: ${id}`);
		}

		if (!details.supports_chat) return [];

		return [
			{
				id,
				name: `${name} (Fireworks US-only)`,
				api: "openai-completions",
				provider: "fireworks",
				baseUrl: FIREWORKS_BASE_URL,
				reasoning: true,
				input: details.supports_image_input === true ? ["text", "image"] : ["text"],
				cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
				contextWindow: details.context_length,
				maxTokens: Math.min(details.context_length, 131_072),
				compat: {
					supportsStore: false,
					supportsDeveloperRole: false,
					sendSessionAffinityHeaders: true,
					supportsLongCacheRetention: false,
				},
			},
		];
	});

	if (models.length === 0) throw new Error("Fireworks US-only catalog contains no usable chat models");

	return models;
}

export async function fetchUSModels(apiKey: string, signal: AbortSignal): Promise<FireworksModel[]> {
	const [docsResponse, modelsResponse] = await Promise.all([
		fetch(FIREWORKS_US_DOCS_URL, { signal }),
		fetch(FIREWORKS_MODELS_URL, { signal, headers: { Authorization: `Bearer ${apiKey}` } }),
	]);

	if (!docsResponse.ok) throw new Error(`Fireworks US-only documentation returned HTTP ${docsResponse.status}`);

	if (!modelsResponse.ok) throw new Error(`Fireworks models API returned HTTP ${modelsResponse.status}`);

	const payload = await modelsResponse.json();

	if (!Value.Check(ApiCatalog, payload)) throw new Error("Fireworks models API returned a malformed catalog");

	return buildUSModels(parseUSModelCatalog(await docsResponse.text()), payload.data);
}

export function cachedUSModels(models: readonly AnyModel[]): Model<Api>[] {
	return models.filter(
		(model): model is Model<Api> =>
			isModelType(model, "chat") &&
			model.provider === "fireworks" &&
			model.api === "openai-completions" &&
			model.baseUrl === FIREWORKS_BASE_URL &&
			isUSModelId(model.id),
	);
}
