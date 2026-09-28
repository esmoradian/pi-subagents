import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT } from "../shared/types.ts";
import type { HerdrStatusBridgeEvents } from "./herdr-status.ts";

export interface HerdrProgressTabRun {
	id: string;
	asyncDir: string;
}

export interface HerdrProgressTabsOptions {
	events: HerdrStatusBridgeEvents;
	enabled: boolean;
	env?: Record<string, string | undefined>;
	/** Opens the run's inspector tab. Failures are swallowed; tabs are best effort. */
	open: (run: HerdrProgressTabRun) => Promise<unknown>;
	/** Closes the run's inspector tab when its shell pane is idle. */
	closeIfIdle: (run: HerdrProgressTabRun) => Promise<unknown>;
}

export interface HerdrProgressTabs {
	/** Only the root interactive session opens tabs; headless parents and children never do. */
	sessionStarted(input: { hasUI: boolean }): void;
	dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Opens one Herdr tab per top-level async run (inspector pane on top, shell
 * pane below) and closes it when the run completes and the shell is idle.
 * Observer only: tab failures never affect the run.
 */
export function registerHerdrProgressTabs(options: HerdrProgressTabsOptions): HerdrProgressTabs {
	const env = options.env ?? process.env;
	const active = options.enabled && env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID);
	// ponytail: in-memory only, so a /reload between start and completion leaves that run's tab open for the user to close.
	const opened = new Map<string, { run: HerdrProgressTabRun; ready: Promise<unknown> }>();
	const subscriptions: Array<() => void> = [];
	let rootSession = false;
	let disposed = false;

	const subscribe = (event: string, handler: (data: unknown) => void): void => {
		const unsubscribe = options.events.on(event, handler);
		if (typeof unsubscribe === "function") subscriptions.push(unsubscribe);
	};

	if (active) {
		subscribe(SUBAGENT_ASYNC_STARTED_EVENT, (data) => {
			if (!rootSession || disposed || !isRecord(data)) return;
			if (typeof data.id !== "string" || !data.id || typeof data.asyncDir !== "string" || !data.asyncDir) return;
			if (opened.has(data.id)) return;
			const run = { id: data.id, asyncDir: data.asyncDir };
			opened.set(run.id, { run, ready: options.open(run).catch(() => undefined) });
		});
		subscribe(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
			if (!isRecord(data)) return;
			const id = typeof data.runId === "string" ? data.runId : data.id;
			const entry = typeof id === "string" ? opened.get(id) : undefined;
			if (!entry) return;
			opened.delete(entry.run.id);
			// A fast run can complete before its tab finishes opening.
			void entry.ready.then(() => options.closeIfIdle(entry.run)).catch(() => undefined);
		});
	}

	return {
		sessionStarted({ hasUI }) {
			if (active && !disposed && hasUI === true) rootSession = true;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const unsubscribe of subscriptions) unsubscribe();
			opened.clear();
		},
	};
}
