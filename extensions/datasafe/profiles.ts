export interface Profile {
	name: string;
	providers: readonly string[] | "all";
	status?: string;
}

const allowlist: Profile = {
	name: "allowlist",
	providers: ["openai", "claude-code", "google-vertex", "baseten"],
};

const profiles = new Map<string, Profile>([
	[allowlist.name, allowlist],
	["unrestricted", { name: "unrestricted", providers: "all", status: "[WARNING: UNRESTRICTED]" }],
]);

export function resolveProfile(mode: string | undefined): Profile {
	if (!mode) return allowlist;

	return (
		profiles.get(mode) ?? {
			...allowlist,
			status: `[WARNING: UNKNOWN DATASAFE MODE ${mode}, USING ALLOWLIST]`,
		}
	);
}
