# Tokenomics

GPU inference profitability plots by [Experiential Labs](https://experientiallabs.ai).

[Open the dashboard](https://tokenomics-one-delta.vercel.app)

## Benchmark credit

Throughput and cache-hit data come from **[SemiAnalysis AgentX](https://inferencex.semianalysis.com/agentx)** and **[InferenceX](https://github.com/SemiAnalysisAI/InferenceX)**. Benchmark credit belongs to SemiAnalysis and its contributors.

This is an independent visualization, not an official SemiAnalysis product. We add GPU rental, pricing and utilization assumptions to model profitability.

## Model

The plots show **monthly revenue minus GPU rent** across utilization and blended token prices. Choose a model, GPU and serving setup; drag the **$/GPU-hour** slider to update the chart. The x-axis also shows total tokens/month, including cached input.

The current snapshot includes **9 models, 10 GPU types and 85 serving curves**. Each curve uses its highest measured throughput meeting 50 output tokens/sec/user (p90); curves with no qualifying point are visibly marked. This is not a complete historical archive. Larger multi-node runs retain their actual GPU count. Smaller serving units are replicated to eight GPUs and labeled as replication assumptions. GLM-5.3 now has its own measured results.

B300 defaults to **$5.50/GPU-hour**. Other defaults are provider list-price references checked October 3, 2026, not negotiated quotes or guaranteed availability. Vera Rubin has only a labeled SemiAnalysis rental estimate. All rates are editable and retained per GPU during the session. Sources and terms: [`lib/rental-rates.mjs`](lib/rental-rates.mjs).

TPU Ironwood and Trillium are listed as unavailable in the benchmark dropdown: Google publishes rental prices, but this AgentX snapshot has no TPU measurements. There are no invented TPU throughput curves.

Benchmark selection: [`lib/benchmarks.mjs`](lib/benchmarks.mjs). Raw public data: [`lib/agentx-snapshot.json`](lib/agentx-snapshot.json). Refresh with `node scripts/refresh-agentx.mjs`, then run tests and review any new hardware/rates. Results assume 730 hours/month, before other operating costs; measured capacity is not a demand forecast. Source links, benchmark dates and price dates are in the dashboard’s **Assumptions & sources**.

## Explorer: every catalog model on every GPU

[`/explorer`](https://tokenomics-one-delta.vercel.app/explorer) puts every priced model from the public catalogs on a set of GPUs and draws:

- break-even utilization for every model, one line per GPU;
- one model's monthly profit against GPU price and against utilization, one line per GPU;
- a sortable table of profit and break-even utilization per model and GPU.

Catalogs (pick any in `catalog.sources`):

| Source | API | Prices |
|---|---|---|
| `experiential` | `https://api.experientiallabs.ai/api/models` | Platform-funded lanes, in serving order (`lane: "lead"` is what Experiential charges) |
| `huggingface` | `https://router.huggingface.co/v1/models` | Hugging Face Inference Providers, open weights only |
| `openrouter` | `https://openrouter.ai/api/v1/models` | OpenRouter list price; open weights when it links a Hub repo |

Throughput, cache hit rate and GPU prices are **generic placeholders**, not measurements. Everything lives in one JSON scenario, [`private/default-scenario.json`](private/default-scenario.json):

- `workload`: input and output tokens/sec per GPU at throughput multiplier 1, plus cache hit rate.
- `gpus`: id, name, `$/GPU-hour`, and a throughput multiplier. Patch one with a map: `{"gpus":{"h100":{"hourlyRate":1.5}}}`; `null` removes a GPU.
- `fleet`: GPU count, hours per month, paid utilization, other monthly cost, fee rate.
- `models`: per-model overrides keyed by `source:slug` (or bare slug): prices, throughput, GPU count, and per-GPU measured numbers under `gpus`. See [`scenarios/measured-b300.json`](scenarios/measured-b300.json).
- `catalog`: sources, price lane (`lead`, `cheapest`, `max`), `include`/`exclude` slug patterns (`*` wildcard), `openWeightsOnly`.
- `sweep`: GPU price and utilization ranges for the curves.

Every input is a partial scenario deep-merged over the defaults, so the same JSON drives all three entry points:

```sh
# HTTP API (JSON; add ?format=csv for a spreadsheet, ?curves=1 for the curve data)
curl -s -X POST https://tokenomics-one-delta.vercel.app/api/report \
  -H 'content-type: application/json' -d '{"gpus":{"h100":{"hourlyRate":1.5}},"fleet":{"utilization":0.3}}'
curl -s https://tokenomics-one-delta.vercel.app/api/scenario   # defaults
curl -s 'https://tokenomics-one-delta.vercel.app/api/catalog?sources=experiential,huggingface'

# CLI (files merge left to right)
node report.mjs scenarios/measured-b300.json scenarios/cheap-hopper-busy.json --csv > report.csv
```

The explorer's JSON editor takes the same patch, and **Copy link** / **Copy API call** reproduce a view exactly.

**Open in the benchmark heatmap** (under the selected model in the explorer) opens the original dashboard on that catalog model and GPU with the current scenario: `/?catalog=<source:slug>&gpu=<id>#s=<scenario>`. The heatmap is unchanged; the model is one extra picker entry served by `GET /api/heatmap-model?id=<source:slug>&gpu=<id>&scenario=<json>`, labelled as generic throughput unless the scenario pins measured numbers for that GPU.

## Run locally

```sh
npm ci
npm test
npm start
```

Open http://127.0.0.1:4319. No credentials required.
