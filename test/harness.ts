/**
 * A minimal stand-in for pi's extension host.
 *
 * Enough of `ExtensionAPI` and `ExtensionContext` to drive the extension's real
 * event flow in-process: emit events, invoke registered commands, and observe
 * what it sent back. Everything the extension does not touch is omitted.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Handler = (event: unknown, ctx: unknown) => unknown;
type InputHandler = (data: string) => { consume?: boolean } | undefined;

export interface SentMessage {
	customType: string;
	content: string;
	details: unknown;
}

export interface Harness {
	/** The fake `ExtensionAPI` to hand to the extension's factory. */
	readonly api: never;
	/** Deliver an event to every handler registered for it, as pi does. */
	emit(event: string, payload?: Record<string, unknown>): Promise<void>;
	/** Convenience: report a failed assistant turn with this error text. */
	fail(errorMessage: string): Promise<void>;
	/** Invoke the extension's registered `/retry-limit` command. */
	command(args: string): Promise<void>;
	/** Feed a raw keystroke to terminal-input listeners. */
	key(data: string): void;
	/** Messages the extension injected via `pi.sendMessage`. */
	readonly sent: SentMessage[];
	readonly notifications: string[];
	readonly widget: string[] | undefined;
	dispose(): void;
}

export function createHarness(options: { mode: "tui" | "print"; env?: Record<string, string> }): Harness {
	const handlers = new Map<string, Handler[]>();
	const inputListeners = new Set<InputHandler>();
	const sent: SentMessage[] = [];
	const notifications: string[] = [];
	let widget: string[] | undefined;
	let command: ((args: string, ctx: unknown) => Promise<void> | void) | undefined;

	// An empty cwd keeps a project-local `.pi/retry-limit.json` out of the picture.
	const cwd = mkdtempSync(join(tmpdir(), "retry-limit-harness-"));

	const ctx = {
		cwd,
		mode: options.mode,
		hasUI: options.mode === "tui",
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
			setStatus: () => {},
			setWidget: (_key: string, lines: string[] | undefined) => {
				widget = lines;
			},
			onTerminalInput: (handler: InputHandler) => {
				inputListeners.add(handler);
				return () => inputListeners.delete(handler);
			},
		},
	};

	async function emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		for (const handler of handlers.get(event) ?? []) {
			await handler({ type: event, ...payload }, ctx);
		}
	}

	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerFlag: () => {},
		getFlag: () => false,
		registerCommand: (_name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
			command = definition.handler;
		},
		sendMessage: (message: SentMessage) => {
			sent.push(message);
			// Pi starts the run asynchronously; mirror that so the extension's
			// "did the resume actually start?" watchdog sees realistic timing.
			queueMicrotask(() => void emit("agent_start"));
		},
	};

	const previousEnv = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(options.env ?? {})) {
		previousEnv.set(key, process.env[key]);
		process.env[key] = value;
	}

	return {
		api: api as never,
		emit,
		fail: (errorMessage: string) =>
			emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage } }),
		command: async (args: string) => {
			if (!command) throw new Error("the extension registered no command");
			await command(args, ctx);
		},
		key: (data: string) => {
			for (const listener of inputListeners) if (listener(data)?.consume) return;
		},
		sent,
		notifications,
		get widget() {
			return widget;
		},
		dispose: () => {
			// The extension's shutdown handler cleans timers/listeners synchronously.
			// Exercise that cleanup rather than leaking a fetch observer between tests.
			void emit("session_shutdown");
			for (const [key, value] of previousEnv) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

/** Let already-queued microtasks, timers, and countdown ticks run. */
export function settle(ms = 20): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
