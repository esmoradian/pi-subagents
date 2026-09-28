import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { closeIdleHerdrInspectorTab, handleHerdrInspectorAction, readHerdrInspectorBinding } from "../../src/inspectors/herdr/actions.ts";
import type { HerdrClient } from "../../src/inspectors/herdr/client.ts";
import { registerHerdrProgressTabs, type HerdrProgressTabRun } from "../../src/integrations/herdr-progress-tabs.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, type AsyncStatus } from "../../src/shared/types.ts";

function writeRun(root: string, id = "run-12345678-abc"): string {
	const asyncDir = path.join(root, id);
	fs.mkdirSync(asyncDir, { recursive: true });
	const status: AsyncStatus = {
		runId: id,
		mode: "parallel",
		state: "running",
		startedAt: Date.now(),
		cwd: root,
		steps: [{ agent: "scout", status: "running" }, { agent: "worker", status: "running" }],
	};
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status), "utf-8");
	return asyncDir;
}

function tabClient(calls: string[][], shell: { foreground: number; shellPid: number }): HerdrClient {
	return {
		run: async <T>(args: string[]) => {
			calls.push(args);
			if (args[0] === "--version") return { ok: true, data: "herdr 0.9.0" as T };
			if (args[0] === "tab" && args[1] === "create") return { ok: true, data: { type: "tab_created", tab: { tab_id: "w1:t7" }, root_pane: { pane_id: "w1:p20", tab_id: "w1:t7" } } as T };
			if (args[0] === "pane" && args[1] === "split") return { ok: true, data: { type: "pane_info", pane: { pane_id: "w1:p21", tab_id: "w1:t7" } } as T };
			if (args[0] === "pane" && args[1] === "process-info") return { ok: true, data: { type: "pane_process_info", process_info: { foreground_process_group_id: shell.foreground, shell_pid: shell.shellPid } } as T };
			return { ok: true, data: {} as T };
		},
	};
}

describe("Herdr progress tabs", () => {
	it("opens an inspector tab with a shell pane below and closes the whole tab", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-tab-"));
		try {
			const asyncDir = writeRun(root);
			const calls: string[][] = [];
			const client = tabClient(calls, { foreground: 1, shellPid: 1 });
			const opened = await handleHerdrInspectorAction("inspector.open", { dir: asyncDir, layout: "tab" }, {
				cwd: root,
				asyncDirRoot: root,
				client,
				runnerPath: path.join(root, "runner.ts"),
				env: { HERDR_WORKSPACE_ID: "w1" },
				sessionRoots: Array.from({ length: 20 }, (_, index) => path.join(root, "sessions", `session-root-with-a-long-name-${index}`)),
			});
			assert.equal(opened.isError, undefined);
			const runCommand = calls.find((args) => args[0] === "pane" && args[1] === "run")?.[3] ?? "";
			assert.match(runCommand, /--args-file/);
			assert.ok(runCommand.length < 1024, `a fresh shell's tty drops typed lines past 1024 bytes; got ${runCommand.length}`);
			assert.deepEqual(calls.find((args) => args[0] === "tab" && args[1] === "create"), ["tab", "create", "--workspace", "w1", "--cwd", root, "--label", "scout+worker run-1234", "--no-focus"]);
			assert.deepEqual(calls.find((args) => args[0] === "pane" && args[1] === "split"), ["pane", "split", "w1:p20", "--direction", "down", "--cwd", root, "--no-focus"]);
			assert.ok(calls.some((args) => args[0] === "pane" && args[1] === "run" && args[2] === "w1:p20"));
			assert.ok(!calls.some((args) => args.includes("--current")), "tab layout must not split the caller's pane");
			const binding = readHerdrInspectorBinding(asyncDir);
			assert.equal(binding?.paneId, "w1:p20");
			assert.equal(binding?.tabId, "w1:t7");
			assert.equal(binding?.shellPaneId, "w1:p21");

			const closed = await handleHerdrInspectorAction("inspector.close", { dir: asyncDir }, { cwd: root, asyncDirRoot: root, client });
			assert.equal(closed.isError, undefined);
			assert.ok(calls.some((args) => args.join(" ") === "tab close w1:t7"));
			assert.equal(readHerdrInspectorBinding(asyncDir), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("closes an idle tab but keeps it while the shell runs a command", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-tab-idle-"));
		try {
			const asyncDir = writeRun(root);
			const calls: string[][] = [];
			const shell = { foreground: 500, shellPid: 100 };
			const client = tabClient(calls, shell);
			await handleHerdrInspectorAction("inspector.open", { dir: asyncDir, layout: "tab" }, { cwd: root, asyncDirRoot: root, client, runnerPath: path.join(root, "runner.ts"), env: {} });

			assert.equal(await closeIdleHerdrInspectorTab(asyncDir, client), false);
			assert.ok(!calls.some((args) => args[0] === "tab" && args[1] === "close"));
			assert.equal(readHerdrInspectorBinding(asyncDir)?.tabId, "w1:t7");

			shell.foreground = 100;
			assert.equal(await closeIdleHerdrInspectorTab(asyncDir, client), true);
			assert.ok(calls.some((args) => args.join(" ") === "tab close w1:t7"));
			assert.equal(readHerdrInspectorBinding(asyncDir), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("opens on async start and closes on completion only for the root Herdr session", async () => {
		const herdrEnv = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };
		const run = { id: "run-1", asyncDir: "/tmp/run-1" };
		const setup = (options: { enabled?: boolean; env?: Record<string, string>; hasUI?: boolean }) => {
			const events = new EventEmitter();
			const log: string[] = [];
			const tabs = registerHerdrProgressTabs({
				events: { on: (event, handler) => { events.on(event, handler); return () => events.off(event, handler); }, emit: (event, data) => events.emit(event, data) },
				enabled: options.enabled ?? true,
				env: options.env ?? herdrEnv,
				open: async (r: HerdrProgressTabRun) => { log.push(`open ${r.id} ${r.asyncDir}`); },
				closeIfIdle: async (r: HerdrProgressTabRun) => { log.push(`close ${r.id}`); },
			});
			tabs.sessionStarted({ hasUI: options.hasUI ?? true });
			return { events, log, tabs };
		};
		const settle = () => new Promise((resolve) => setImmediate(resolve));

		const { events, log, tabs } = setup({});
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { ...run, agent: "worker" });
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: "other-run" });
		events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: run.id });
		await settle();
		assert.deepEqual(log, ["open run-1 /tmp/run-1", "close run-1"]);
		tabs.dispose();
		events.emit(SUBAGENT_ASYNC_STARTED_EVENT, run);
		assert.equal(log.length, 2);

		for (const options of [{ enabled: false }, { env: {} }, { hasUI: false }]) {
			const other = setup(options);
			other.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, run);
			other.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { runId: run.id });
			await settle();
			assert.deepEqual(other.log, [], JSON.stringify(options));
		}
	});
});
