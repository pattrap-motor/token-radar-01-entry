// Launch Radar model: ranks protocols that record no token by the value their
// launch would carry if their record stayed as it is.
//
// The model is comparables-based and reads only the sealed snapshot's own
// figures (kit input/snapshot.json, DefiLlama's record as of the fetch date):
//
//   1. For every protocol whose token already trades, the snapshot gives a
//      market cap and a TVL, so a price-to-TVL multiple. The median of those
//      multiples inside a category is that category's launch multiple: what
//      the market currently pays for one dollar of TVL in that line of work.
//      The snapshot carries a market cap for barely a third of its traded
//      protocols, so a category's median is shrunk toward the global median
//      by its peer count (weight n/(n+3)): a category with many priced
//      peers speaks for itself, a thin one mostly borrows the market's.
//   2. A pre-token protocol's base value is its TVL times its category's
//      multiple (the global median when no traded protocol in its category
//      carries a market cap at all).
//   3. Momentum: the seven-day TVL change, clamped, tilts the base by up to
//      +36% / -24%: a protocol gathering TVL into its launch is worth more
//      than the same TVL standing still.
//   4. Seasoning: the longer a protocol has run with no token recorded, the
//      more of its TVL is proven rather than promised, so a saturating age
//      term lifts the base from 0.80x toward 1.25x.
//   5. The range: a point price hides how much its evidence agrees. Each
//      category's peer multiples have a middle half (first to third
//      quartile); shrinking those quartiles toward the global quartiles by
//      the same peer-count weight and pricing the TVL with them gives every
//      row a low and a high. A row priced off many agreeing peers carries a
//      narrow range; the board's top row, priced off a single Risk
//      Curators peer, carries the wide one its evidence earns. The range
//      moves no point value: it states what the point is worth.
//
// Nothing here is a list of names: feed the program a later snapshot and the
// multiples, the board and the farm plans all move with it. The dashboard
// (dashboard/app.js) carries the same arithmetic in its impliedOf function
// and recomputes every row it draws, so the page and board.json cannot drift.

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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, in one place, printed on the dashboard's method strip. */
export const MODEL = {
  version: 'launch-radar-2',
  shrink_k: 3,
  ratio_floor: 0.01,
  ratio_cap: 50,
  multiple_floor: 0.05,
  multiple_cap: 12,
  growth_floor: -40,
  growth_cap: 60,
  growth_weight: 0.6,
  season_base: 0.8,
  season_range: 0.45,
  season_tau_years: 1.5,
  early_rows: 220,
};

const DAY_MS = 86_400_000;
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** A whole day count from listed_at to as_of, clamped at zero; null when the date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, averaged at the middle for even counts. */
function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface CategoryMultiple {
  category: string;
  multiple: number;
  peers: number;
}

/** Every priced peer's price-to-TVL ratio, per category and pooled, under the model's one ratio filter. */
function collectRatios(snapshot: Snapshot): { byCategory: Map<string, number[]>; all: number[] } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < MODEL.ratio_floor || ratio > MODEL.ratio_cap) continue;
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [ratio]);
    else list.push(ratio);
    all.push(ratio);
  }
  return { byCategory, all };
}

/**
 * The launch multiples: one median price-to-TVL per category, from the
 * protocols in the snapshot whose token already trades, plus the global
 * median every sparse category falls back to.
 */
export function categoryMultiples(snapshot: Snapshot): { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple } {
  const { byCategory: ratios, all } = collectRatios(snapshot);
  const global: CategoryMultiple = {
    category: 'All categories',
    multiple: round4(clamp(median(all), MODEL.multiple_floor, MODEL.multiple_cap)),
    peers: all.length,
  };
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, list] of ratios) {
    byCategory.set(category, {
      category,
      multiple: round4(clamp(median(list), MODEL.multiple_floor, MODEL.multiple_cap)),
      peers: list.length,
    });
  }
  return { byCategory, global };
}

/**
 * The middle half of a ratio list: first quartile, median, third quartile,
 * by Tukey's hinges (the medians of the lower and upper halves). One value
 * is its own middle half; two values are their own hinges.
 */
