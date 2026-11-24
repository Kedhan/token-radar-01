// Token Radar's model (radar-2): one sealed snapshot in, one ranked board out.
//
// The board ranks every protocol the snapshot records as pre-token and rankable:
// no token on record (no market cap, no CoinGecko id, no symbol), and not a
// wrapped, staked or bridged product of a token that already trades (the
// watchlist rule's exclusions, applied to every row, not just the floor).
// That is the whole watchlist (40) plus every rankable pre-token protocol
// below the floor — 203 rows on this snapshot. Live-token protocols are kept
// apart and shown with the market's own value.
//
// Implied value follows only from the snapshot's own figures, through four
// factors the dashboard states and the page recomputes per row:
//
//   catRatio  = median(mcap_usd / tvl_usd) over live protocols in the same
//               category (n >= 3; otherwise the global median over all live
//               protocols), winsorized to [0.08, 1.20]. A category whose tokens
//               trade rich against TVL implies a richer launch; a thin one the
//               opposite. No protocol name is ever special-cased.
//   growth    = clamp(change_7d, -60, 120); growthMult = 1 + growth/100 * 0.6
//   breadth   = 1 + 0.02 * (min(chains, 8) - 1)          (1.00 - 1.14)
//   maturity  = 0.70 + 0.30 * min(age_days, 1095) / 1095  (age unknown: 365d)
//   implied   = max(1, round(tvl_usd * catRatio * growthMult * breadth * maturity))
//
// Farm plans are derived per protocol from its own record (category, first
// chain, TVL tier, age): the action, the capital, the hold and every cost and
// time. No hand-written list of names anywhere in this file.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  ratio_floor: number;
  ratio_cap: number;
  min_category_sample: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  breadth_per_chain: number;
  breadth_max_chains: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  ratio_floor: 0.08,
  ratio_cap: 1.2,
  min_category_sample: 3,
  growth_weight: 0.6,
  growth_floor: -60,
  growth_cap: 120,
  breadth_per_chain: 0.02,
  breadth_max_chains: 8,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_ratio: number;
    category_sample: number;
    growth_pct: number;
    growth_multiplier: number;
    breadth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, farm plan included verbatim. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_ratio: number;
  category_sample: number;
  growth_multiplier: number;
  breadth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's comparable: how live tokens in it trade against TVL. */
export interface CategoryComparable {
  category: string;
  sample: number;
  median_ratio: number;
}

/** Everything the dashboard needs: the board, the live set, the comparables, the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  categories: CategoryComparable[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Median of a non-empty list of finite numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * Category comparables from the live-token protocols in the snapshot: for each
 * category with at least `min_category_sample` live protocols carrying both a
 * market cap and a TVL, the median mcap/TVL, winsorized to the model's band.
 * Categories too thin to read fall back to the global median, same band.
 */
