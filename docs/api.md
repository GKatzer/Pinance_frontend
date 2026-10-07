# API used by the frontend

All calls are `GET` and read-only. `{symbol}` is the pair id URL-encoded (`BTC/USDT` becomes `BTC%2FUSDT`); the four symbols are `BTC/USDT`, `ETH/USDT`, `SOL/USDT`, `BNB/USDT`. The base URL is `VITE_API_URL` (empty = same origin). Every `fetch` has a 15 s timeout (`AbortSignal.timeout`).

Responses below were captured from the public deployment on 2026-10-03 (about 08:05 UTC) for BTC/USDT; the trimmed files are in [`examples/`](examples/). The backend is the source of truth for these shapes; this document describes what the frontend reads.

## Endpoints

| Endpoint | Used by | When | Notes |
|---|---|---|---|
| `GET /candles/{symbol}?timeframe={1D\|1W\|1M\|1Y\|ALL}` | `useLiveCandles` | on mount, on symbol/timeframe change | closed candles only; `interval` is `5m`, `15m`, `1h`, `1d`, `1d` |
| `GET /candles/{symbol}/latest` | `useLiveCandles` (once, 24H), `usePairPrices` | every 10 s for all four symbols | the current, still-forming candle (`closed: false`) |
| `GET /candles/{symbol}/pred_history?horizon={h}&hours={n}` | `useLiveCandles` | 24H: `horizon=1&hours=24` (re-polled every 30 s); 1W: `horizon=3&hours=168` | past forecasts with outcome, for the trail |
| `GET /snapshot/{symbol}` | `usePriceStream`, `useLiveCandles` | on mount, SSE (re)connect, every 30 s on 24H | last candle, latest forecast, recent resolved results |
| `GET /stream/{symbol}` (SSE) | `useEventSource` (shell), `useLiveCandles` (24H only) | continuous | events `tick`, `prediction`, `result`, `ping` |
| `GET /metrics/{symbol}/summary` | `useMetricsSummary` | every 45 s | windows `1h`, `24h`, `7d`, `30d`, `all` |
| `GET /metrics/{symbol}/history?metric={accuracy\|mae}&window=&bucket=` | `useMetricsHistory` | on mount of Performance tab | `24h/1h` and `7d/1d` are used |
| `GET /metrics/{symbol}/errors?window=24h&bins=24` | `useMetricsErrors` | on mount | histogram of forecast error in USD |
| `GET /metrics/{symbol}/scatter?window=24h&limit=200` | `useMetricsScatter` | on mount | actual vs predicted price, with q10/q90, and R² |
| `GET /metrics/{symbol}/coverage` | `useMetricsCoverage` | every 45 s | q10/q90 coverage per window |
| `GET /metrics/{symbol}/coverage_history?window=24h&bucket=1h` | `useMetricsCoverageHistory` | on mount | coverage, mean width and pinball loss per bucket |
| `GET /metrics/{symbol}/width_histogram?window=24h&bins=24` | `useMetricsWidthHistogram` | on mount | histogram of corridor width |
| `GET /metrics/{symbol}/retrain-timeline?limit=8` | `useMetricsRetrainTimeline` | every 45 s | last decisions per track |
| `GET /metrics/{symbol}/latency?window=24h` | `useMetricsLatency` | every 45 s | inference latency percentiles |
| `GET /metrics/{symbol}/drift` | `useMetricsDrift` | every 45 s | **returns 404 today**, see below |

`/health` and `/ready` are not called by the frontend; the dev proxy forwards them only so they can be checked through the dev server (`{"status":"ok"}` and `{"status":"ready"}` on the public deployment).

On any non-2xx response a hook keeps the previous data (if any) and exposes `error`; pages then show their empty or error text. A request that does not finish in 15 s is aborted.

## Responses

### `/snapshot/{symbol}`

[`examples/snapshot-BTCUSDT.json`](examples/snapshot-BTCUSDT.json) (trimmed: 2 of 12 horizons, 2 of 240 results).

```json
{
  "symbol": "BTC/USDT",
  "last_candle": { "ts": 1791013800000, "closed": false, "open": 84600.01, "high": 84609.07, "low": 84574.96, "close": 84574.96, "volume": 13.43942 },
  "prediction": {
    "as_of_ts": "2026-10-03T07:45:00+00:00",
    "close": 84600.0,
    "model_version": "202610021348-4de49a70",
    "quantile_model_version": "202610021525-4de49a70",
    "schema_version": "38b98fc7516d",
    "feature_count": 93,
    "predictions": [
      { "horizon": 1, "target_ts": "2026-10-03T07:50:00+00:00", "r_pred": -1.28e-06, "price_pred": 84599.89,
        "r_q10": -0.000422, "r_q90": 0.000430, "price_q10": 84564.28, "price_q90": 84636.43 }
    ]
  },
  "recent_results": [
    { "as_of_ts": "2026-10-03T07:10:00", "horizon": 7, "target_ts": "2026-10-03T07:45:00",
      "price_pred": 84591.998, "price_q10": 84490.247, "price_q90": 84684.423,
      "actual_price": 84600.0, "hit": true, "model_version": "202610021348-4de49a70" }
  ]
}
```

