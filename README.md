# Tokenomics

GPU inference profitability plots by [Experiential Labs](https://experientiallabs.ai).

[Open the dashboard](https://tokenomics-one-delta.vercel.app)

## Benchmark credit

Throughput and cache-hit data come from **[SemiAnalysis AgentX](https://inferencex.semianalysis.com/agentx)** and **[InferenceX](https://github.com/SemiAnalysisAI/InferenceX)**. Benchmark credit belongs to SemiAnalysis and its contributors.

This is an independent visualization, not an official SemiAnalysis product. We add GPU rental, pricing and utilization assumptions to model profitability.

## Model

The plots show revenue minus GPU rent across utilization and blended token prices. Defaults: **8 × B300, $5.50/GPU-hour, 730 hours/month**, before other operating costs.

Model-specific sources and assumptions are in [`lib/models.mjs`](lib/models.mjs). GLM-5.3 is explicitly an estimate using GLM-5.2 throughput, not a measured result.

## Run locally

```sh
npm ci
npm test
npm start
```

Open http://127.0.0.1:4319. No credentials required.