export function categoryRatios(snapshot: Snapshot, model: ModelConstants = MODEL): { byCategory: Map<string, { ratio: number; sample: number }>; global: number; table: CategoryComparable[] } {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const clamp = (r: number): number => Math.min(model.ratio_cap, Math.max(model.ratio_floor, r));
  const global = clamp(median(live.map((p) => p.mcap_usd! / p.tvl_usd)));
  const groups = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const arr = groups.get(key) ?? [];
    arr.push(p.mcap_usd! / p.tvl_usd);
    groups.set(key, arr);
  }
  const byCategory = new Map<string, { ratio: number; sample: number }>();
  const table: CategoryComparable[] = [];
  for (const [category, values] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (values.length >= model.min_category_sample) {
      const ratio = clamp(median(values));
      byCategory.set(category, { ratio, sample: values.length });
      table.push({ category, sample: values.length, median_ratio: round4(ratio) });
    }
  }
  return { byCategory, global, table };
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  ratios: { byCategory: Map<string, { ratio: number; sample: number }>; global: number },
  model: ModelConstants,
): { implied: number; ratio: number; sample: number; growthPct: number; growthMult: number; breadthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const entry = ratios.byCategory.get(protocol.category ?? 'Other');
  const ratio = round4(entry !== undefined ? entry.ratio : ratios.global);
  const sample = entry !== undefined ? entry.sample : 0;
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  // Each multiplier is rounded to 4 decimals before it is applied, so the
  // dashboard's recompute from the stored multipliers reproduces this exact
  // integer instead of a near miss.
  const growthMult = round4(1 + (growthPct / 100) * model.growth_weight);
  const breadthMult = round4(1 + model.breadth_per_chain * (Math.min(Math.max(protocol.chains.length, 1), model.breadth_max_chains) - 1));
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = round4(model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range);
  const implied = Math.max(1, Math.min(100_000_000_000_000, Math.round(protocol.tvl_usd * ratio * growthMult * breadthMult * maturityMult)));
  return { implied, ratio, sample, growthPct, growthMult, breadthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked or bridged product of another protocol, never a launch of their own. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchange names: a protocol beginning with one is that exchange's product, not a launch of its own. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** A whole word wrapped, staked or staking anywhere in the name. */
const WRAPPED_WORD = /\bwrapped\b|\bstaked\b|\bstaking\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped,
 * staked or bridged product of a protocol whose token already trades — the
 * same exclusion the watchlist rule applies, so the board never ranks a
 * bridge, a staking wrapper or an exchange's product as a token to come.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  return (
    isPreToken(p) &&
    !EXCLUDED_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name) &&
    !WRAPPED_WORD.test(p.name)
  );
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const ratios = categoryRatios(snapshot, model);
  const chosen = snapshot.protocols.filter(isRankable);
  const scored = chosen.map((p) => {
    const v = impliedValue(p, snapshot.as_of, ratios, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_ratio: round4(s.ratio),
      category_sample: s.sample,
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      breadth_multiplier: round4(s.breadthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow $20 against it and repay the loan in the same week so both sides of the market are used.`;
  if (c.includes('dex') || c.includes('amm')) return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} in a balanced pair and keep the position open.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Deposit $${capital} into ${name}'s highest-TVL vault on ${chain} and leave the yield compounding in the vault.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then deploy the bridged funds in the app it lands in.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position, then close it the same day.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one small position in a market that settles within the week.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares instead of chasing the highest APY.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the protocol's own savings vault.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it for the full qualifying window.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} for a position you already hold and keep the policy active.`;
  if (c.includes('payment')) return `Route $${capital} of real payments through ${name} on ${chain} in two separate transfers a week apart.`;
  if (c.includes('liquid')) return `Deposit $${capital} into ${name}'s liquid position on ${chain} and keep the receipt token staked in its app.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open for the full qualifying window.`;
}

/** The category's weekly qualifying action, distinct from the core action. */
function weeklyFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Each week, adjust the ${name} position once: top up $10 of collateral or repay $10 of the loan, alternating weeks.`;
  if (c.includes('dex') || c.includes('amm')) return `Each week, swap $10 through ${name} on ${chain} and, once a month, rebalance the liquidity range.`;
  if (c.includes('yield') || c.includes('leveraged farm')) return `Each week, claim the vault yield on ${name} and redeposit it instead of letting it sit idle.`;
  if (c.includes('bridge')) return `Each week, bridge $10 in each direction through ${name} so the activity reads as a real user, not a single transfer.`;
  if (c.includes('staking') || c.includes('restak')) return `Each week, restake the staking rewards ${name} pays on ${chain} instead of withdrawing them.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Each week, open and close one small $10 hedge on ${name} and never leave leverage on overnight.`;
  if (c.includes('prediction')) return `Each week, settle one small prediction on ${name} and keep the stake under $10 per market.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('risk')) return `Each week, check the ${name} vault's allocation report and move $10 between its two largest vaults.`;
  if (c.includes('stable')) return `Each week, mint $10 of the stable asset through ${name} and deposit it in the savings vault the same day.`;
  if (c.includes('rwa')) return `Each week, verify the ${name} asset's backing report and add $10 to the position when the report is fresh.`;
  if (c.includes('insurance')) return `Each week, review the ${name} cover you hold and renew or extend it before it lapses.`;
  if (c.includes('payment')) return `Each week, send one $10 payment through ${name} on ${chain} to a different counterparty than the week before.`;
  return `Each week, make one qualifying action on ${name} — a deposit, a swap, a vote or a claim — and log the transaction hash.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: `Use a fresh wallet that holds only the $${capital} you plan to farm with, and keep its seed phrase offline on paper.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyFor(p, capital, chain),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days and open ${p.name}'s own points or rewards page once a week to confirm the activity is being counted.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days, 5 minutes a week to check`,
    },
    {
      text: `When a token or claim is announced, claim only from the link ${p.name} publishes on its own page, and never pay anyone to claim for you.`,
      cost: 'no fee to check, gas only to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction hash in a farm log, then unwind in tranches and keep $5 of gas in the wallet for the exit.`,
      cost: 'about $3 of gas to exit',
      time: '10 minutes to log and unwind',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_ratio: row.model.category_ratio,
    category_sample: row.model.category_sample,
    growth_multiplier: row.model.growth_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { global, table } = categoryRatios(snapshot, model);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    categories: [{ category: 'All live tokens (fallback)', sample: 0, median_ratio: round4(global) }, ...table],
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the gate's 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
