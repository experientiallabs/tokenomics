# Tokenomics

Public Experiential Labs inference economics plots, deployed as a Vercel project named `tokenomics`.

Production: https://tokenomics-one-delta.vercel.app

Source: https://github.com/experientiallabs/tokenomics

Vercel project: `experiential-labs/tokenomics`.

## Access

Anyone can view the website without signing in. No Google account, session cookie, API key, database connection or environment variables are required. The application serves public benchmark snapshots and hypothetical GPU rental assumptions only. It does not ingest customer usage, billing, internal spreadsheets or personal account information.

The server in `api/index.mjs` exposes an explicit asset allowlist and `GET /api/models`. Assets remain in the legacy `private/` source directory but are publicly served at their allowlisted URLs. Local configuration, source files and test fixtures are not web routes. Legacy sign-in URLs redirect to the homepage.

Keep `.env*`, `.vercel/`, `node_modules/` and local test artifacts out of Git. Never add customer data or credentials to this public-facing app. Repository visibility and website access are separate: the GitHub repository can remain private while the deployed website is public.

## Models and calculations

Add verified model definitions to `lib/models.mjs`. Each entry records per-GPU input/output throughput, cache hit rate, hardware/engine, measurement date, source URLs, reference prices and date. The UI and calculations operate on this registry rather than hardcoded model-specific formulas.

The initial model is DeepSeek V4.1 Flash on B300, using SemiAnalysis InferenceX's AgentX calculator snapshot from 2026-09-29 at 50 output tokens/sec/user, p90. The modeled 8-GPU throughput assumes linear replication. Total throughput includes input tokens, most of which hit the prefix cache. The benchmark is not evidence of production demand or guaranteed OpenRouter revenue.

Additional choices: DeepSeek V4 Pro (8-GPU vLLM FP4, September 28), GLM-5.2 (8-GPU SGLang FP4, September 11), Kimi K3 (8-GPU vLLM FP4, August 16), and an explicitly labeled GLM-5.3 estimate using the same 5.2 base-model throughput. DeepSeek Pro and Kimi use the official calculator's interpolated 50 tok/s/user p90 points, bracketed by source runs using exactly eight GPUs. GLM uses the best measured throughput meeting the target (24 sessions, 85.8 tok/s/user), rather than extrapolating beyond its throughput peak. In aggregated engines, the mirrored eight-GPU prefill/decode counts are not added together. Source IDs, raw rows, pinned calculator responses and price evidence are frozen in `tests/fixtures/` and excluded from deployment.

Cache share is copied from the official calculator, including its external-cache treatment; do not silently replace it with GPU-only cache hits or add CPU and external metrics twice. Reference prices use current single-provider input/cache/output rates, not unrelated minimum prices from different providers. Lower-price OpenRouter comparisons were selected for the benchmark mix from available endpoints with at least 1M context. DeepSeek off-peak matches StreamLake's low-price quote; the other line is the official peak rate. These are not guaranteed sell prices or six-month contracts. GLM-5.3 has current 5.3 prices but estimated 5.2 capacity, not measured 5.3 performance. No cache-write premium is assumed. First-token latency, cache offload and the age of Kimi's benchmark are disclosed under each model's sources.

Monthly revenue = total TPS × paid utilization × hours × 3600 / 1M × blended price. Blended price weights uncached input, cached input and output by the benchmark token mix. The chart shows revenue minus GPU rent, before fees and other operating costs. Six-month mode multiplies monthly results by six and assumes steady demand, prices and costs. No cloud grants or avoided internal provider costs are assumed.

The main view follows the original chart: one heatmap, break-even curve, two toggleable price references, and a monthly/six-month switch. Pointer hover shows a local tooltip and crosshairs. Click/tap pins a point; click again or Escape clears it. Keyboard users can focus the chart, inspect with arrow keys, and pin with Enter. Assumptions and source links are collapsed; there are no editable financial-input panels or extra tables. Existing spreadsheet data is not ingested or modified.

## Run and verify

```sh
npm ci
npm test
npm start
```

Open http://127.0.0.1:4319. No authentication or environment setup is needed. Tests cover anonymous access, asset boundaries, safe HTTP methods and the pinned model calculations.

Deploy from this directory with Vercel CLI, scoped to the Experiential Labs team:

```sh
vercel deploy --prod --scope experiential-labs
```

The production domain must be publicly accessible; preview deployments may retain Vercel's deployment protection. Verify the homepage, `/api/models`, all five model choices, period toggle and hover/click tooltip after deployment.
