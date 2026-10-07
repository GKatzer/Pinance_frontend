// Charts — all hand-built SVG, no external libs

import { useState, useRef, useEffect, useMemo, memo } from "react";
import { fmt } from "./data";

// Вынесены за пределы PriceChart и обёрнуты в memo — на больших таймфреймах
// (1W/1Y/ALL, до тысяч свечей) даже при мемоизированном массиве элементов
// (useMemo) React всё равно СВЕРЯЕТ его на каждый ре-рендер родителя (hover
// меняет состояние в PriceChart на каждый кадр) — само сравнение O(N) узлов
// фибера блокирует поток достаточно, чтобы курсор при быстром движении обгонял
// обработку (тултип "залипает", догоняет только когда курсор замедлился).
// memo с props-примитивами (не замыканиями xAt/yAt — они новые на каждый
// рендер и всегда "разные" для shallow-compare) даёт React вообще не заходить
// в это поддерево, когда все входы не изменились — не просто не пересчитывать,
// а не сверять совсем.
const CandleLayer = memo(function CandleLayer({
  candles, basePrice, padL, xStep, chartT, chartB, minP, maxP, cw,
  showActual, showVolume, volBot, maxVol, volH,
}) {
  const xAt = (i) => padL + i * xStep;
  const yAt = (p) => chartT + (1 - (p - minP) / (maxP - minP)) * (chartB - chartT);
  return (
    // pointerEvents="none" — наведение считается математикой в processPointer
    // (px/py от getBoundingClientRect), а не через event.target, так что свечам
    // не нужно участвовать в hit-testing'е вообще. На ALL (до ~5000 свечей,
    // т.е. до ~15000 <rect>/<line> узлов) браузер иначе гоняет hit-test по всем
    // ним на КАЖДЫЙ pointermove — это нативная стоимость браузера, не React, и
    // memo() выше её не убирает (он экономит только React-рендер, не hit-test).
    <g pointerEvents="none">
      {candles.map((c, i) => {
        const color = c.close >= basePrice ? "var(--color-green)" : "var(--color-red)";
        const x = xAt(i);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={yAt(c.high)} y2={yAt(c.low)} stroke={color} strokeWidth="1" strokeOpacity="0.6" />
            <rect
              x={x - cw / 2}
              y={yAt(Math.max(c.open, c.close))}
              width={cw}
              height={Math.max(1, Math.abs(yAt(c.open) - yAt(c.close)))}
              fill={color}
              fillOpacity={showActual ? 0.75 : 0.35}
            />
            {showVolume && (
              <rect
                x={x - cw / 2}
                y={volBot - (c.volume / maxVol) * volH}
                width={cw}
                height={(c.volume / maxVol) * volH}
                fill={color} fillOpacity="0.55"
              />
            )}
          </g>
        );
      })}
    </g>
  );
});

// Та же логика, что у CandleLayer выше — трейл прошлых предиктов (LAYER 1),
// активен и на 1D, и на 1W (см. PRED_HISTORY_TIMEFRAMES), у 1W уже до 288 точек.
const PredTrailLayer = memo(function PredTrailLayer({ predHistoryPts, padL, xStep, chartT, chartB, minP, maxP, baseY }) {
  const xAt = (i) => padL + i * xStep;
  const yAt = (p) => chartT + (1 - (p - minP) / (maxP - minP)) * (chartB - chartT);
  return (
    <g pointerEvents="none">
      <defs>
        {predHistoryPts.map((p, i) => (
          <linearGradient key={i} id={`predTrailGrad-${i}`}
            x1="0" x2="0" y1={yAt(p.predicted)} y2={baseY} gradientUnits="userSpaceOnUse"
          >
            <stop offset="0%" stopColor={p.hit ? "var(--color-cian)" : "var(--color-vio)"} stopOpacity="0.85" />
            <stop offset="100%" stopColor={p.hit ? "var(--color-cian)" : "var(--color-vio)"} stopOpacity="0" />
          </linearGradient>
        ))}
      </defs>
      {predHistoryPts.map((p, i) => (
        <line key={i}
          x1={xAt(p.i)} x2={xAt(p.i)}
          y1={yAt(p.predicted)} y2={baseY}
          stroke={`url(#predTrailGrad-${i})`} strokeWidth="1.3"
        />
      ))}
      {predHistoryPts.map((p, i) => {
        if (i === 0) return null;
        const prev = predHistoryPts[i - 1];
        // Пропущенные свечи (нет резолвнутого предикта — см. gap-guard в
        // historyBandRuns выше) режут коннектор так же, как режут band-заливку:
        // без этой проверки соседние В МАССИВЕ, но НЕ соседние по свече точки
        // соединялись прямой линией через весь разрыв — после реконнекта/дырки
        // в данных это рисовало один-два длинных "лишних" диагональных штриха
        // через весь график, которые выглядели как отдельные "дорожки".
        if (p.i !== prev.i + 1) return null;
        const color = p.hit ? "var(--color-cian)" : "var(--color-vio)";
        return (
          <line key={i}
            x1={xAt(prev.i)} y1={yAt(prev.predicted)}
            x2={xAt(p.i)} y2={yAt(p.predicted)}
            stroke={color} strokeWidth="1.5" strokeOpacity="0.55"
          />
        );
      })}
      {predHistoryPts.map((p, i) => (
        <circle key={i}
          cx={xAt(p.i)} cy={yAt(p.predicted)} r="2"
          fill={p.hit ? "var(--color-cian)" : "var(--color-vio)"} fillOpacity="1.0"
        />
      ))}
    </g>
  );
});

export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpoint]);
  return isMobile;
}

