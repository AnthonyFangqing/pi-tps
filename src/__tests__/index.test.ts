import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import tpsExtension, {
  estimateStreamTokens,
  formatRate,
  formatTtft,
  activeDurationMs,
} from '../index.js';

// --- Types for events used in tests ---
interface TurnStartEvent {
  turnIndex: number;
}

interface MessageUpdateEvent {
  assistantMessageEvent?: {
    type: 'text_delta' | 'thinking_delta' | 'other';
    delta?: string;
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

// --- Helpers ---
const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- Unit tests for exported helper functions ---
describe('estimateStreamTokens', () => {
  it('estimates ASCII text tokens as ceil(byteLength / 5)', () => {
    expect(estimateStreamTokens('hello')).toBe(1); // 5 bytes
    expect(estimateStreamTokens('hello world')).toBe(3); // 11 bytes -> ceil(11/5)=3
  });

  it('estimates Unicode text using UTF-8 byte length', () => {
    expect(estimateStreamTokens('héllo')).toBe(2); // 6 bytes -> ceil(6/5)=2
    expect(estimateStreamTokens('你好')).toBe(2); // 6 bytes -> ceil(6/5)=2
  });

  it('returns at least 1 for any input including empty string', () => {
    expect(estimateStreamTokens('a')).toBe(1);
    expect(estimateStreamTokens('')).toBe(1);
  });
});

describe('formatRate', () => {
  it('returns undefined for non-finite or non-positive values', () => {
    expect(formatRate(NaN, 'TPS')).toBeUndefined();
    expect(formatRate(Infinity, 'TPS')).toBeUndefined();
    expect(formatRate(-1, 'TPS')).toBeUndefined();
    expect(formatRate(0, 'TPS')).toBeUndefined();
  });

  it('formats >=100 as integer with optional TPS suffix', () => {
    expect(formatRate(100, 'TPS')).toBe('100 TPS');
    expect(formatRate(150.7, 'TPS')).toBe('151 TPS');
    expect(formatRate(1000, 'AVG')).toBe('1000');
  });

  it('formats >=10 with 1 decimal', () => {
    expect(formatRate(10, 'TPS')).toBe('10.0 TPS');
    expect(formatRate(99.99, 'TPS')).toBe('100.0 TPS');
    expect(formatRate(45.2, 'AVG')).toBe('45.2');
  });

  it('formats <10 with 2 decimals', () => {
    expect(formatRate(9.999, 'TPS')).toBe('10.00 TPS');
    expect(formatRate(5.5, 'TPS')).toBe('5.50 TPS');
    expect(formatRate(0.5, 'AVG')).toBe('0.50');
  });
});

describe('formatTtft', () => {
  it('returns undefined for non-finite or negative values', () => {
    expect(formatTtft(NaN)).toBeUndefined();
    expect(formatTtft(-0.1)).toBeUndefined();
  });

  it('formats to 1 decimal with s suffix', () => {
    expect(formatTtft(0)).toBe('0.0s');
    expect(formatTtft(0.8)).toBe('0.8s');
    expect(formatTtft(1.23)).toBe('1.2s');
  });
});

describe('activeDurationMs', () => {
  it('returns 0 for empty samples', () => {
    expect(activeDurationMs([])).toBe(0);
  });

  it('clamps single sample without tailAt to 1000ms', () => {
    const now = Date.now();
    expect(activeDurationMs([{ at: now, tokens: 1 }])).toBe(1000);
  });

  it('clamps single sample with tailAt to [250, 1000]', () => {
    const now = Date.now();
    expect(activeDurationMs([{ at: now, tokens: 1 }], now + 100)).toBe(250);
    expect(activeDurationMs([{ at: now, tokens: 1 }], now + 500)).toBe(500);
    expect(activeDurationMs([{ at: now, tokens: 1 }], now + 2000)).toBe(1000);
  });

  it('sums gaps between multiple samples with 1000ms minimum', () => {
    const now = Date.now();
    const samples = [
      { at: now, tokens: 1 },
      { at: now + 200, tokens: 1 },
      { at: now + 500, tokens: 1 },
    ];
    expect(activeDurationMs(samples)).toBe(1000); // 200 + 300 = 500, max(500, 1000) = 1000
  });

  it('adds tail duration for multiple samples', () => {
    const now = Date.now();
    const samples = [
      { at: now, tokens: 1 },
      { at: now + 600, tokens: 1 },
    ];
    expect(activeDurationMs(samples, now + 1600)).toBe(1600); // 600 + 1000 = 1600
  });
});

// --- Integration tests for extension event handlers ---
describe('pi-tps extension', () => {
  let mockPi: Partial<ExtensionAPI>;
  let handlers: Record<string, (...args: unknown[]) => unknown>;
  let setStatusSpy: ReturnType<typeof vi.fn>;
  let mockCtx: ExtensionContext;

  beforeEach(() => {
    handlers = {};
    setStatusSpy = vi.fn();

    mockCtx = {
      hasUI: true,
      ui: {
        setStatus: setStatusSpy,
        theme: { fg: vi.fn((_color: string, text: string) => text) },
      },
    } as unknown as ExtensionContext;

    mockPi = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers[event] = handler;
        return mockPi as ExtensionAPI;
      }),
    };

    tpsExtension(mockPi as ExtensionAPI);
  });

  afterEach(() => {
    if (handlers['session_shutdown']) {
      handlers['session_shutdown']();
    }
    vi.restoreAllMocks();
  });

