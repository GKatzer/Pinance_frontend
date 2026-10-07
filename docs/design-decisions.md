# Design decisions

Why the frontend looks and behaves the way it does, what was tried first, and what was dropped. The reasoning comes from the source comments and the version history; where a decision rests on an observed symptom, the symptom is named.

## Product decisions

### Show the model's measured quality next to the forecast

A price forecast with no track record invites over-trust. The Live page therefore places the hit rate, rolling accuracy, MAE, RMSE and the prediction log beside the chart, and a whole tab (Model Performance) is spent on calibration and error. The corridor (q10–q90) is drawn so that its width, and its misses, are visible: the log marks each outcome `◆` (inside) or `◇` (outside).

### Never fill a gap with a plausible number

When data is missing the interface prints `--`, `NO DATA`, an HTTP error, or "endpoint not deployed yet". This is the reason the drift panel and the Brier row stay empty instead of showing sample values, and the reason the serving-model tile shows `--` when the snapshot has expired, rather than the last known version "as if the model were still alive". The same rule removed the earlier hard-coded header values, the mock event tape and the fixed prices in the pair menu: each now shows live data or `--`.

### The live indicator reports the connection, not a clock

`LIVE · UPDATED Ns AGO` is driven by the SSE stream's state (`open`, `error`, `connecting`) and the time the browser last received a tick. An earlier version derived the seconds from the wall clock, so it kept "updating" with the backend down; a status that cannot go wrong is not a status.

### Two independent model tracks

The point forecast and the corridor are separate models with separate versions, retrain schedules and promotion decisions (the training repository records an incident where a rejected point model reached production together with an approved corridor, which led to independent decisions). The UI mirrors that: separate "Pointer model" and "Quantile models" sections, a two-track retrain timeline, and a corridor-model version shown next to the coverage card.

### Hit-rate window follows the timeframe

The `HIT RATE` tile used to be a 1-hour figure under a tab labelled `24H`, a real mismatch. It now maps `24H→24 h`, `1W→7 d`, `1M→30 d`, `1Y/ALL→all`. The model's horizon (5–60 min) does not change with the tab; only the averaging period does. `1Y` and `ALL` match because the backend keeps 90 days of forecasts.

### Forecast trail only where the horizon fits the candle

The trail of past forecasts exists for 24H (horizon 1 on 5-minute candles) and 1W (horizon 3 on 15-minute candles, covering exactly 168 hours). On 1M, 1Y and ALL the model's 5-minute horizon does not coincide with 1-hour or 1-day candle boundaries, so there is nothing honest to draw without backend changes.

### Ticker shows only fast-moving numbers

Model version, drift, p95 latency and the next retrain time were removed from the ticker tape. Not for lack of data: a tape implies numbers that change constantly, while those values change hourly or daily. The version stays in the badge and on the MLOps tab.

## Data flow decisions

### The backend computes metrics; the browser renders them

Rejected: accumulating SSE `result` events in each tab and computing windows on the client. The buffer is truncated by count, not by time; it vanishes on reload; and every open tab ends up with a different hit rate for the same symbol. Windows, trends and distributions are computed once on the backend, cached, and fetched as finished numbers (about every 45 s, as agreed with the backend, since results arrive every five minutes anyway).

### A silence watchdog, not just `onerror`

Rejected: relying on `EventSource.onerror` (or the native auto-reconnect) alone. A reverse proxy can keep a socket open while the backend restarts, so the browser sees no error and the chart, the log and the metrics silently stop. The backend sends a `ping` every 15 s; the frontend treats every event, including `ping`, as proof of life and reconnects after 45 s of silence (three missed pings absorb jitter and one lost ping).

### Poll as well as stream

The prediction log is refreshed every 30 s even while the stream is healthy. A stream that stays open while the backend's result publisher has stopped looks identical to "no new results yet", so a poll is the independent source of truth. The same reasoning applies to the forecast history.

### Fifteen-second fetch timeout

Rejected: bare `fetch`. A request accepted by a proxy but never answered holds one of the browser's few per-origin connections; enough of them would block SSE and every other request until a manual reload. Every fetch carries `AbortSignal.timeout(15000)`. This is especially important for the ticker's polling, which issues four requests at a time.

### Client-side hit/miss as a fallback

The backend persists resolved results with a delay and did not always send the `result` event. The browser therefore resolves a forecast itself when its target candle closes, using the sign of the move from the forecast's anchor close, and treats the backend's result as authoritative when it arrives. Registering all 12 horizons of every snapshot gives each future candle up to 12 independent chances to be matched, so one lost snapshot does not leave a gap.

### The live candle is merged into the first render

REST `/candles` returns only closed candles, so the first 24H render was one candle "older" than what the stream delivered a second later, and the chart visibly jumped. The page fetches `/candles/{symbol}/latest` in the same batch and appends it before the first render (best-effort: a 404 does not fail the load).

### Drift hook written before the endpoint

`useMetricsDrift` and the PSI table exist while the backend returns 404. The hook honestly propagates the error, so when the endpoint appears the panel starts working without a code change. Until then it shows its empty state. The six curated feature names are kept in sync by hand with the training and inference repositories.

## Rendering decisions

### The price chart is hand-built SVG

The chart needs a forecast corridor that widens into a reserved future zone, a trail of per-forecast hit/miss lines, a baseline-relative fill and a past-corridor band, all synchronised with one tooltip. That is easier to control directly than to bend a general charting library into. The performance pages have standard needs (area, bar, scatter), so they use Recharts.

### Smooth hover on thousands of candles

The symptom behind these optimisations: on the large timeframes (1W/1Y/ALL) the tooltip lagged behind a fast cursor and caught up only when the cursor slowed. The fixes: memoised candle and trail layers with primitive props (React no longer even compares their children), `pointer-events: none` on them with the hovered index computed arithmetically (no hit-testing of up to ~15,000 nodes), `requestAnimationFrame` coalescing of pointer events, and `useMemo` for min/max, the close path and the volume maximum. A stable `EMPTY_PREDICTION` array avoids passing a new empty array on every render of the timeframes that have no forecast.

### Ticker loop length measured, not guessed

The tape used a fixed 90 s cycle, which left a gap at the end on wide screens. It now measures the width of one item set and repeats it enough times to cover the mask, then derives the duration from a constant speed (20 px/s). The spacing is the item's own padding, not a flex gap, because a gap makes the shift period differ from the content period by half a gap, which shows as a jump at the seam.

### Tab in the query string

The active tab is `?tab=perf`, not `/perf`. The path always stays `/`, so reloading works whether or not the server has a single-page-app fallback for unknown paths.

### The future zone always reserves 12 slots

The x axis keeps room for 12 forecast steps even with the overlay hidden. Toggling `PRED` therefore does not rescale the chart.

## Not done

- **Code splitting.** The 700 kB bundle triggers Vite's warning and nothing is split. No reason is recorded in the code; it is listed as an open option.
- **A mock mode.** The prototype's generators are still in `data.jsx`, but the app is wired to the real API only. A local mock server is the missing piece for a self-contained demo.
- **Tests.** None exist; the interface is verified manually against the backend.
