import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// SPA. В проде статика из dist/ отдаётся Caddy, API проксируется тем же доменом.
// В dev те же относительные пути проксируются на локальный бэк (см. proxy ниже).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_DEV_API_PROXY || "http://localhost:8000";

  const apiPaths = ["/candles", "/stream", "/snapshot", "/health", "/ready", "/metrics"];
  const proxy = Object.fromEntries(
    apiPaths.map((path) => [path, { target: apiTarget, changeOrigin: true }]),
  );

  return {
    plugins: [react(), tailwindcss()],
    // host: "127.0.0.1" — без этого Vite слушает строку "localhost", а Node
    // на этой машине резолвит её в IPv6 (::1) раньше IPv4, из-за чего сервер
    // слушает только [::1]:5173 и браузер по 127.0.0.1 получает
    // ERR_CONNECTION_REFUSED, хотя dev-сервер поднялся без единой ошибки.
    server: { host: "127.0.0.1", proxy },
    build: { outDir: "dist" },
  };
});
