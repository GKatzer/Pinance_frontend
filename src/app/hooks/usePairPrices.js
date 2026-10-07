// hooks/usePairPrices.js
//
// Лёгкий REST-поллинг /candles/{symbol}/latest для Ticker — раз в 10с на все
// отслеживаемые пары. Эндпоинт уже существует и уже отдаёт open/close для
// всех 4 DISPLAY_SYMBOLS (WS-консьюмер пишет candle:{symbol} в Redis для
// каждой из них постоянно, не только для активной — см. app/ingest/binance_ws.py
// SYMBOLS в бэкенде), так что бэк тут ничего не меняет. Активная пара и так
// льётся живьём по SSE (usePriceStream) — это только для остальных трёх,
// у которых своего живого потока нет.
"use client";

import { useEffect, useState } from "react";

const API_BASE = import.meta.env.VITE_API_URL ?? "";
const POLL_MS = 10000;
// Без таймаута зависший fetch держал бы слот в лимите браузера на
// одновременные соединения per-origin — тут особенно чувствительно, это 4
// параллельных запроса на каждый тик поллинга.
const FETCH_TIMEOUT_MS = 15000;

export function usePairPrices(pairIds) {
  const [prices, setPrices] = useState({});

  useEffect(() => {
    let active = true;

    async function poll() {
      const entries = await Promise.all(pairIds.map(async (id) => {
        try {
          const res = await fetch(`${API_BASE}/candles/${encodeURIComponent(id)}/latest`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!res.ok) return [id, null];
          return [id, await res.json()];
        } catch {
          return [id, null];
        }
      }));
      if (active) setPrices(Object.fromEntries(entries));
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { active = false; clearInterval(id); };
  }, [pairIds]);

  return prices;
}
