export function economics(s) {
  const totalPerGpu = s.inputTpsPerGpu + s.outputTpsPerGpu;
  const totalTps = totalPerGpu * s.gpus;
  const inputShare = totalPerGpu > 0 ? s.inputTpsPerGpu / totalPerGpu : 0;
  const blend = inputShare * ((1 - s.cacheHitRate) * s.inputPrice + s.cacheHitRate * s.cachedPrice) + (1 - inputShare) * s.outputPrice;
  const millionTokensAtFull = totalTps * s.hours * 3600 / 1e6;
  const rent = s.gpus * s.hourlyRate * s.hours;
  const fixedCost = rent + s.otherMonthlyCost;
  const receiptsAtFull = millionTokensAtFull * blend * (1 - s.feeRate);
  const revenue = millionTokensAtFull * s.utilization * blend;
  const fees = revenue * s.feeRate;
  const profit = revenue - fees - fixedCost;
  return { totalTps, inputShare, blend, millionTokensAtFull, rent, fixedCost, revenue, fees, profit,
    margin: revenue > 0 ? profit / revenue : null,
    breakEvenUtilization: receiptsAtFull > 0 ? fixedCost / receiptsAtFull : null,
    breakEvenPrice: millionTokensAtFull * s.utilization * (1 - s.feeRate) > 0
      ? fixedCost / (millionTokensAtFull * s.utilization * (1 - s.feeRate)) : null,
  };
}
export function profitAt(s, utilization, price) {
  const e = economics(s);
  return e.millionTokensAtFull * utilization * price * (1 - s.feeRate) - e.fixedCost;
}
