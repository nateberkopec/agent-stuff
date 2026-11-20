import type { Api, Model, Provider, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

const RequestPayload = Type.Object({ model: Type.Optional(Type.String()) });

export interface Policy {
	check?: (options: StreamOptions | undefined) => void;
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

			return result;
		},
	} as T;
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
