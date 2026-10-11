import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");

test("the packed package installs and discovers every exported resource in an isolated real Pi runtime", () => {
	const home = mkdtempSync(path.join(tmpdir(), "agent-stuff-package-"));
	const agentDir = path.join(home, "agent");

	const env = {
		...process.env,
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_DATASAFE_MODE: "unrestricted",
	};

	try {
		const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", home], {
			cwd: root,
			env,
			encoding: "utf8",
		}))[0];

		assert.ok(!packed.files.some((file) => file.path.startsWith("node_modules/")));
		execFileSync("tar", ["-xzf", path.resolve(home, packed.filename), "-C", home]);
		const installed = path.join(home, "package");
		execFileSync("pi", ["install", installed], { cwd: home, env, timeout: 30_000 });

		const worker = `
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import path from "node:path";
			import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(sdk)};
			const root = ${JSON.stringify(installed)};
			const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
			const loader = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: process.env.PI_CODING_AGENT_DIR,
				settingsManager: SettingsManager.create(process.cwd(), process.env.PI_CODING_AGENT_DIR),
				noContextFiles: true,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(loaded.errors, []);
			assert.deepEqual(loaded.warnings ?? [], []);
			assert.deepEqual(loaded.extensions.map(e => e.resolvedPath).sort(),
				manifest.pi.extensions.map(p => path.resolve(root, p)).sort());
			const tools = loaded.extensions.flatMap(e => [...e.tools.keys()]);
			assert.deepEqual(tools.sort(), ["create_goal", "executor_watch", "get_goal", "update_goal"]);
			const commands = loaded.extensions.flatMap(e => [...e.commands.keys()]);
			assert.equal(commands.length, new Set(commands).size);
			for (const name of ["answer", "btw", "compact-at", "goal", "window-fork", "plan-pause"])
				assert.ok(commands.includes(name), name);
			const expectedSkills = fs.readdirSync(path.join(root, "skills")).filter(name =>
				fs.existsSync(path.join(root, "skills", name, "SKILL.md")));
			assert.deepEqual(loader.getSkills().diagnostics, []);
			assert.deepEqual(loader.getSkills().skills.map(s => s.name).sort(), expectedSkills.sort());
			assert.deepEqual(loader.getPrompts().diagnostics, []);
			assert.deepEqual(loader.getPrompts().prompts.map(p => p.name), ["plan-follow"]);
			assert.deepEqual(loader.getThemes().diagnostics, []);
			assert.deepEqual(loader.getThemes().themes.map(t => t.name).sort(), ["dayowl", "modern-dark", "nightowl"]);
			console.log("installed resources verified");
		`;

		const output = execFileSync("node", ["--input-type=module", "-e", worker], {
			cwd: home,
			env,
			encoding: "utf8",
			timeout: 30_000,
		});

		assert.match(output, /installed resources verified/);
		const settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		assert.deepEqual(settings.packages.map((source) => path.resolve(agentDir, source)), [installed]);
		assert.ok(readdirSync(installed).includes("agents"));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
