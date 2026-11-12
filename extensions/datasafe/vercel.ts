import type { Policy, RequestPayload } from "./guard.ts";

function applyUSZeroDataRetention(payload: RequestPayload) {
	const providerOptions = payload.providerOptions ?? {};

	return {
		...payload,
		providerOptions: {
			...providerOptions,
			gateway: {
				...providerOptions.gateway,
				inferenceRegion: { scope: "zone", geoRegion: "us" },
				disallowPromptTraining: true,
				zeroDataRetention: true,
			},
		},
	};
}

export const vercelUSPolicy: Policy = { transform: applyUSZeroDataRetention };
