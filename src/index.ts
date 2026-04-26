/**
 * pi-tps — Live TPS (tokens per second), average TPS, and average TTFT
 * (time to first token) displayed in the pi footer status bar.
 *
 * Ported from oc-tps by Tarquinen (https://github.com/Tarquinen/oc-tps)
 * for the pi coding agent.
 *
 * Install:
 *   pi install /path/to/pi-tps
 *   — or —
 *   pi -e /path/to/pi-tps
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MessageTiming = {
	requestStartAt: number;
	firstResponseAt?: number;
	firstTokenAt?: number;
	lastTokenAt?: number;
	lastToolCallAt?: number;
};

type SessionAverage = {
	totalTokens: number;
	totalDurationMs: number;
	totalTtftMs: number;
	messageCount: number;
};

// Local event shapes (not exported by pi-coding-agent)
interface SessionStartEvent {
	reason?: string;
}

interface TurnStartEvent {
	turnIndex: number;
}

interface MessageUpdateEvent {
	assistantMessageEvent?: {
		type: string;
		delta: string;
	} | null;
}

interface MessageEndEvent {
	message: {
		role: string;
		usage?: {
			output?: number;
			reasoning?: number;
		};
	};
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BURST_MIN_DURATION_MS = 250;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rough token estimate from a text delta (same heuristic as oc-tps). */
export function estimateStreamTokens(delta: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5));
}

export function formatRate(value: number, label: "TPS" | "AVG"): string | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	if (value >= 100) return `${Math.round(value)}${label === "TPS" ? " TPS" : ""}`;
	if (value >= 10) return `${value.toFixed(1)}${label === "TPS" ? " TPS" : ""}`;
	return `${value.toFixed(2)}${label === "TPS" ? " TPS" : ""}`;
}

