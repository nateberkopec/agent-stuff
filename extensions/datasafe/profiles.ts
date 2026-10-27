export interface Profile {
	name: string;
	providers: readonly string[] | "all";
	status?: string;
}

const usaNoTrain: Profile = {
	name: "usa-no-train",
	providers: ["openai", "meridian", "google-vertex", "openrouter", "vercel-ai-gateway"],
};

const profiles = new Map<string, Profile>([
	[usaNoTrain.name, usaNoTrain],
	["claude-only", { name: "claude-only", providers: ["meridian", "anthropic"], status: "[PROFILE: CLAUDE-ONLY]" }],
	["unrestricted", { name: "unrestricted", providers: "all", status: "[WARNING: UNRESTRICTED]" }],
]);

export function resolveProfile(mode: string | undefined): Profile {
	if (!mode) return usaNoTrain;

	return (
		profiles.get(mode) ?? {
			...usaNoTrain,
			status: `[WARNING: UNKNOWN DATASAFE MODE ${mode}, USING USA-NO-TRAIN]`,
		}
	);
}
