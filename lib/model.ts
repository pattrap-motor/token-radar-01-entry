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
  version: 'launch-radar-1',
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

/**
 * The launch multiples: one median price-to-TVL per category, from the
 * protocols in the snapshot whose token already trades, plus the global
 * median every sparse category falls back to.
 */
export function categoryMultiples(snapshot: Snapshot): { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple } {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (ratio < MODEL.ratio_floor || ratio > MODEL.ratio_cap) continue;
    const key = p.category ?? 'Uncategorised';
    const list = ratios.get(key);
    if (list === undefined) ratios.set(key, [ratio]);
    else list.push(ratio);
    all.push(ratio);
  }
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
  multiple: number;
  multiple_own: boolean;
  multiple_peers: number;
  growth_pct: number;
  growth_mult: number;
  season_mult: number;
  age_days: number | null;
}

/** One protocol's implied launch value and the three terms that produced it. */
export function impliedValue(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  table: { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple },
  ageStandIn: number,
): Scored {
  const age = ageDays(snapshot.as_of, p.listed_at);
  const { multiple, own, peers } = multipleFor(p, table);
  const growthPct = clamp(finite(p.change_7d, 0), MODEL.growth_floor, MODEL.growth_cap);
  // The multipliers are rounded to 4 places before they price anything, so
  // the dashboard's own recomputation of a row lands on the same dollar.
  const growthMult = round4(1 + (growthPct / 100) * MODEL.growth_weight);
  const years = (age ?? ageStandIn) / 365.25;
  const seasonMult = round4(MODEL.season_base + MODEL.season_range * (1 - Math.exp(-years / MODEL.season_tau_years)));
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * seasonMult));
  return {
    implied,
    multiple,
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
  radar_score: number;
  model: {
    category_multiple: number;
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
  if (c.includes('dex') || c.includes('swap')) return `Rebalance the ${name} position once a week and make one small swap (about $10) so the wallet keeps trading history. Cost: about $1 of gas a week. Time: 10 minutes a week.`;
  if (c.includes('lend') || c.includes('cdp')) return `Add or repay a small amount (about $10) on ${name} once a week so the position shows continuing use, not a parked deposit. Cost: about $1 of gas a week. Time: 5 minutes a week.`;
  if (c.includes('deriv') || c.includes('perpetual') || c.includes('basis')) return `Roll the hedge on ${name} once a week and keep margin above twice the maintenance level. Cost: about $2 of fees a week. Time: 10 minutes a week.`;
  if (c.includes('bridge')) return `Bridge a small amount (about $10) through ${name} once a week, alternating direction. Cost: about $1 of fees a week. Time: 10 minutes a week.`;
  return `Make one small interaction with ${name} on ${chain} every week (about $10 in or out) so the wallet's history spans months, not one day. Cost: about $1 of gas a week. Time: 5 minutes a week.`;
}

/**
 * A protocol's farm plan: five steps, each an action with a cost and a time,
 * derived from the protocol's own record (category, chains, TVL, age).
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const cheap = cheapChainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = cheap === 'Ethereum' ? 12 : 3;
  return [
    `Start a fresh wallet for ${p.name} alone and fund it on ${cheap}, the cheapest chain it runs on. Cost: about $${gas} of gas to make the first transaction. Time: 10 minutes, once.`,
    actionFor(p, capital, chain) + ` Cost: $${capital} of capital plus about $${gas} of gas. Time: 15 minutes to set up.`,
    routineFor(p, chain),
    `Hold the position for at least ${hold} days and check ${p.name}'s own announcements every Monday for a points program or a launch post. Cost: nothing beyond the weekly step. Time: 5 minutes a week.`,
    `When ${p.name} announces a token, claim from this same wallet in the first week and keep the transaction receipts; wallets that farmed before the announcement are the ones a launch rewards. Cost: the claim fee only, usually under $5. Time: 20 minutes, once.`,
  ];
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
  };
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
    radar_score: number;
    multiple: number;
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

  const scored = [...chosen.values()].map((p) => ({ p, s: impliedValue(p, snapshot, table, ageStandIn) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : 1));

  const implieds = scored.map((x) => x.s.implied);
  const tvls = scored.map((x) => x.p.tvl_usd);
  const minI = Math.min(...implieds);
  const maxI = Math.max(...implieds);
  const minT = Math.min(...tvls);
  const maxT = Math.max(...tvls);

  const board: BoardRow[] = scored.map((x, i) => {
    const g = clamp(finite(x.p.change_7d, 0), MODEL.growth_floor, MODEL.growth_cap);
    const score = Math.round(
      100 *
        (0.45 * logNorm(x.s.implied, minI, maxI) +
          0.25 * ((g - MODEL.growth_floor) / (MODEL.growth_cap - MODEL.growth_floor)) +
          0.15 * logNorm(x.p.tvl_usd, minT, maxT) +
          0.15 * ((x.s.season_mult - MODEL.season_base) / MODEL.season_range)),
    );
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
      radar_score: score,
      model: {
        category_multiple: x.s.multiple,
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
    },
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
      radar_score: r.radar_score,
      multiple: r.model.category_multiple,
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
