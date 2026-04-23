# pi-tps

Displays **live TPS** (tokens per second), **average TPS**, and **average TTFT** (time to first token) in the pi footer status bar.

Ported from [oc-tps](https://github.com/Tarquinen/oc-tps) by Tarquinen for the [pi coding agent](https://pi.dev).

## Install

```bash
pi install git:github.com/AnthonyFangqing/pi-tps
```

Or try without installing:

```bash
pi -e git:github.com/AnthonyFangqing/pi-tps
```

## How it works

- **Live TPS** — computed from a 5-second sliding window of streaming `text_delta` / `thinking_delta` events, same heuristic as oc-tps (`Buffer.byteLength(delta) / 5`).
- **Average TPS** — cumulative session average using provider-reported output token counts and wall-clock duration per completed assistant message.
- **TTFT** — average time-to-first-token across completed assistant messages.

Metrics appear in the pi footer as:

```
TPS 45.2 | AVG 38.1 | TTFT 0.8s
```

## License

MIT