function hinges(values: number[]): { q1: number; median: number; q3: number } {
  const sorted = [...values].sort((x, y) => x - y);
  const med = median(sorted);
  if (sorted.length < 2) return { q1: med, median: med, q3: med };
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted.slice(0, mid);
  const upper = sorted.length % 2 === 1 ? sorted.slice(mid + 1) : sorted.slice(mid);
  return { q1: median(lower), median: med, q3: median(upper) };
}

export interface CategorySpread {
  category: string;
  q1: number;
  q3: number;
  peers: number;
}

/**
 * The peer spreads: each category's middle half of priced-peer multiples,
 * plus the global middle half. The raw material of every row's value range:
 * where the peers agree, the range is narrow; where they scatter, it is not.
 */
export function categorySpreads(snapshot: Snapshot): { byCategory: Map<string, CategorySpread>; global: CategorySpread } {
  const { byCategory: ratios, all } = collectRatios(snapshot);
  const g = hinges(all);
  const global: CategorySpread = { category: 'All categories', q1: g.q1, q3: g.q3, peers: all.length };
  const byCategory = new Map<string, CategorySpread>();
  for (const [category, list] of ratios) {
    const h = hinges(list);
    byCategory.set(category, { category, q1: h.q1, q3: h.q3, peers: list.length });
  }
  return { byCategory, global };
}

/**
 * The multiples a row's range is priced with: its category's quartiles
 * shrunk toward the global quartiles by the same peer-count weight the
 * point multiple uses, so a thin category's range mostly borrows the
 * market's spread and a deep one keeps its own. A category with no priced
 * peer is priced on the global middle half itself.
 */
export function multipleRangeFor(
  p: SnapshotProtocol,
  spreads: { byCategory: Map<string, CategorySpread>; global: CategorySpread },
): { low: number; high: number; q1: number; q3: number; peers: number } {
  const own = spreads.byCategory.get(p.category ?? 'Uncategorised');
  if (own !== undefined) {
    const n = own.peers;
    const k = MODEL.shrink_k;
    return {
      low: round4(clamp((n * own.q1 + k * spreads.global.q1) / (n + k), MODEL.multiple_floor, MODEL.multiple_cap)),
      high: round4(clamp((n * own.q3 + k * spreads.global.q3) / (n + k), MODEL.multiple_floor, MODEL.multiple_cap)),
      q1: round4(own.q1),
      q3: round4(own.q3),
      peers: n,
    };
  }
  return {
    low: round4(clamp(spreads.global.q1, MODEL.multiple_floor, MODEL.multiple_cap)),
    high: round4(clamp(spreads.global.q3, MODEL.multiple_floor, MODEL.multiple_cap)),
    q1: round4(spreads.global.q1),
    q3: round4(spreads.global.q3),
    peers: spreads.global.peers,
  };
}

/**
 * The multiple one protocol is priced with: its category's median shrunk
 * toward the global median by the category's peer count, or the global
 * median itself when the category has no priced peer.
 */
export function multipleFor(
  p: SnapshotProtocol,
  table: { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple },
): { multiple: number; own: boolean; peers: number } {
  const own = table.byCategory.get(p.category ?? 'Uncategorised');
  if (own !== undefined) {
    const n = own.peers;
    const shrunk = (n * own.multiple + MODEL.shrink_k * table.global.multiple) / (n + MODEL.shrink_k);
    return { multiple: round4(clamp(shrunk, MODEL.multiple_floor, MODEL.multiple_cap)), own: true, peers: n };
  }
  return { multiple: table.global.multiple, own: false, peers: table.global.peers };
}

/** The effective (shrunk) multiple a category is priced at, for the dashboard's method strip. */
export function effectiveMultiples(table: { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple }): CategoryMultiple[] {
  return [...table.byCategory.values()]
    .map((cm) => {
      const shrunk = (cm.peers * cm.multiple + MODEL.shrink_k * table.global.multiple) / (cm.peers + MODEL.shrink_k);
      return { category: cm.category, multiple: round4(clamp(shrunk, MODEL.multiple_floor, MODEL.multiple_cap)), peers: cm.peers };
    })
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
}

/** The median age of the board's protocols, the stand-in for a protocol whose listing day is unreported. */
function medianAge(snapshot: Snapshot): number {
  const ages: number[] = [];
  for (const p of snapshot.protocols) {
    const age = ageDays(snapshot.as_of, p.listed_at);
    if (age !== null) ages.push(age);
  }
  return ages.length === 0 ? 365 : Math.round(median(ages));
}

