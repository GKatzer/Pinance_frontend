// App shell
"use client"
import { usePriceStream } from "./hooks/usePriceStream";
import { usePairPrices } from "./hooks/usePairPrices";
import { useMetricsSummary } from "./hooks/useMetrics";
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { PAIRS, fmt, parseModelVersion } from "./data";
import { useTweaks, TweaksPanel, TweakSection, TweakToggle, TweakRadio } from "./tweaks-panel";
import { LivePrediction, ModelPerformance, MLOps, Methodology } from "./screens";

// Стабильная ссылка на уровне модуля — usePairPrices зависит от identity
// массива в useEffect, PAIRS.map(...) внутри компонента создавал бы новый
// массив на каждый рендер и рвал бы поллинг на каждый ре-рендер App.
const PAIR_IDS = PAIRS.map((p) => p.id);

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "showPrediction": true,
  "showVolume": true,
  "accent": "blue",
  "density": "comfortable"
}/*EDITMODE-END*/;

const ACCENT_MAP = {
  blue:   { color: "#4D7CFF", dim: "#1B2C5C", glow: "rgba(77, 124, 255, 0.18)" },
  violet: { color: "#7C5BFF", dim: "#261D4D", glow: "rgba(124, 91, 255, 0.18)" },
  green:  { color: "#1FCB7E", dim: "#0E3D2A", glow: "rgba(31, 203, 126, 0.18)" },
  amber:  { color: "#F5A524", dim: "#3D2D10", glow: "rgba(245, 165, 36, 0.18)" },
};

function IconTrendUp() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="14 7 21 7 21 14" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="20" x2="4" y2="10" />
      <line x1="10" y1="20" x2="10" y2="4" />
      <line x1="16" y1="20" x2="16" y2="14" />
      <line x1="22" y1="20" x2="22" y2="8" />
    </svg>
  );
}
function IconSync() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}
function IconBook() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

const TABS = [
  { id: "live", n: "01", label: "Live Prediction", Icon: IconTrendUp },
  { id: "perf", n: "02", label: "Model Performance", Icon: IconChart },
  { id: "ops",  n: "03", label: "MLOps", Icon: IconSync },
  { id: "meth", n: "04", label: "Methodology", Icon: IconBook },
];
const TAB_IDS = TABS.map(t => t.id);
const DEFAULT_TAB = TAB_IDS[0];

// Активная вкладка живёт в query-параметре (?tab=perf), а не только в стейте —
// иначе обновление страницы всегда сбрасывало на дефолтную вкладку. Query,
// а не path: путь остаётся "/", так что перезагрузка не зависит от того,
// настроен ли SPA-фолбэк на сервере для произвольных путей.
function tabFromLocation() {
  const t = new URLSearchParams(window.location.search).get("tab");
  return TAB_IDS.includes(t) ? t : DEFAULT_TAB;
}

