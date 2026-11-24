const money = (value) => "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (value) => value.toLocaleString("en-US");
const short = (date) => date.slice(5).replace("-", ".");
const change = (current, previous) => previous > 0 ? (current / previous - 1) * 100 : null;
const percent = (value) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
function totals(values) {
  const sum = values.reduce((total, row) => ({ rev: total.rev + row.rev, imp: total.imp + row.imp, clk: total.clk + row.clk }), { rev: 0, imp: 0, clk: 0 });
  return { ...sum, ecpm: sum.imp > 0 ? sum.rev / sum.imp * 1e3 : null, ctr: sum.imp > 0 ? sum.clk / sum.imp * 100 : null };
}
function buildH5DailyReport(input) {
  const { runId, dates, products, totalTargets } = input;
  if (!products.length || !dates.length) return;
  if (products.some((product) => product.values.length !== dates.length || product.values.some((row) => !Number.isFinite(row.rev) || !Number.isSafeInteger(row.imp) || row.imp < 0 || !Number.isSafeInteger(row.clk) || row.clk < 0))) throw new Error("H5 日报缺少完整的本轮指标。");
  const daily = dates.map((date, index) => ({ date, ...totals(products.map((product) => product.values[index])) }));
  const aggregate = totals(products.flatMap((product) => product.values));
  const current = daily.at(-1), previous = daily.at(-2);
  const range = dates.length === 1 ? short(dates[0]) : `${short(dates[0])} - ${short(dates.at(-1))}`;
  const period = dates.length === 2 ? "两天" : dates.length === 1 ? "单日" : "区间";
  const lines = [`📊 H5业务收益综合报表 (${range})`, "", `1. ${period}核心数据概览`];
  for (const day of daily) lines.push(`${short(day.date)}：收益 ${money(day.rev)}｜展示 ${count(day.imp)}｜点击 ${count(day.clk)}｜eCPM ${day.ecpm === null ? "—" : money(day.ecpm)}｜CTR ${day.ctr === null ? "—" : day.ctr.toFixed(2) + "%"}`);
  if (dates.length > 1) {
    lines.push(`累计：收益 ${money(aggregate.rev)}｜展示 ${count(aggregate.imp)}｜点击 ${count(aggregate.clk)}｜综合 eCPM ${aggregate.ecpm === null ? "—" : money(aggregate.ecpm)}｜综合 CTR ${aggregate.ctr === null ? "—" : aggregate.ctr.toFixed(2) + "%"}`);
    const ctrChange = previous.ctr === null || current.ctr === null ? null : current.ctr - previous.ctr;
    lines.push(`日环比（${short(previous.date)} → ${short(current.date)}）：收益 ${percent(change(current.rev, previous.rev))}｜展示 ${percent(change(current.imp, previous.imp))}｜点击 ${percent(change(current.clk, previous.clk))}｜eCPM ${percent(previous.ecpm === null || current.ecpm === null ? null : change(current.ecpm, previous.ecpm))}｜CTR ${ctrChange === null ? "—" : `${ctrChange >= 0 ? "+" : ""}${ctrChange.toFixed(2)} 个百分点`}`);
  }
  const ranked = products.map((product) => ({ ...product, total: totals(product.values) })).sort((left, right) => right.total.rev - left.total.rev);
  const movements = [];
  if (previous) for (const product of ranked) {
    const before = product.values.at(-2).rev, after = product.values.at(-1).rev, delta = change(after, before);
    if (delta === null) continue;
    if (after > 200 && delta > 15) movements.push(`🟢 ${product.product}：大涨 ${percent(delta)}，收益 ${money(before)} → ${money(after)}`);
    else if (before > 500 && delta < -15) movements.push(`🔻 ${product.product}：回落 ${percent(delta)}，收益 ${money(before)} → ${money(after)}`);
  }
  lines.push("", "2. 重点产品异动分析", ...previous ? movements.length ? movements.slice(0, 5) : ["各重点产品未触发预设异动阈值。"] : ["本次为单日数据，未选择对比日。"]);
  const top = ranked.slice(0, 10);
  lines.push("", "3. 收益 Top 10 核心产品榜单", `统计周期：${dates[0]}${dates.length > 1 ? " ~ " + dates.at(-1) : ""}（按${dates.length > 1 ? "区间" : "当日"}收益降序排列）`);
  for (const [index, product] of top.entries()) lines.push(`${index + 1}. ${product.product} — ${money(product.total.rev)}${dates.length > 1 ? "（" + product.values.map((value, i) => `${short(dates[i])} ${money(value.rev)}`).join("；") + "）" : ""}`);
  const coverage = { total: totalTargets, included: products.length, excluded: totalTargets - products.length };
  if (coverage.excluded > 0) lines.push("", `统计口径：本轮完成并核对 ${coverage.included}/${coverage.total} 个产品，其余 ${coverage.excluded} 个未纳入，以上为部分统计。`);
  return { schemaVersion: 1, kind: "h5", runId, generatedAt: (/* @__PURE__ */ new Date()).toISOString(), dates, coverage, daily, totals: aggregate, top: top.map((product) => ({ product: product.product, values: product.values, total: product.total })), text: lines.join("\n") };
}
export {
  buildH5DailyReport
};