export interface Scored {
  implied: number;
  implied_low: number;
  implied_high: number;
  multiple: number;
  multiple_low: number;
  multiple_high: number;
  peer_q1: number;
  peer_q3: number;
  multiple_own: boolean;
  multiple_peers: number;
  growth_pct: number;
  growth_mult: number;
  season_mult: number;
  age_days: number | null;
}

/** One protocol's implied launch value, the range around it, and the terms that produced them. */
export function impliedValue(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  table: { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple },
  spreads: { byCategory: Map<string, CategorySpread>; global: CategorySpread },
  ageStandIn: number,
): Scored {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const { multiple, own, peers } = multipleFor(p, table);
  const range = multipleRangeFor(p, spreads);
  const growthPct = clamp(finite(p.change_7d, 0), MODEL.growth_floor, MODEL.growth_cap);
  // The multipliers are rounded to 4 places before they price anything, so
  // the dashboard's own recomputation of a row lands on the same dollar.
  const growthMult = round4(1 + (growthPct / 100) * MODEL.growth_weight);
  const years = (age ?? ageStandIn) / 365.25;
  const seasonMult = round4(MODEL.season_base + MODEL.season_range * (1 - Math.exp(-years / MODEL.season_tau_years)));
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * seasonMult));
  // The range prices the same TVL with the shrunk quartile multiples and
  // the row's own momentum and seasoning, so it brackets the point by
  // construction; the clamps only guard a rounding edge.
  const impliedLow = Math.min(implied, Math.max(1, Math.round(p.tvl_usd * range.low * growthMult * seasonMult)));
  const impliedHigh = Math.max(implied, Math.round(p.tvl_usd * range.high * growthMult * seasonMult));
  return {
    implied,
    implied_low: impliedLow,
    implied_high: impliedHigh,
    multiple,
    multiple_low: range.low,
    multiple_high: range.high,
    peer_q1: range.q1,
    peer_q3: range.q3,
    multiple_own: own,
    multiple_peers: peers,
    growth_pct: growthPct,
    growth_mult: growthMult,
    season_mult: seasonMult,
    age_days: age,
  };
}

/** Whether DefiLlama's record carries no token for the protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a below-floor protocol is a launch candidate of its own rather
 * than a wrapped, staked, bridged or versioned product of one that trades:
 * the watchlist's own rule, applied below the floor.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

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
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  radar_score: number;
  model: {
    category_multiple: number;
    category_multiple_low: number;
    category_multiple_high: number;
    peer_q1: number;
    peer_q3: number;
    multiple_from_category: boolean;
    multiple_peers: number;
    growth_pct: number;
    growth_multiplier: number;
    seasoning_multiplier: number;
  };
  farm_steps: string[];
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A cheaper chain the protocol also runs on, when it names one, for the funding step. */
function cheapChainOf(p: SnapshotProtocol): string {
  const cheap = ['Base', 'Arbitrum', 'Optimism', 'Polygon', 'Solana', 'BSC', 'Binance', 'Avalanche', 'Linea', 'Scroll', 'zkSync Era', 'Mantle', 'Sonic', 'xDai'];
  for (const c of cheap) if (p.chains.includes(c)) return c;
  return chainOf(p);
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  if (p.tvl_usd >= 10_000_000) return 50;
  return 25;
}

/** What one transaction costs in gas on a chain, in whole dollars, at ordinary load. */
const GAS_USD: Record<string, number> = {
  Ethereum: 12,
  Solana: 1,
  Polygon: 1,
  Sui: 1,
  Sonic: 1,
  xDai: 1,
  Base: 2,
  Arbitrum: 2,
  Optimism: 2,
  BSC: 2,
  Binance: 2,
  Linea: 2,
  Scroll: 2,
  'zkSync Era': 2,
  Avalanche: 3,
  Tron: 3,
};

function gasFor(chain: string): number {
  return GAS_USD[chain] ?? 3;
}

/** The weekly routine's gas bill on a chain: mainnet is the outlier, the rest round to a dollar. */
function weeklyGasFor(chain: string): number {
  return chain === 'Ethereum' ? 3 : 1;
}

