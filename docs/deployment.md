# Deployment

## What gets deployed

`npm run build` produces `dist/`: `index.html`, one JS file, one CSS file and the images from `public/`. It is a static single-page app; nothing runs on a server. All data comes from the Pinance backend over HTTP.

## Routing contract

The browser requests API paths relative to its own origin (`VITE_API_URL` is empty), so the web server must do two things on one domain:

| Request path | Goes to |
|---|---|
| `/candles/*`, `/snapshot/*`, `/stream/*`, `/metrics/*`, `/health`, `/ready` | the backend (the same six prefixes the dev proxy forwards in `vite.config.js`) |
| everything else | static files from `dist/` |

No SPA fallback is needed: the path is always `/` and the tab lives in the query string (`?tab=perf`).

`/stream/*` is Server-Sent Events. The proxy must not buffer or time out the response: the backend sends a `ping` every 15 s and the client reconnects after 45 s of silence, so a proxy idle timeout below 45 s would cause reconnect loops.

The reference deployment uses Caddy (named in the comments of `vite.config.js`). The block below is an **illustration of the contract with placeholders; it was not run in this environment**:

```caddyfile
<your-domain> {
    root * /srv/pinance-frontend/dist
    @api path /candles/* /snapshot/* /stream/* /metrics/* /health /ready
    reverse_proxy @api <backend-host>:<backend-port> {
        flush_interval -1        # do not buffer SSE
    }
    file_server
}
```

## Variables

`VITE_*` values are substituted into the bundle at build time. To point a build at a different API, set `VITE_API_URL` before `npm run build` and rebuild. `VITE_MLFLOW_UI_URL` enables the MLflow button on the MLOps tab. See the table in the [README](../README.md#configuration).

## External requests

The only third-party requests are the Google Fonts stylesheet and font files (`fonts.googleapis.com`, `fonts.gstatic.com`), imported at the top of `globals.css`. A deployment that must not contact third parties has to self-host the three font families.

## Build facts

Measured in a clean copy with `npm ci && npm run build` (Node 26.10.0): 627 modules transformed, built in about 2 s; `dist/` is about 796 kB on disk, of which the JS is 700.10 kB (206.25 kB gzip) and the CSS 32.73 kB (7.42 kB gzip). File hashes and sizes change with every source edit.

## Health checks

Through the reverse proxy: `GET /health` returns `{"status":"ok"}` and `GET /ready` returns `{"status":"ready"}` on the public deployment. These belong to the backend; the static site has no health endpoint of its own.
