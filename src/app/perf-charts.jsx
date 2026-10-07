// Интерактивные графики для page2 (Model Performance) на Recharts — в отличие
// от ручных SVG в charts.jsx (PriceChart и компания, которые остаются
// как есть), тут нужны были тултипы/оси из коробки, а не кастомная отрисовка.
// PriceChart сюда специально не переносим — он сложный и уже отдельно допилен.

import { useId } from "react";
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, Cell,
  ComposedChart, Line, Scatter, ReferenceLine, XAxis, YAxis, Tooltip,
} from "recharts";
import { fmt } from "./data";

// Общий тултип для всех трёх чартов — оформление в стиле .chart-tip
// (тот же тёмный чат-бокс, что и у PriceChart), см. globals.css .rc-tooltip.
function RcTooltip({ children }) {
  return <div className="rc-tooltip">{children}</div>;
}

function ChartEmpty({ children }) {
  return (
    <div style={{
      height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "var(--mono-d)", fontSize: 11, letterSpacing: "0.08em",
      textTransform: "uppercase", color: "var(--text-3)",
    }}>
      {children}
    </div>
  );
}

// ── Тренд (спарклайн) с тултипом — Accuracy Rolling 1h / MAE Over Time / Directional Accuracy ──
export function TrendChart({ data, color = "var(--color-cian)", height = 140, valueFmt = (v) => fmt(v, 1), tsFmt }) {
  const gradId = "tc-" + useId().replace(/[^a-zA-Z0-9]/g, "");
  if (!data?.length) return null;
  // Recharts считает позиции по (rightmost X − leftmost X) — на одной точке
  // это деление на ноль (NaN на cx). Один сэмпл — это не тренд, честно
  // показываем "мало данных" вместо графика из одной несуществующей линии.
  if (data.length < 2) return <ChartEmpty>Not enough data yet</ChartEmpty>;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 6, bottom: 2, left: 6 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="ts" hide />
        <YAxis hide domain={["auto", "auto"]} />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            return (
              <RcTooltip>
                {tsFmt && <div className="rc-tooltip-t">{tsFmt(label)}</div>}
                <div style={{ color }}>{valueFmt(payload[0].value)}</div>
              </RcTooltip>
            );
          }}
        />
        <Area
          type="monotone" dataKey="value" stroke={color} strokeWidth={1.5}
          fill={`url(#${gradId})`} dot={false} isAnimationActive={false}
          activeDot={{ r: 4, fill: color, stroke: "var(--bg-base)", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── Гистограмма ошибок предсказания — Error Distribution ──
// data: [{ i, count, rangeLabel }] — rangeLabel уже посчитан на вызывающей
// стороне из bin_edges бэка, чтобы тултип показывал реальный диапазон ошибки,
// а не индекс бина.
export function ErrorHistogramChart({ data, color = "var(--violet)", height = 140 }) {
  if (!data?.length) return null;
  const center = (data.length - 1) / 2;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 6, bottom: 2, left: 6 }}>
        <XAxis dataKey="i" hide />
        <YAxis hide />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.05)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload;
            return (
              <RcTooltip>
                <div className="rc-tooltip-t">{d.rangeLabel}</div>
                <div style={{ color }}>{d.count} predictions</div>
              </RcTooltip>
            );
          }}
        />
        <Bar dataKey="count" radius={[2, 2, 0, 0]} isAnimationActive={false}>
          {data.map((d, i) => {
            const dist = Math.abs(i - center) / (center || 1);
            const fill = dist < 0.3 ? "var(--color-green)" : dist < 0.6 ? color : "var(--amber)";
            return <Cell key={i} fill={fill} fillOpacity={0.75} />;
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Quantile Coverage — target (заявленный квантиль) vs observed (реальное
// покрытие), два грида-бара на категорию. Раньше был ручной SVG-компонент
// (CalibrationChart в charts.jsx) без тултипа — та же идея, но на Recharts,
// как и остальные карточки page2. data: [{label, target, observed}]. ──
export function CoverageBarChart({ data, height = 140 }) {
  if (!data?.length) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 6, bottom: 2, left: 6 }}>
        <XAxis dataKey="label" hide />
        <YAxis hide domain={[0, 1]} />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.05)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload;
            return (
              <RcTooltip>
                <div className="rc-tooltip-t">{d.label}</div>
                <div style={{ color: "var(--color-cian)" }}>target {fmt(d.target * 100, 1)}%</div>
                <div style={{ color: "var(--color-green)" }}>observed {fmt(d.observed * 100, 1)}%</div>
              </RcTooltip>
            );
          }}
        />
        <Bar dataKey="target" fill="var(--color-cian)" fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="observed" fill="var(--color-green)" fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Coverage by Window — q10/q90-coverage сразу по всем окнам /coverage