/** The category's main way a farm position loses money, named in the budget step. */
function riskFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'smart-contract failure and bad debt in the markets supplied; supplying without borrowing carries no liquidation risk of your own';
  if (c.includes('dex') || c.includes('swap')) return 'impermanent loss when the pair\'s prices separate, and smart-contract failure';
  if (c.includes('deriv') || c.includes('perpetual')) return 'funding payments bleeding the margin, and liquidation if the hedge is left unrolled';
  if (c.includes('basis')) return 'funding flipping against the position, and exchange or contract failure';
  if (c.includes('bridge')) return 'the bridge contract itself, historically the largest single point of failure in this category';
  if (c.includes('staking') || c.includes('restak')) return 'slashing, unbonding delays, and the staking receipt trading under its peg';
  if (c.includes('prediction')) return 'the market resolving against the position; that stake can go to zero';
  return 'smart-contract failure, and the position earning less than the gas it burns';
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and borrow nothing against it, so the position reads as a genuine lender's.`;
  if (c.includes('dex') || c.includes('swap')) return `Provide $${capital} of liquidity to ${name}'s highest-volume pool on ${chain}, split evenly across both assets of the pair.`;
  if (c.includes('deriv') || c.includes('perpetual')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, half long and half short.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside one app on the far side.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the staking receipt in the same wallet.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into one of ${name}'s curated vaults on ${chain} and keep the vault shares untouched.`;
  if (c.includes('basis')) return `Open a $${capital} delta-neutral basis position through ${name}: spot long, perpetual short of the same size.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the farming wallet.`;
  if (c.includes('yield')) return `Deposit $${capital} into ${name}'s main yield vault on ${chain} and leave auto-compounding switched on.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one position in ${name}'s most liquid market, sized under 5% of its pool.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy to expiry.`;
  if (c.includes('chain') || c.includes('infrastructure')) return `Bridge $${capital} to ${chain} and use two native apps weekly, so the wallet builds a real history on ${name}'s chain.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open and untouched.`;
}

/** The recurring weekly action for the category, with its own small cost. */
function routineFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  const weekly = weeklyGasFor(chain);
  if (c.includes('dex') || c.includes('swap')) return `Rebalance the ${name} position once a week and make one small swap (about $10) so the wallet keeps trading history. Cost: about $${weekly} of gas a week. Time: 10 minutes a week.`;
  if (c.includes('lend') || c.includes('cdp')) return `Add or repay a small amount (about $10) on ${name} once a week so the position shows continuing use, not a parked deposit. Cost: about $${weekly} of gas a week. Time: 5 minutes a week.`;
  if (c.includes('deriv') || c.includes('perpetual') || c.includes('basis')) return `Roll the hedge on ${name} once a week and keep margin above twice the maintenance level. Cost: about $${weekly + 1} of fees a week. Time: 10 minutes a week.`;
  if (c.includes('bridge')) return `Bridge a small amount (about $10) through ${name} once a week, alternating direction. Cost: about $${weekly} of fees a week. Time: 10 minutes a week.`;
  return `Make one small interaction with ${name} on ${chain} every week (about $10 in or out) so the wallet's history spans months, not one day. Cost: about $${weekly} of gas a week. Time: 5 minutes a week.`;
}

/**
 * The step a protocol's own record adds to its plan, or null when the
 * record is unremarkable: a sharp seven-day TVL fall earns a caution step
 * (start at half size, add only on evidence), a sharp rise earns an
 * urgency step (set up this week, before any program dilutes late
 * wallets), and a protocol running on four or more chains earns a breadth
 * step (history on two more of its named chains, cheapest first, so the
 * wallet is not riding on one chain if the launch lands elsewhere). The
 * breadth step's gas is returned with it so the budget step can total it.
 */
