import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

function git(cwd, ...args) {
	execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			...args,
		],
		{ cwd, stdio: "ignore" },
	);
}

function fixture(run) {
	const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "worktree-trust-")));
	const main = path.join(dir, "main");
	const worktree = path.join(dir, "worktree");
	const trust = {};

	mkdirSync(main);
	git(main, "init", "-q");
	git(main, "commit", "-q", "--allow-empty", "-m", "init");
	git(main, "worktree", "add", "-q", worktree);

	const project = (name) => {
		const projectDir = path.join(dir, name);
		mkdirSync(path.join(projectDir, ".pi/extensions"), { recursive: true });
		writeFileSync(
			path.join(projectDir, ".pi/extensions/marker.ts"),
			'import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(process.env.MARKER_FILE!, "loaded"); }\n',
		);

		return projectDir;
	};

	const loadsProjectExtensions = (cwd) => {
		const agentDir = path.join(dir, "agent");
		const marker = path.join(dir, "marker");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, "trust.json"), JSON.stringify(trust));
		rmSync(marker, { force: true });
		execFileSync(
			path.join(root, "node_modules/.bin/pi"),
			["--offline", "--no-session", "-e", path.join(root, "extensions/worktree_trust.ts"), "--list-models"],
			{
				cwd,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, MARKER_FILE: marker },
				stdio: "ignore",
				timeout: 30_000,
			},
		);

		return existsSync(marker);
	};

	project("worktree");

	try {
		run({ dir, main, worktree, trust, project, loadsProjectExtensions });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("a linked worktree inherits trust from its trusted main checkout", () =>
	fixture(({ main, worktree, trust, loadsProjectExtensions }) => {
		assert.equal(loadsProjectExtensions(worktree), false);
		trust[main] = true;
		assert.equal(loadsProjectExtensions(worktree), true);
	}));

test("an explicit decision for the worktree path wins over the main checkout", () =>
	fixture(({ main, worktree, trust, loadsProjectExtensions }) => {
		trust[main] = true;
		trust[worktree] = false;
		assert.equal(loadsProjectExtensions(worktree), false);
	}));

test("a forged .git file pointing at a trusted repository's worktree is not trusted", () =>
	fixture(({ main, trust, project, loadsProjectExtensions }) => {
		trust[main] = true;
		const forged = project("forged");
		writeFileSync(path.join(forged, ".git"), `gitdir: ${path.join(main, ".git/worktrees/worktree")}\n`);
		assert.equal(loadsProjectExtensions(forged), false);
	}));

test("a forged worktree administrative directory naming a trusted repository is not trusted", () =>
	fixture(({ main, trust, project, loadsProjectExtensions }) => {
		trust[main] = true;
		const forged = project("forged");
		const admin = path.join(forged, "admin");
		mkdirSync(admin);
		writeFileSync(path.join(forged, ".git"), "gitdir: admin\n");
		writeFileSync(path.join(admin, "gitdir"), `${path.join(forged, ".git")}\n`);
		writeFileSync(path.join(admin, "commondir"), `${path.join(main, ".git")}\n`);
		assert.equal(loadsProjectExtensions(forged), false);
	}));