// ============ MAIN PRICE CHART ============
export function PriceChart({
  candles,
  prediction,
  predHistory,
  showPrediction,
  showVolume,
  showActual,
  showPredHistory,
  showCI,
  showPredInfo,
  interval = "5m",   // "5m" | "15m" | "1h" | "1d"
  timeframe = "1D",  // "1D" | "1W" | "1M" | "1Y" | "ALL" — 1Y и ALL оба дают interval="1d",
                     // различать их приходится по этому пропу (мобильная разметка оси X разная)
  ohlcvParams = [],  // [{key, color, fmtVal}] — параметры для отображения в tooltip
  shownParams = [],  // ["O","H","L","V"] — какие показывать
  isFullscreen = false,
}) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  const tipRef  = useRef(null);
  // Какой стороной от курсора стоял тултип на прошлом рендере — см. floating
  // tooltip ниже: transition на "left" нужен только в момент смены стороны,
  // не на каждый пиксель слежения за курсором.
  const tipSideRef = useRef(true);
  const isMobile = useIsMobile();

  // Живая высота .chart-wrap (теперь flex:1 в globals.css, не aspect-ratio) —
  // на десктопе панель растягивается гридом под соседнюю side-панель (обычно
  // выше графика), и viewBox должен под неё подстроиться, иначе SVG просто
  // леттербоксит пустыми полями внутри уже растянутого блока (см. пункт про
  // пустое место под графиком). Só на десктопе — на мобилке высота
  // фиксирована в CSS (.chart-wrap{height:300px;flex:none}), измерять нечего.
  const [wrapSize, setWrapSize] = useState({ width: 1080, height: 480 });
  useEffect(() => {
    if (isMobile) return;
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setWrapSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isMobile]);

  // ts → индекс свечи пересчитываем каждый раз, когда меняются candles —
  // индексы съезжают при сдвиге буфера (см. pushTick в useLiveCandles),
  // так что закреплять их статично на предикт-точках нельзя.
  const tsToIdx = useMemo(() => new Map(candles.map((c, i) => [c.ts, i])), [candles]);
  const predHistoryPts = useMemo(() => {
    if (!predHistory || !predHistory.length) return [];
    return predHistory
      .map((p) => ({
        i: tsToIdx.get(p.ts), predicted: p.predicted, hit: p.hit,
        q10: p.q10 ?? null, q90: p.q90 ?? null,
      }))
      .filter((p) => p.i !== undefined);
  }, [predHistory, tsToIdx]);

  // Смежные (по индексу свечи) точки трейла с обеими квантилями — рисуются
  // залитым бэндом, продолжением LAYER 4 назад по прошлым свечам. Разрывы
  // (строки до промоушена квантильной корзины, пропущенные точки) режут бэнд
  // на отдельные куски вместо того, чтобы тянуть заливку через дыру в данных.
  const historyBandRuns = useMemo(() => {
    const withBand = predHistoryPts.filter((p) => p.q10 != null && p.q90 != null);
    const runs = [];
    for (const p of withBand) {
      const last = runs[runs.length - 1];
      if (last && p.i === last[last.length - 1].i + 1) last.push(p);
      else runs.push([p]);
    }
    return runs.filter((run) => run.length > 1);
  }, [predHistoryPts]);

  // viewBox height подстраивается под реальные пропорции .chart-wrap (ширина
  // всегда 100% контейнера => 1:1 с W=1080 юнитами; высота — с флекс-заполненным
  // контейнером может быть чем угодно), чтобы preserveAspectRatio="meet" не
  // леттербоксил, а сама геометрия графика (шаг свечей, высота price-оси)
  // реально растягивалась на всю выделенную высоту, а не только SVG-бокс вокруг
  // неё. 420 — тот же пол, что min-height у .chart-wrap в CSS.
  const W = 1080;
  const H = isMobile
    ? 300
    : Math.max(420, Math.round(W * (wrapSize.height / wrapSize.width)));
  // SVG-текст масштабируется вместе с viewBox: 1080 юнитов растягиваются на
  // всю ширину контейнера (а на 2K ещё и на .container zoom), так что
  // fontSize="12" превращался в ~25px на экране. Подпись оси X держим на
  // постоянном размере в CSS-px, пересчитывая его в юниты viewBox.
  const AXIS_LABEL_PX = 11;
  const axisLabelSize = AXIS_LABEL_PX * W / wrapSize.width;
  // padT раньше держал место под price-overlay (убран — цена/пара и так есть в
  // метриках над графиком); теперь достаточно отступа под легенду (top:16px,
  // HTML-оверлей). На мобилке легенда и chartT совпадают почти 1:1 в px (см.
  // хендлMove), поэтому там нужно больше запаса, чем кажется по SVG-юнитам.
  const padL = isMobile ? 12 : 16, padR = isMobile ? 10 : 64, padT = isMobile ? 46 : 40, padB = isMobile ? 24 : 36;
  const volGap = showVolume ? (isMobile ? 5 : 8) : 0;
  const volH = showVolume ? (isMobile ? 42 : 70) : 0;
  const chartT = padT;
  const chartB = H - padB - volH - volGap;

  // useMemo + ручной цикл вместо .map()+spread Math.min/max — на ALL (до
  // ~5000 свечей) spread по массиву такой длины сам по себе не бесплатен, а
  // без memo это пересчитывалось на КАЖДЫЙ рендер (включая рендеры от
  // наведения курсора), даже когда candles не менялись — самый вероятный
  // источник "не пересчитывается вовремя" на больших таймфреймах, раз он
  // не зависел от showPrediction/памяти детей, которые уже были мемоизированы.
  const { minP, maxP } = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const c of candles) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    if (showPrediction) {
      for (const p of prediction) {
        if (p.lo < lo) lo = p.lo;
        if (p.hi > hi) hi = p.hi;
      }
    }
    for (const p of predHistoryPts) {
      const q10 = p.q10 ?? p.predicted;
      const q90 = p.q90 ?? p.predicted;
      if (q10 < lo) lo = q10;
      if (q90 > hi) hi = q90;
    }
    const padP = (hi - lo) * 0.06;
    return { minP: lo - padP, maxP: hi + padP };
  }, [candles, showPrediction, prediction, predHistoryPts]);

  const PRED_SLOTS = 12; // резервируем место для предсказания всегда
  const totalSlots = candles.length + (showPrediction ? Math.max(prediction.length, PRED_SLOTS) : PRED_SLOTS);
  const xStep = (W - padL - padR) / (totalSlots - 1);
  const cw = xStep * 0.3;

  const xAt = (i) => padL + i * xStep;
  const yAt = (p) => chartT + (1 - (p - minP) / (maxP - minP)) * (chartB - chartT);

  const lastClose = candles[candles.length - 1].close;
  const predLine = prediction.map((p, idx) => ({
    x: xAt(candles.length - 1 + idx),
    y: yAt(p.mid),
    mid: p.mid,
    lo: p.lo,
    hi: p.hi,
    horizon: p.i ?? idx,
  }));

  const predBandPath =
    predLine.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${yAt(p.hi)}`).join(" ") +
    " " +
    predLine.slice().reverse().map((p) => `L ${p.x} ${yAt(p.lo)}`).join(" ") +
    " Z";

  const predLinePath = predLine.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  // Тот же принцип заливки, что predBandPath выше, только назад по прошлым
  // свечам — по одному path на смежный кусок (см. historyBandRuns).
  const historyBandPaths = historyBandRuns.map((run) =>
    run.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p.i)} ${yAt(p.q90)}`).join(" ") +
    " " +
    run.slice().reverse().map((p) => `L ${xAt(p.i)} ${yAt(p.q10)}`).join(" ") +
    " Z"
  );

  // useMemo + ручной цикл — тот же анти-паттерн, что и у minP/maxP выше
  // (spread по candles.map() на каждый рендер, включая hover), но был пропущен
  // здесь: на ALL (до ~5000 свечей) это самый частый источник полного
  // пересчёта на каждый кадр наведения курсора.
  const maxVol = useMemo(() => {
    let m = 0;
    for (const c of candles) if (c.volume > m) m = c.volume;
    return m;
  }, [candles]);
  const volTop = chartB + volGap;
  const volBot = volTop + volH;

  const yTicks = 6;
  const tickVals = Array.from(
    { length: yTicks },
    (_, i) => minP + ((maxP - minP) * i) / (yTicks - 1)
  );

  // Количество минут в одной свече — для fallback-меток и tooltip
  const INTERVAL_MINUTES = { "5m": 5, "15m": 15, "1h": 60, "1d": 1440 };
  const intervalMinutes = INTERVAL_MINUTES[interval] ?? 5;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Общая высота выделений на осях X и Y (должна совпадать) — для десктопа с
  // запасом, чтобы X-выделение перекрывало собой подписи времени, когда стоит рядом.
  const AXIS_BADGE_H = isMobile ? 20 : 26;

  // Обратная к yAt — цена в точке наведения по вертикали (для ценового выделения оси Y).
  const priceAt = (y) => minP + (1 - (y - chartT) / (chartB - chartT)) * (maxP - minP);

  // "25 Jul '26 14:32:07" — для выделения на шкале времени (ось X)
  const fmtAxisDateTime = (ts) => {
    const d    = new Date(ts);
    const day  = d.getUTCDate();
    const mon  = d.toLocaleString("en", { month: "short", timeZone: "UTC" });
    const yr2  = (d.getUTCFullYear() % 100).toString().padStart(2, "0");
    const h    = d.getUTCHours().toString().padStart(2, "0");
    const min  = d.getUTCMinutes().toString().padStart(2, "0");
    const sec  = d.getUTCSeconds().toString().padStart(2, "0");
    return `${day} ${mon} '${yr2} ${h}:${min}:${sec}`;
  };

  // {date:"07/25/2026", time:"02:32:07 PM"} — для верхней строки тултипа
  const fmtTooltipDateTime = (ts) => {
    const d   = new Date(ts);
    const mm  = (d.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd  = d.getUTCDate().toString().padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    let h = d.getUTCHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    const hh  = h.toString().padStart(2, "0");
    const min = d.getUTCMinutes().toString().padStart(2, "0");
    const sec = d.getUTCSeconds().toString().padStart(2, "0");
    return { date: `${mm}/${dd}/${yyyy}`, time: `${hh}:${min}:${sec} ${ampm}` };
  };

  // ── X-axis labels (CoinMarketCap style) ── useMemo — на 1Y/ALL (до ~1500
  // свечей) этот цикл пересчитывался на каждый ре-рендер, включая ре-рендеры
  // от наведения курсора, хотя от hover тут ничего не зависит. ──
  const timeLabels = useMemo(() => (() => {
    const MIN_PX = 64;
    const raw = [];

    if (!candles[0]?.ts) {
      const s = Math.max(1, Math.floor(candles.length / 6));
      for (let i = 0; i < candles.length; i += s)
        raw.push({ x: xAt(i), label: `−${(candles.length - i) * intervalMinutes}m` });

    } else if (interval === "5m") {
      // 1D — every 3h; midnight → date "Jun 1"
      candles.forEach((c, i) => {
        const d = new Date(c.ts);
        const h = d.getUTCHours(), m = d.getUTCMinutes();
        if (m !== 0 || h % 3 !== 0) return;
        const label = h === 0
          ? d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
          : `${h % 12 || 12}${h < 12 ? "AM" : "PM"}`;
        raw.push({ x: xAt(i), label });
      });

    } else if (interval === "15m" || interval === "1h") {
      // 1W (15m) / 1M (1h) — равномерно по индексу (≈1 метка в день для 1W,
      // ≈каждые 3 дня для 1M). Десктоп: месяц+число на каждой метке, как раньше.
      // Мобилка: месяц пишем только на первой метке и на первой метке после
      // смены месяца — остальные просто число, чтобы подписи не толкались.
      const N = interval === "15m" ? 7 : 10;
      const seg = candles.length / N;
      let prevMonth = null;
      for (let j = 0; j < N; j++) {
        const i = Math.min(Math.round(seg * (j + 0.5)), candles.length - 1);
        const d = new Date(candles[i].ts);
        let label;
        if (isMobile) {
          const mon = d.getUTCMonth();
          label = (prevMonth === null || mon !== prevMonth)
            ? d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
            : String(d.getUTCDate());
          prevMonth = mon;
        } else {
          label = d.toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        }
        raw.push({ x: xAt(i), label });
      }

    } else if (isMobile && timeframe === "1Y") {
      // 1Y (мобилка) — по метке на каждые ~4 месяца видимого диапазона, формат
      // "Mon 'YY"; метка ставится на свече ближе к середине своего 4-месячного
      // интервала (не на равномерных индексах, а привязана к реальным датам).
      const first = candles[0].ts, last = candles[candles.length - 1].ts;
      const totalMs = last - first || 1;
      const approxMonths = totalMs / (30.44 * 24 * 3600 * 1000);
      const bucketCount = Math.max(1, Math.round(approxMonths / 4));
      for (let j = 0; j < bucketCount; j++) {
        const bucketMid = first + ((j + 0.5) / bucketCount) * totalMs;
        let bestI = 0, bestDiff = Infinity;
        for (let i = 0; i < candles.length; i++) {
          const diff = Math.abs(candles[i].ts - bucketMid);
          if (diff < bestDiff) { bestDiff = diff; bestI = i; }
        }
        const d = new Date(candles[bestI].ts);
        const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        const yr2 = (d.getUTCFullYear() % 100).toString().padStart(2, "0");
        raw.push({ x: xAt(bestI), label: `${mon} '${yr2}` });
      }

    } else if (isMobile && timeframe === "ALL") {
      // ALL (мобилка) — только целые года, подписываем каждый второй видимый
      // год, без единого месяца.
      const yearStarts = [];
      let prevYear = null;
      candles.forEach((c, i) => {
        const y = new Date(c.ts).getUTCFullYear();
        if (y !== prevYear) { yearStarts.push({ i, y }); prevYear = y; }
      });
      yearStarts.forEach((yr, idx) => {
        if (idx % 2 === 0) raw.push({ x: xAt(yr.i), label: String(yr.y) });
      });

    } else if (timeframe === "ALL") {
      // ALL (десктоп) — только года, без месяцев: метка на первой свече каждого
      // года (граница 1 января), а не равномерно по индексу — иначе метки
      // попадают на случайные месяцы ("Jun", "Oct"). История почти всегда
      // начинается не с января: подпись "2019" на самой первой свече означала
      // бы начало графика, а не начало года, поэтому неполный первый год
      // пропускаем (кроме случая, когда данные начинаются в январе).
      let prevYear = null;
      candles.forEach((c, i) => {
        const d = new Date(c.ts);
        const y = d.getUTCFullYear();
        if (y === prevYear) return;
        const isFirst = prevYear === null;
        prevYear = y;
        if (isFirst && d.getUTCMonth() !== 0) return;
        raw.push({ x: xAt(i), label: String(y) });
      });

    } else {
      // 1Y (десктоп) — равномерно по индексу, ~12 меток на год
      const span = candles.length;
      const N = 12;
      const seg = span / N;
      for (let j = 0; j < N; j++) {
        const i = Math.min(Math.round(seg * (j + 0.5)), span - 1);
        const d = new Date(candles[i].ts);
        const mon = d.getUTCMonth();
        const label = mon === 0
          ? String(d.getUTCFullYear())
          : d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
        raw.push({ x: xAt(i), label });
      }
    }

    return raw.filter((l, i) => i === 0 || l.x - raw[i - 1].x >= MIN_PX);
  })(), [candles, interval, isMobile, timeframe, intervalMinutes, padL, xStep]);

  // Пока showPrediction включён, future-зона (pred-«свечи») тоже доступна
  // для наведения — иначе hover ограничен последней настоящей свечой.
  const maxHoverIdx = showPrediction && predLine.length > 1
    ? candles.length - 1 + (predLine.length - 1)
    : candles.length - 1;

  // Раньше setHover вызывался на каждый сырой pointermove — на 1Y/ALL (до ~1500
  // свечей) это гоняло полный ре-рендер SVG (все wick'и/бары объёма/тайм-лейблы,
  // ничего из этого не мемоизировано) с частотой, с которой браузер шлёт события
  // (может быть кратно выше 60Гц), отсюда лаг курсора относительно референса
  // (CoinMarketCap и т.п. throttling'ят ровно по этой же причине). rAF ограничивает
  // до одного setHover на кадр — событий может прийти много, обрабатываем последнее.
  const rafIdRef = useRef(null);
  const pendingPointerRef = useRef(null);

  useEffect(() => () => { if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current); }, []);

  const processPointer = ({ clientX, clientY }) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;

    // preserveAspectRatio: "none" на мобилке растягивает SVG по каждой оси независимо
    // (rect == реальный размер контента, леттербокс-полей нет); "xMidYMid meet" на
    // десктопе — единый масштаб с центрированием, из-за чего при несовпадении
    // пропорций контейнера и viewBox (1080:H) по бокам или сверху/снизу могут быть
    // пустые поля. Раньше это игнорировалось, из-за чего курсор "уезжал" от свечи.
    let scaleX, scaleY, offsetX, offsetY;
    if (isMobile) {
      scaleX = rect.width / W;
      scaleY = rect.height / H;
      offsetX = 0;
      offsetY = 0;
    } else {
      const scale = Math.min(rect.width / W, rect.height / H);
      scaleX = scaleY = scale;
      offsetX = (rect.width - W * scale) / 2;
      offsetY = (rect.height - H * scale) / 2;
    }

    const px = (clientX - rect.left - offsetX) / scaleX;
    const pyRaw = (clientY - rect.top - offsetY) / scaleY;
    const py = Math.max(chartT, Math.min(chartB, pyRaw));

    // hover только в зоне данных (не над price-overlay, не под осью)
    if (pyRaw < chartT || pyRaw > chartB) {
      setHover(null);
      return;
    }

    let idx = Math.round((px - padL) / xStep);
    if (idx < 0 || idx > maxHoverIdx) {
      setHover(null);
      return;
    }

    // rawX/rawY — экранные пиксели внутри контейнера, соответствующие (px,py) в SVG
    // (с учётом леттербокс-отступов) — чтобы тултип совпадал с "мячиком", а не с сырой
    // позицией курсора/пальца.
    const rawX = offsetX + px * scaleX;
    const rawY = offsetY + py * scaleY;

    if (idx < candles.length) {
      const c  = candles[idx];
      const ph = predHistoryPts.find((p) => p.i === idx) ?? null;
      setHover({ idx, c, ph, pred: null, x: px, y: py, rawX, rawY });
    } else {
      const pred = predLine[idx - candles.length + 1] ?? null;
      if (!pred) { setHover(null); return; }
      setHover({ idx, c: null, ph: null, pred, x: px, y: py, rawX, rawY });
    }
  };

  const handleMove = (e) => {
    pendingPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (rafIdRef.current != null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      if (pendingPointerRef.current) processPointer(pendingPointerRef.current);
    });
  };

  // Метка времени точки наведения (факт или pred) — используется и тултипом, и
  // выделением на шкале времени. Принимает hover-подобный объект параметром (не
  // только состояние hover), чтобы её же можно было применить к дефолтной
  // "последняя свеча" точке мобильной ИП-плашки, когда ничего не наведено.
  const tsFor = (h) => {
    if (!h) return null;
    if (h.c) return h.c.ts ?? null;
    const lastTs = candles[candles.length - 1]?.ts;
    return lastTs != null && h.pred ? lastTs + h.pred.horizon * intervalMinutes * 60000 : null;
  };
  const hoverTs = tsFor(hover);

  // Низ видимой части графика (свечи + volume, если включён) — вплотную к
  // этой границе, без зазора, тянется вертикальная линия наведения и сидит
  // выделение на шкале времени (симметрично оси Y, которая стартует от W-padR).
  const plotBottom = H - padB;

  const basePrice = candles[0].open;
  const baseY = yAt(basePrice);

  const closePath = useMemo(() => candles.map((c, i) =>
    `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(c.close)}`
  ).join(" "), [candles, padL, xStep, chartT, chartB, minP, maxP]);

  const closeArea = useMemo(() => closePath +
    ` L ${xAt(candles.length - 1)} ${baseY} L ${xAt(0)} ${baseY} Z`,
    [closePath, candles.length, padL, xStep, baseY]);

  // Тела/фитили свечей + бары объёма — useMemo — на 1Y/ALL (до ~1500 свечей)
  // самый тяжёлый кусок разметки, ре-рендерился на каждое наведение курсора,
  // хотя от hover ничего здесь не зависит.
  // ── Tooltip content — общие строки (дата/время, Price, OHLCV), переиспользуются
  // и десктопным плавающим тултипом, и мобильной статичной плашкой под panel-head
  // (см. .chart-tip-mobile ниже — на мобилке ИП больше не перекрывает график).
  const LABEL_W = 42;
  const labelStyle = (color) => ({
    color, fontFamily: "var(--mono-d)", letterSpacing: "0.08em",
    display: "inline-block", width: LABEL_W, flexShrink: 0,
  });

  // Верхняя строка: дата слева (белым), время справа (нейтральный серый, не тусклый)
  const dateTimeRow = (dt, fallback) => (
    <div style={{display:"flex", justifyContent:"space-between", fontSize:10, marginBottom:6}}>
      {dt ? (
        <>
          <span style={{color:"var(--text)"}}>{dt.date}</span>
          <span style={{color:"var(--text-2)"}}>{dt.time}</span>
        </>
      ) : (
        <span style={{color:"var(--text-2)"}}>{fallback}</span>
      )}
    </div>
  );

  // h — hover-подобный объект { idx, c, ph, pred }; требует h.c || h.pred. Принимает
  // его параметром (не берёт hover из замыкания), чтобы мобильная ИП-плашка могла
  // рендерить либо реальный hover, либо дефолтную точку "последняя свеча".
  const renderTipRows = (h) => {
    const ts = tsFor(h);
    if (h.pred) {
      const targetMs = h.pred.horizon * intervalMinutes * 60000;
      const dt = ts != null ? fmtTooltipDateTime(ts) : null;
      const predDelta    = h.pred.mid - basePrice;
      const predDeltaPct = (predDelta / basePrice) * 100;
      return (
        <>
          {dateTimeRow(dt, `T+${targetMs / 60000}m`)}
          {showPredInfo && (
            <div style={{display:"flex", alignItems:"center", fontSize:11, whiteSpace:"nowrap"}}>
              <span style={labelStyle("var(--color-cian)")}>Price:</span>
              <span style={{fontFamily:"var(--mono-n)", color:"var(--color-cian)", marginLeft:6}}>${fmt(h.pred.mid, 2)}</span>
              <span style={{color:"var(--color-cian)", marginLeft:8}}>
                {predDelta >= 0 ? "▲" : "▼"} {Math.abs(predDeltaPct).toFixed(2)}%
              </span>
            </div>
          )}
          {showCI && h.pred.lo < h.pred.hi && (
            <div style={{ display:"flex", alignItems:"center", fontSize:11, marginTop:3 }}>
              <span style={labelStyle("rgba(77,124,255,1)")}>CI:</span>
              <span style={{fontFamily:"var(--mono-n)", color:"var(--text)", marginLeft:6}}>
                ${fmt(h.pred.lo, 0)} – ${fmt(h.pred.hi, 0)}
              </span>
            </div>
          )}
          {/* Pred-точка не несёт OHLCV — но те же строки-заголовки без значений
              держат высоту плашки одинаковой что для факта, что для прогноза;
              меняется высота только когда сам пользователь переключит o/h/l/v. */}
          {ohlcvParams.filter(p => shownParams.includes(p.key)).map(p => (
            <div key={p.key} style={{ display:"flex", alignItems:"center", fontSize:11, marginTop:3 }}>
              <span style={labelStyle(p.color)}>{p.key}:</span>
            </div>
          ))}
        </>
      );
    }

    const delta    = h.c.close - basePrice;
    const deltaPct = (delta / basePrice) * 100;
    const dt = ts != null ? fmtTooltipDateTime(ts) : null;
    return (
      <>
        {dateTimeRow(dt, `T−${(candles.length - h.idx) * intervalMinutes}m`)}
        <div style={{display:"flex", alignItems:"center", fontSize:11, whiteSpace:"nowrap"}}>
          <span style={labelStyle("var(--text-2)")}>Price:</span>
          <span style={{fontFamily:"var(--mono-n)", color:"var(--text)", marginLeft:6}}>${fmt(h.c.close, 2)}</span>
          <span className={delta >= 0 ? "pos" : "neg"} style={{marginLeft:8}}>
            {delta >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(2)}%
          </span>
          {showPredInfo && h.ph && (
            h.ph.hit
              ? <img src="/hit.png" alt="hit" style={{width:13, height:13, marginLeft:8, verticalAlign:"middle", flexShrink:0}} />
              : <span style={{color:"var(--color-vio)", marginLeft:8, flexShrink:0}} title="прогноз относительно факта">
                  {h.ph.predicted >= h.c.close ? "▲" : "▼"} {fmt(Math.abs(h.ph.predicted - h.c.close), 0)}$
                </span>
          )}
        </div>
        {showCI && h.ph && h.ph.q10 != null && h.ph.q90 != null && (
          <div style={{ display:"flex", alignItems:"center", fontSize:11, marginTop:3 }}>
            <span style={labelStyle("rgba(77,124,255,1)")}>CI:</span>
            <span style={{fontFamily:"var(--mono-n)", color:"var(--text)", marginLeft:6}}>
              ${fmt(h.ph.q10, 0)} – ${fmt(h.ph.q90, 0)}
            </span>
          </div>
        )}
        {ohlcvParams.filter(p => shownParams.includes(p.key)).map(p => (
          <div key={p.key} style={{ display:"flex", alignItems:"center", fontSize:11, marginTop:3 }}>
            <span style={labelStyle(p.color)}>{p.key}:</span>
            <span style={{fontFamily:"var(--mono-n)", color:"var(--text)", marginLeft:6}}>{p.fmtVal(h.c)}</span>
          </div>
        ))}
      </>
    );
  };

  // Дефолтная точка мобильной ИП-плашки, когда ничего не наведено — последняя
  // фактическая свеча (см. панель ниже: она теперь открыта всегда, а не только по тапу).
  const lastIdx = candles.length - 1;
  const defaultTipHover = {
    idx: lastIdx,
    c: candles[lastIdx],
    ph: predHistoryPts.find((p) => p.i === lastIdx) ?? null,
    pred: null,
  };

  return (
    <>
      {/* Мобилка: ИП (инфо-панель наведения) переезжает сюда, под panel-head, статичным
          блоком в потоке — вместо плавающего оверлея поверх графика (который на узком
          экране неизбежно перекрывал линии/свечи под курсором). Плашка открыта всегда:
          пока ничего не наведено — показывает последнюю фактическую свечу. */}
      {isMobile && (
        <div className="chart-tip-mobile">
          {renderTipRows(hover && (hover.c || hover.pred) ? hover : defaultTipHover)}
        </div>
      )}
      <div ref={wrapRef} className="chart-wrap" style={{position:"relative", overflow:"hidden", ...(isFullscreen ? {flex:"1 1 auto", display:"flex", alignItems:"center"} : {})}}
      onPointerMove={handleMove}
      onPointerDown={handleMove}
      onPointerLeave={(e) => {
        // На тач-устройствах тап синтезирует leave сразу после отпускания пальца —
        // из-за этого подсказка появлялась на мгновение и тут же пропадала.
        // Для тача просто не прячем hover по leave; он обновится следующим тапом.
        if (e.pointerType === "touch") return;
        if (rafIdRef.current != null) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = null; }
        pendingPointerRef.current = null;
        setHover(null);
      }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio={isMobile ? "none" : "xMidYMid meet"} className="chart-svg" style={isFullscreen ? {width:"100%", height:"100%"} : {width:"100%", height:"100%"}}>
        <defs>
        <linearGradient id="baseGreen" x1="0" x2="0" y1={yAt(maxP)} y2={baseY} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--color-green)" stopOpacity="0.4" />
          <stop offset="100%" stopColor="var(--color-green)" stopOpacity="0" />
        </linearGradient>

        <linearGradient id="baseRed" x1="0" x2="0" y1={baseY} y2={yAt(minP)} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--color-red)" stopOpacity="0" />
          <stop offset="100%" stopColor="var(--color-red)" stopOpacity="0.4" />
        </linearGradient>

        {/* q10/q90 доверительный коридор — общий для future band (LAYER 4) и
            history band (LAYER 1); раньше LAYER 4 ссылался на fill="url(#predBand)"
            без единого определения этого id — заливка не рендерилась вообще.
            Цвет — тот же rgba(77,124,255,...), что уже использует свотч "CI"
            в легенде (ниже). */}
        <linearGradient id="predBand" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="rgba(77,124,255,1)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="rgba(77,124,255,1)" stopOpacity="0.18" />
        </linearGradient>
          <clipPath id="clipAbove">
            <rect x={padL} y={chartT} width={W - padL - padR} height={Math.max(0, baseY - chartT)} />
          </clipPath>
          <clipPath id="clipBelow">
            <rect x={padL} y={baseY} width={W - padL - padR} height={Math.max(0, chartB - baseY)} />
          </clipPath>
          <clipPath id="clipHistory">
            <rect x={padL} y={chartT} width={xAt(candles.length - 1) - padL} height={chartB - chartT} />
          </clipPath>
        </defs>

        {/* future zone background */}
        {showPrediction && (
          <rect
            x={xAt(candles.length - 1)} y={chartT}
            width={W - padR - xAt(candles.length - 1)} height={chartB - chartT}
            fill="rgba(77,124,255,0.04)"
          />
        )}

        {/* grid */}
        {tickVals.map((v, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={yAt(v)} y2={yAt(v)} stroke="rgba(184,184,184,0.2)" />
            {!isMobile && (
              <text x={W - padR + 8} y={yAt(v) + 3} fill="var(--text-3)" fontSize="10" fontFamily="JetBrains Mono">
                {fmt(v, 0)}
              </text>
            )}
          </g>
        ))}

        {/* time labels (desktop only; mobile uses HTML overlay below) — рисуются ДО
            выделения оси X, чтобы бейдж-подсветка нормально перекрывала их сплошным
            фоном (симметрично оси Y, где ценовые метки тоже рисуются раньше бейджа) */}
        {!isMobile && timeLabels.map((t, i) => (
          <text key={i} x={t.x} y={H - 14} textAnchor="middle" fill="var(--text-3)" fontSize={axisLabelSize} fontFamily="JetBrains Mono">
            {t.label}
          </text>
        ))}

        {/* now divider */}
        {showPrediction && (
          <line
            x1={xAt(candles.length - 1)} x2={xAt(candles.length - 1)}
            y1={chartT} y2={chartB}
            stroke="var(--color-cian)" strokeOpacity="0.3" strokeDasharray="3 3"
          />
        )}

        {/* ── LAYER 1: pred history (behind everything) ── */}
        {showPredHistory && predHistoryPts.length > 0 && (
          <g clipPath="url(#clipHistory)">
            <PredTrailLayer
              predHistoryPts={predHistoryPts}
              padL={padL} xStep={xStep} chartT={chartT} chartB={chartB}
              minP={minP} maxP={maxP} baseY={baseY}
            />
          </g>
        )}

        {/* ── LAYER 2: actual baseline fill + line — pointerEvents="none" тут же:
            closePath/closeArea это ОДИН path на все свечи (до ~5000 точек на
            ALL), а hit-testing браузера по сложному path недёшев сам по себе,
            даже когда это один DOM-узел (см. CandleLayer выше про ту же природу
            тормозов на ALL). ── */}
        {showActual && (
          <g pointerEvents="none">
            <path d={closeArea} fill="url(#baseGreen)" clipPath="url(#clipAbove)" />
            <path d={closeArea} fill="url(#baseRed)" clipPath="url(#clipBelow)" />
            <path d={closePath} fill="none" stroke="var(--color-green)" strokeWidth="1.5" clipPath="url(#clipAbove)" />
            <path d={closePath} fill="none" stroke="var(--color-red)" strokeWidth="1.5" clipPath="url(#clipBelow)" />
          </g>
        )}

        {/* baseline dotted */}
        <line
          x1={padL} x2={W - padR} y1={baseY} y2={baseY}
          stroke="rgba(255,255,255,0.45)" strokeWidth="1" strokeDasharray="1 3"
        />
          <line x1={padL} x2={padL} y1={chartT} y2={chartB} stroke="rgba(184,184,184,0.2)"/>
          <line x1={W - padR} x2={W - padR} y1={chartT} y2={chartB} stroke="rgba(184,184,184,0.2)"/>
        {/* ── LAYER 3: candlestick wicks + bodies ── */}
        <CandleLayer
          candles={candles} basePrice={basePrice}
          padL={padL} xStep={xStep} chartT={chartT} chartB={chartB}
          minP={minP} maxP={maxP} cw={cw}
          showActual={showActual} showVolume={showVolume}
          volBot={volBot} maxVol={maxVol} volH={volH}
        />

        {/* ── LAYER 3.5: past q10/q90 band — рисуется ПОСЛЕ свечей и actual-заливки
            (LAYER 2/3), не в LAYER 1 (behind everything) вместе с трейлом. Раньше
            заливка лежала за opacity-0.4 baseGreen/Red и opacity-0.75 телами свечей —
            полупрозрачный band на 0.18 под ними практически не читался, отсюда баг
            "коридор не виден для прошлых предиктов". Future band (LAYER 4) видим
            именно потому, что в future-зоне рисовать поверх нечего — здесь та же
            логика, просто применённая по эту сторону "now"-разделителя.
            Гейт — только showPredHistory (PRED): band такой же "related элемент"
            графика прогноза, как трейл-точки и будущая линия — весь визуал целиком
            прячет PRED, CI трогает только свою строку в тултипе (см. renderTipRows). ── */}
        {showPredHistory && historyBandPaths.length > 0 && (
          <g clipPath="url(#clipHistory)">
            {historyBandPaths.map((d, i) => (
              <path key={i} d={d} fill="url(#predBand)" />
            ))}
          </g>
        )}

        {/* ── LAYER 4: future prediction band + line — оба всегда вместе, пока
            showPrediction активен (т.е. пока включён PRED, см. screens.jsx) ── */}
        {showPrediction && (
          <>
            <path d={predBandPath} fill="url(#predBand)" />
            <path d={predLinePath} fill="none" stroke="var(--color-cian)" strokeWidth="1.5" strokeDasharray="4 4" />
          </>
        )}

        {/* price label — future pred end (desktop only; mobile uses HTML overlay badge) */}
        {showPrediction && !isMobile && (
          <g>
            <rect x={W - padR + 4} y={predLine[predLine.length - 1].y - 9} width="60" height="18" fill="var(--color-cian)" rx="2" />
            <text
              x={W - padR + 34} y={predLine[predLine.length - 1].y + 4}
              fill="var(--bg-base)" fontSize="11" fontFamily="JetBrains Mono" fontWeight="600" textAnchor="middle"
            >
              {fmt(predLine[predLine.length - 1].mid, 0)}
            </text>
          </g>
        )}

        {/* crosshair — линии не искажаются неравномерным масштабом мобилки, поэтому в SVG всегда */}
        {hover && (
          <g pointerEvents="none">
            <line x1={hover.x} x2={hover.x} y1={chartT} y2={plotBottom} stroke="rgba(255,255,255,0.5)" strokeDasharray="1 3" />
            <line x1={padL} x2={W - padR} y1={hover.y} y2={hover.y} stroke="rgba(255,255,255,0.5)" strokeDasharray="1 3" />
          </g>
        )}

        {/* "мячик" — SVG-circle корректен только при равномерном масштабе (десктоп, meet).
            На мобилке (preserveAspectRatio="none") он сплющивался бы по ширине — там кружок
            рисуется отдельно HTML-оверлеем ниже, вне SVG. */}
        {hover && !isMobile && (
          <g pointerEvents="none">
            {hover.c && showActual && (() => {
              const dotY = yAt(hover.c.close);
              const color = hover.c.close >= basePrice ? "var(--color-green)" : "var(--color-red)";
              return (
                <g>
                  <circle cx={xAt(hover.idx)} cy={dotY} r="8" fill={color} fillOpacity="0.15" />
                  <circle cx={xAt(hover.idx)} cy={dotY} r="5" fill="var(--bg-base)" stroke={color} strokeWidth="2" />
                  <circle cx={xAt(hover.idx)} cy={dotY} r="2" fill={color} />
                </g>
              );
            })()}
            {hover.pred && showPrediction && (() => {
              const dotY = yAt(hover.pred.mid);
              const color = "var(--color-cian)";
              return (
                <g>
                  <circle cx={xAt(hover.idx)} cy={dotY} r="8" fill={color} fillOpacity="0.15" />
                  <circle cx={xAt(hover.idx)} cy={dotY} r="5" fill="var(--bg-base)" stroke={color} strokeWidth="2" />
                  <circle cx={xAt(hover.idx)} cy={dotY} r="2" fill={color} />
                </g>
              );
            })()}
          </g>
        )}

        {/* ── выделение на оси Y: цена в точке наведения — только при hover, вплотную к графику, нейтральный цвет ── */}
        {hover && !isMobile && (() => {
          const bw = 56, bh = AXIS_BADGE_H;
          const cy = clamp(hover.y, chartT + bh / 2, chartB - bh / 2);
          return (
            <g pointerEvents="none">
              <rect x={W - padR} y={cy - bh / 2} width={bw} height={bh} fill="var(--bg-overlay)" stroke="var(--border-strong)" />
              <text x={W - padR + bw / 2} y={cy + 4} textAnchor="middle" fill="var(--text)" fontSize="11" fontFamily="JetBrains Mono">
                {fmt(priceAt(hover.y), 0)}
              </text>
            </g>
          );
        })()}

        {/* ── выделение на оси X: дата-время в точке наведения — вплотную к шкале времени, нейтральный цвет ── */}
        {hover && hoverTs != null && !isMobile && (() => {
          const bw = 132, bh = AXIS_BADGE_H;
          const cx = clamp(hover.x, padL + bw / 2, (W - padR) - bw / 2);
          return (
            <g pointerEvents="none">
              <rect x={cx - bw / 2} y={plotBottom} width={bw} height={bh} fill="var(--bg-overlay)" stroke="var(--border-strong)" />
              <text x={cx} y={plotBottom + bh / 2 + 4} textAnchor="middle" fill="var(--text)" fontSize="10" fontFamily="JetBrains Mono">
                {fmtAxisDateTime(hoverTs)}
              </text>
            </g>
          );
        })()}
      </svg>

      {/* y-axis (price) labels — на правом краю графика (mobile only), но с z-index ниже
          самого SVG (candles/линии), так что они не перекрывают линии — линии рисуются
          поверх подписей там, где пересекаются, а не наоборот, как было раньше. */}
      {isMobile && (
      <div className="chart-yaxis" style={{ zIndex: -1 }}>
        {tickVals.map((v, i) => (
          <span key={i} className="axis-label" style={{ top: `${(yAt(v) / H) * 100}%` }}>
            {fmt(v, 0)}
          </span>
        ))}
      </div>
      )}

      {/* x-axis (time) labels (mobile only) */}
      {isMobile && (
      <div className="chart-xaxis">
        {timeLabels.map((t, i) => (
          <span key={i} className="axis-label" style={{ left: `${(t.x / W) * 100}%` }}>
            {t.label}
          </span>
        ))}
      </div>
      )}

      {/* выделение оси Y (цена в точке наведения) — мобильный HTML-оверлей, вплотную к правому краю,
          тоже за линиями графика (z-index ниже svg), см. .chart-yaxis выше.
          Вертикаль на мобильном 1:1 совпадает с SVG-юнитами (контейнер ровно H px высотой),
          поэтому клэмп в SVG-координатах здесь корректен без пересчёта в реальные px. */}
      {hover && isMobile && (() => {
        const cyPct = (clamp(hover.y, chartT + AXIS_BADGE_H / 2, chartB - AXIS_BADGE_H / 2) / H) * 100;
        return (
          <div style={{
            position: "absolute", right: 0, top: `${cyPct}%`, transform: "translateY(-50%)",
            height: AXIS_BADGE_H, display: "flex", alignItems: "center", boxSizing: "border-box",
            zIndex: -1,
            background: "var(--bg-overlay)", border: "1px solid var(--border-strong)",
            color: "var(--text)", fontFamily: "var(--mono-n)", fontSize: 11,
            padding: "0 6px", whiteSpace: "nowrap", pointerEvents: "none",
          }}>
            {fmt(priceAt(hover.y), 0)}
          </div>
        );
      })()}

      {/* выделение оси X (дата-время в точке наведения) — мобильный HTML-оверлей, вплотную к шкале времени.
          По горизонтали SVG-юниты (0..W) НЕ совпадают 1:1 с реальными CSS-пикселями контейнера
          (ширина сжимается non-uniform из-за preserveAspectRatio="none") — клэмп в SVG-юнитах
          с "жёстко зашитым" половинным размером бейджа в px раньше давал вылезание за края.
          Поэтому здесь клэмпим позицию в реальных px контейнера, зная фактическую ширину бейджа. */}
      {hover && hoverTs != null && isMobile && (() => {
        const BADGE_W = 140;
        const containerW = wrapRef.current?.offsetWidth || (W * 0.3);
        const xPx  = (hover.x / W) * containerW;
        const cxPx = clamp(xPx, BADGE_W / 2, containerW - BADGE_W / 2);
        const cxPct = (cxPx / containerW) * 100;
        return (
          <div style={{
            position: "absolute", top: `${(plotBottom / H) * 100}%`, left: `${cxPct}%`, transform: "translateX(-50%)",
            width: BADGE_W, height: AXIS_BADGE_H, display: "flex", alignItems: "center", justifyContent: "center",
            boxSizing: "border-box", background: "var(--bg-overlay)", border: "1px solid var(--border-strong)",
            color: "var(--text)", fontFamily: "var(--mono-n)", fontSize: 10,
            whiteSpace: "nowrap", pointerEvents: "none",
          }}>
            {fmtAxisDateTime(hoverTs)}
          </div>
        );
      })()}

      {/* "мячик" (мобильный HTML-оверлей) — SVG-circle сплющивался бы по ширине из-за
          preserveAspectRatio="none" (масштаб X и Y на мобилке разный). left/top в процентах
          от W/H корректны и без пересчёта в px, т.к. "none" растягивает каждую ось линейно
          на всю ширину/высоту контейнера — а вот сами кружки рисуем как HTML div с
          одинаковыми width/height, поэтому они остаются круглыми независимо от масштаба. */}
      {hover && isMobile && ((hover.c && showActual) || (hover.pred && showPrediction)) && (() => {
        const isPredDot = !!hover.pred;
        const dotY  = isPredDot ? yAt(hover.pred.mid) : yAt(hover.c.close);
        const color = isPredDot ? "var(--color-cian)" : (hover.c.close >= basePrice ? "var(--color-green)" : "var(--color-red)");
        const leftPct = (xAt(hover.idx) / W) * 100;
        const topPct  = (dotY / H) * 100;
        const circle = (size, style) => (
          <div style={{
            position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)",
            width: size, height: size, borderRadius: "50%", boxSizing: "border-box", ...style,
          }} />
        );
        return (
          <div style={{ position: "absolute", left: `${leftPct}%`, top: `${topPct}%`, pointerEvents: "none" }}>
            {circle(16, { background: color, opacity: 0.15 })}
            {circle(10, { background: "var(--bg-base)", border: `2px solid ${color}` })}
            {circle(4,  { background: color })}
          </div>
        );
      })()}

      {/* predicted price badge — future pred end (mobile only; desktop uses the in-SVG badge) */}
      {showPrediction && isMobile && (
        <div
          className="chart-pred-badge"
          style={{
            left: `${(predLine[predLine.length - 1].x / W) * 100}%`,
            top: `${(predLine[predLine.length - 1].y / H) * 100}%`,
          }}
        >
          {fmt(predLine[predLine.length - 1].mid, 0)}
        </div>
      )}

      <div className="chart-legend">
        
        {showActual && (
          <span className="lg">
            <span className="swatch" style={{ background: "var(--color-green)" }} /> ACTUAL
          </span>
        )}
        {showPredHistory && (
          <>
            <span className="lg">
              <span className="swatch" style={{ background: "var(--color-cian)" }} /> PRED HIT
            </span>
            <span className="lg">
              <span className="swatch" style={{ background: "var(--violet)" }} /> PRED MISS
            </span>
          </>
        )}
        {showPrediction && (
          <span className="lg">
            <span className="swatch" style={{ background: "var(--color-cian)", borderBottom: "1px dashed var(--color-cian)" }} /> FORECAST
          </span>
        )}
        {showPredHistory && (showPrediction || historyBandPaths.length > 0) && (
          <span className="lg">
            <span className="swatch" style={{ background: "rgba(77,124,255,0.3)", height: "8px" }} /> CI
          </span>
        )}
      </div>

      {/* Десктоп: плавающий тултип у курсора. На мобилке этот же контент уже
          показан статичной плашкой над графиком (см. .chart-tip-mobile выше). */}
      {!isMobile && hover && (hover.c || hover.pred) && (() => {
        // top мгновенно следует за мышью (без transition). По умолчанию тултип
        // всегда слева от курсора; вправо — только если слева реально не хватает
        // места (а не по половине контейнера). Ширина увеличена (и строка Price
        // держится в один ряд, nowrap), чтобы 3-4-значные суммы (miss-дельта) не
        // переносили строку — раньше при фиксированной узкой ширине их могло
        // сжать на вторую строку. Позиция клэмпится в границы контейнера — как
        // плашки на осях наведения: тултип старается встать слева от курсора, но
        // не вылезает за края графика, а просто останавливается у границы, пока
        // сам курсор двигается свободно.
        const TOOLTIP_W = 268, GAP = 19, EDGE = 14, MARGIN = 4;
        const containerW = wrapRef.current?.offsetWidth || W;
        const fitsLeft   = hover.rawX - TOOLTIP_W - GAP >= 0;
        const idealLeft  = fitsLeft ? hover.rawX - TOOLTIP_W - GAP : hover.rawX + EDGE;
        const clampedLeft = clamp(idealLeft, MARGIN, containerW - TOOLTIP_W - MARGIN);

        // transition на "left" нужен ТОЛЬКО в момент смены стороны (fitsLeft
        // flip) — раньше он висел на "left" всегда, а "left" это то же самое
        // значение, что и слежение за курсором по X. При быстром свайпе новая
        // цель transition'а прилетала быстрее раз в кадр, чем 50мс успевали её
        // догнать — тултип не "лагал", а буквально не двигался с места весь
        // свайп, догоняя курсор одним прыжком только когда тот останавливался.
        // Обычное слежение теперь мгновенное, как и top; анимируется только флип.
        const justFlippedSide = tipSideRef.current !== fitsLeft;
        tipSideRef.current = fitsLeft;

        const tipStyle = {
          position: "absolute",
          width: `${TOOLTIP_W}px`,
          left: `${clampedLeft}px`,
          top: hover.rawY + "px",
          transform: "translateY(-50%)",
          transition: justFlippedSide ? "left 0.18s cubic-bezier(0.22, 1, 0.36, 1)" : "none",
          pointerEvents: "none",
        };

        return (
          <div ref={tipRef} className="chart-tip show" style={tipStyle}>
            {renderTipRows(hover)}
          </div>
        );
      })()}
      </div>
    </>
  );
}