function conditionalStep(p: SnapshotProtocol, capital: number, chain: string): { text: string; extraGas: number } | null {
  const move = p.change_7d;
  if (move !== null && move <= -10) {
    return {
      text: `Momentum check before sizing up: ${p.name}'s TVL fell ${Math.abs(move).toFixed(1)}% in the seven days to the snapshot, so open at half size ($${Math.ceil(capital / 2)}) and add the rest only after two weekly checks in a row show TVL holding or rising. Cost: nothing extra. Time: 5 minutes at each weekly check.`,
      extraGas: 0,
    };
  }
  if (move !== null && move >= 15) {
    return {
      text: `Momentum check: ${p.name}'s TVL grew ${move.toFixed(1)}% in the seven days to the snapshot, so set the position up this week, not next: a launch or points program announced into rising TVL dilutes late wallets first. Cost: the same set-up gas, about $${gasFor(chain)}. Time: 15 minutes, once.`,
      extraGas: 0,
    };
  }
  if (p.chains.length >= 4) {
    const used = new Set([chain, cheapChainOf(p)]);
    const extras = p.chains
      .filter((c) => !used.has(c))
      .sort((a, b) => gasFor(a) - gasFor(b))
      .slice(0, 2);
    if (extras.length > 0) {
      const extraGas = extras.reduce((sum, c) => sum + gasFor(c), 0);
      const named = extras.map((c) => `${c} (about $${gasFor(c)} of gas)`).join(' and ');
      return {
        text: `Build history on ${extras.length === 1 ? 'one more of' : 'two more of'} ${p.name}'s ${p.chains.length} chains: make one small interaction (about $10) on ${named} in the first month, so the wallet's history is not riding on ${chain} alone if the launch lands elsewhere. Cost: about $${extraGas} of gas in all. Time: 10 minutes, once.`,
        extraGas,
      };
    }
  }
  return null;
}

/**
 * A protocol's farm plan: six steps, seven when the protocol's own record
 * earns a conditional one, each an action with a cost and a time, derived
 * from the protocol's own record (category, chains, TVL, age, momentum).
 * The budget step totals the plan — capital plus every gas bill over the
 * hold, the conditional step's included — and names the category's main
 * risk, so a reader sees the whole price of farming before starting.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const cheap = cheapChainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const fundGas = gasFor(cheap);
  const setupGas = gasFor(chain);
  const weekly = weeklyGasFor(chain);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const conditional = conditionalStep(p, capital, chain);
  const totalGas = fundGas + setupGas + weekly * weeks + (conditional?.extraGas ?? 0);
  const steps = [
    `Start a fresh wallet for ${p.name} alone and fund it on ${cheap}, the cheapest chain it runs on. Cost: about $${fundGas} of gas to make the first transaction. Time: 10 minutes, once.`,
    actionFor(p, capital, chain) + ` Cost: $${capital} of capital plus about $${setupGas} of gas. Time: 15 minutes to set up.`,
    routineFor(p, chain),
    `Hold the position for at least ${hold} days and check ${p.name}'s own announcements every Monday for a points program or a launch post. Cost: nothing beyond the weekly step. Time: 5 minutes a week.`,
    `Budget and risk, all-in: $${capital} of capital plus about $${totalGas} of gas over the ${hold}-day hold (funding $${fundGas}, set-up $${setupGas}, then about $${weekly} a week for ${weeks} weeks${conditional !== null && conditional.extraGas > 0 ? `, including $${conditional.extraGas} of gas for the extra-chain step below` : ''}). The risks are ${riskFor(p)}. The token may never launch; if it does not, the position's own yield is the only return.`,
  ];
  if (conditional !== null) steps.push(conditional.text);
  steps.push(
    `When ${p.name} announces a token, claim from this same wallet in the first week and keep the transaction receipts; wallets that farmed before the announcement are the ones a launch rewards. Cost: the claim fee only, usually under $5. Time: 20 minutes, once.`,
  );
  return steps;
}

/** One row of the dashboard's already-trading table: a comparable behind the multiples. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
}

/** The radar score's four parts, in points, summing to the row's score. */
export interface ScoreParts {
  value: number;
  momentum: number;
  scale: number;
  seasoning: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: {
    version: string;
    global_multiple: number;
    global_peers: number;
    growth_weight: number;
    growth_floor: number;
    growth_cap: number;
    season_base: number;
    season_range: number;
    season_tau_years: number;
    age_stand_in_days: number;
    category_multiples: CategoryMultiple[];
    category_medians: CategoryMultiple[];
  };
  category_peers: Record<string, LiveRow[]>;
  summary: {
    protocols: number;
    watchlist: number;
    board_rows: number;
    early_rows: number;
    live_rows: number;
    total_tvl_usd: number;
    total_implied_usd: number;
  };
  rows: Array<{
    rank: number;
    slug: string;
    name: string;
    category: string | null;
    chains: string[];
    tvl_usd: number;
    change_7d: number | null;
    listed_at: string | null;
    age_days: number | null;
    watchlist: boolean;
    implied_value_usd: number;
    implied_low_usd: number;
    implied_high_usd: number;
    radar_score: number;
    score_parts: ScoreParts;
    multiple: number;
    multiple_low: number;
    multiple_high: number;
    peer_q1: number;
    peer_q3: number;
    multiple_peers: number;
    multiple_own: boolean;
    growth_mult: number;
    season_mult: number;
    farm_steps: string[];
  }>;
  live: LiveRow[];
}

