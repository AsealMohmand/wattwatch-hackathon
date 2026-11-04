# WattWatch console

The web console for WattWatch: live power, device and node health, alerts,
energy analytics, topology, an AI assistant, insights and a model lab over the
hub's energy data. Served by `../hub/api.py`. React
19 + TypeScript, Vite, Tailwind CSS 4, react-query, recharts, React Flow.
Design notes (palette, type, layout rationale) live in `DESIGN.md`.

## Develop

```powershell
npm install
npm run dev     # http://127.0.0.1:5173, proxies /api -> VITE_API_TARGET or http://127.0.0.1:8090
```

The dev proxy needs a running API. Either:

```powershell
cd ../hub
python api.py --port 8090      # or whatever ENERGY_DB it's pointed at
```

or point the proxy elsewhere: `VITE_API_TARGET=http://127.0.0.1:8080 npm run dev`.

## Build

```powershell
npm run build    # tsc -b && vite build -> dist/
```

`python ../hub/api.py` serves the built `dist/` at `http://127.0.0.1:8080` once it exists
(SPA fallback; `/api/*` stays the real API).

## Test

```powershell
npx playwright install chromium   # once
npm run e2e                       # playwright test
```

`e2e/serve.mjs` starts its own hub API instances on ports 8091-8093 against
throwaway databases in `%TEMP%\wattwatch-e2e`, so the live `energy.db` is never
touched. It needs a Python with `../hub/requirements.txt` installed:
`python` on PATH by default, or set `WATTWATCH_PYTHON` to its path.
`WATTWATCH_E2E_DIR` moves the scratch directory. Screenshots of every page land
in `e2e/screenshots/` (gitignored).

## Layout

```
src/api/        client.ts (types + REST calls), hooks.ts (react-query), stream.ts (SSE), ai.ts (assistant, model lab)
src/lib/        format.ts, theme.ts, chartPalette.ts, topologyLayout.ts, outletContext.ts
src/components/ Shell, CommandPalette, NotificationDrawer, SiteSwitcher, UserMenu, StatusPill,
                PowerChart, DeviceChart, DeviceCard, StatCard, TopologyNodeView, ai/ (meters, chips)
src/pages/      Overview, Live, Topology, Devices, DeviceProfile, Nodes, NodeDetail, Alerts,
                Analytics (Energy), System, Settings, NotFound, ai/ (Assistant, Insights, ModelLab)
e2e/            serve.mjs (test backends), fixtures.ts, *.spec.ts
```
