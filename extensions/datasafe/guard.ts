import type { Api, Model, Provider, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { WireValue } from "../shared/wire_value.ts";

export const RequestPayload = Type.Object({
	model: Type.Optional(Type.String()),
	provider: Type.Optional(Type.Record(Type.String(), WireValue)),
	providerOptions: Type.Optional(
		Type.Intersect([
			Type.Record(Type.String(), WireValue),
			Type.Object({ gateway: Type.Optional(Type.Record(Type.String(), WireValue)) }),
		]),
	),
});

export type RequestPayload = Static<typeof RequestPayload>;

const CATALOG_TTL_MS = 60 * 60 * 1000;

export function catalogIsFresh(checkedAt: number | undefined): boolean {
	return checkedAt !== undefined && Date.now() - checkedAt < CATALOG_TTL_MS;
}

export interface Policy {
	check?: (options: StreamOptions | undefined) => void;
	transform?: (payload: RequestPayload) => RequestPayload;
}

interface Catalog extends Policy {
	name?: string;
	baseUrl: string;
	getModels: () => readonly Model<Api>[];
	refreshModels: NonNullable<Provider["refreshModels"]>;
}

function guard<T extends StreamOptions | SimpleStreamOptions>(
	provider: string,
	allowed: boolean,
	policy: Policy,
	model: Model<Api>,
	options: T | undefined,
): T {
	if (!allowed) throw new Error(`Datasafe blocked ${provider} model or endpoint: ${model.id} at ${model.baseUrl}`);

	policy.check?.(options);

	// SAFETY: the spread preserves API-specific options; only the shared onPayload callback changes.
	return {
		...options,
		onPayload: async (payload, payloadModel) => {
			const result = (await options?.onPayload?.(payload, payloadModel)) ?? payload;

			if (!Value.Check(RequestPayload, result) || result.model !== model.id) {
				throw new Error(`Datasafe blocked a ${provider} payload that does not target ${model.id}`);
			}

			return policy.transform ? policy.transform(result) : result;
		},
	} as T;
}

export function guardCatalog(raw: Provider, catalog: Catalog): Provider {
	const guarded = <T extends StreamOptions | SimpleStreamOptions>(model: Model<Api>, options: T | undefined) => {
		const listed = catalog.getModels().some((entry) => entry.id === model.id && entry.baseUrl === model.baseUrl);

		return guard(raw.id, listed, catalog, model, options);
	};

	return {
		id: raw.id,
		name: catalog.name ?? raw.name,
		baseUrl: catalog.baseUrl,
		headers: raw.headers,
		auth: raw.auth,
		getModels: catalog.getModels,
		refreshModels: catalog.refreshModels,
		stream: (model, context, options) => raw.stream(model, context, guarded(model, options)),
		streamSimple: (model, context, options) => raw.streamSimple(model, context, guarded(model, options)),
	};
}

export function pinEndpoints(raw: Provider, policy: Policy = {}): ProviderConfig {
	const models = raw.getModels();
	const apis = new Set(models.map((model) => model.api));
	const endpoints = new Set(models.map((model) => model.baseUrl));

	if (apis.size !== 1) throw new Error(`Datasafe cannot pin ${raw.id}, which serves several chat APIs`);

	return {
		api: [...apis][0],
		streamSimple: (model, context, options) =>
			raw.streamSimple(model, context, guard(raw.id, endpoints.has(model.baseUrl), policy, model, options)),
	};
}