// "2026-08-03T17:14:00.000Z" -> "Aug 3" — компактно для nav-бейджа/футера;
// полный model_version/schema_version живут в title-тултипе рядом.
const fmtModelDate = (d) => d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function PairSelect({ pair, onChange, tick, prices }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const quoteOf = (id) => id.split("/")[1];

  return (
    <div className="pair-wrap" ref={ref}>
      <div className="pair-select" onClick={() => setOpen(o => !o)}>
        <span className="pair-icon" style={{background: pair.color, color: "var(--bg-base)"}}>{pair.sym[0]}</span>
        <span>{pair.sym}<span className="pair-quote">/{quoteOf(pair.id)}</span></span>
        <span style={{color: "var(--text-3)", fontSize: 10}}>▾</span>
      </div>
      {open && (
        <div className="dropdown">
          {PAIRS.map(p => (
            <div key={p.id} className={"dropdown-item " + (p.id === pair.id ? "active" : "")}
              onClick={() => { onChange(p); setOpen(false); }}>
              <span className="pair-icon" style={{background: p.color, color: "var(--bg-base)"}}>{p.sym[0]}</span>
              <span>{p.sym}<span className="pair-quote">/{quoteOf(p.id)}</span></span>
              <span style={{marginLeft: "auto", color: "var(--text-3)", fontSize: 10, fontFamily: "var(--mono-n)"}}>{(() => {
                const c = p.id === pair.id && tick?.close ? tick.close : prices[p.id]?.close;
                return c != null ? "$" + fmt(c, 0) : "--";
              })()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// pct = (close-open)/open — та же формула, что и раньше для активной пары
// (formally это ход текущей 5м-свечи, не "24h change" несмотря на подпись,
// это унаследованное поведение, не то, что меняется здесь), теперь просто
// применена одинаково и к активной (live tick), и к остальным (poll).
function pctOf(open, close) {
  return open > 0 ? ((close - open) / open) * 100 : null;
}

// Скорость бегущей строки. Раньше цикл был фиксированные 90с (~11px/s при
// реальных данных); теперь длительность выводится из ширины группы.
const TICKER_SPEED_PX_S = 20;
const TICKER_FALLBACK_S = 90; // до первого замера

function Ticker({ tick, pairId, prices, summary }) {
  const win1h  = summary?.windows?.["1h"];
  const win24h = summary?.windows?.["24h"];

  const pairItems = PAIRS.map((p) => {
    const isActive = p.id === pairId;
    const o = isActive ? tick?.open  : prices[p.id]?.open;
    const c = isActive ? tick?.close : prices[p.id]?.close;
    const d = pctOf(o, c);
    return { k: p.id, raw: true, v: c != null ? "$" + fmt(c, 2) : "--", d: d ?? undefined };
  });

  const items = [
    ...pairItems,
    {
      k: "ACC 1H", raw: true,
      v: win1h?.directional_accuracy != null ? `${fmt(win1h.directional_accuracy, 1)}%` : "--",
      d: win1h?.delta_accuracy ?? undefined,
    },
    {
      // Бэк не отдаёт delta для MAE (см. тот же комментарий на page2) — neutral,
      // без стрелки, а не выдуманное число.
      k: "MAE", raw: true, neutral: true,
      v: win24h?.mae != null ? `$${fmt(win24h.mae, 2)}` : "--",
    },
    // MODEL / DRIFT / P95 LAT / RETRAIN убраны — не из-за отсутствия данных
    // (модель теперь реальна), а потому что бегущая строка как язык компонента
    // подразумевает частообновляющиеся числа, а версия модели/дрифт/ретрейн
    // меняются раз в час-сутки — это рассинхрон формы и содержания, а не то,
    // что чинится добавлением поллинга. Версия модели уже есть в nav brand tag
    // и на MLOps-вкладке, дублировать её сюда не нужно.
  ];

  // Бесшовный цикл: трек = 2 одинаковые группы, анимация двигает его на -50%
  // (ровно на ширину группы). Чтобы в конце цикла справа не было пустоты,
  // группа должна быть не уже маски — поэтому набор items повторяется
  // `copies` раз (замер через ResizeObserver, а не константа ×2: на широком
  // экране 4 пар + 2 метрик не хватает). Отступ между элементами — padding
  // самого .ticker-item, а не gap трека: иначе период сдвига и реальный
  // период контента расходятся на gap/2 и на шве виден прыжок.
  const maskRef = useRef(null);
  const setRef = useRef(null);
  const [fit, setFit] = useState({ copies: 1, duration: TICKER_FALLBACK_S });

  useLayoutEffect(() => {
    const mask = maskRef.current;
    const set = setRef.current;
    if (!mask || !set) return;
    const measure = () => {
      const setW = set.getBoundingClientRect().width;
      if (setW <= 0) return;
      const copies = Math.max(1, Math.ceil(mask.clientWidth / setW));
      // Скорость в px/s постоянна: длительность растёт вместе с шириной группы.
      // Округляем, чтобы дрожание ширины от смены цифр не дёргало анимацию.
      const duration = Math.round((copies * setW) / TICKER_SPEED_PX_S);
      setFit((prev) => (prev.copies === copies && prev.duration === duration ? prev : { copies, duration }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(mask);
    ro.observe(set);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="ticker-mask" ref={maskRef}>
      <div className="ticker-track" style={{ animationDuration: `${fit.duration}s` }}>
        {[0, 1].map((g) => (
          <div className="ticker-group" key={g}>
            {Array.from({ length: fit.copies }, (_, c) => (
              <div
                className="ticker-set"
                key={c}
                ref={g === 0 && c === 0 ? setRef : undefined}
                aria-hidden={g === 0 && c === 0 ? undefined : true}
              >
                {items.map((it) => (
                  <span className="ticker-item" key={it.k}>
                    <span style={{color: "var(--text-3)", letterSpacing: "0.08em"}}>{it.k}</span>
                    <span style={{color: it.color || "var(--text)"}}>{it.raw ? it.v : "$" + fmt(it.v, 2)}</span>
                    {!it.neutral && it.d !== undefined && (
                      <span className={it.d >= 0 ? "pos" : "neg"} style={{fontSize: 10}}>
                        {it.d >= 0 ? "▲" : "▼"} {Math.abs(it.d).toFixed(2)}%
                      </span>
                    )}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [tab, setTabState] = useState(tabFromLocation);
  const [pair, setPair] = useState(PAIRS[0]);
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [now, setNow] = useState(null);
  // Момент получения последнего тика/снапшота браузером — для "UPDATED Ns AGO".
  const [lastTickAt, setLastTickAt] = useState(null);
  const {
  status,
  tick,
  prediction,
  results,
} = usePriceStream(pair.id);
  const prices = usePairPrices(PAIR_IDS);
  const { summary } = useMetricsSummary(pair.id);

  // model_version/schema_version живут в Redis-снимке с TTL 600с —
  // приходят и с /snapshot на маунте, и живьём с
  // каждым SSE "prediction", так что бейдж не требует отдельного поллинга.
  const modelVersion = parseModelVersion(prediction?.model_version);

  const setTab = useCallback((id) => {
    setTabState(id);
    const url = new URL(window.location.href);
    if (id === DEFAULT_TAB) url.searchParams.delete("tab");
    else url.searchParams.set("tab", id);
    window.history.pushState({}, "", url);
  }, []);

  // Кнопки браузера назад/вперёд тоже должны переключать вкладку.
  useEffect(() => {
    const onPopState = () => setTabState(tabFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const a = ACCENT_MAP[tweaks.accent] || ACCENT_MAP.blue;
    document.documentElement.style.setProperty("--accent", a.color);
    document.documentElement.style.setProperty("--accent-dim", a.dim);
    document.documentElement.style.setProperty("--accent-glow", a.glow);
  }, [tweaks.accent]);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { if (tick) setLastTickAt(Date.now()); }, [tick]);

  // Реальная свежесть данных: секунды с последнего полученного тика (а не
  // счётчик по часам) и статус SSE-соединения.
  const updatedAgo = now && lastTickAt != null ? Math.max(0, Math.floor((now.getTime() - lastTickAt) / 1000)) : null;
  const isLive = status === "open";
  const liveLabel = isLive ? "LIVE" : status === "error" ? "RECONNECTING" : "CONNECTING";

  // Горизонт прогноза и число признаков берём из живого снапшота.
  const horizonMin = prediction?.predictions?.length
    ? Math.max(...prediction.predictions.map((p) => p.horizon)) * 5
    : null;

  return (
    <>
      <Ticker tick={tick} pairId={pair.id} prices={prices} summary={summary} />
 

      <div className="container">
             <nav className="nav">
        <div className="brand">
          <img src="/logo.png" alt="logo" style={{ width: 22, height: 22, objectFit: "contain" }} />
          <span>PINANCE</span>
          <span
            className="brand-tag"
            title={modelVersion ? `model_version ${modelVersion.raw}${prediction?.quantile_model_version ? ` · quantile ${prediction.quantile_model_version}` : ""}${prediction?.schema_version ? ` · schema ${prediction.schema_version}` : ""}` : "no live model snapshot"}
          >
            ML{modelVersion?.date ? ` · ${fmtModelDate(modelVersion.date)}` : ""}
          </span>
        </div>
        <div className="tabs" data-screen-label="nav">
          {TABS.map(t => (
            <button key={t.id} data-screen-label={t.n + " " + t.label}
              className={"tab " + (tab === t.id ? "active" : "")}
              onClick={() => setTab(t.id)}>
              <span className="tab-num">{t.n}</span>
              <span className="tab-icon"><t.Icon /></span>
              <span className="tab-text">{t.label}</span>
            </button>
          ))}
        </div>
        <div className="nav-right">
          <div className="live">
            <span className="live-dot" style={isLive ? undefined : { background: "var(--amber)", animation: "none" }}></span>
            <span>{liveLabel}{updatedAgo != null ? ` · UPDATED ${updatedAgo}s AGO` : ""}</span>
          </div>
          <PairSelect pair={pair} onChange={setPair} tick={tick} prices={prices} />
        </div>
      </nav>

      
        {tab === "live" && (
          <div data-screen-label="01 Live Prediction" className="fade-in" key="live">
            <div className="page-strip">
              <span className="crumb">PINANCE</span>
              <span className="sep">/</span>
              <span style={{color: "var(--text)"}}>LIVE PREDICTION</span>
              <span className="sep">/</span>
              <span>{pair.id}</span>
              <div className="meta">
                <span><span style={{color:"var(--text-3)"}}>HORIZON</span> <b>{horizonMin != null ? `+${horizonMin}m` : "--"}</b></span>
                <span><span style={{color:"var(--text-3)"}}>FEATURES</span> <b>{prediction?.feature_count ?? "--"}</b></span>
                <span><span style={{color:"var(--text-3)"}}>UTC</span> <b>{now ? now.toISOString().slice(11,19) : "--:--:--"}</b></span>
              </div>
            </div>
          <LivePrediction
            pair={pair}
            tweaks={tweaks}
            tick={tick}
            prediction={prediction}
            results={results}
            streamStatus={status}
          />
        </div>
        )}
        {tab === "perf" && <div data-screen-label="02 Model Performance" className="fade-in" key="perf"><ModelPerformance pair={pair} prediction={prediction} /></div>}
        {tab === "ops"  && <div data-screen-label="03 MLOps" className="fade-in" key="ops"><MLOps pair={pair} prediction={prediction} /></div>}
        {tab === "meth" && <div data-screen-label="04 Methodology" className="fade-in" key="meth"><Methodology prediction={prediction} /></div>}

        <div className="foot">
          <span>PINANCE · {pair.id} · {now ? now.toISOString().slice(0,10) : "----"}</span>

          <span>
            MODEL{" "}
            <span title={modelVersion ? `${modelVersion.raw}${prediction?.quantile_model_version ? ` · quantile ${prediction.quantile_model_version}` : ""}` : "no live model snapshot"}>
              {modelVersion?.date ? fmtModelDate(modelVersion.date) : "--"}
            </span>{" "}
            · © PINANCE
          </span>
        </div>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Chart">
          <TweakToggle label="Show prediction overlay" value={tweaks.showPrediction} onChange={v => setTweak("showPrediction", v)} />
          <TweakToggle label="Show volume" value={tweaks.showVolume} onChange={v => setTweak("showVolume", v)} />
        </TweakSection>
        <TweakSection label="Accent color">
          <TweakRadio
            value={tweaks.accent}
            onChange={v => setTweak("accent", v)}
            options={[
              { value: "blue",   label: "Blue"   },
              { value: "violet", label: "Violet" },
              { value: "green",  label: "Green"  },
              { value: "amber",  label: "Amber"  },
            ]}
          />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

export default App;
