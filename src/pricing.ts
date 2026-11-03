/** 本地价目基线（#53 成本账本）：USD per 1M tokens。
 *  口径纪律：这里是「估算」的唯一数据源——内置基线可随上游调价维护，
 *  用户可在 SQLite 覆盖表里逐模型改价；解析不到基线、又没有覆盖价的
 *  模型一律如实显示「—」，绝不估一个数充数。基线为发布时点的官方牌价
 *  快照（asOf 2026-11），标注在 UI 上。
 */
export interface PriceSet {
  input: number;
  cached_input: number;
  cache_write_input: number;
  output: number;
}

// 规则按顺序匹配，取第一条命中的子串规则；exact 键优先于子串规则。
// 字段含义：input=普通输入 / cached_input=缓存命中读 / cache_write_input=
// 缓存写入 / output=输出（含推理输出——主流 API 的 reasoning 计入 output 计费）。
const BASELINE_RULES: { match: string; price: PriceSet }[] = [
  { match: "claude-opus", price: { input: 15, cached_input: 1.5, cache_write_input: 18.75, output: 75 } },
  { match: "claude-sonnet", price: { input: 3, cached_input: 0.3, cache_write_input: 3.75, output: 15 } },
  { match: "claude-haiku", price: { input: 0.8, cached_input: 0.08, cache_write_input: 1, output: 4 } },
  { match: "gpt-5", price: { input: 1.25, cached_input: 0.125, cache_write_input: 0, output: 10 } },
  { match: "codex-mini", price: { input: 1.5, cached_input: 0.15, cache_write_input: 0, output: 6 } },
  { match: "deepseek-chat", price: { input: 0.28, cached_input: 0.028, cache_write_input: 0, output: 0.42 } },
  { match: "deepseek-reasoner", price: { input: 0.55, cached_input: 0.14, cache_write_input: 0, output: 2.19 } },
  { match: "glm-4", price: { input: 0.6, cached_input: 0.11, cache_write_input: 0, output: 2.2 } },
  { match: "gemini-2.5-pro", price: { input: 1.25, cached_input: 0.31, cache_write_input: 0, output: 10 } },
  { match: "gemini-2.5-flash", price: { input: 0.3, cached_input: 0.075, cache_write_input: 0, output: 2.5 } },
];

export const PRICING_AS_OF = "2026-11";

export function baselinePrice(model: string): PriceSet | null {
  const exact = BASELINE_RULES.find((r) => r.match === model);
  if (exact) return exact.price;
  const lower = model.toLowerCase();
  const rule = BASELINE_RULES.find((r) => lower.includes(r.match));
  return rule ? rule.price : null;
}

/** 估算花费：逐分量 tokens/1M × 单价求和。返回 null 表示无价可估。 */
export function estimateCost(
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
  },
  price: PriceSet,
): number {
  const m = 1e6;
  return (
    (usage.input_tokens / m) * price.input +
    (usage.cached_input_tokens / m) * price.cached_input +
    (usage.cache_write_input_tokens / m) * price.cache_write_input +
    (usage.output_tokens / m) * price.output
  );
}