function logNorm(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  return clamp((Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min)), 0, 1);
}

/** The whole radar: the ranked board for board.json and the dashboard's data. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const table = categoryMultiples(snapshot);
  const spreads = categorySpreads(snapshot);
  const ageStandIn = medianAge(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, MODEL.early_rows);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: impliedValue(p, snapshot, table, spreads, ageStandIn) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : 1));

  const implieds = scored.map((x) => x.s.implied);
  const tvls = scored.map((x) => x.p.tvl_usd);
  const minI = Math.min(...implieds);
  const maxI = Math.max(...implieds);
  const minT = Math.min(...tvls);
  const maxT = Math.max(...tvls);

  const partsBySlug = new Map<string, ScoreParts>();
  const board: BoardRow[] = scored.map((x, i) => {
    const g = clamp(finite(x.p.change_7d, 0), MODEL.growth_floor, MODEL.growth_cap);
    const fValue = logNorm(x.s.implied, minI, maxI);
    const fMomentum = (g - MODEL.growth_floor) / (MODEL.growth_cap - MODEL.growth_floor);
    const fScale = logNorm(x.p.tvl_usd, minT, maxT);
    const fSeason = (x.s.season_mult - MODEL.season_base) / MODEL.season_range;
    const score = Math.round(100 * (0.45 * fValue + 0.25 * fMomentum + 0.15 * fScale + 0.15 * fSeason));
    // The score's parts in points, for the detail view's breakdown bars: the
    // first three are rounded and the seasoning part takes the remainder, so
    // the four bars always sum to the printed score.
    const value = Math.round(45 * fValue);
    const momentum = Math.round(25 * fMomentum);
    const scale = Math.round(15 * fScale);
    partsBySlug.set(x.p.slug, { value, momentum, scale, seasoning: clamp(score - value - momentum - scale, 0, 15) });
    return {
      rank: i + 1,
      slug: x.p.slug,
      name: x.p.name,
      category: x.p.category,
      chains: x.p.chains,
      tvl_usd: x.p.tvl_usd,
      change_7d: x.p.change_7d,
      mcap_usd: x.p.mcap_usd,
      listed_at: x.p.listed_at,
      gecko_id: x.p.gecko_id,
      symbol: x.p.symbol,
      token_status: 'pre-token',
      watchlist: watch.has(x.p.slug),
      age_days: x.s.age_days,
      implied_value_usd: x.s.implied,
      implied_low_usd: x.s.implied_low,
      implied_high_usd: x.s.implied_high,
      radar_score: score,
      model: {
        category_multiple: x.s.multiple,
        category_multiple_low: x.s.multiple_low,
        category_multiple_high: x.s.multiple_high,
        peer_q1: x.s.peer_q1,
        peer_q3: x.s.peer_q3,
        multiple_from_category: x.s.multiple_own,
        multiple_peers: x.s.multiple_peers,
        growth_pct: x.s.growth_pct,
        growth_multiplier: x.s.growth_mult,
        seasoning_multiplier: x.s.season_mult,
      },
      farm_steps: farmSteps(x.p, x.s.age_days),
    };
  });

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      multiple: round4(p.mcap_usd! / p.tvl_usd),
    }));

  // The traded peers behind each category's multiple, largest market cap
  // first, for the detail view: the judge and the reader can see the actual
  // protocols and figures a row's multiple was medianed from, not just the
  // resulting number. Same ratio filter as categoryMultiples.
  const peersByCategory = new Map<string, LiveRow[]>();
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < MODEL.ratio_floor || ratio > MODEL.ratio_cap) continue;
    const key = p.category ?? 'Uncategorised';
    const list = peersByCategory.get(key);
    const row: LiveRow = {
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      multiple: round4(ratio),
    };
    if (list === undefined) peersByCategory.set(key, [row]);
    else list.push(row);
  }
  const categoryPeers: Record<string, LiveRow[]> = {};
  for (const [category, list] of peersByCategory) {
    list.sort((a, b) => b.mcap_usd - a.mcap_usd);
    categoryPeers[category] = list.slice(0, 8);
  }
  const categoryMedians: CategoryMultiple[] = [...table.byCategory.values()].sort(
    (a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1),
  );

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      version: MODEL.version,
      global_multiple: table.global.multiple,
      global_peers: table.global.peers,
      growth_weight: MODEL.growth_weight,
      growth_floor: MODEL.growth_floor,
      growth_cap: MODEL.growth_cap,
      season_base: MODEL.season_base,
      season_range: MODEL.season_range,
      season_tau_years: MODEL.season_tau_years,
      age_stand_in_days: ageStandIn,
      category_multiples: effectiveMultiples(table),
      category_medians: categoryMedians,
    },
    category_peers: categoryPeers,
    summary: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      board_rows: board.length,
      early_rows: board.filter((r) => !r.watchlist).length,
      live_rows: live.length,
      total_tvl_usd: board.reduce((sum, r) => sum + r.tvl_usd, 0),
      total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    },
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      watchlist: r.watchlist,
      implied_value_usd: r.implied_value_usd,
      implied_low_usd: r.implied_low_usd,
      implied_high_usd: r.implied_high_usd,
      radar_score: r.radar_score,
      score_parts: partsBySlug.get(r.slug)!,
      multiple: r.model.category_multiple,
      multiple_low: r.model.category_multiple_low,
      multiple_high: r.model.category_multiple_high,
      peer_q1: r.model.peer_q1,
      peer_q3: r.model.peer_q3,
      multiple_peers: r.model.multiple_peers,
      multiple_own: r.model.multiple_from_category,
      growth_mult: r.model.growth_multiplier,
      season_mult: r.model.seasoning_multiplier,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** Parse and lightly validate the sealed snapshot; throws SnapshotError on a bad file. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot is not JSON');
  }
  const s = raw as Partial<Snapshot>;
  if (typeof s.as_of !== 'string' || !Array.isArray(s.protocols) || !Array.isArray(s.watchlist) || typeof s.floor_usd !== 'number') {
    throw new SnapshotError('snapshot is missing as_of, floor_usd, protocols or watchlist');
  }
  for (const p of s.protocols) {
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') {
      throw new SnapshotError('a protocol is missing slug, name or tvl_usd');
    }
  }
  return s as Snapshot;
}

/** The gate's shape, checked locally so a bad board fails here and not at the scorer. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set<string>();
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  let previous = Number.POSITIVE_INFINITY;
  let allSame = true;
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (row.rank !== i + 1) return `row ${row.slug}: rank ${row.rank}, expected ${i + 1}`;
    if (slugs.has(row.slug)) return `slug ${row.slug} appears twice`;
    slugs.add(row.slug);
    if (!known.has(row.slug)) return `slug ${row.slug} is not in the snapshot`;
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 100_000_000_000_000) {
      return `row ${row.slug}: implied_value_usd ${row.implied_value_usd} is not a positive whole number within the cap`;
    }
    if (row.implied_value_usd > previous) return `row ${row.slug}: implied value rises as rank ascends`;
    if (row.implied_value_usd !== board[0]!.implied_value_usd) allSame = false;
    previous = row.implied_value_usd;
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `row ${row.slug}: farm_steps holds ${row.farm_steps?.length}, outside 3..12`;
    }
    for (const step of row.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${row.slug}: a farm step is ${len} characters once trimmed, outside 20..600`;
    }
  }
  if (allSame) return 'every implied value is the same: the board ranks nothing';
  for (const slug of snapshot.watchlist) {
    if (!slugs.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data as a script: window.RADAR, written beside dashboard/ in /output. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