export function formatTtft(value: number): string | undefined {
	if (!Number.isFinite(value) || value < 0) return undefined;
	return `${value.toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const messageTimingByTurn: Record<number, MessageTiming> = {};
	const sessionAverage: SessionAverage = {
		totalTokens: 0,
		totalDurationMs: 0,
		totalTtftMs: 0,
		messageCount: 0,
	};

	let currentTurnIndex: number | undefined;
	let isStreaming = false;

	// Burst tracking: cumulative tokens and start time for the current
	// uninterrupted stretch of LLM streaming. Resets on tool calls,
	// message boundaries, and turn boundaries so TPS is accurate
	// immediately after a gap (no warm-up).
	let burstStartAt: number | undefined;
	let burstTokens = 0;

	// -- Refresh the status display -------------------------------------------

	function updateStatus(ctx: { ui: any }) {
		const theme = ctx.ui.theme;
		const parts: string[] = [];

		// Live TPS
		const liveTps = computeLiveTps();
		parts.push(`TPS ${liveTps ?? "-"}`);

		// Session average TPS
		const avg = computeSessionAvg();
		parts.push(`AVG ${avg ?? "-"}`);

		// Average TTFT
		const ttft = computeSessionTtft();
		parts.push(`TTFT ${ttft ?? "-"}`);

		const text = parts.join(" | ");
		ctx.ui.setStatus("pi-tps", theme.fg("muted", text));
	}

	function computeLiveTps(): string | undefined {
		if (!isStreaming) return undefined;
		if (!burstStartAt || burstTokens <= 0) return undefined;
		const now = Date.now();
		const durationMs = Math.max(now - burstStartAt, BURST_MIN_DURATION_MS);
		const durationSeconds = durationMs / 1000;
		return formatRate(burstTokens / durationSeconds, "TPS");
	}

	function computeSessionAvg(): string | undefined {
		if (sessionAverage.totalTokens <= 0 || sessionAverage.totalDurationMs <= 0) return undefined;
		return formatRate(sessionAverage.totalTokens / (sessionAverage.totalDurationMs / 1000), "AVG");
	}

	function computeSessionTtft(): string | undefined {
		if (sessionAverage.messageCount <= 0 || sessionAverage.totalTtftMs < 0) return undefined;
		return formatTtft(sessionAverage.totalTtftMs / sessionAverage.messageCount / 1000);
	}

	// -- Reset burst ----------------------------------------------------------

	function resetBurst() {
		isStreaming = false;
		burstStartAt = undefined;
		burstTokens = 0;
	}

	// -- Events ---------------------------------------------------------------

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		// Reset state
		Object.keys(messageTimingByTurn).forEach((k) => delete messageTimingByTurn[+k]);
		sessionAverage.totalTokens = 0;
		sessionAverage.totalDurationMs = 0;
		sessionAverage.totalTtftMs = 0;
		sessionAverage.messageCount = 0;
		currentTurnIndex = undefined;
		resetBurst();

		updateStatus(ctx);
	});

	// Track turn index and mark start of LLM call
	pi.on("turn_start", async (event: TurnStartEvent) => {
		currentTurnIndex = event.turnIndex;
		messageTimingByTurn[event.turnIndex] = {
			requestStartAt: Date.now(),
		};
	});

	pi.on("turn_end", async () => {
		currentTurnIndex = undefined;
		resetBurst();
	});

	// Track streaming deltas for live TPS
	pi.on("message_update", async (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		const e = event.assistantMessageEvent;
		if (!e) return;

		// Record first-response timing
		if (currentTurnIndex !== undefined) {
			const timing = messageTimingByTurn[currentTurnIndex];
			if (timing && !timing.firstResponseAt) {
				timing.firstResponseAt = Date.now();
			}
		}

		// Handle text and thinking deltas
		if (e.type === "text_delta" || e.type === "thinking_delta") {
			const now = Date.now();
			const tokens = estimateStreamTokens(e.delta);

			// Start or continue burst
			if (!burstStartAt) {
				burstStartAt = now;
			}
			burstTokens += tokens;
			isStreaming = true;

			// Record first-token timing
			if (currentTurnIndex !== undefined) {
				const timing = messageTimingByTurn[currentTurnIndex];
				if (timing && !timing.firstTokenAt) {
					timing.firstTokenAt = now;
				}
				if (timing) {
					timing.lastTokenAt = now;
				}
			}

			updateStatus(ctx);
		}
	});

	// When a message ends, accumulate session averages
	pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;

		resetBurst();

		// Find the timing for this turn
		const timing = currentTurnIndex !== undefined
			? messageTimingByTurn[currentTurnIndex]
			: undefined;

		if (timing && typeof timing.firstResponseAt === "number") {
			const outputTokens = msg.usage?.output ?? 0;
			const reasoningTokens = msg.usage?.reasoning ?? 0;
			// Some providers report reasoning inside output; avoid double-count
			const totalTokens = Math.max(outputTokens, 0) + (outputTokens >= reasoningTokens ? 0 : reasoningTokens);

			const endAt = timing.lastToolCallAt ?? Date.now();
			const durationMs = Math.max(endAt - timing.firstResponseAt, 1);
			const ttftMs = Math.max(timing.firstResponseAt - timing.requestStartAt, 0);

			if (totalTokens > 0 && durationMs > 0) {
				sessionAverage.totalTokens += totalTokens;
				sessionAverage.totalDurationMs += durationMs;
				sessionAverage.totalTtftMs += ttftMs;
				sessionAverage.messageCount += 1;
			}
		}

		updateStatus(ctx);
	});

	// When a tool starts, reset the burst (tools interrupt the stream)
	pi.on("tool_execution_start", async (_event: unknown, ctx: ExtensionContext) => {
		resetBurst();

		// Record last tool call time for duration calculation
		if (currentTurnIndex !== undefined) {
			const timing = messageTimingByTurn[currentTurnIndex];
			if (timing) {
				timing.lastToolCallAt = Date.now();
			}
		}
		updateStatus(ctx);
	});
}