- `model_version` is `YYYYMMDDHHMM-<commit>` in UTC; the frontend parses it for the top-bar badge (`ML · Oct 2`), the MLOps "Serving model" tile and the tooltips.
- `predictions` has 12 entries, horizon 1 to 12, five minutes apart.
- `quantile_model_version`, `price_q10`, `price_q90` may be absent on rows from before the corridor model existed; the code falls back to `price_pred`.
- `recent_results` holds up to 240 rows (12 horizons × 20 candles); the same shape arrives as the SSE `result` event.

### SSE `/stream/{symbol}`

[`examples/sse-tick-sample.txt`](examples/sse-tick-sample.txt)

```text
event: tick
data: {"symbol": "BTC/USDT", "ts": 1791014700000, "closed": false, "open": 84594.72, "high": 84614.01, "low": 84594.71, "close": 84614.01, "volume": 3.01572}
```

| Event | Payload | Frontend reaction |
|---|---|---|
| `tick` | the forming 5-minute candle | updates the last candle; when `ts` changes the previous candle is considered closed |
| `prediction` | same object as `snapshot.prediction` | redraws the forecast; registers all 12 horizons as pending for client-side resolution |
| `result` | one resolved forecast (shape of `recent_results[i]`) | prepended to the prediction log; for horizon 1 also replaces the client's own hit/miss on the chart |
| `ping` | keepalive, every 15 s per the code comments | resets the silence watchdog |

### `/metrics/{symbol}/summary`

[`examples/metrics-summary-BTCUSDT.json`](examples/metrics-summary-BTCUSDT.json)

```json
{ "windows": { "24h": { "directional_accuracy": 52.3, "mae": 133.53, "rmse": 223.49, "delta_accuracy": -0.1,
                         "n": 3432, "sharpe": 2.788, "sharpe_n": 286 }, "…": "1h, 7d, 30d, all" },
  "updated_at": "2026-10-03T08:05:07.189185Z" }
```

`directional_accuracy` is in percent; `mae`/`rmse` are in USD; `delta_accuracy` (percentage points) is shown as the green/red arrow; `n` counts forecast rows (about 12 per candle); `sharpe` is simulated on horizon 1 with `sharpe_n` samples.

### `/metrics/{symbol}/coverage`

[`examples/coverage-BTCUSDT.json`](examples/coverage-BTCUSDT.json): per window `{ n, q10_coverage, q90_coverage }` as fractions (0.0857 = 8.57 % of outcomes fell below the q10 bound; the target is 0.10 and 0.90).

### Other metric endpoints (shapes seen on the public deployment)

```text
/history?metric=mae&window=24h&bucket=6h   {"metric","window","bucket","points":[{"ts":"2026-10-02T06:00:00Z","value":136.1}, …]}
/errors?window=24h&bins=6                  {"bin_edges":[-692.21,…,1279.52],"counts":[79,1155,1874,228,84,24],"mean_error":31.68,"std_error":223.01}
/scatter?window=24h&limit=2                {"points":[{"actual":84205.42,"predicted":84177.49,"q10":83692.21,"q90":84547.18}, …],"r2":0.932}
/coverage_history?window=24h&bucket=6h     {"window","bucket","points":[{"ts","q10_coverage","q90_coverage","avg_width","pinball_loss"}, …]}
/width_histogram?window=24h&bins=4         {"bin_edges":[59.72,…],"counts":[1831,998,487,128],"mean_width":517.31,"std_width":348.37}
/latency?window=24h                        {"window":"24h","n":286,"p50":119.1,"p95":737.4,"p99":864.5}
```

(`/latency`: [`examples/latency-BTCUSDT.json`](examples/latency-BTCUSDT.json).) `ts` values are UTC; the frontend formats them in UTC.

### `/metrics/{symbol}/retrain-timeline`

[`examples/retrain-timeline-BTCUSDT.json`](examples/retrain-timeline-BTCUSDT.json) (`limit=2`): two arrays, `point` and `quantile`, newest first as returned (the frontend re-sorts by `decided_at` descending anyway). Each event:

```json
{ "candidate_version": "202610021348-4de49a70", "production_version": "202610021348-4de49a70",
  "decision": "rejected", "metric_name": "directional_accuracy (new_scheme_manual_promotion_required)",
  "candidate_value": 50.3, "production_value": 50.3, "threshold": 1.0, "n_samples": 2334,
  "train_wall_seconds": null, "decided_at": "2026-10-03T06:00:05.660334" }
```

The UI uses `decision` (`promoted` or anything else shown as rejected), `candidate_version`, `decided_at` and `n_samples`.

### `/metrics/{symbol}/drift` (not implemented on the backend)

```text
{"detail":"Not Found"}   HTTP 404
```

When the backend adds it, the panel expects `{ "features": [ { "feature": "rsi", "psi": 0.07, "status": "ok|warn|alert" }, … ] }` for these six feature names: `btc_ret`, `atr`, `bb_width`, `rsi`, `ret_std_144`, `macd_diff`; the bar width is `psi / 0.4`. That is the contract the code reads; no backend provides it today.

## Candle counts per timeframe

[`examples/candles-counts-by-timeframe.json`](examples/candles-counts-by-timeframe.json), as returned for BTC/USDT:

| Timeframe | Interval | Candles |
|---|---|---|
| 1D | 5 m | 288 |
| 1W | 15 m | 672 |
| 1M | 1 h | 720 |
| 1Y | 1 d | 365 |
| ALL | 1 d | 3,075 |
