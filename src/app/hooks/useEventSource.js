// hooks/useEventSource.js
"use client";

import { useEffect, useRef, useState } from "react";

// Бэк шлёт "ping" каждые 15с как keepalive именно на случай тишины (см.
// app/api/stream.py::_PUBSUB_TIMEOUT) — если от источника (любое событие,
// включая ping) не было вестей дольше этого, соединение фактически мертво,
// даже если браузер ни разу не вызвал onerror (проверено: зависшее без
// явной ошибки соединение — например, если Caddy держит socket открытым,
// пока бэк перезапускается — ни нативный, ни самодельный реконнект по
// onerror не заметит; раньше фронт получал "ping" и просто игнорировал его,
// хотя это ровно тот сигнал, которым бэк уже помечает "я жив"). 3x запас
// над серверным интервалом — переживает джиттер/пропущенный один ping,
// не переживает реально мёртвое соединение.
const WATCHDOG_TIMEOUT = 45000;
const WATCHDOG_CHECK_INTERVAL = 10000;

export function useEventSource(url, handlers = {}, options = {}) {
  const {
    enabled = true,
    reconnectInterval = 3000,
  } = options;

  const sourceRef = useRef(null);
  const reconnectRef = useRef(null);
  const lastActivityRef = useRef(Date.now());

  const [status, setStatus] = useState("idle");
  // idle | connecting | open | error

  useEffect(() => {
    if (!enabled || !url) return;

    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      setStatus("connecting");
      lastActivityRef.current = Date.now();

      const source = new EventSource(url, {
        withCredentials: false,
      });

      sourceRef.current = source;

      source.onopen = () => {
        setStatus("open");
        lastActivityRef.current = Date.now();
      };

      source.onerror = () => {
        setStatus("error");

        source.close();

        reconnectRef.current = setTimeout(() => {
          connect();
        }, reconnectInterval);
      };

      Object.entries(handlers).forEach(([event, handler]) => {
        source.addEventListener(event, (e) => {
          lastActivityRef.current = Date.now();
          try {
            const parsed = JSON.parse(e.data);
            handler(parsed);
          } catch (err) {
            console.error("SSE parse error:", err);
          }
        });
      });
    };

    connect();

    // Watchdog — не полагается на onerror вообще, только на факт "давно
    // ничего не приходило" (а приходить должно минимум раз в 15с — ping).
    // Форсирует полный reconnect тем же путём, что и onerror-ветка выше.
    const watchdogId = setInterval(() => {
      if (cancelled) return;
      if (Date.now() - lastActivityRef.current > WATCHDOG_TIMEOUT) {
        sourceRef.current?.close();
        if (reconnectRef.current) clearTimeout(reconnectRef.current);
        connect();
      }
    }, WATCHDOG_CHECK_INTERVAL);

    return () => {
      cancelled = true;
      clearInterval(watchdogId);

      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
      }

      if (sourceRef.current) {
        sourceRef.current.close();
      }
    };
  }, [url, enabled]);

  return {
    status,
  };
}