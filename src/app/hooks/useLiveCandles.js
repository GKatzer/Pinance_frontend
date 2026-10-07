// hooks/useLiveCandles.js
//
// Реальные данные с бэка. Полностью заменяет genCandles() в LivePrediction.
//
// Таймфреймы:
//   1D  → 5m  свечи →  288 точек → БД (live, обновляется через SSE)
//   1W  → 15m свечи →  672 точек → Binance REST (кэш 5 мин)
//   1M  → 1h  свечи →  720 точек → Binance REST (кэш 10 мин)
//   1Y  → 1d  свечи →  365 точек → Binance REST (кэш 1 час)
//   ALL → 1d  свечи → ~1500 точек → Binance REST (кэш 1 час)
//
// SSE работает только для 1D — обновляет последнюю свечу каждую секунду.
// Для остальных таймфреймов данные статичны (рефреш по смене таймфрейма).

import { useState, useEffect, useRef, useCallback } from "react";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

// Сколько свечей держим в буфере для 1D (= количество 5m свечей за сутки)
const MAX_CANDLES_1D = 288;

const TIMEFRAMES = ["1D", "1W", "1M", "1Y", "ALL"];

// Сколько точек трейла предиктов держим в памяти (только для живого 1D-потока,
// см. upsertPredPoint — REST-подгрузка ниже сама по себе уже ограничена своим hours)
const MAX_PRED_HISTORY = MAX_CANDLES_1D;

// Prediction Log: не по одной записи на свечу — actualizer публикует все 12
// горизонтов на каждую дозревшую свечу (не фильтрует, в отличие от
// pred_history). 240 = 12 × 20 свечей — держим тот же лимит, что и бэкенд
// (app.ingest.actualizer.RESULTS_RECENT_MAXLEN, LTRIM/LRANGE на Redis-листе);
// меньшее число здесь молча резало бы историю раньше, чем реально прислал бэк.
const MAX_RESULTS_LOG = 240;

// pred_history доступен там, где горизонт кратно ложится на границы свечи:
// 1D — horizon=1 (5м) на 5м свечах; 1W — horizon=3 (15м) на 15м свечах, а
// hours=168 — ровно 7×24, весь видимый диапазон 1W. На 1M/1Y/ALL горизонт
// модели (5-минутный) не совпадает с границами свечей (1ч/1д) — там показывать
// нечего без доработки бэка.
const PRED_HISTORY_PARAMS = {
  "1D": { horizon: 1, hours: 24 },
  "1W": { horizon: 3, hours: 168 },
};

// Длина 1D-свечи — используется, чтобы посчитать target_ts горизонта=1
// от последней известной свечи (см. pendingRef в openSSE).
const FIVE_MIN_MS = 5 * 60 * 1000;

// SSE watchdog — см. lastActivityRef/openSSE. Бэк шлёт ping каждые 15с
// (app/api/stream.py::_PUBSUB_TIMEOUT), 45с — 3x запас на джиттер/пропуск.
const WATCHDOG_TIMEOUT = 45000;
const WATCHDOG_CHECK_INTERVAL = 10000;

// Без таймаута fetch ждёт ответа сколько угодно — зависший запрос (бэк
// перезапускается за прокси, соединение принято, ответа нет) держал бы слот
// в лимите браузера на одновременные соединения per-origin, блокируя и SSE,
// и остальные REST-запросы до ручной перезагрузки страницы.
const FETCH_TIMEOUT_MS = 15000;

// epoch ms из числа (сек или мс) либо ISO-строки без указания зоны (считаем её UTC)
function toMs(ts) {
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  const s = /[zZ]|[+-]\d{2}:\d{2}$/.test(ts) ? ts : ts + "Z";
  return new Date(s).getTime();
}

// Апсерт точки трейла по ts (используется и SSE "result", и клиентским
// расчётом hit/miss в "tick" — см. openSSE).
function upsertPredPoint(predHistory, point) {
  const idx = predHistory.findIndex((p) => p.ts === point.ts);
  let next = idx >= 0
    ? predHistory.map((p, i) => (i === idx ? point : p))
    : [...predHistory, point].sort((a, b) => a.ts - b.ts);
  if (next.length > MAX_PRED_HISTORY) next = next.slice(-MAX_PRED_HISTORY);
  return next;
}

const INITIAL_STATE = {
  candles:     [],
  lastCandle:  null,
  prediction:  null,
  predHistory: [],
  results:     [],
  connected:   false,   // true только для 1D пока SSE активен
  loading:     true,
  error:       null,
  timeframe:   "1D",
};