  it('registers all required event handlers', () => {
    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('turn_start', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_update', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('message_end', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('tool_execution_start', expect.any(Function));
  });

  it('does nothing when hasUI is false on session_start', () => {
    const noUiCtx = { ...mockCtx, hasUI: false } as unknown as ExtensionContext;
    handlers['session_start']?.({}, noUiCtx);
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it('updates status on session_start', () => {
    handlers['session_start']?.({}, mockCtx);
    expect(setStatusSpy).toHaveBeenCalledWith('pi-tps', expect.any(String));
  });

  it('tracks turn_start and turn_end', () => {
    handlers['session_start']?.({}, mockCtx);
    setStatusSpy.mockClear();

    handlers['turn_start']?.({ turnIndex: 0 } as TurnStartEvent);
    handlers['turn_end']?.();
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it('tracks text_delta for live TPS', () => {
    handlers['session_start']?.({}, mockCtx);
    handlers['turn_start']?.({ turnIndex: 0 } as TurnStartEvent);

    const event: MessageUpdateEvent = {
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'hello world', // 11 bytes -> 3 tokens
      },
    };

    handlers['message_update']?.(event, mockCtx);
    expect(setStatusSpy).toHaveBeenCalled();
    const lastCall = setStatusSpy.mock.calls[setStatusSpy.mock.calls.length - 1];
    expect(lastCall[0]).toBe('pi-tps');
    expect(lastCall[1]).toMatch(/TPS/);
  });

  it('tracks thinking_delta same as text_delta', () => {
    handlers['session_start']?.({}, mockCtx);
    handlers['turn_start']?.({ turnIndex: 0 } as TurnStartEvent);

    const event: MessageUpdateEvent = {
      assistantMessageEvent: {
        type: 'thinking_delta',
        delta: 'thinking...',
      },
    };

    handlers['message_update']?.(event, mockCtx);
    const lastCall = setStatusSpy.mock.calls[setStatusSpy.mock.calls.length - 1];
    expect(lastCall[1]).toMatch(/TPS/);
  });

  it('ignores non-delta message_update events', () => {
    handlers['session_start']?.({}, mockCtx);
    setStatusSpy.mockClear();

    const event: MessageUpdateEvent = {
      assistantMessageEvent: {
        type: 'other',
        delta: 'ignored',
      },
    };

    handlers['message_update']?.(event, mockCtx);
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it('ignores message_update without assistantMessageEvent', () => {
    handlers['session_start']?.({}, mockCtx);
    setStatusSpy.mockClear();

    handlers['message_update']?.({}, mockCtx);
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it('accumulates session average on message_end for assistant', async () => {
    handlers['session_start']?.({}, mockCtx);
    handlers['turn_start']?.({ turnIndex: 0 } as TurnStartEvent);

    // Simulate streaming to set firstResponseAt
    handlers['message_update']?.({
      assistantMessageEvent: { type: 'text_delta', delta: 'a' },
    }, mockCtx);

    await tick(50);

    const endEvent: MessageEndEvent = {
      message: {
        role: 'assistant',
        usage: { output: 100, reasoning: 0 },
      },
    };

    setStatusSpy.mockClear();
    handlers['message_end']?.(endEvent, mockCtx);

    // Should show AVG and TTFT after message_end
    const lastCall = setStatusSpy.mock.calls[setStatusSpy.mock.calls.length - 1];
    expect(lastCall[1]).toMatch(/AVG/);
    expect(lastCall[1]).toMatch(/TTFT/);
  });

  it('ignores message_end for non-assistant', () => {
    handlers['session_start']?.({}, mockCtx);
    handlers['turn_start']?.({ turnIndex: 0 } as TurnStartEvent);

    const endEvent: MessageEndEvent = {
      message: { role: 'user' },
    };

    setStatusSpy.mockClear();
    handlers['message_end']?.(endEvent, mockCtx);
    expect(setStatusSpy).not.toHaveBeenCalled();
  });

  it('stops streaming on tool_execution_start', () => {
    handlers['session_start']?.({}, mockCtx);
    handlers['turn_start']?.({ turnIndex: 0 } as TurnStartEvent);

    handlers['message_update']?.({
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    }, mockCtx);

    setStatusSpy.mockClear();
    handlers['tool_execution_start']?.({}, mockCtx);

    // Status should no longer show live TPS digits
    const lastCall = setStatusSpy.mock.calls[setStatusSpy.mock.calls.length - 1];
    expect(lastCall[1]).not.toMatch(/TPS \d/);
  });

  it('prune timer updates status when streaming stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    handlers['session_start']?.({}, mockCtx);
    handlers['turn_start']?.({ turnIndex: 0 } as TurnStartEvent);

    handlers['message_update']?.({
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    }, mockCtx);

    setStatusSpy.mockClear();

    // Stop streaming so the prune timer will update status
    handlers['turn_end']?.();

    vi.advanceTimersByTime(1500);
    expect(setStatusSpy).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('formats session stats correctly after multiple messages', async () => {
    handlers['session_start']?.({}, mockCtx);
    handlers['turn_start']?.({ turnIndex: 0 } as TurnStartEvent);

    // First assistant message
    handlers['message_update']?.({
      assistantMessageEvent: { type: 'text_delta', delta: 'a'.repeat(50) },
    }, mockCtx);

    await tick(50);

    handlers['message_end']?.({
      message: { role: 'assistant', usage: { output: 50 } },
    }, mockCtx);

    // Second assistant message in same turn
    handlers['message_update']?.({
      assistantMessageEvent: { type: 'text_delta', delta: 'b'.repeat(50) },
    }, mockCtx);

    await tick(50);

    handlers['message_end']?.({
      message: { role: 'assistant', usage: { output: 50 } },
    }, mockCtx);

    // Should show AVG
    const lastCall = setStatusSpy.mock.calls[setStatusSpy.mock.calls.length - 1];
    expect(lastCall[1]).toMatch(/AVG/);
  });
});
