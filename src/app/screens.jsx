// Screen components

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import {
  fmt,
  parseModelVersion,
} from "./data";
import {
  PriceChart, useIsMobile,
} from "./charts";
import { TrendChart, ErrorHistogramChart, PredictionScatterChart, CoverageTrendChart, CoverageBarChart, CoverageByWindowChart, BandScatterChart } from "./perf-charts";
import { useLiveCandles } from "./hooks/useLiveCandles";
import {
  useMetricsSummary, useMetricsHistory, useMetricsErrors, useMetricsScatter,
  useMetricsCoverage, useMetricsCoverageHistory, useMetricsWidthHistogram,
  useMetricsRetrainTimeline, useMetricsLatency, useMetricsDrift,
} from "./hooks/useMetrics";

// Стабильная ссылка на уровне модуля — `predData ?? []` создавал бы новый
// пустой массив на КАЖДЫЙ рендер, когда predData === null (а для 1W/1Y/ALL/1M
// он равен null всегда — /snapshot фетчится только для tf==="1D", см.
// useLiveCandles.js). PriceChart получал новый проп prediction на каждый
// кадр, и любой useMemo внутри, зависящий от него, не мог сработать ни разу
// именно на этих таймфреймах.
const EMPTY_PREDICTION = [];

export function MetricPill({ label, value, sub, glyph, accent, badge, className }) {
  return (
    <div className={"metric" + (className ? " " + className : "")}>
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ color: accent || "var(--text)" }}>{value}</div>
      {sub && <div className="metric-sub">{sub}</div>}
      {badge && <div style={{marginTop: 6}}>{badge}</div>}
      {glyph && <div className="metric-glyph">{glyph}</div>}
    </div>
  );
}

const TF_INTERVAL = { "1D": "5m", "1W": "15m", "1M": "1h", "1Y": "1d", "ALL": "1d" };
const TIMEFRAMES  = ["1D", "1W", "1M", "1Y", "ALL"];
const TF_LABEL    = { "1D": "24H", "1W": "1W",  "1M": "1M", "1Y": "1Y", "ALL": "ALL" };
// Таймфреймы, где horizon модели (5м) кратно ложится на границы свечи —
// только там есть трейл прошлых предиктов (см. PRED_HISTORY_PARAMS в useLiveCandles.js)
const PRED_HISTORY_TIMEFRAMES = ["1D", "1W"];

// HIT RATE-плашка: окно из /metrics/{symbol}/summary, растущее вместе с
// глубиной вкладки — таб называется "24H", значит и окно должно быть 24h,
// а не 1h (это была реальная нестыковка по длительности, не только по
// названию). Горизонт модели (5-60 мин) от вкладки не зависит — зависит
// только то, за какой период усредняем точность. 1Y и ALL дают один и тот
// же результат не по ошибке — у predictions retention 90 дней.
// Подпись рядом с HIT RATE берём из TF_LABEL — того же источника, что и
// названия самих вкладок, чтобы не завести отдельный список, который может
// разъехаться с реальными подписями кнопок.
const HIT_RATE_WINDOW_BY_TIMEFRAME = { "1D": "24h", "1W": "7d", "1M": "30d", "1Y": "all", "ALL": "all" };

// Модель отдаёт ровно 12 горизонтов на снапшот (см. predictions[].horizon) —
// используется и тут (фильтр в Prediction Log), и в PriceChart для будущей зоны.
const LOG_HORIZONS = Array.from({ length: 12 }, (_, i) => i + 1);

const OHLCV_PARAMS = [
  { key: "O", color: "#A0A8B4", bg: "rgba(160,168,180,0.08)", fmtVal: (c) => "$" + fmt(c.open,   0) },
  { key: "H", color: "var(--green)", bg: "rgba(31,203,126,0.08)",  fmtVal: (c) => "$" + fmt(c.high,   0) },
  { key: "L", color: "#FF5252", bg: "rgba(255,82,82,0.08)",   fmtVal: (c) => "$" + fmt(c.low,    0) },
  { key: "V", color: "#4D7CFF", bg: "rgba(77,124,255,0.08)",  fmtVal: (c) => c.volume.toFixed(3) },
];

// Нормализует result-событие с бэка (actualizer, по одной строке на горизонт)
// в единый формат для лога предсказаний.
function normalizeResult(r) {
  const ts  = r.target_ts ?? r.ts ?? r.close_ts;
  const t   = r.t ?? (ts ? new Date(typeof ts === "number" ? (ts > 1e12 ? ts : ts * 1000) : ts).toISOString().slice(11, 19) : "--:--");
  const from  = r.from  ?? r.price_pred   ?? r.predicted_close ?? 0;
  const to    = r.to    ?? r.actual_price ?? r.actual_close    ?? 0;
  const hit   = r.hit   ?? false;
  const delta = r.delta ?? (from - to);
  const horizon = r.horizon ?? null;
  // q10/q90 — nullable: строки до промоушена квантильной корзины их не несут.
  const q10 = r.q10 ?? r.price_q10 ?? null;
  const q90 = r.q90 ?? r.price_q90 ?? null;
  const inBand = (q10 != null && q90 != null) ? (to >= q10 && to <= q90) : null;
  return { t, from, to, hit, delta, horizon, q10, q90, inBand };
}

