# Tokenomics

GPU inference profitability plots by [Experiential Labs](https://experientiallabs.ai).

[Open the dashboard](https://tokenomics-one-delta.vercel.app)

## Benchmark credit

Throughput and cache-hit data come from **[SemiAnalysis AgentX](https://inferencex.semianalysis.com/agentx)** and **[InferenceX](https://github.com/SemiAnalysisAI/InferenceX)**. Benchmark credit belongs to SemiAnalysis and its contributors.

This is an independent visualization, not an official SemiAnalysis product. We add GPU rental, pricing and utilization assumptions to model profitability.

## Model

The plots show **monthly revenue minus GPU rent** across utilization and blended token prices. Choose a model, GPU and serving setup; drag the **$/GPU-hour** slider to update the chart. The x-axis also shows total tokens/month, including cached input.

The dashboard includes **8 models, 10 GPU types and 73 serving curves**; GLM-5.2 is excluded. Each curve uses its highest measured throughput meeting 50 output tokens/sec/user (p90); curves with no qualifying point are visibly marked. This is not a complete historical archive. Larger multi-node runs retain their actual GPU count. Smaller serving units are replicated to eight GPUs and labeled as replication assumptions. GLM-5.3 has its own measured results.

B300 defaults to **$5.50/GPU-hour**. Other defaults are provider list-price references checked October 3, 2026, not negotiated quotes or guaranteed availability. Vera Rubin has only a labeled SemiAnalysis rental estimate. All rates are editable and retained per GPU during the session. Sources and terms: [`lib/rental-rates.mjs`](lib/rental-rates.mjs).

TPU Ironwood and Trillium are listed as unavailable in the benchmark dropdown: Google publishes rental prices, but this AgentX snapshot has no TPU measurements. There are no invented TPU throughput curves.

Benchmark selection: [`lib/benchmarks.mjs`](lib/benchmarks.mjs). Raw public data: [`lib/agentx-snapshot.json`](lib/agentx-snapshot.json). Refresh with `node scripts/refresh-agentx.mjs`, then run tests and review any new hardware/rates. Results assume 730 hours/month, before other operating costs; measured capacity is not a demand forecast. Source links, benchmark dates and price dates are in the dashboard’s **Assumptions & sources**.

## Every catalog model: estimates

The model picker lists the models SemiAnalysis measured, then **every other model in the [Experiential catalog](https://api.experientiallabs.ai/api/models)** as an estimate. A measured model also gets estimates on GPUs SemiAnalysis did not run. Estimates are labelled on the page and in every API row (`kind: "estimate"`).

How an estimate is made ([`private/estimate.mjs`](private/estimate.mjs)):

- Fit `log(total tokens/sec/GPU) = level[GPU] + slope x log(input + output $/M)` on the best AgentX point per model and GPU (meeting 50 tok/s/user), priced from our catalog. The slope is shared; each GPU has its own level.
- Current fit: slope about -0.95 over 39 points; within a GPU it explains about 40% of the variation, and a typical estimate is off by about 2.6x. Market price is a rough proxy for serving cost, nothing more.
- A measured model on an unmeasured GPU keeps its own measured speed relative to the GPU levels, instead of the price fit.
- Input/output mix and cache share are the medians of the measured models on that GPU. Rental defaults are the same sourced rates as the measured entries.
- Embeddings and image/audio models are skipped. Closed models are estimated as if self-hostable; they are not.

`GET /api/estimates` returns the fit and the catalog the page uses.

## Reports from JSON

The same numbers (measured, else estimated) drive a JSON report over every catalog model and GPU. A scenario is a partial JSON deep-merged over [`private/default-scenario.json`](private/default-scenario.json) (`null` deletes a key):

- `fleet`: GPU count, hours per month, paid utilization, other monthly cost, fee rate.
- `gpus`: restrict to some AgentX GPUs and override rates, e.g. `{"gpus":{"h100":{"hourlyRate":2}}}`. Empty means every AgentX GPU at its sourced rate.
- `models`: per slug, override `input`/`cached`/`output` prices or pin your own throughput per GPU under `gpus` (`kind: "pinned"`). See [`scenarios/pin-glm-5.3-b300.json`](scenarios/pin-glm-5.3-b300.json).
- `catalog`: `sources` (`experiential`, `huggingface`, `openrouter`), `include`/`exclude` slug patterns, `openWeightsOnly`.
- `sweep`: GPU price and utilization ranges for `?curves=1`.

```sh
curl -s -X POST 'https://tokenomics-one-delta.vercel.app/api/report?format=csv' \
  -H 'content-type: application/json' -d '{"gpus":{"h100":{"hourlyRate":2}},"fleet":{"utilization":0.3}}'
curl -s https://tokenomics-one-delta.vercel.app/api/scenario      # defaults
node report.mjs scenarios/cheap-hopper-busy.json --csv > report.csv   # files merge left to right
```

## Run locally

```sh
npm ci
npm test
npm start
```

Open http://127.0.0.1:4319. No credentials required.
