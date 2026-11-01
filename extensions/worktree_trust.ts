import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { getAgentDir, ProjectTrustStore, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function findDotGit(cwd: string): string | undefined {
	for (let dir = realpathSync(cwd); ; dir = path.dirname(dir)) {
		const candidate = path.join(dir, ".git");

		if (existsSync(candidate)) return candidate;

		if (path.dirname(dir) === dir) return undefined;
	}
}

function readPath(file: string, prefix = ""): string {
	const content = readFileSync(file, "utf8").trim();

	if (!content.startsWith(prefix)) throw new Error(`Unexpected contents in ${file}`);

	return realpathSync(path.resolve(path.dirname(file), content.slice(prefix.length)));
}

function mainCheckout(cwd: string): string | undefined {
	const dotGit = findDotGit(cwd);

	if (!dotGit || !lstatSync(dotGit).isFile()) return undefined;

	const gitDir = readPath(dotGit, "gitdir: ");

	if (readPath(path.join(gitDir, "gitdir")) !== dotGit) return undefined;

	const commonDir = realpathSync(path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim()));

	if (path.dirname(gitDir) !== path.join(commonDir, "worktrees")) return undefined;

	if (path.basename(commonDir) !== ".git" || !lstatSync(commonDir).isDirectory()) return undefined;

	return path.dirname(commonDir);
}

function linkedCheckout(cwd: string): string | undefined {
	try {
		return mainCheckout(cwd);
	} catch {
		return undefined;
	}
}

export default function worktreeTrustExtension(pi: ExtensionAPI) {
	pi.on("project_trust", (event) => {
		const store = new ProjectTrustStore(getAgentDir());

		if (store.get(event.cwd) !== null) return { trusted: "undecided" };

		const checkout = linkedCheckout(event.cwd);

		if (checkout && store.get(checkout) === true) return { trusted: "yes" };

		return { trusted: "undecided" };
	});
}
