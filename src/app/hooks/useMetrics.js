// hooks/useMetrics.js
//
// Реальные rolling-метрики модели с бэка (/metrics/{symbol}/...).
// Один источник правды и для HIT RATE, и для блока
// MODEL QUALITY на page1, и для карточек на page2 (Model Performance) —
// вместо клиентской агрегации по обрезанному буферу results или рандомных
// генераторов на page2.
"use client";

import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

// Без таймаута fetch ждёт ответа сколько угодно — если один запрос зависнет
// (например, бэк перезапускается за прокси, соединение принято, но ничего
// не отвечает), он бы держал слот в лимите браузера на одновременные
// соединения per-origin, потенциально блокируя вообще все остальные запросы
// на тот же origin (SSE, другие polling-хуки) до ручной перезагрузки страницы.
const FETCH_TIMEOUT_MS = 15000;

// Общий fetch-хук: держит только последний ответ (не копит историю),
// опционально перезапрашивает по таймеру.
function useJsonFetch(url, { interval } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!url) { setData(null); setLoading(false); return; }
    let active = true;

    async function load() {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (active) { setData(json); setError(null); }
      } catch (err) {
        if (active) setError(err.message);
      } finally {
        if (active) setLoading(false);
      }
    }

    setLoading(true);
    load();
    const id = interval ? setInterval(load, interval) : null;
    return () => { active = false; if (id) clearInterval(id); };
  }, [url, interval]);

  return { data, loading, error };
}

// Rolling accuracy/MAE/RMSE по окнам 1h/24h/7d — рефетч раз в 45с (в вилке
// 30-60с, о которой договорились с бэком), не по SSE-событию, чтобы не
// городить кросс-хуковую координацию ради метрики, которая и так меняется
// медленно.
const SUMMARY_REFRESH_MS = 45000;

export function useMetricsSummary(symbol) {
  const url = symbol ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/summary` : null;
  const { data, loading, error } = useJsonFetch(url, { interval: SUMMARY_REFRESH_MS });
  return { summary: data, loading, error };
}

// Точки для спарклайнов на page2 — фетчится только пока смонтирована
// карточка/страница, без постоянного поллинга.
export function useMetricsHistory(symbol, metric, window = "24h", bucket = "1h") {
  const url = symbol
    ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/history?metric=${metric}&window=${window}&bucket=${bucket}`
    : null;
  const { data, loading } = useJsonFetch(url);
  return { history: data, loading };
}

export function useMetricsErrors(symbol, window = "24h", bins = 24) {
  const url = symbol
    ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/errors?window=${window}&bins=${bins}`
    : null;
  const { data, loading } = useJsonFetch(url);
  return { errors: data, loading };
}

export function useMetricsScatter(symbol, window = "24h", limit = 200) {
  const url = symbol
    ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/scatter?window=${window}&limit=${limit}`
    : null;
  const { data, loading } = useJsonFetch(url);
  return { scatter: data, loading };
}

// q10_coverage/q90_coverage по тем же SUMMARY_WINDOWS — фактическая доля
// actual_price ниже заявленных квантилей, для карточки Quantile Coverage
// на page2. Тот же рефетч-интервал, что у summary — обе окна одного размера.
export function useMetricsCoverage(symbol) {
  const url = symbol ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/coverage` : null;
  const { data, loading, error } = useJsonFetch(url, { interval: SUMMARY_REFRESH_MS });
  return { coverage: data, loading, error };
}

// Coverage/ширина корзины по бакетам — для тренд-карточки Coverage Over Time
// на page2. Фетчится только пока смонтирована карточка, без поллинга — тот
// же принцип, что у useMetricsHistory.
export function useMetricsCoverageHistory(symbol, window = "24h", bucket = "1h") {
  const url = symbol
    ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/coverage_history?window=${window}&bucket=${bucket}`
    : null;
  const { data, loading } = useJsonFetch(url);
  return { coverageHistory: data, loading };
}

// Распределение ширины квантильной корзины (price_q90 - price_q10) — зеркало
// useMetricsErrors, для карточки Interval Width Distribution на page2.
export function useMetricsWidthHistogram(symbol, window = "24h", bins = 24) {
  const url = symbol
    ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/width_histogram?window=${window}&bins=${bins}`
    : null;
  const { data, loading } = useJsonFetch(url);
  return { widthHistogram: data, loading };
}

// Последние N promote/reject-решений по обеим независимым моделям (point —
// LGBM-регрессор, quantile — доверительный коридор) — для RETRAIN TIMELINE на
// MLOps. Рефетч раз в 45с, тем же тактом, что summary/coverage — решения
// принимаются раз в 6ч (promote_if_better), 45с более чем достаточно.
export function useMetricsRetrainTimeline(symbol, limit = 8) {
  const url = symbol
    ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/retrain-timeline?limit=${limit}`
    : null;
  const { data, loading, error } = useJsonFetch(url, { interval: SUMMARY_REFRESH_MS });
  return { retrainTimeline: data, loading, error };
}

// P50/P95/P99 инференс-латенси — для INFERENCE LATENCY на MLOps. Реальный
// эндпоинт (миграция retrain_events_and_inference_ms), но свежий — до первых
// накопленных замеров отдаёт n=0/null по всем перцентилям, это не ошибка.
export function useMetricsLatency(symbol, window = "24h") {
  const url = symbol
    ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/latency?window=${window}`
    : null;
  const { data, loading, error } = useJsonFetch(url, { interval: SUMMARY_REFRESH_MS });
  return { latency: data, loading, error };
}

// PSI по куратированному набору фич — для FEATURE DRIFT на MLOps. Эндпоинта
// пока нет на бэке (нужна отдельная инфра: персист feature_snapshot на
// прогноз + сравнение с baseline из MinIO — см. README бэка, roadmap v2,
// "Drift-детекция — 2 дня"), 404 ожидаем и это не баг фронта. Хук заведён
// заранее по тому же принципу, что и остальные /metrics-хуки здесь — когда
// бэк выкатит ручку, компонент заработает без доп. правок, useJsonFetch уже
// честно прокидывает !res.ok в error.
export function useMetricsDrift(symbol) {
  const url = symbol ? `${API_BASE}/metrics/${encodeURIComponent(symbol)}/drift` : null;
  const { data, loading, error } = useJsonFetch(url, { interval: SUMMARY_REFRESH_MS });
  return { drift: data, loading, error };
}
