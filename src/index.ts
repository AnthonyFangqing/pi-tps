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

export type StreamSample = {
	at: number;
	tokens: number;
};

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

type TrackerState = {
	streamSamples: StreamSample[];
	messageTimingByTurn: Record<number, MessageTiming>;
	sessionAverage: SessionAverage;
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

const STREAM_WINDOW_MS = 5_000;
const LIVE_STALE_MS = 1_500;
const SINGLE_SAMPLE_MS = 1_000;
const PRUNE_INTERVAL_MS = 1_000;

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

export function activeDurationMs(samples: StreamSample[], tailAt?: number): number {
	if (samples.length === 0) return 0;
	if (samples.length === 1) {
		const tailDuration = tailAt ? Math.max(0, tailAt - samples[0].at) : SINGLE_SAMPLE_MS;
		return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS);
	}

	let duration = 0;
	for (let i = 1; i < samples.length; i++) {
		duration += Math.max(0, samples[i].at - samples[i - 1].at);
	}

	if (tailAt) {
		duration += Math.max(0, tailAt - samples[samples.length - 1].at);
	}

	return Math.max(duration, SINGLE_SAMPLE_MS);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const tracker: TrackerState = {
		streamSamples: [],
		messageTimingByTurn: {},
		sessionAverage: { totalTokens: 0, totalDurationMs: 0, totalTtftMs: 0, messageCount: 0 },
	};

	let currentTurnIndex: number | undefined;
	let isStreaming = false;
	let pruneTimer: ReturnType<typeof setInterval> | undefined;

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
		const samples = tracker.streamSamples;
		if (samples.length === 0) return undefined;
		const now = Date.now();
		const relevant = samples.filter((s) => now - s.at <= STREAM_WINDOW_MS);
		if (relevant.length === 0) return undefined;
		const lastSample = relevant[relevant.length - 1]!;
		if (now - lastSample.at > LIVE_STALE_MS) return undefined;
		const total = relevant.reduce((sum, s) => sum + s.tokens, 0);
		const durationSeconds = activeDurationMs(relevant, now) / 1000;
		if (durationSeconds <= 0) return undefined;
		return formatRate(total / durationSeconds, "TPS");
	}

	function computeSessionAvg(): string | undefined {
		const totals = tracker.sessionAverage;
		if (totals.totalTokens <= 0 || totals.totalDurationMs <= 0) return undefined;
		return formatRate(totals.totalTokens / (totals.totalDurationMs / 1000), "AVG");
	}

	function computeSessionTtft(): string | undefined {
		const totals = tracker.sessionAverage;
		if (totals.messageCount <= 0 || totals.totalTtftMs < 0) return undefined;
		return formatTtft(totals.totalTtftMs / totals.messageCount / 1000);
	}

	// -- Prune stale samples --------------------------------------------------

	function pruneSamples(now = Date.now()) {
		let changed = false;
		const next = tracker.streamSamples.filter((s) => now - s.at <= STREAM_WINDOW_MS);
		if (next.length !== tracker.streamSamples.length) {
			changed = true;
			tracker.streamSamples = next;
		}
		return changed;
	}

	// -- Events ---------------------------------------------------------------

	pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		// Reset state
		tracker.streamSamples = [];
		tracker.messageTimingByTurn = {};
		tracker.sessionAverage = { totalTokens: 0, totalDurationMs: 0, totalTtftMs: 0, messageCount: 0 };
		currentTurnIndex = undefined;
		isStreaming = false;

		updateStatus(ctx);

		// Start prune timer
		pruneTimer = setInterval(() => {
			pruneSamples();
			// Force re-render even when idle so stale live TPS clears
			if (!isStreaming) {
				updateStatus({ ui: ctx.ui });
			}
		}, PRUNE_INTERVAL_MS);
	});

	pi.on("session_shutdown", async () => {
		if (pruneTimer) {
			clearInterval(pruneTimer);
			pruneTimer = undefined;
		}
	});

	// Track turn index and mark start of LLM call
	pi.on("turn_start", async (event: TurnStartEvent) => {
		currentTurnIndex = event.turnIndex;
		tracker.messageTimingByTurn[event.turnIndex] = {
			requestStartAt: Date.now(),
		};
	});

	pi.on("turn_end", async () => {
		isStreaming = false;
		currentTurnIndex = undefined;
	});

	// Track streaming deltas for live TPS
	pi.on("message_update", async (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		const e = event.assistantMessageEvent;
		if (!e) return;

		// Record first-response timing
		if (currentTurnIndex !== undefined) {
			const timing = tracker.messageTimingByTurn[currentTurnIndex];
			if (timing && !timing.firstResponseAt) {
				timing.firstResponseAt = Date.now();
			}
		}

		// Handle text and thinking deltas
		if (e.type === "text_delta" || e.type === "thinking_delta") {
			isStreaming = true;

			// Record first-token timing
			if (currentTurnIndex !== undefined) {
				const timing = tracker.messageTimingByTurn[currentTurnIndex];
				if (timing && !timing.firstTokenAt) {
					timing.firstTokenAt = Date.now();
				}
				if (timing) {
					timing.lastTokenAt = Date.now();
				}
			}

			// Append stream sample
			const now = Date.now();
			tracker.streamSamples = [
				...tracker.streamSamples.filter((s) => now - s.at <= STREAM_WINDOW_MS),
				{ at: now, tokens: estimateStreamTokens(e.delta) },
			];

			updateStatus(ctx);
		}
	});

	// When a message ends, accumulate session averages
	pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;

		isStreaming = false;

		// Find the timing for this turn
		const timing = currentTurnIndex !== undefined
			? tracker.messageTimingByTurn[currentTurnIndex]
			: undefined;

		if (timing && typeof timing.firstResponseAt === "number") {
			const outputTokens = msg.usage?.output ?? 0;
			const reasoningTokens = msg.usage?.reasoning ?? 0;
			// Some providers report reasoning inside output; avoid double-count
			const totalTokens = Math.max(outputTokens, 0) + (outputTokens >= reasoningTokens ? 0 : reasoningTokens);

			if (totalTokens <= 0) {
				// Fallback: estimate from stream samples that are still around
				const liveEstimate = tracker.streamSamples.reduce((sum, s) => sum + s.tokens, 0);
				if (liveEstimate <= 0) {
					updateStatus(ctx);
					return;
				}
			}

			const endAt = timing.lastToolCallAt ?? Date.now();
			const durationMs = Math.max(endAt - timing.firstResponseAt, 1);
			const ttftMs = Math.max(timing.firstResponseAt - timing.requestStartAt, 0);

			// Use provider tokens if available, otherwise estimate from samples
			const tokensToUse = totalTokens > 0 ? totalTokens : tracker.streamSamples.reduce((s, x) => s + x.tokens, 0);

			if (tokensToUse > 0 && durationMs > 0) {
				const avg = tracker.sessionAverage;
				tracker.sessionAverage = {
					totalTokens: avg.totalTokens + tokensToUse,
					totalDurationMs: avg.totalDurationMs + durationMs,
					totalTtftMs: avg.totalTtftMs + ttftMs,
					messageCount: avg.messageCount + 1,
				};
			}
		}

		// Clear live samples (tool calls or end of turn will interrupt streaming)
		tracker.streamSamples = tracker.streamSamples.filter(
			(s) => Date.now() - s.at <= STREAM_WINDOW_MS,
		);

		updateStatus(ctx);
	});

	// When a tool starts, clear live TPS (tools interrupt the stream)
	pi.on("tool_execution_start", async (_event: unknown, ctx: ExtensionContext) => {
		isStreaming = false;
		// Record last tool call time
		if (currentTurnIndex !== undefined) {
			const timing = tracker.messageTimingByTurn[currentTurnIndex];
			if (timing) {
				timing.lastToolCallAt = Date.now();
			}
		}
		updateStatus(ctx);
	});
}
