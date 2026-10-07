// Pair list + formatting helpers for Pinance

export const PAIRS = [
  { id: "BTC/USDT", sym: "BTC", color: "#F7931A" },
  { id: "ETH/USDT", sym: "ETH", color: "#627EEA" },
  { id: "SOL/USDT", sym: "SOL", color: "#9945FF" },
  { id: "BNB/USDT", sym: "BNB", color: "#F3BA2F" },
];

export function fmt(n, d = 2) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

// "202608031714-7883e760" (YYYYMMDDHHMM-commit, UTC, из export_models.py) →
// { date, commit, raw }. Строка не парсится — просто отдаём raw как есть,
// вызывающая сторона решает, что показать при отсутствии/битом формате.
export function parseModelVersion(v) {
  if (!v) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})-([0-9a-f]+)$/i.exec(v);
  if (!m) return { raw: v, date: null, commit: null };
  const [, yyyy, mm, dd, hh, min, commit] = m;
  const date = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +hh, +min));
  return { raw: v, date, commit };
}
