import type { Policy, RequestPayload } from "./guard.ts";

function applyUSInferenceRegion(payload: RequestPayload) {
	const providerOptions = payload.providerOptions ?? {};

	return {
		...payload,
		providerOptions: {
			...providerOptions,
			gateway: {
				...providerOptions.gateway,
				inferenceRegion: { scope: "zone", geoRegion: "us" },
				disallowPromptTraining: true,
			},
		},
	};
}

export const vercelUSPolicy: Policy = { transform: applyUSInferenceRegion };