// =========== LIVE PREDICTION ===========
export function LivePrediction({ pair, tweaks }) {
  const isMobile = useIsMobile();
  const [timeframe, setTimeframe] = useState("1D");

  const { candles, prediction, predHistory, connected, loading, error, results } =
    useLiveCandles(pair.id, timeframe);

  const lastClose = candles[candles.length - 1]?.close ?? 0;

  // Бэкенд отдаёт 12 точечных прогнозов + 10%/90% квантили (с 2026-08-02,
  // VDS2). lo/hi = price_q10/price_q90 — реальный доверительный коридор,
  // не заглушка. Фоллбэк на price_pred — на случай кэша из переходного
  // периода (Redis TTL 10 мин), где квантилей ещё нет.
  // useMemo — иначе новый массив на КАЖДЫЙ рендер LivePrediction, и PriceChart
  // получал бы новый проп prediction, даже когда сам live-прогноз не менялся,
  // не давая ничему, что от него зависит (minP/maxP и т.д.), мемоизироваться.
  // Стабильная ссылка, пока prediction/lastClose реально те же.
  const predData = useMemo(() => (
    prediction?.predictions?.length ? (() => {
      const start = prediction.close ?? lastClose;
      const points = prediction.predictions.map((p) => ({
        i: p.horizon,
        mid: p.price_pred,
        lo: p.price_q10 ?? p.price_pred,
        hi: p.price_q90 ?? p.price_pred,
      }));
      return [{ i: 0, mid: start, lo: start, hi: start }, ...points];
    })() : null
  ), [prediction, lastClose]);

  const predEnd    = predData ? predData[predData.length - 1].mid : lastClose;
  const predDelta  = predEnd - lastClose;
  const predDir    = predDelta >= 0 ? "BULLISH" : "BEARISH";
  // Прогноз грузится только для 24H — на остальных таймфреймах показывать нечего.
  const hasPred    = predData !== null;

  const [showActual,      setShowActual]      = useState(true);
  const [showPredHistory, setShowPredHistory] = useState(true);
  const [showCI,          setShowCI]          = useState(true);
  const [showPredInfo,    setShowPredInfo]    = useState(true);
  const [shownParams,     setShownParams]     = useState(["H", "L", "V"]);

  // ── Refs для кнопок панели ──────────────────────────────────────────────────
  const chartPanelRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Мобилка: настройки графика (ACT/PRED, OHLCV, ◷/⌂/⤢) прячутся под шестерёнку,
  // видны только таймфреймы + сама кнопка — иначе controls не помещаются в ширину.
  const [showChartMenu, setShowChartMenu] = useState(false);
  const chartMenuRef = useRef(null);
  useEffect(() => {
    if (!showChartMenu) return;
    const onDoc = (e) => { if (chartMenuRef.current && !chartMenuRef.current.contains(e.target)) setShowChartMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showChartMenu]);

  // ── Prediction Log: фильтр по горизонту + сортировка по клику на заголовок ──
  const [logHorizons, setLogHorizons] = useState(() => new Set(LOG_HORIZONS));
  const [showLogHorizonMenu, setShowLogHorizonMenu] = useState(false);
  const logHorizonMenuRef = useRef(null);
  useEffect(() => {
    if (!showLogHorizonMenu) return;
    const onDoc = (e) => { if (logHorizonMenuRef.current && !logHorizonMenuRef.current.contains(e.target)) setShowLogHorizonMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showLogHorizonMenu]);
  const toggleLogHorizon = (h) => setLogHorizons(prev => {
    const next = new Set(prev);
    next.has(h) ? next.delete(h) : next.add(h);
    return next;
  });

  const [logSort, setLogSort] = useState({ col: null, dir: "asc" });
  const handleLogSort = (col) => setLogSort(prev =>
    prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "asc" }
  );

  // Строки без horizon (старый формат результата) никогда не режутся фильтром —
  // так добавление фильтра не прячет то, что уже было видно раньше.
  const logRows = useMemo(() => {
    let rows = results.map(normalizeResult).filter(r => r.horizon == null || logHorizons.has(r.horizon));
    if (logSort.col) {
      const { col, dir } = logSort;
      rows = [...rows].sort((a, b) => {
        const av = a[col], bv = b[col];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return dir === "asc" ? cmp : -cmp;
      });
    }
    return rows;
  }, [results, logHorizons, logSort]);

  // ◷ Часики — сброс к live (1D + текущий момент)
  const handleGoLive = useCallback(() => {
    setTimeframe("1D");
  }, []);

  // ⌂ Домик — сброс всех настроек графика к дефолту
  const handleReset = useCallback(() => {
    setTimeframe("1D");
    setShowActual(true);
    setShowPredHistory(true);
    setShowCI(true);
    setShowPredInfo(true);
    setShownParams(["H", "L", "V"]);
  }, []);

  // ⤢ Fullscreen — разворачиваем панель с графиком
  const handleFullscreen = useCallback(() => {
    const el = chartPanelRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }, []);

  // Следим за выходом из fullscreen (кнопка Esc)
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // Rolling accuracy/MAE/RMSE с бэка (/metrics/{symbol}/summary) — единый
  // источник и для HIT RATE, и для MODEL QUALITY ниже, вместо клиентского
  // подсчёта по обрезанному буферу results.
  const { summary } = useMetricsSummary(pair.id);
  const win1h  = summary?.windows?.["1h"];
  const win24h = summary?.windows?.["24h"];
  const win7d  = summary?.windows?.["7d"];

  // HIT RATE — окно зависит от активной вкладки таймфрейма: горизонт модели
  // (5-60 мин) от вкладки не меняется, но глубина, за которую усредняем
  // точность, логично растёт вместе с ней. 1Y и ALL совпадают не случайно —
  // у predictions retention 90 дней, дальше "all" физически то же самое.
  const winHitRate = summary?.windows?.[HIT_RATE_WINDOW_BY_TIMEFRAME[timeframe] ?? "1h"];

  const sessionOpen   = candles[0]?.open ?? lastClose;
  const sessionChange = lastClose - sessionOpen;
  const sessionPct    = sessionOpen ? (sessionChange / sessionOpen * 100) : 0;

  // Статус источника данных
  const dataStatus = loading
    ? <span style={{color:"var(--text-3)"}}>LOADING…</span>
    : timeframe === "1D" && connected
      ? <span style={{color:"var(--green)"}}>● LIVE</span>
      : timeframe === "1D"
        ? <span style={{color:"var(--amber)"}}>◌ RECONNECTING</span>
        : <span style={{color:"var(--text-2)"}}>REST · {timeframe}</span>;

  // Переиспользуются и в десктопной шапке панели, и внутри мобильного меню настроек (⚙)
  // ACT/PRED — управляют только видимостью на графике (весь связанный визуал:
  // у ACT — тело/заливка реальных свечей, у PRED — трейл-точки, будущая линия
  // И band целиком), тултип не трогают вообще — ровно как ACT сейчас не трогает
  // OHLCV-строки. CI/P ниже — обратная пара: тултип-only, графика не касаются.
  const actPredButtons = (
    <>
      <button
        className={"icon-btn chip-btn " + (showActual ? "active" : "")}
        style={showActual ? {borderColor:"var(--green)", color:"var(--green)", background:"rgba(31,203,126,0.1)"} : {}}
        onClick={() => setShowActual(v => !v)}
      >ACT</button>
      <button
        className={"icon-btn chip-btn " + (showPredHistory ? "active" : "")}
        style={showPredHistory ? {borderColor:"var(--accent)", color:"var(--accent)", background:"rgba(77,124,255,0.1)"} : {}}
        onClick={() => setShowPredHistory(v => !v)}
      >PRED</button>
    </>
  );

  const ohlcvButtons = (
    <>
      {OHLCV_PARAMS.map(({ key, color, bg }) => {
        const on = shownParams.includes(key);
        return (
          <button
            key={key}
            className="icon-btn"
            style={{
              width: "auto", padding: "0 9px", fontSize: 11,
              transition: "border-color 0.15s, color 0.15s, background 0.15s",
              ...(on ? { borderColor: color, color, background: bg } : {}),
            }}
            onClick={() => setShownParams(p =>
              p.includes(key) ? p.filter(k => k !== key) : [...p, key]
            )}
          >
            {key}
          </button>
        );
      })}
    </>
  );

  // CI/P — тултип-only, тот же принцип, что у O/H/L/V: не трогают график
  // (band/трейл/будущая линия рисуются, пока их не спрятал ACT/PRED), только
  // добавляют/убирают свои строки в окне наведения. showPredHistory (PRED)
  // по-прежнему единолично решает, рисуется ли band/трейл/будущая линия на
  // самом графике — CI сюда не примешивается.
  const ciButton = (
    <button
      className={"icon-btn chip-btn " + (showCI ? "active" : "")}
      style={{
        width: "auto", padding: "0 9px", fontSize: 11,
        ...(showCI ? {borderColor:"rgba(77,124,255,1)", color:"rgba(77,124,255,1)", background:"rgba(77,124,255,0.1)"} : {}),
      }}
      onClick={() => setShowCI(v => !v)}
    >CI</button>
  );

  // P — предикт-инфа в тултипе (Price-строка у будущей точки, hit/miss у
  // прошлой) — отдельная state-переменная от PRED (showPredHistory), которая
  // как и раньше отвечает только за график.
  const pInfoButton = (
    <button
      className={"icon-btn chip-btn " + (showPredInfo ? "active" : "")}
      style={{
        width: "auto", padding: "0 9px", fontSize: 11,
        ...(showPredInfo ? {borderColor:"var(--accent)", color:"var(--accent)", background:"rgba(77,124,255,0.1)"} : {}),
      }}
      onClick={() => setShowPredInfo(v => !v)}
    >P</button>
  );

  // P и CI — одна группа (P слева от CI), обе тултип-only.
  const predToggleGroup = (
    <>
      {pInfoButton}
      {ciButton}
    </>
  );

  const panelActionButtons = (
    <>
      <button
        className={"icon-btn" + (timeframe === "1D" ? " active" : "")}
        title="Go live · reset to 1D"
        onClick={handleGoLive}
        style={timeframe === "1D" ? {borderColor:"var(--accent)", color:"var(--accent)"} : {}}
      >◷</button>
      <button
        className="icon-btn"
        title="Reset chart to defaults"
        onClick={handleReset}
      > <span className="home-icon" /> </button>
      <button
        className={"icon-btn" + (isFullscreen ? " active" : "")}
        title="Toggle fullscreen"
        onClick={handleFullscreen}
        style={isFullscreen ? {borderColor:"var(--accent)", color:"var(--accent)"} : {}}
      >⤢</button>
    </>
  );

  return (
    <>
      <style>{`
        .chart-panel:fullscreen,
        .chart-panel:-webkit-full-screen,
        .chart-panel:-moz-full-screen {
          background: var(--border-subtle) !important;
          display: flex;
          flex-direction: column;
        }
        .chart-panel:fullscreen::backdrop,
        .chart-panel:-webkit-full-screen::backdrop {
          background: var(--border-subtle);
        }
      `}</style>
      {/* Мобилка: Current Price остаётся компактной строкой над Event Tape —
          остальной снапшот переезжает в плашки в боковой вкладке под графиком. */}
      {isMobile && (
        <div className="mobile-price-row">
          <span className="mobile-price-value">${fmt(lastClose, 2)}</span>
          <span className={sessionChange >= 0 ? "pos" : "neg"}>
            {sessionChange >= 0 ? "+" : ""}{fmt(sessionPct, 2)}%
          </span>
        </div>
      )}

      <div className="live-grid">
        <div ref={chartPanelRef} className="panel chart-panel" style={isFullscreen ? {display:"flex", flexDirection:"column", height:"100vh", background:"var(--bg-base)", padding:0} : {}}>
          <div className="panel-head">
            <div className="chart-controls">
              {/* Таймфреймы — всегда видны */}
              <div style={{display:"flex", gap:4}}>
                {TIMEFRAMES.map(tf => (
                  <button
                    key={tf}
                    className={"icon-btn chip-btn " + (tf === timeframe ? "active" : "")}
                    style={tf === timeframe ? {borderColor:"var(--accent)", color:"var(--accent)", background:"var(--accent-dim)"} : {}}
                    onClick={() => setTimeframe(tf)}
                  >{TF_LABEL[tf] ?? tf}</button>
                ))}
              </div>

              {/* Layer toggles — на десктопе сразу видны, на мобилке спрятаны в меню настроек */}
              {!isMobile && (
                <div style={{display:"flex", gap:4, borderLeft:"1px solid var(--border-subtle)", paddingLeft:8}}>
                  {actPredButtons}
                </div>
              )}
            </div>

            {/* OHLCV чипы — на десктопе сразу видны, на мобилке спрятаны в меню настроек */}
            {!isMobile && (
              <div style={{display:"flex", gap:3, borderLeft:"1px solid var(--border-subtle)", paddingLeft:8}}>
                {ohlcvButtons}
              </div>
            )}

            {/* P + CI — отдельная группа справа от OHLCV, P слева от CI */}
            {!isMobile && (
              <div style={{display:"flex", gap:3, borderLeft:"1px solid var(--border-subtle)", paddingLeft:8}}>
                {predToggleGroup}
              </div>
            )}

            {isMobile ? (
              <div className="panel-actions" ref={chartMenuRef} style={{position:"relative"}}>
                <button
                  className={"icon-btn" + (showChartMenu ? " active" : "")}
                  title="Chart settings"
                  onClick={() => setShowChartMenu(v => !v)}
                  style={showChartMenu ? {borderColor:"var(--accent)", color:"var(--accent)"} : {}}
                >⚙</button>
                {showChartMenu && (
                  <div className="dropdown" style={{padding:10, display:"flex", flexDirection:"column", gap:10, minWidth:200}}>
                    <div style={{display:"flex", gap:4}}>{actPredButtons}</div>
                    <div style={{display:"flex", gap:3, flexWrap:"wrap"}}>{ohlcvButtons}</div>
                    <div style={{display:"flex", gap:3}}>{predToggleGroup}</div>
                    <div style={{display:"flex", gap:4, borderTop:"1px solid var(--border-subtle)", paddingTop:8}}>{panelActionButtons}</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="panel-actions">{panelActionButtons}</div>
            )}
          </div>

          {candles.length < 2 ? (
            <div style={{flex:"1 1 auto", minHeight:420, display:"flex", alignItems:"center", justifyContent:"center",
              color:"var(--text-3)", fontFamily:"var(--mono-d)", fontSize:12, letterSpacing:"0.1em"}}>
              {loading
                ? `LOADING ${timeframe} · ${TF_INTERVAL[timeframe]} CANDLES…`
                : error
                  ? `ERROR · ${error}`
                  : "NO DATA"}
            </div>
          ) : (
            <PriceChart
              candles={candles}
              prediction={predData ?? EMPTY_PREDICTION}
              predHistory={predHistory}
              showPrediction={tweaks.showPrediction && showPredHistory && timeframe === "1D" && predData !== null}
              showVolume={tweaks.showVolume}
              showActual={showActual}
              showPredHistory={showPredHistory && PRED_HISTORY_TIMEFRAMES.includes(timeframe)}
              showCI={showCI}
              showPredInfo={showPredInfo}
              interval={TF_INTERVAL[timeframe]}
              timeframe={timeframe}
              ohlcvParams={OHLCV_PARAMS}
              shownParams={shownParams}
              isFullscreen={isFullscreen}
            />
          )}
        </div>

        <div className="panel">
          {/* Снапшот (цена/прогноз/направление/уверенность/источник) — плашками,
              как карточки статистики у CoinMarketCap. На мобилке Current Price
              сюда не дублируем — он уже отдельной строкой над Event Tape. */}
          <div className="stat-tiles">
            {!isMobile && (
              <div className="stat-tile stat-tile-row">
                <div>
                  <div className="stat-tile-value" style={{fontWeight:700}}>${fmt(lastClose, 2)}</div>
                </div>
                <span className={sessionChange >= 0 ? "pos" : "neg"} style={{fontSize:10}}>
                  {sessionChange >= 0 ? "+" : ""}{fmt(sessionPct, 2)}%
                </span>
              </div>
            )}
            <div className="stat-tile-pair">
              <div className="stat-tile">
                <div className="stat-tile-label">PREDICTED</div>
                <div className="stat-tile-value" style={{color: !hasPred ? "var(--text-3)" : predDelta >= 0 ? "var(--accent)" : "var(--violet)"}}>
                  {hasPred ? `$${fmt(predEnd, 2)}` : "--"}
                </div>
                {hasPred && (
                  <div className={predDelta >= 0 ? "pos" : "neg"} style={{fontSize:10, marginTop:4}}>
                    {predDelta >= 0 ? "+" : ""}${fmt(predDelta, 2)}
                  </div>
                )}
              </div>
              <div className="stat-tile">
                <div className="stat-tile-label">DIRECTION</div>
                <div className="stat-tile-value" style={{color: !hasPred ? "var(--text-3)" : predDir === "BULLISH" ? "var(--accent)" : "var(--violet)"}}>
                  {hasPred ? `${predDir === "BULLISH" ? "▲" : "▼"} ${predDir}` : "--"}
                </div>
              </div>
            </div>
            <div className="stat-tile-pair">
              <div className="stat-tile">
                <div className="stat-tile-label">
                  HIT RATE
                  <span style={{color:"var(--text-3)", marginLeft:6}}>
                    · {TF_LABEL[timeframe] ?? timeframe}
                  </span>
                </div>
                <div className="stat-tile-value">
                  {winHitRate?.directional_accuracy != null
                    ? `${fmt(winHitRate.directional_accuracy, 1)}%`
                    : <span style={{color:"var(--text-3)"}}>--</span>}
                </div>
                <div className="bar" style={{marginTop:8}}>
                  <div className="bar-fill" style={{width: (winHitRate?.directional_accuracy ?? 0) + "%"}} />
                </div>
              </div>
              <div className="stat-tile">
                <div className="stat-tile-label">DATA SOURCE</div>
                <div className="stat-tile-value">{dataStatus}</div>
                <div className="stat-tile-sub" style={{color:"var(--text-3)"}}>
                  {candles.length > 0
                    ? ``
                    : "awaiting data…"}
                </div>
              </div>
            </div>
          </div>

          <div className="panel-head" style={{borderTop:"1px solid var(--border-subtle)"}}>
            <div className="panel-title"><b>MODEL QUALITY</b></div>
            <div className="panel-actions"><span className="badge muted">ROLLING</span></div>
          </div>
          <div className="side-block">
            <div style={{marginBottom:10, fontFamily:"var(--mono-d)", fontSize:10, letterSpacing:"0.12em", color:"var(--text-3)", textTransform:"uppercase"}}>Rolling Accuracy</div>
            {[
              { k: "1H",  w: win1h },
              { k: "24H", w: win24h },
              { k: "7D",  w: win7d },
            ].map(r => {
              const v = r.w?.directional_accuracy;
              const c = v == null ? "" : v >= 65 ? "green" : v >= 55 ? "" : "amber";
              return (
                <div key={r.k} className="roll-row">
                  <span className="lbl">{r.k}</span>
                  <span className="bar"><span className={"bar-fill " + c} style={{width:(v ?? 0)+"%"}} /></span>
                  <span className="val">{v != null ? `${fmt(v, 1)}%` : "--"}</span>
                </div>
              );
            })}
          </div>
          <div className="side-block">
            <div className="stat-row">
              <span className="k">Directional Acc.</span>
              <span>
                {win24h?.directional_accuracy != null ? `${fmt(win24h.directional_accuracy, 1)}%` : "--"}
                {win24h?.delta_accuracy != null && (
                  <span className={win24h.delta_accuracy >= 0 ? "pos" : "neg"} style={{fontSize:10, marginLeft:6}}>
                    {win24h.delta_accuracy >= 0 ? "+" : ""}{fmt(win24h.delta_accuracy, 1)}%
                  </span>
                )}
              </span>
            </div>
            <div className="stat-row"><span className="k">MAE</span><span>{win24h?.mae != null ? `$${fmt(win24h.mae, 2)}` : "--"}</span></div>
            <div className="stat-row"><span className="k">RMSE</span><span>{win24h?.rmse != null ? `$${fmt(win24h.rmse, 2)}` : "--"}</span></div>
            <div className="stat-row">
              <span className="k">Sharpe (sim)</span>
              {win24h?.sharpe != null ? (
                <span
                  className={win24h.sharpe >= 0 ? "pos" : "neg"}
                  title={`horizon=1 (5м) · sign(r_pred)×actual_r, annualized · N=${fmt(win24h.sharpe_n ?? 0, 0)}`}
                >
                  {fmt(win24h.sharpe, 2)}
                </span>
              ) : (
                <span style={{color:"var(--text-3)"}}>--</span>
              )}
            </div>
            <div className="stat-row"><span className="k">Brier</span><span style={{color:"var(--text-3)"}}>--</span></div>
          </div>
          <div className="panel-head" style={{borderTop:"1px solid var(--border-subtle)"}}>
            <div className="panel-title"><b>PREDICTION LOG</b></div>
            <div className="panel-actions">
              <span className="badge muted">{logRows.length === results.length ? results.length : `${logRows.length}/${results.length}`}</span>
            </div>
          </div>
          <div className="log">
            {/* .log-head живёт ВНУТРИ скролл-контейнера (sticky), а не рядом с ним —
                иначе это два независимых грида, и ширина .log под скроллбар (когда
                строк больше, чем влезает в max-height) отличается от ширины .log-head,
                которая скроллбар не режет — колонки REAL/PRED/DIFF съезжали
                относительно шапки ровно на ширину скроллбара. */}
            <div className="log-head">
              <span
                className={"log-col" + (logSort.col === "t" ? " active" : "")}
                onClick={() => handleLogSort("t")}
              >TIME{logSort.col === "t" && (logSort.dir === "asc" ? " ▲" : " ▼")}</span>

              <div className="log-col" ref={logHorizonMenuRef}>
                <span onClick={() => setShowLogHorizonMenu(v => !v)}>HRZN ▾</span>
                {showLogHorizonMenu && (
                  <div className="dropdown log-horizon-menu" onClick={e => e.stopPropagation()}>
                    <div className="log-horizon-quick-row">
                      <span className="log-horizon-quick" onClick={() => setLogHorizons(new Set(LOG_HORIZONS))}>All</span>
                      <span className="log-horizon-quick" onClick={() => setLogHorizons(new Set())}>None</span>
                    </div>
                    <div className="log-horizon-grid">
                      {LOG_HORIZONS.map(h => (
                        <label key={h} className="log-horizon-item">
                          <input type="checkbox" checked={logHorizons.has(h)} onChange={() => toggleLogHorizon(h)} />
                          H{h}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <span
                className={"log-col" + (logSort.col === "to" ? " active" : "")}
                onClick={() => handleLogSort("to")}
              >REAL{logSort.col === "to" && (logSort.dir === "asc" ? " ▲" : " ▼")}</span>

              <span className="log-col">PRED</span>

              <span
                className={"log-col right" + (logSort.col === "delta" ? " active" : "")}
                onClick={() => handleLogSort("delta")}
              >DIFF{logSort.col === "delta" && (logSort.dir === "asc" ? " ▲" : " ▼")}</span>
            </div>
            {results.length === 0
              ? <div className="log-empty">AWAITING RESULTS…</div>
              : logRows.length === 0
                ? <div className="log-empty">NO HORIZONS SELECTED</div>
                : logRows.map((p, i) => (
                    <div key={i} className="log-row">
                      <span className="t">{p.t.slice(0,5)}</span>
                      <span className="h">{p.horizon != null ? `H${p.horizon}` : "—"}</span>
                      <span className="real">{fmt(p.to, 0)}</span>
                      <span className="pred">
                        {fmt(p.from, 0)}
                        {p.inBand != null && (
                          <span
                            className={"log-band " + (p.inBand ? "in" : "out")}
                            title={`90% CI: $${fmt(p.q10, 0)} – $${fmt(p.q90, 0)}`}
                          >
                            {p.inBand ? "◆" : "◇"}
                          </span>
                        )}
                      </span>
                      <span className={"delta " + (p.hit ? "pos" : "neg")}>
                        {p.delta >= 0 ? "+" : ""}{fmt(p.delta, 0)}
                      </span>
                    </div>
                  ))
            }
          </div>
        </div>
      </div>
    </>
  );
}

// =========== MODEL PERFORMANCE ===========
// Заглушка на месте графика, пока запрос ещё в полёте или бэк вернул пусто.
function PerfCardEmpty({ children }) {
  return (
    <div style={{
      height:"100%", display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"var(--mono-d)", fontSize:11, letterSpacing:"0.08em",
      textTransform:"uppercase", color:"var(--text-3)",
    }}>
      {children}
    </div>
  );
}

export function ModelPerformance({ pair, prediction }) {
  const { summary } = useMetricsSummary(pair.id);
  const win1h  = summary?.windows?.["1h"];
  const win24h = summary?.windows?.["24h"];

  const { history: accHistory, loading: accLoading } = useMetricsHistory(pair.id, "accuracy", "24h", "1h");
  const { history: dirHistory, loading: dirLoading } = useMetricsHistory(pair.id, "accuracy", "7d", "1d");
  const { history: maeHistory, loading: maeLoading } = useMetricsHistory(pair.id, "mae", "24h", "1h");
  const { errors,  loading: errLoading } = useMetricsErrors(pair.id, "24h", 24);
  const { scatter, loading: scatLoading } = useMetricsScatter(pair.id, "24h", 200);
  const { coverage, loading: covLoading } = useMetricsCoverage(pair.id);
  const { coverageHistory, loading: covHistLoading } = useMetricsCoverageHistory(pair.id, "24h", "1h");
  const { widthHistogram, loading: widthLoading } = useMetricsWidthHistogram(pair.id, "24h", 24);

  // "Loading…" пока запрос ещё в полёте; если он завершился (успешно или с
  // ошибкой) и данных всё равно нет — значит эндпоинт недоступен, это другое
  // состояние и не должно вечно висеть как "Loading…".
  const emptyLabel = (loading) => loading ? "Loading…" : "No data";

  // Recharts сам масштабирует оси и строит тултип по реальным данным — не нужно
  // сжимать в голые числа (было нужно только для ручных SVG-компонентов).
  const accData = accHistory?.points?.length ? accHistory.points : null;
  const dirData = dirHistory?.points?.length ? dirHistory.points : null;
  const maeData = maeHistory?.points?.length ? maeHistory.points : null;
  const fmtTs = (ts) => new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

  // rangeLabel — реальный диапазон бина ($X to $Y) для тултипа, не индекс.
  const errData = errors?.counts?.length
    ? errors.counts.map((count, i) => ({
        i, count,
        rangeLabel: `${fmt(errors.bin_edges[i], 0)} to ${fmt(errors.bin_edges[i + 1], 0)}`,
      }))
    : null;
  const errN = errors?.counts?.reduce((a, b) => a + b, 0);

  const scatterPoints = scatter?.points?.length ? scatter.points : null;

  const cov24h = coverage?.windows?.["24h"];
  const coverageBins = cov24h?.q10_coverage != null && cov24h?.q90_coverage != null
    ? [
        { label: "q10", target: 0.10, observed: cov24h.q10_coverage },
        { label: "q90", target: 0.90, observed: cov24h.q90_coverage },
      ]
    : null;
  const coverageHistData = coverageHistory?.points?.length ? coverageHistory.points : null;
  const quantileModelVersion = prediction?.quantile_model_version ?? null;
  const perfModel = parseModelVersion(prediction?.model_version);

  // Ширина корзины по бакетам — то же самое avg_width, что уже едет в
  // /coverage_history для тултипа Coverage Over Time, просто вынесено в свой
  // тренд-график (сужается/расширяется корзина со временем).
  const widthTrendData = coverageHistory?.points?.length
    ? coverageHistory.points.filter(p => p.avg_width != null).map(p => ({ ts: p.ts, value: p.avg_width }))
    : null;

  // pinball_loss по бакетам — тоже уже едет в /coverage_history, тот же
  // источник, что и q10/q90-coverage и avg_width, просто отдельный график.
  const pinballHistData = coverageHistory?.points?.length
    ? coverageHistory.points.filter(p => p.pinball_loss != null).map(p => ({ ts: p.ts, value: p.pinball_loss }))
    : null;

  // Распределение ширины корзины — зеркало errData выше, только источник
  // /width_histogram вместо /errors.
  const widthDistData = widthHistogram?.counts?.length
    ? widthHistogram.counts.map((count, i) => ({
        i, count,
        rangeLabel: `$${fmt(widthHistogram.bin_edges[i], 0)} to $${fmt(widthHistogram.bin_edges[i + 1], 0)}`,
      }))
    : null;
  const widthDistN = widthHistogram?.counts?.reduce((a, b) => a + b, 0);

  // Coverage по всем окнам /coverage сразу (1h/24h/7d/30d/all) — та же
  // подборка окон, что и Rolling Accuracy на page1, просто для q10/q90.
  const covWindowData = ["1h", "24h", "7d", "30d", "all"].map((w) => {
    const d = coverage?.windows?.[w];
    return { w, q10_coverage: d?.q10_coverage ?? null, q90_coverage: d?.q90_coverage ?? null };
  });

  const fmtDelta = (d, suffix = "%") => d == null ? null : {
    text: `${d >= 0 ? "▲ +" : "▼ "}${fmt(Math.abs(d), 1)}${suffix}`,
    pos: d >= 0,
  };

  return (
    <>
      <div className="page-strip">
        <span className="crumb">PERFORMANCE</span>
        <span className="sep">/</span>
        <span style={{color:"var(--text)"}}>{pair.id}</span>
        <div className="meta">
          <span><span style={{color:"var(--text-3)"}}>WINDOW</span> <b>24H</b></span>
          <span><span style={{color:"var(--text-3)"}}>SAMPLES</span> <b>{win24h ? fmt(win24h.n, 0) : "--"}</b></span>
          <span><span style={{color:"var(--text-3)"}}>MODEL</span> <b>{perfModel?.date ? perfModel.date.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "--"}</b></span>
        </div>
      </div>
      <div className="perf-section" style={{marginTop:12}}>
        <span>POINTER MODEL</span>
        <span className="perf-section-sub">point price_pred · commit-версионируется независимо от квантильной корзины</span>
      </div>
      <div className="perf-grid">
        {[
          {
            title:"Accuracy · Rolling 1h",
            val: win1h?.directional_accuracy != null ? `${fmt(win1h.directional_accuracy, 1)}%` : null,
            valColor:"var(--color-cian)",
            delta: fmtDelta(win1h?.delta_accuracy),
            data: accData, loading: accLoading, color:"var(--color-cian)",
            valueFmt: (v) => `${fmt(v, 1)}%`,
          },
          {
            title:"MAE Over Time",
            val: win24h?.mae != null ? `$${fmt(win24h.mae, 2)}` : null,
            valColor:"var(--amber)",
            delta: null, // бэк пока не отдаёт delta для MAE (только delta_accuracy)
            data: maeData, loading: maeLoading, color:"var(--amber)",
            valueFmt: (v) => `$${fmt(v, 2)}`,
          },
          {
            title:"Directional Accuracy",
            val: win24h?.directional_accuracy != null ? `${fmt(win24h.directional_accuracy, 1)}%` : null,
            valColor:"var(--green)",
            delta: fmtDelta(win24h?.delta_accuracy),
            data: dirData, loading: dirLoading, color:"var(--green)",
            valueFmt: (v) => `${fmt(v, 1)}%`,
          },
        ].map(({title, val, valColor, delta, data, loading, color, valueFmt}) => (
          <div key={title} className="perf-card">
            <div className="perf-card-head">
              <div>
                <div className="perf-card-title">{title}</div>
                <div style={{fontFamily:"var(--mono-n)", fontSize:18, marginTop:4, color: val ? valColor : "var(--text-3)"}}>{val ?? "--"}</div>
              </div>
              {delta && <div className={`perf-card-val ${delta.pos ? "pos" : "neg"}`}>{delta.text}</div>}
            </div>
            <div className="perf-card-svg">
              {data
                ? <TrendChart data={data} color={color} valueFmt={valueFmt} tsFmt={fmtTs} />
                : <PerfCardEmpty>{emptyLabel(loading)}</PerfCardEmpty>}
            </div>
          </div>
        ))}
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Error Distribution</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                {errors ? `μ ${fmt(errors.mean_error, 1)} · σ ${fmt(errors.std_error, 1)}` : "--"}
              </div>
            </div>
            <div className="perf-card-val">{errN != null ? `N=${fmt(errN, 0)}` : "--"}</div>
          </div>
          <div className="perf-card-svg">
            {errData ? <ErrorHistogramChart data={errData} color="var(--violet)" /> : <PerfCardEmpty>{emptyLabel(errLoading)}</PerfCardEmpty>}
          </div>
        </div>
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Actual vs Predicted</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                {scatter?.r2 != null ? `R² = ${fmt(scatter.r2, 3)}` : "--"}
              </div>
            </div>
            <div className="perf-card-val">scatter · {scatter?.points?.length ?? "--"}</div>
          </div>
          <div className="perf-card-svg">
            {scatterPoints ? <PredictionScatterChart data={scatterPoints} color="var(--green)" /> : <PerfCardEmpty>{emptyLabel(scatLoading)}</PerfCardEmpty>}
          </div>
        </div>
      </div>

      <div className="perf-section">
        <span>QUANTILE MODELS</span>
        <span className="perf-section-sub">price_q10/price_q90 · promoutится отдельно от point-модели</span>
      </div>
      <div className="perf-grid">
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Quantile Coverage</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                target vs observed · 24h
                {quantileModelVersion && (
                  <span style={{color:"var(--text-3)", marginLeft:8}} title={quantileModelVersion}>· {quantileModelVersion}</span>
                )}
              </div>
            </div>
            <div className="perf-card-val">{cov24h?.n != null ? `N=${fmt(cov24h.n, 0)}` : "--"}</div>
          </div>
          <div className="perf-card-svg">
            {coverageBins ? <CoverageBarChart data={coverageBins} /> : <PerfCardEmpty>{emptyLabel(covLoading)}</PerfCardEmpty>}
          </div>
        </div>
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Coverage Over Time</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                <span style={{color:"var(--color-cian)"}}>q10</span> · <span style={{color:"var(--color-green)"}}>q90</span> · target 10%/90%
              </div>
            </div>
          </div>
          <div className="perf-card-svg">
            {coverageHistData
              ? <CoverageTrendChart data={coverageHistData} tsFmt={fmtTs} />
              : <PerfCardEmpty>{emptyLabel(covHistLoading)}</PerfCardEmpty>}
          </div>
        </div>
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Interval Width Over Time</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                q90 − q10 · сужается/расширяется
              </div>
            </div>
          </div>
          <div className="perf-card-svg">
            {widthTrendData && widthTrendData.length
              ? <TrendChart data={widthTrendData} color="var(--amber)" valueFmt={(v) => `$${fmt(v, 0)}`} tsFmt={fmtTs} />
              : <PerfCardEmpty>{emptyLabel(covHistLoading)}</PerfCardEmpty>}
          </div>
        </div>
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Coverage by Window</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                <span style={{color:"var(--color-cian)"}}>q10</span> · <span style={{color:"var(--color-green)"}}>q90</span> · target 10%/90%
              </div>
            </div>
          </div>
          <div className="perf-card-svg">
            <CoverageByWindowChart data={covWindowData} />
          </div>
        </div>
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Band Scatter</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                <span style={{color:"var(--color-green)"}}>in-band</span> · <span style={{color:"var(--color-vio)"}}>miss</span>
              </div>
            </div>
            <div className="perf-card-val">scatter · {scatter?.points?.length ?? "--"}</div>
          </div>
          <div className="perf-card-svg">
            {scatterPoints ? <BandScatterChart data={scatterPoints} /> : <PerfCardEmpty>{emptyLabel(scatLoading)}</PerfCardEmpty>}
          </div>
        </div>
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Pinball Loss Over Time</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                q10+q90 · r-пространство, ниже — лучше
              </div>
            </div>
          </div>
          <div className="perf-card-svg">
            {pinballHistData && pinballHistData.length
              ? <TrendChart data={pinballHistData} color="var(--violet)" valueFmt={(v) => fmt(v, 5)} tsFmt={fmtTs} />
              : <PerfCardEmpty>{emptyLabel(covHistLoading)}</PerfCardEmpty>}
          </div>
        </div>
        <div className="perf-card">
          <div className="perf-card-head">
            <div>
              <div className="perf-card-title">Interval Width Distribution</div>
              <div style={{fontFamily:"var(--mono-n)", fontSize:12, marginTop:4, color:"var(--text-2)"}}>
                {widthHistogram ? `μ $${fmt(widthHistogram.mean_width, 0)} · σ $${fmt(widthHistogram.std_width, 0)}` : "--"}
              </div>
            </div>
            <div className="perf-card-val">{widthDistN != null ? `N=${fmt(widthDistN, 0)}` : "--"}</div>
          </div>
          <div className="perf-card-svg">
            {widthDistData ? <ErrorHistogramChart data={widthDistData} color="var(--amber)" /> : <PerfCardEmpty>{emptyLabel(widthLoading)}</PerfCardEmpty>}
          </div>
        </div>
      </div>
    </>
  );
}

// =========== MLOPS ===========

// Куратированный набор фич для FEATURE DRIFT — реальный список из
// pinance_ml_training/config.py::DRIFT_FEATURE_COLUMNS и
// pinance_ml_inference/predict.py (держатся синхронно вручную между
// репами, общего импорта нет). Раньше здесь стояли 10 произвольных фич —
// "10" было не числом куратированных фич, а числом PSI-бинов
// (DRIFT_BASELINE_N_BINS), это разные вещи.
const DRIFT_FEATURES = ["btc_ret", "atr", "bb_width", "rsi", "ret_std_144", "macd_diff"];

// Расписание ретрейна — НЕ поле API (бэк такого нигде не отдаёт), а из
// deploy-конфига ML-пайплайна: auto-retrain.timer / auto-retrain-quantiles.timer
// в pinance_ml_training. Если бэк когда-нибудь начнёт отдавать своё
// расписание — эти константы переезжают туда, а не остаются захардкоженными.
function mostRecentDailyUTC(now, hour, minute) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0));
  if (d > now) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
function mostRecentWeeklyUTC(now, weekday, hour, minute) {
  const d = mostRecentDailyUTC(now, hour, minute);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
const MLFLOW_UI_URL = import.meta.env.VITE_MLFLOW_UI_URL ?? "";
const RETRAIN_SCHEDULE = {
  point: {
    label: "point", cadence: "daily · 03:00 UTC",
    lastDue: (now) => mostRecentDailyUTC(now, 3, 0),
    nextDue: (now) => { const d = mostRecentDailyUTC(now, 3, 0); d.setUTCDate(d.getUTCDate() + 1); return d; },
  },
  quantile: {
    label: "quantile", cadence: "weekly · Sun 04:30 UTC",
    lastDue: (now) => mostRecentWeeklyUTC(now, 0, 4, 30),
    nextDue: (now) => { const d = mostRecentWeeklyUTC(now, 0, 4, 30); d.setUTCDate(d.getUTCDate() + 7); return d; },
  },
};

function fmtDuration(ms) {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86400000);
  const h = Math.floor((abs % 86400000) / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function MLOps({ pair, prediction }) {
  const { retrainTimeline, loading: timelineLoading } = useMetricsRetrainTimeline(pair.id, 8);
  const { latency, loading: latLoading } = useMetricsLatency(pair.id);
  const { drift, loading: driftLoading, error: driftError } = useMetricsDrift(pair.id);
  const { coverage, loading: covLoading } = useMetricsCoverage(pair.id);
  const emptyLabel = (loading, text) => loading ? "LOADING…" : text;

  // fallback на "--"/text-3 для неизвестного/отсутствующего статуса — раньше
  // ?? заворачивал ЛЮБОЕ незнакомое значение (в т.ч. "нет данных вообще") в
  // ALERT (красный), что для куратированной, но ещё не подключённой к бэку
  // таблицы было бы враньём похуже мока.
  const driftStatus = (s) => ({
    ok:    { bar: "var(--green)", dot: "var(--green)", lbl: "OK" },
    warn:  { bar: "var(--amber)", dot: "var(--amber)", lbl: "WARN" },
    alert: { bar: "var(--red)",   dot: "var(--red)",   lbl: "ALERT" },
  }[s] ?? { bar: "var(--text-4)", dot: "var(--text-3)", lbl: "--" });

  // model_version/schema_version — из Redis-снимка (TTL 600с), приходят в
  // prediction. Если пайплайн встал и снимок протух, честно показываем это,
  // а не подставляем последнюю известную версию как будто модель ещё жива.
  const modelVersion = parseModelVersion(prediction?.model_version);
  const fmtModelDateTime = (d) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";

  // Сортируем на фронте по decided_at desc сами — не полагаемся на порядок
  // от бэка, чтобы UI не сломался молча, если он когда-нибудь изменится.
  const sortDesc = (arr) => [...(arr ?? [])].sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at));
  const pointEvents    = sortDesc(retrainTimeline?.point);
  const quantileEvents = sortDesc(retrainTimeline?.quantile);
  const combinedEvents = [
    ...pointEvents.map((e) => ({ ...e, track: "point" })),
    ...quantileEvents.map((e) => ({ ...e, track: "quantile" })),
  ].sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at));
  const lastEvent = combinedEvents[0] ?? null;

  const now = new Date();
  const trackStatus = (events, sched) => {
    const due = sched.lastDue(now);
    const latest = events[0] ? new Date(events[0].decided_at) : null;
    return { overdue: !latest || latest < due, next: sched.nextDue(now) };
  };
  const pointStatus    = trackStatus(pointEvents, RETRAIN_SCHEDULE.point);
  const quantileStatus = trackStatus(quantileEvents, RETRAIN_SCHEDULE.quantile);
  // Без загруженных событий "overdue" не имеет смысла (бэк недоступен или данных ещё нет).
  const hasEvents = combinedEvents.length > 0;
  const overdueTracks = hasEvents ? [
    pointStatus.overdue && "point",
    quantileStatus.overdue && "quantile",
  ].filter(Boolean) : [];
  const nextRetrainAt = overdueTracks.length
    ? null
    : (pointStatus.next < quantileStatus.next ? pointStatus.next : quantileStatus.next);

  // q10/q90-coverage по всем окнам сразу — тот же transform и тот же чарт
  // (CoverageByWindowChart), что уже на page2 (Model Performance). "Q10/Q90
  // vs target" — это /metrics/{symbol}/coverage (реальный, живой), а не
  // /metrics/{symbol}/calibration (такого эндпоинта нет — он из фазы 2,
  // заблокирован на confidence-score, которого модель пока не отдаёт).
  const covWindowData = ["1h", "24h", "7d", "30d", "all"].map((w) => {
    const d = coverage?.windows?.[w];
    return { w, q10_coverage: d?.q10_coverage ?? null, q90_coverage: d?.q90_coverage ?? null };
  });

  const driftRows = Array.isArray(drift?.features) ? drift.features : null;

  return (
    <>
      <div className="mlops-strip">
        <MetricPill
          label="SERVING MODEL"
          value={<span style={{fontSize:18, color: modelVersion?.date ? "var(--text)" : "var(--text-3)"}}>{modelVersion?.date ? fmtModelDateTime(modelVersion.date) : "--"}</span>}
          sub={modelVersion?.date ? `commit ${modelVersion.commit}${prediction?.quantile_model_version ? ` · quantile ${prediction.quantile_model_version}` : ""}${prediction?.schema_version ? ` · schema ${prediction.schema_version}` : ""}` : "no live model snapshot"}
          badge={modelVersion?.date ? <span className="badge blue">● LIVE</span> : <span className="badge muted">NO DATA</span>}
        />
        <MetricPill
          label="LAST RETRAIN"
          value={<span style={{fontSize:18, color: lastEvent ? "var(--text)" : "var(--text-3)"}}>{lastEvent ? `${fmtDuration(now - new Date(lastEvent.decided_at))} ago` : "--"}</span>}
          sub={lastEvent ? `${lastEvent.track} · ${lastEvent.n_samples ?? "?"} samples` : "no retrain events recorded yet"}
          badge={lastEvent
            ? (lastEvent.decision === "promoted" ? <span className="badge green">PROMOTED</span> : <span className="badge red">REJECTED</span>)
            : <span className="badge muted">NO DATA</span>}
        />
        <MetricPill
          label="NEXT RETRAIN"
          value={!hasEvents
            ? <span style={{fontSize:18, color:"var(--text-3)"}}>--</span>
            : overdueTracks.length
              ? <span style={{fontSize:18, color:"var(--red)"}}>overdue</span>
              : <span style={{fontSize:18}}>in {fmtDuration(nextRetrainAt - now)}</span>}
          sub={!hasEvents
            ? "no retrain events recorded yet"
            : overdueTracks.length
              ? `${overdueTracks.join(" & ")} missed scheduled run`
              : `auto · ${(pointStatus.next < quantileStatus.next ? RETRAIN_SCHEDULE.point : RETRAIN_SCHEDULE.quantile).cadence}`}
          badge={!hasEvents ? <span className="badge muted">NO DATA</span> : overdueTracks.length ? <span className="badge red">ALERT</span> : <span className="badge muted">SCHEDULED</span>}
        />
        <MetricPill
          label="DRIFT STATUS"
          value={<span style={{fontSize:18, color:"var(--text-3)"}}>--</span>}
          sub="endpoint not deployed yet"
          badge={<span className="badge muted">NO DATA</span>}
        />
      </div>

      <div className="panel" style={{marginTop:12}}>
        <div className="panel-head">
          <div className="panel-title"><b>RETRAIN TIMELINE</b> · LAST 8 PER TRACK</div>
          <div className="panel-actions">
            <span className="badge green">● promoted</span>
            <span className="badge red">● rejected</span>
          </div>
        </div>
        {[
          { key: "point", label: "POINT", events: pointEvents },
          { key: "quantile", label: "QUANTILE", events: quantileEvents },
        ].map((track, ti) => (
          <div key={track.key} style={ti > 0 ? {borderTop:"1px solid var(--border-subtle)"} : undefined}>
            <div style={{padding:"10px 16px 0", fontFamily:"var(--mono-d)", fontSize:10, letterSpacing:"0.1em", color:"var(--text-3)", textTransform:"uppercase"}}>
              {track.label}
            </div>
            {track.events.length === 0 ? (
              <div className="log-empty">{emptyLabel(timelineLoading, "NO RETRAIN EVENTS YET")}</div>
            ) : (
              <div className="timeline">
                {track.events.map((t, i) => {
                  const v = parseModelVersion(t.candidate_version);
                  return (
                    <div key={i} className="tl-node">
                      <div className={`tl-dot ${t.decision === "promoted" ? "promote" : "reject"}`} />
                      <div className="tl-ver">{v?.date ? fmtModelDateTime(v.date) : t.candidate_version}</div>
                      <div className="tl-tag">{t.decision.toUpperCase()}</div>
                      <div className="tl-time">{fmtDuration(now - new Date(t.decided_at))} ago</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="panel" style={{marginTop:12}}>
        <div className="panel-head">
          <div className="panel-title"><b>CALIBRATION</b> · Q10/Q90 COVERAGE</div>
          <div className="panel-actions">
            <span className="badge muted">{coverage?.windows?.all?.n != null ? `N=${fmt(coverage.windows.all.n, 0)}` : "--"}</span>
          </div>
        </div>
        <div style={{padding:"10px 16px 0", fontFamily:"var(--mono-n)", fontSize:12, color:"var(--text-2)"}}>
          <span style={{color:"var(--color-cian)"}}>q10</span> · <span style={{color:"var(--color-green)"}}>q90</span> · target 10%/90%
        </div>
        <div style={{padding:14, height:180}}>
          {covLoading && !coverage ? <PerfCardEmpty>Loading…</PerfCardEmpty> : <CoverageByWindowChart data={covWindowData} height={160} />}
        </div>
      </div>

      <div className="mlops-grid">
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title"><b>FEATURE DRIFT</b> · PSI</div>
            <div className="panel-actions"><span className="badge muted">{DRIFT_FEATURES.length} curated features</span></div>
          </div>
          <div style={{padding:"10px 16px", fontFamily:"var(--mono-n)", fontSize:11, color:"var(--text-3)", borderBottom:"1px solid var(--border-subtle)"}}>
            Without a sentiment feature in prod, PSI here mostly reflects market regime, not pipeline decay — read
            as "does the market look normal", not as a silent-degradation safety net.
          </div>
          {driftRows ? (
            <table className="drift-table">
              <thead><tr><th>Feature</th><th>PSI</th><th>Status</th><th style={{width:120}}></th></tr></thead>
              <tbody>
                {DRIFT_FEATURES.map((f, i) => {
                  const row = driftRows.find((x) => x.feature === f);
                  const s = driftStatus(row?.status);
                  return (
                    <tr key={i}>
                      <td className="mono-d" style={{color:"var(--text)"}}>{f}</td>
                      <td>{row?.psi != null ? row.psi.toFixed(2) : "--"}</td>
                      <td><span style={{color:s.dot}}>● {s.lbl}</span></td>
                      <td>{row?.psi != null && <span className="drift-bar"><span className="drift-bar-fill" style={{width:(row.psi/0.4*100)+"%", background:s.bar}} /></span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="log-empty">{emptyLabel(driftLoading, driftError ? "BACKEND ENDPOINT NOT DEPLOYED YET" : "NO DATA")}</div>
          )}
        </div>
        <div className="panel">
          <div className="panel-head">
            <div className="panel-title"><b>INFERENCE LATENCY</b> · {(latency?.window ?? "24h").toUpperCase()}</div>
            <div className="panel-actions"><span className="badge muted">{latency?.n ? `N=${fmt(latency.n, 0)}` : "ms"}</span></div>
          </div>
          {latency?.n ? (
            <div style={{padding:14, display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:8}}>
              {[
                { l: "P50", v: latency.p50, c: "var(--green)" },
                { l: "P95", v: latency.p95, c: "var(--amber)" },
                { l: "P99", v: latency.p99, c: "var(--red)" },
              ].map((p) => (
                <div key={p.l} className="metric" style={{background:"var(--bg-elevated)", padding:10}}>
                  <div className="metric-label" style={{marginBottom:2}}>{p.l}</div>
                  <div className="mono-n" style={{fontSize:16, color:p.c}}>{p.v != null ? fmt(p.v, 0) : "--"}<span style={{fontSize:10, color:"var(--text-3)"}}>ms</span></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="log-empty">{emptyLabel(latLoading, "NO INFERENCE SAMPLES YET")}</div>
          )}
          <div className="panel-head" style={{borderTop:"1px solid var(--border-subtle)"}}>
            <div className="panel-title"><b>EXPERIMENT TRACKING</b></div>
          </div>
          <div style={{padding:14, display:"flex", gap:10, flexWrap:"wrap"}}>
            {MLFLOW_UI_URL ? (
              <a href={MLFLOW_UI_URL} target="_blank" rel="noreferrer" className="meth-btn">
                ↗ Open MLflow UI
              </a>
            ) : (
              <span
                className="meth-btn"
                style={{opacity:0.45, cursor:"not-allowed"}}
                title="MLflow isn't deployed yet (v2 backlog on the backend) — set VITE_MLFLOW_UI_URL once back/train confirm a real instance"
              >
                ↗ Open MLflow UI
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// =========== METHODOLOGY ===========
export function Methodology({ prediction }) {
  const modelVersion = parseModelVersion(prediction?.model_version);
  const fmtModelDate = (d) => d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  return (
    <div className="meth">
      <div className="meth-sub" title={modelVersion ? `${modelVersion.raw}${prediction?.quantile_model_version ? ` · quantile ${prediction.quantile_model_version}` : ""}` : undefined}>
        PINANCE / METHODOLOGY · {modelVersion?.date ? `model trained ${fmtModelDate(modelVersion.date)}` : "no live model snapshot"}
      </div>
      <h1>How the prediction engine works.</h1>
      <p className="muted" style={{fontSize:16}}>Pinance forecasts the next hour of price on liquid spot pairs, in twelve 5-minute steps, and measures every forecast against what actually happened. Below: the data, the model, and how we keep ourselves honest about what is and isn't signal.</p>
      <h2><span className="num">01</span> Data &amp; features</h2>
      <p>We ingest 5-minute OHLCV candles from the exchange websocket and store every closed candle. Features (returns, momentum, volatility and volume indicators such as RSI, ATR, Bollinger width and MACD) are computed from a window of recent candles by one function that training and serving share, and tests check that both see identical values. The number of features of the serving model is shown in the Live Prediction header. News and sentiment features were tested and gave no measurable gain, so they are not used.</p>
      <h2><span className="num">02</span> Model</h2>
      <p>The target is the 5-minute log-return, not the price. Twelve LightGBM regressors, one per horizon from 5 to 60 minutes, predict it directly, so errors do not accumulate. The shaded corridor comes from separate quantile models (10th and 90th percentile) that are versioned and promoted independently of the point model.</p>
      <blockquote>We do not predict whether you should trade. We predict the next returns, and the spread around them. What you do with that is your problem.</blockquote>
      <h2><span className="num">03</span> Evaluation</h2>
      <p>Offline, models are validated with walk-forward splits that purge overlapping targets and are compared against naive baselines (see the training repository). Live, every forecast is compared with the realised price. Model Performance shows directional accuracy over 1 h, 24 h, 7 d, 30 d and all time, forecast error, and how often outcomes fall inside the corridor (coverage, against the 10% and 90% targets). Directional accuracy is usually only a few points above 50%.</p>
      <h2><span className="num">04</span> MLOps</h2>
      <p>A new point-model candidate is trained daily and the corridor weekly. Each candidate is gated against the production model on held-out data and is promoted only if it also holds up on live shadow traffic. The two decisions are independent, and every one of them appears on the MLOps tab.</p>
      <h2><span className="num">05</span> Caveats</h2>
      <p className="muted">Forecasting crypto on a 5-minute horizon is close to the limit of predictability. This is a research instrument, not financial advice. Past forecast accuracy does not imply future profitability.</p>
      <div className="meth-links">
        <a href="https://github.com/GKatzer/Pinance_ml_training" target="_blank" rel="noreferrer" className="meth-btn">↗ Training repository</a>
        <a href="https://github.com/GKatzer/Pinance_backend" target="_blank" rel="noreferrer" className="meth-btn">↗ Backend repository</a>
        <a href="https://github.com/GKatzer/Pinance_frontend" target="_blank" rel="noreferrer" className="meth-btn">↗ Frontend repository</a>
      </div>
    </div>
  );
}