// hooks/usePriceStream.js
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useEventSource } from "./useEventSource";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export function usePriceStream(symbol) {
  const [tick, setTick] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [results, setResults] = useState([]);

  const normalized = useMemo(
    () => encodeURIComponent(symbol),
    [symbol]
  );

  // initial snapshot
  useEffect(() => {
    if (!symbol) return;

    let active = true;

    async function loadSnapshot() {
      try {
        const res = await fetch(
          `${API_BASE}/snapshot/${normalized}`,
          { signal: AbortSignal.timeout(15000) }
        );

        const data = await res.json();

        if (!active) return;

        setTick(data.last_candle);
        setPrediction(data.prediction);
        setResults(data.recent_results || []);
      } catch (err) {
        console.error("snapshot error", err);
      }
    }

    loadSnapshot();

    return () => {
      active = false;
    };
  }, [normalized, symbol]);

  const onTick = useCallback((data) => {
    setTick(data);
  }, []);

  const onPrediction = useCallback((data) => {
    setPrediction(data);
  }, []);

  const onResult = useCallback((data) => {
    setResults((prev) => [data, ...prev].slice(0, 20));
  }, []);

  const { status } = useEventSource(
    `${API_BASE}/stream/${normalized}`,
    {
      tick: onTick,
      prediction: onPrediction,
      result: onResult,
      ping: () => {},
    },
    {
      enabled: !!symbol,
    }
  );

  return {
    status,
    tick,
    prediction,
    results,
  };
}