// (1h/24h/7d/30d/all), не по одному 24h, как у CoverageBarChart выше. Раньше
// это был текстовый список строк — при пустых длинных окнах (мало истории у
// свежепромоутнутой квантильной корзины) выглядел как ничего не отрисовалось;
// ось + рефренс-линии здесь остаются на месте, даже когда часть категорий без
// бара — видно, что это график с недостающими данными, а не пустое место.
// data: [{w, q10_coverage, q90_coverage}]. ──
export function CoverageByWindowChart({ data, height = 140 }) {
  if (!data?.length) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 6, bottom: 2, left: 6 }}>
        <XAxis dataKey="w" hide />
        <YAxis hide domain={[0, 1]} />
        <ReferenceLine y={0.10} stroke="var(--color-cian)" strokeDasharray="3 3" strokeOpacity={0.5} />
        <ReferenceLine y={0.90} stroke="var(--color-green)" strokeDasharray="3 3" strokeOpacity={0.5} />
        <Tooltip
          cursor={{ fill: "rgba(255,255,255,0.05)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload;
            return (
              <RcTooltip>
                <div className="rc-tooltip-t">{d.w.toUpperCase()}</div>
                <div style={{ color: "var(--color-cian)" }}>q10 {d.q10_coverage != null ? `${fmt(d.q10_coverage * 100, 1)}%` : "--"}</div>
                <div style={{ color: "var(--color-green)" }}>q90 {d.q90_coverage != null ? `${fmt(d.q90_coverage * 100, 1)}%` : "--"}</div>
              </RcTooltip>
            );
          }}
        />
        <Bar dataKey="q10_coverage" fill="var(--color-cian)" fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="q90_coverage" fill="var(--color-green)" fillOpacity={0.7} radius={[2, 2, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Coverage Over Time — q10/q90-coverage по бакетам, две линии + пунктирные
// референсы на заявленных уровнях (0.10/0.90). В отличие от TrendChart — тут
// на бакет два значения, не одно, поэтому AreaChart с одним dataKey не подходит. ──
export function CoverageTrendChart({ data, height = 140, tsFmt }) {
  if (!data?.length) return null;
  if (data.length < 2) return <ChartEmpty>Not enough data yet</ChartEmpty>;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 6, bottom: 2, left: 6 }}>
        <XAxis dataKey="ts" hide />
        <YAxis hide domain={[0, 1]} />
        <ReferenceLine y={0.10} stroke="var(--color-cian)" strokeDasharray="3 3" strokeOpacity={0.5} />
        <ReferenceLine y={0.90} stroke="var(--color-green)" strokeDasharray="3 3" strokeOpacity={0.5} />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload;
            return (
              <RcTooltip>
                {tsFmt && <div className="rc-tooltip-t">{tsFmt(label)}</div>}
                {d.q10_coverage != null && <div style={{ color: "var(--color-cian)" }}>q10 coverage {fmt(d.q10_coverage * 100, 1)}%</div>}
                {d.q90_coverage != null && <div style={{ color: "var(--color-green)" }}>q90 coverage {fmt(d.q90_coverage * 100, 1)}%</div>}
                {d.avg_width != null && <div style={{ color: "var(--text-2)" }}>width ${fmt(d.avg_width, 0)}</div>}
              </RcTooltip>
            );
          }}
        />
        <Line
          type="monotone" dataKey="q10_coverage" stroke="var(--color-cian)" strokeWidth={1.5}
          dot={false} isAnimationActive={false} connectNulls
          activeDot={{ r: 4, fill: "var(--color-cian)", stroke: "var(--bg-base)", strokeWidth: 2 }}
        />
        <Line
          type="monotone" dataKey="q90_coverage" stroke="var(--color-green)" strokeWidth={1.5}
          dot={false} isAnimationActive={false} connectNulls
          activeDot={{ r: 4, fill: "var(--color-green)", stroke: "var(--bg-base)", strokeWidth: 2 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Actual vs Predicted — реальные значения на осях (не нормализация 0..1,
// как было у ручного SVG-варианта — Recharts сам масштабирует домен) ──
export function PredictionScatterChart({ data, color = "var(--green)", height = 140 }) {
  if (!data?.length) return null;
  const all = data.flatMap((p) => [p.actual, p.predicted]);
  const min = Math.min(...all), max = Math.max(...all);
  const pad = (max - min) * 0.05 || 1;
  const domain = [min - pad, max + pad];
  const diagonal = [{ actual: domain[0], predicted: domain[0] }, { actual: domain[1], predicted: domain[1] }];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart margin={{ top: 8, right: 10, bottom: 2, left: 6 }}>
        <XAxis type="number" dataKey="actual" domain={domain} hide />
        <YAxis type="number" dataKey="predicted" domain={domain} hide />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload;
            if (d.actual == null || d.predicted == null) return null;
            return (
              <RcTooltip>
                <div className="rc-tooltip-t">Actual ${fmt(d.actual, 0)}</div>
                <div style={{ color }}>Predicted ${fmt(d.predicted, 0)}</div>
              </RcTooltip>
            );
          }}
        />
        <Line
          data={diagonal} dataKey="predicted" stroke="var(--color-cian)"
          strokeDasharray="3 3" strokeWidth={1} dot={false} activeDot={false}
          isAnimationActive={false} legendType="none"
        />
        <Scatter data={data} dataKey="predicted" fill={color} fillOpacity={0.6} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── Band Scatter — тот же Actual vs Predicted, но точки красятся по тому,
// попал ли actual в [q10, q90] той же строки (не по величине ошибки, как у
// обычного scatter). data — тот же ответ /scatter, что уже переиспользует
// PredictionScatterChart на POINTER-блоке: q10/q90 в нём nullable —
// point-only строки (без корзины) красятся нейтральным серым, не пропадают. ──
export function BandScatterChart({ data, height = 140 }) {
  if (!data?.length) return null;
  const all = data.flatMap((p) => [p.actual, p.predicted]);
  const min = Math.min(...all), max = Math.max(...all);
  const pad = (max - min) * 0.05 || 1;
  const domain = [min - pad, max + pad];
  const diagonal = [{ actual: domain[0], predicted: domain[0] }, { actual: domain[1], predicted: domain[1] }];

  const bandColor = (d) => {
    if (d.q10 == null || d.q90 == null) return "var(--text-3)";
    return d.actual >= d.q10 && d.actual <= d.q90 ? "var(--color-green)" : "var(--color-vio)";
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart margin={{ top: 8, right: 10, bottom: 2, left: 6 }}>
        <XAxis type="number" dataKey="actual" domain={domain} hide />
        <YAxis type="number" dataKey="predicted" domain={domain} hide />
        <Tooltip
          cursor={{ stroke: "var(--border-strong)", strokeDasharray: "3 3" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const d = payload[0].payload;
            if (d.actual == null || d.predicted == null) return null;
            return (
              <RcTooltip>
                <div className="rc-tooltip-t">Actual ${fmt(d.actual, 0)}</div>
                <div style={{ color: bandColor(d) }}>Predicted ${fmt(d.predicted, 0)}</div>
                {d.q10 != null && d.q90 != null && (
                  <div style={{ color: "var(--text-2)" }}>CI ${fmt(d.q10, 0)} – ${fmt(d.q90, 0)}</div>
                )}
              </RcTooltip>
            );
          }}
        />
        <Line
          data={diagonal} dataKey="predicted" stroke="var(--color-cian)"
          strokeDasharray="3 3" strokeWidth={1} dot={false} activeDot={false}
          isAnimationActive={false} legendType="none"
        />
        <Scatter data={data} dataKey="predicted" fillOpacity={0.6} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={bandColor(d)} />)}
        </Scatter>
      </ComposedChart>
    </ResponsiveContainer>
  );
}