export function useLiveCandles(pairId, timeframe = "1D") {
  const [state, setState] = useState(INITIAL_STATE);

  const esRef      = useRef(null);
  const bufferRef  = useRef([]);
  const pollRef    = useRef(null);
  const watchdogRef = useRef(null);
  // Бэк шлёт "ping" каждые 15с как keepalive именно на случай тишины (см.
  // app/api/stream.py::_PUBSUB_TIMEOUT) — если от источника (любое событие,
  // включая ping) не было вестей дольше этого, соединение фактически мертво,
  // даже если браузер ни разу не вызвал onerror (например, Caddy держит
  // сокет открытым, пока бэк перезапускается — тогда ни нативный, ни
  // самодельный реконнект по onerror ничего не заметят, и график/Pred Log/
  // Model Quality молча перестают обновляться до ручной перезагрузки
  // страницы). lastActivityRef обновляется на каждое событие (включая ping,
  // который раньше просто игнорировался), watchdog ниже сверяет раз в 10с.
  const lastActivityRef = useRef(Date.now());
  // horizon=1 прогнозы, ещё не подтверждённые бэком (см. openSSE): ts закрытия
  // целевой свечи → { predicted, anchorClose }. Бэк пока не всегда шлёт SSE
  // "result" (и не персистит старые предикты), поэтому resolve считаем сами
  // в момент, когда целевая свеча реально закрывается.
  const pendingRef = useRef(new Map());

  const enc = (s) => encodeURIComponent(s);

  // ── Normalize candle ───────────────────────────────────────────────────────

  function norm(raw) {
    return {
      ts:     raw.ts,
      open:   parseFloat(raw.open),
      high:   parseFloat(raw.high),
      low:    parseFloat(raw.low),
      close:  parseFloat(raw.close),
      volume: parseFloat(raw.volume),
      closed: raw.closed ?? true,
    };
  }

  // ── Buffer update (только для 1D live-тиков) ──────────────────────────────

  function pushTick(candle) {
    const buf = bufferRef.current;
    let closedCandle = null;
    if (buf.length && buf[buf.length - 1].ts === candle.ts) {
      buf[buf.length - 1] = candle;   // intra-minute update
    } else {
      // Свеча в буфере сменилась → предыдущая только что закрылась окончательно
      // (полагаться на candle.closed нельзя — бэк не всегда его присылает).
      if (buf.length) closedCandle = buf[buf.length - 1];
      buf.push(candle);
      if (buf.length > MAX_CANDLES_1D) buf.shift();
    }
    return { candles: [...buf], closedCandle };
  }

  // ── SSE (только для 1D) ────────────────────────────────────────────────────

  const closeSSE = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (watchdogRef.current) {
      clearInterval(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // Клиентский resolve (см. "prediction"/"tick" ниже) — не единственный источник
  // истины: бэк персистит результаты со своей задержкой, и это единственный
  // способ узнать hit/miss, если клиентская оценка почему-то не сработала.
  // Периодически подтягиваем pred_history заново — так новые свечи получают
  // pred-инфо без перезагрузки страницы, как только бэк её посчитает.
  const pollPredHistory = useCallback(async (symbol) => {
    try {
      const r = await fetch(`${API_BASE}/candles/${enc(symbol)}/pred_history?horizon=1&hours=24`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) return;
      const data = await r.json();
      const history = data.history ?? [];
      if (!history.length) return;
      setState(prev => {
        let predHistory = prev.predHistory;
        for (const p of history) {
          predHistory = upsertPredPoint(predHistory, {
            ts: toMs(p.ts), predicted: p.predicted, hit: p.hit,
            q10: p.q10 ?? null, q90: p.q90 ?? null,
          });
        }
        return { ...prev, predHistory };
      });
    } catch {}
  }, []);

  // Подхватить Prediction Log заново — и при (пере)подключении SSE (onopen), и
  // периодически по таймеру вместе с pollPredHistory (см. pollRef ниже). Один
  // onopen не чинит кейс, когда соединение НЕ рвётся и НЕ молчит (ping и tick
  // продолжают идти, watchdog никогда не сработает, onopen никогда не
  // перевызовется), но конкретно actualizer на бэке перестал публиковать
  // "result" — с фронта такое неотличимо от "просто пока нет новых результатов",
  // поэтому period-poll обязателен как отдельный, не завязанный на реконнект,
  // источник истины — ровно так же, как уже сделано для pred_history.
  const refreshResults = useCallback(async (symbol) => {
    try {
      const r = await fetch(`${API_BASE}/snapshot/${enc(symbol)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) return;
      const data = await r.json();
      setState(prev => ({ ...prev, results: data.recent_results ?? prev.results }));
    } catch {}
  }, []);

  const openSSE = useCallback((symbol) => {
    closeSSE();
    const es = new EventSource(`${API_BASE}/stream/${enc(symbol)}`);
    esRef.current = es;
    lastActivityRef.current = Date.now();
    pollRef.current = setInterval(() => {
      pollPredHistory(symbol);
      refreshResults(symbol);
    }, 30000);
    // Watchdog — не полагается на onerror вообще, только на факт "давно
    // ничего не приходило" (а должно приходить минимум раз в 15с — ping,
    // см. lastActivityRef выше). Форсирует полный reconnect тем же
    // openSSE — та же цепочка, что и обычное переподключение при смене пары.
    watchdogRef.current = setInterval(() => {
      if (Date.now() - lastActivityRef.current > WATCHDOG_TIMEOUT) {
        openSSE(symbol);
      }
    }, WATCHDOG_CHECK_INTERVAL);

    es.addEventListener("tick", (e) => {
      lastActivityRef.current = Date.now();
      const candle = norm(JSON.parse(e.data));
      const { candles, closedCandle } = pushTick(candle);

      setState(prev => {
        let predHistory = prev.predHistory;

        // Свеча, на которую был отложенный прогноз, только что закрылась —
        // считаем hit/miss сами, не дожидаясь SSE "result" от бэка.
        if (closedCandle && pendingRef.current.has(closedCandle.ts)) {
          const pf = pendingRef.current.get(closedCandle.ts);
          pendingRef.current.delete(closedCandle.ts);
          const hit = (pf.predicted >= pf.anchorClose) === (closedCandle.close >= pf.anchorClose);
          predHistory = upsertPredPoint(predHistory, {
            ts: closedCandle.ts, predicted: pf.predicted, hit,
            q10: pf.q10 ?? null, q90: pf.q90 ?? null,
          });
        }

        return { ...prev, candles, lastCandle: candle, predHistory, loading: false };
      });
    });

    es.addEventListener("prediction", (e) => {
      lastActivityRef.current = Date.now();
      const pred = JSON.parse(e.data);

      // Запоминаем ВСЕ горизонты снапшота как "ожидающие" (не только horizon=1) —
      // resolve произойдёт в "tick", когда свеча с этим target_ts реально закроется.
      // Так каждая будущая свеча получает до 12 независимых попыток быть пойманной
      // (от 12 разных снапшотов, сделанных в разные моменты) — если один конкретный
      // snapshot потеряется/придёт неполным, соседний горизонт всё равно её поймает.
      const anchor = bufferRef.current[bufferRef.current.length - 1];
      if (anchor && pred?.predictions?.length) {
        const anchorClose = pred.close ?? anchor.close;
        for (const p of pred.predictions) {
          const targetTs = anchor.ts + p.horizon * FIVE_MIN_MS;
          const existing = pendingRef.current.get(targetTs);
          // Предпочитаем более свежий (меньший) горизонт — он точнее отражает "прогноз за 5 минут".
          if (!existing || p.horizon <= existing.horizon) {
            pendingRef.current.set(targetTs, {
              predicted: p.price_pred, anchorClose, horizon: p.horizon,
              q10: p.price_q10 ?? null, q90: p.price_q90 ?? null,
            });
          }
        }

        // Подчищаем протухшие записи (пропущенный тик и т.п.), чтобы Map не рос вечно
        for (const [ts] of pendingRef.current) {
          if (ts < anchor.ts - 15 * FIVE_MIN_MS) pendingRef.current.delete(ts);
        }
      }

      setState(prev => ({ ...prev, prediction: pred }));
    });

    es.addEventListener("ping", () => { lastActivityRef.current = Date.now(); });
    es.addEventListener("result", (e) => {
      lastActivityRef.current = Date.now();
      try {
        const result = JSON.parse(e.data);
        setState(prev => {
          const results = [result, ...prev.results].slice(0, MAX_RESULTS_LOG);

          // Трейл на графике сейчас скоуплен на horizon=1 (как и pred_history REST) —
          // остальные горизонты остаются только в ленте результатов ниже.
          let predHistory = prev.predHistory;
          if ((result.horizon ?? 1) === 1) {
            const ts = toMs(result.target_ts ?? result.ts);
            predHistory = upsertPredPoint(predHistory, {
              ts, predicted: result.price_pred, hit: result.hit,
              q10: result.price_q10 ?? null, q90: result.price_q90 ?? null,
            });
            // Авторитетный результат бэка перекрывает клиентскую оценку — ждать больше нечего.
            pendingRef.current.delete(ts);
          }

          return { ...prev, results, predHistory };
        });
      } catch {}
    });

    es.onopen  = () => { lastActivityRef.current = Date.now(); setState(prev => ({ ...prev, connected: true,  error: null })); refreshResults(symbol); };
    es.onerror = () => setState(prev => ({ ...prev, connected: false }));
  }, [closeSSE, pollPredHistory, refreshResults]);

  // ── REST load (все таймфреймы) ─────────────────────────────────────────────

  const loadCandles = useCallback(async (symbol, tf) => {
    setState(prev => ({ ...prev, loading: true, error: null }));

    try {
      // История свечей + snapshot (live-прогноз, только 1D) + pred_history
      // (трейл прошлых прогнозов, где есть — см. PRED_HISTORY_PARAMS) параллельно.
      // Именованные промисы вместо позиционных индексов — иначе при разных
      // таймфреймах responses[1]/[2] означали бы то snapshot, то pred_history.
      const phParams = PRED_HISTORY_PARAMS[tf];
      const candlesReq     = fetch(`${API_BASE}/candles/${enc(symbol)}?timeframe=${tf}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const snapshotReq    = tf === "1D" ? fetch(`${API_BASE}/snapshot/${enc(symbol)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }) : null;
      const predHistoryReq = phParams
        ? fetch(`${API_BASE}/candles/${enc(symbol)}/pred_history?horizon=${phParams.horizon}&hours=${phParams.hours}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        : null;
      // Текущая формирующаяся свеча не попадает в /candles (REST отдаёт только
      // закрытые — см. binance_ws.py, _save_candle только на closed) — без
      // неё первый рендер 1D на 1-2с "младше" того, что тут же пришлёт SSE
      // тиком, и буфер видимо дёргается на одну свечу вперёд, хотя эта свеча
      // не новая, просто REST её не отдаёт. Подмешиваем её сюда же, до
      // первого рендера. Best-effort (.catch(()=>null)) — 404 (ещё нет тика
      // вообще) не должен ронять всю загрузку.
      const latestReq = tf === "1D" ? fetch(`${API_BASE}/candles/${enc(symbol)}/latest`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null) : null;

      const [candlesRes, snapshotRes, predHistoryRes, latestRes] = await Promise.all([candlesReq, snapshotReq, predHistoryReq, latestReq]);
      for (const r of [candlesRes, snapshotRes, predHistoryRes]) {
        if (r && !r.ok) throw new Error(`HTTP ${r.status} ${r.url}`);
      }

      const histData = await candlesRes.json();
      const candles  = (histData.candles ?? []).map(norm);

      if (latestRes && latestRes.ok) {
        try {
          const latest = norm(await latestRes.json());
          const last = candles[candles.length - 1];
          if (!last || latest.ts > last.ts) candles.push(latest);
        } catch {}
      }

      let prediction  = null;
      let results     = [];
      let predHistory = [];
      if (snapshotRes) {
        const snapData = await snapshotRes.json();
        prediction = snapData.prediction      ?? null;
        results    = snapData.recent_results  ?? [];
      }
      if (predHistoryRes) {
        const phData = await predHistoryRes.json();
        // Держим {ts, predicted, hit, q10, q90} как есть — сопоставление ts →
        // индекс свечи пересчитывается в PriceChart на каждый рендер, т.к.
        // индексы съезжают при сдвиге буфера (см. pushTick). Не режем по
        // MAX_PRED_HISTORY — тут это REST-снимок, уже ограниченный своим
        // hours, а не растущий live-трейл. q10/q90 отсутствуют (undefined)
        // на строках до промоушена квантильной корзины — PriceChart это
        // фоллбэчит на null сам.
        predHistory = phData.history ?? [];
      }

      // Для 1D — наполняем мутабельный буфер (SSE будет его дополнять)
      if (tf === "1D") {
        bufferRef.current = [...candles];
      }

      const lastCandle = candles[candles.length - 1] ?? null;

      setState(prev => ({
        ...prev,
        candles,
        lastCandle,
        prediction,
        predHistory,
        results,
        timeframe: tf,
        loading:   false,
        error:     null,
      }));
    } catch (err) {
      console.warn("[useLiveCandles] load failed:", err.message);
      setState(prev => ({
        ...prev,
        loading:   false,
        timeframe: tf,
        error:     err.message,
      }));
    }
  }, []);

  // ── Effect: реакция на смену пары или таймфрейма ──────────────────────────

  useEffect(() => {
    bufferRef.current = [];
    pendingRef.current = new Map();
    setState(INITIAL_STATE);

    // Загружаем свечи через REST
    loadCandles(pairId, timeframe);

    // SSE только для 1D (остальные таймфреймы не нуждаются в live-обновлении)
    if (timeframe === "1D") {
      openSSE(pairId);
    } else {
      closeSSE();
      setState(prev => ({ ...prev, connected: false }));
    }

    return closeSSE;
  }, [pairId, timeframe]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}

// Экспортируем список таймфреймов для кнопок в UI
export { TIMEFRAMES };