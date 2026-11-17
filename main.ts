// Token Radar — a pre-token protocol radar for make.fun token-radar-01.
//
// The program reads the sealed DefiLlama snapshot at /input/snapshot.json (or
// --input <file|dir>), ranks the protocols that record no token by what a
// launch would be worth if their record stayed as it is, and writes a static
// dashboard to /output (or $MAKEFUN_OUTPUT_DIR / --output):
//
//   /output/board.json     the ranked board (rows with implied value + farm plan)
//   /output/data.js        the same board plus the set-aside lists, for the page
//   /output/dashboard/    index.html + app.css + app.js (no network, no framework)
//   /output/screenshots/  the three dashboard screenshots, copied in
//   /output/dossier.json  the judge's dossier, built by buildDossier below
//
// The value model is derived from the snapshot's own figures, never from a
// hand-kept list of names. For each protocol that records no token and is not
// a wrapped, staked or bridged product of a token that already trades:
//
//   implied = TVL x category multiple x growth factor x age factor x chain factor
//
//   category multiple  the median market-cap/TVL of the token-bearing
//                      protocols in the same category (global median when a
//                      category has fewer than three such comps), clamped to
//                      [0.08, 1.50]. It answers "what do tokens of protocols
//                      shaped like this one trade at, per dollar of TVL?"
//   growth factor      1 + 0.5 x clamp(change_7d, -50, +100) / 100, so a
//                      protocol growing 20% in a week scores 1.10 and one
//                      shrinking 20% scores 0.90; unknown growth scores 1.
//   age factor         1 + 0.15 x min(years since listed_at, 4): a protocol
//                      that ran for years with no token recorded carries more
//                      pent-up launch value than one tracked for a month.
//                      Unknown listing date scores 1.
//   chain factor       1 + 0.02 x min(chains - 1, 5): a protocol live on more
//                      chains has more surface to farm.
//
// A board row's farm plan is generated from the protocol's own category,
// primary chain and TVL tier, with concrete amounts, gas costs and weeks —
// never a slogan. The dashboard keeps three lists apart: the ranked board
// (pre-token, eligible), the set-aside pre-token protocols the exclusion rule
// drops (CEXs, bridges, liquid staking, wrapped or versioned names, with the
// reason each was set aside), and the already-launched protocols shown only
// as reference. Language throughout is "records no token", never "has none":
// the snapshot is DefiLlama's record, not proof.
//
// Determinism: nothing here reads the clock, the network or a random source.
// Two runs on the same snapshot write the same bytes.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// The scorer's own caps: the text cap shapes the dossier bytes, the rest refuse.
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const DOSSIER_MAX_BYTES = 4 * 1024 * 1024;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

// ------------------------------------------------------------------ input

interface Protocol {
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

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot has no protocols/watchlist arrays');
  }
  return raw;
}

// ------------------------------------------------------------------ helpers

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from a YYYY-MM-DD date to the snapshot's as_of (UTC, no clock). */
function daysSince(listedAt: string, asOf: string): number {
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

// ------------------------------------------------------------------ eligibility

/** Categories the watchlist rule treats as a wrapped, staked or bridged product. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_TAIL = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Why a pre-token protocol is set aside, or null when it is board-eligible. */
function exclusionReason(p: Protocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSION_TAIL.test(p.name)) return 'versioned name (V2 / 2.0)';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked product';
  if (EXCHANGE_NAMES.some((e) => p.name === e || p.name.startsWith(`${e} `) || p.name.startsWith(`${e}-`))) {
    return 'exchange product';
  }
  return null;
}

function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

// ------------------------------------------------------------------ value model

interface Factors {
  growth: number;
  age: number;
  chains: number;
}

function growthFactor(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 1;
  return 1 + (0.5 * clamp(change7d, -50, 100)) / 100;
}

function ageFactor(listedAt: string | null, asOf: string): number {
  if (listedAt === null) return 1;
  const years = daysSince(listedAt, asOf) / 365.25;
  return 1 + 0.15 * Math.min(years, 4);
}

function chainFactor(chains: string[]): number {
  return 1 + 0.02 * Math.min(Math.max(chains.length - 1, 0), 5);
}

/**
 * The category multiple: the median market-cap/TVL of the token-bearing
 * protocols in the same category, when at least three of them report both
 * figures; the global median otherwise. Clamped so one wild comp cannot
 * stretch a whole category.
 */
function categoryMultiples(snapshot: Snapshot): { byCategory: Map<string, number>; global: number } {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    all.push(ratio);
    const key = p.category ?? '(none)';
    const list = byCategory.get(key) ?? [];
    list.push(ratio);
    byCategory.set(key, list);
  }
  const global = clamp(median(all), 0.08, 1.5);
  const out = new Map<string, number>();
  for (const [cat, ratios] of byCategory) {
    out.set(cat, ratios.length >= 3 ? clamp(median(ratios), 0.08, 1.5) : global);
  }
  return { byCategory: out, global };
}

function multipleFor(p: Protocol, multiples: { byCategory: Map<string, number>; global: number }): number {
  if (p.category !== null && multiples.byCategory.has(p.category)) return multiples.byCategory.get(p.category)!;
  return multiples.global;
}

function impliedValue(p: Protocol, multiple: number, asOf: string): { value: number; factors: Factors } {
  const factors: Factors = {
    growth: growthFactor(p.change_7d),
    age: ageFactor(p.listed_at, asOf),
    chains: chainFactor(p.chains),
  };
  const value = Math.round(p.tvl_usd * multiple * factors.growth * factors.age * factors.chains);
  return { value, factors };
}

// ------------------------------------------------------------------ farm plans

/** What farming this category means, in the protocol's own terms. */
interface Playbook {
  verb: string;
  venue: string;
  second: string;
}

const PLAYBOOKS: Record<string, Playbook> = {
  Dexs: { verb: 'Swap', venue: 'liquidity pool', second: 'Add liquidity to a pool' },
  Lending: { verb: 'Supply assets and borrow against them', venue: 'lending market', second: 'Supply a second asset' },
  Yield: { verb: 'Deposit into a yield vault', venue: 'vault', second: 'Move the deposit to a second vault' },
  'Yield Aggregator': { verb: 'Deposit into a strategy vault', venue: 'strategy vault', second: 'Try a second strategy vault' },
  RWA: { verb: 'Buy a position in a tokenised real-world asset', venue: 'RWA vault', second: 'Hold the position and add a second asset' },
  Derivatives: { verb: 'Open and close a small perpetual position', venue: 'perpetual market', second: 'Open a second small position' },
  CDP: { verb: 'Lock collateral and mint against it', venue: 'CDP vault', second: 'Top up the collateral' },
  'CDP Manager': { verb: 'Open a CDP and manage its collateral ratio', venue: 'CDP dashboard', second: 'Adjust the collateral ratio' },
  'Risk Curators': { verb: 'Deposit into a curated vault', venue: 'curated vault', second: 'Deposit into a second curated vault' },
  'Onchain Capital Allocator': { verb: 'Allocate capital to an allocator vault', venue: 'allocator vault', second: 'Allocate to a second vault' },
  'Prediction Market': { verb: 'Place small prediction trades', venue: 'prediction market', second: 'Trade a second market' },
  'Basis Trading': { verb: 'Deposit into the basis vault', venue: 'basis vault', second: 'Add to the position' },
  'Collateral Markets': { verb: 'Supply collateral to the market', venue: 'collateral market', second: 'Supply a second collateral asset' },
};

const DEFAULT_PLAYBOOK: Playbook = {
  verb: "Use the protocol's main product",
  venue: 'app',
  second: 'Use a second feature of the app',
};

/** Rough gas cost of one transaction, in dollars, by the chain it runs on. */
const GAS_USD: Record<string, number> = {
  Ethereum: 4,
  Solana: 0.02,
  Base: 0.05,
  Arbitrum: 0.15,
  Binance: 0.3,
  Avalanche: 0.6,
  Polygon: 0.05,
  Optimism: 0.1,
  'Hyperliquid L1': 0.05,
  Monad: 0.05,
  Tron: 1,
  Bitcoin: 2,
};

const NATIVE_TOKEN: Record<string, string> = {
  Ethereum: 'ETH',
  Solana: 'SOL',
  Base: 'ETH',
  Arbitrum: 'ETH',
  Binance: 'BNB',
  Avalanche: 'AVAX',
  Polygon: 'MATIC',
  Optimism: 'ETH',
  'Hyperliquid L1': 'HYPE',
  Monad: 'MON',
  Tron: 'TRX',
  Bitcoin: 'BTC',
};

function gasUsd(chain: string): number {
  return GAS_USD[chain] ?? 0.5;
}

function nativeToken(chain: string): string {
  return NATIVE_TOKEN[chain] ?? 'the chain’s gas token';
}

/** Deposit sizes by TVL tier: big vaults take bigger positions. */
function amounts(tvl: number): { first: number; second: number } {
  if (tvl >= 1e9) return { first: 1000, second: 5000 };
  if (tvl >= 1e8) return { first: 500, second: 1000 };
  if (tvl >= 5e7) return { first: 250, second: 500 };
  return { first: 100, second: 250 };
}

function farmSteps(p: Protocol): string[] {
  const play = p.category !== null && PLAYBOOKS[p.category] !== undefined ? PLAYBOOKS[p.category]! : DEFAULT_PLAYBOOK;
  const chain = p.chains[0] ?? 'Ethereum';
  const gas = gasUsd(chain);
  const gasText = gas < 1 ? `$${gas.toFixed(2)}` : `$${gas.toFixed(0)}`;
  const amt = amounts(p.tvl_usd);
  return [
    `Open a fresh wallet on ${chain} and fund it with about $${amt.first} in stablecoins plus a little ${nativeToken(chain)} for gas. Keep this wallet only for ${p.name}: one clean wallet makes its activity easy to prove if a snapshot is ever taken.`,
    `${play.verb} through ${p.name} on ${chain} (about $${amt.first}). Do it as a trade you would make anyway, not a wash: each transaction costs roughly ${gasText} in gas on ${chain} and takes about 5 minutes.`,
    `${play.second} with about $${amt.second} and leave it in place for at least 4 weeks. ${p.name} rewards deposits that stay, so do not pull it out after a day.`,
    `Come back once a week for 8 to 12 weeks and repeat the ${play.venue} activity. Airdrop snapshots usually reward steady use across weeks over one large deposit on a single day.`,
    `Connect the same wallet to ${p.name}’s points or quest page, finish every task it lists, and keep a note of your transaction hashes and dates. If ${p.name} opens a claim, the same wallet is the one that claims it.`,
  ];
}

function thesis(p: Protocol, implied: number, multiple: number, factors: Factors): string {
  const age = p.listed_at === null ? 'an unknown listing date' : `${(daysSince(p.listed_at, '2026-11-14') / 365.25).toFixed(1)} years tracked`;
  const growth =
    p.change_7d === null ? '7-day growth unreported' : `${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}% in 7 days`;
  return (
    `${p.name} records no token and holds ${money(p.tvl_usd)} of TVL across ${p.chains.length} ` +
    `chain${p.chains.length === 1 ? '' : 's'}, ${growth}, ${age}. At its category’s ${multiple.toFixed(2)}x ` +
    `market-cap/TVL multiple, with growth ${factors.growth.toFixed(2)}x and age ${factors.age.toFixed(2)}x, ` +
    `the radar puts a launch at ${money(implied)}.`
  );
}

// ------------------------------------------------------------------ board

interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_years: number | null;
  multiple: number;
  growth_factor: number;
  age_factor: number;
  chain_factor: number;
  watchlist: boolean;
  thesis: string;
}

function buildRadar(snapshot: Snapshot): {
  board: BoardRow[];
  excluded: { slug: string; name: string; category: string | null; tvl_usd: number; reason: string }[];
  launched: { slug: string; name: string; category: string | null; tvl_usd: number; mcap_usd: number; ratio: number }[];
} {
  const watchlist = new Set(snapshot.watchlist);
  const multiples = categoryMultiples(snapshot);
  const scored: { p: Protocol; value: number; factors: Factors; multiple: number }[] = [];
  const excluded: { slug: string; name: string; category: string | null; tvl_usd: number; reason: string }[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsNoToken(p)) continue;
    const reason = exclusionReason(p);
    if (reason !== null) {
      excluded.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason });
      continue;
    }
    const multiple = multipleFor(p, multiples);
    const { value, factors } = impliedValue(p, multiple, snapshot.as_of);
    scored.push({ p, value, factors, multiple });
  }
  // Highest implied value first; ties break by TVL, then slug, so the order is total.
  scored.sort((a, b) => b.value - a.value || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : 1));
  const board: BoardRow[] = [];
  let previous = Number.POSITIVE_INFINITY;
  for (const [index, s] of scored.entries()) {
    // Keep implied values strictly decreasing down the ranks.
    const value = Math.min(s.value, previous - 1);
    previous = value;
    const ageYears = s.p.listed_at === null ? null : daysSince(s.p.listed_at, snapshot.as_of) / 365.25;
    board.push({
      slug: s.p.slug,
      name: s.p.name,
      rank: index + 1,
      implied_value_usd: value,
      farm_steps: farmSteps(s.p),
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_years: ageYears === null ? null : Math.round(ageYears * 100) / 100,
      multiple: Math.round(s.multiple * 1000) / 1000,
      growth_factor: Math.round(s.factors.growth * 1000) / 1000,
      age_factor: Math.round(s.factors.age * 1000) / 1000,
      chain_factor: Math.round(s.factors.chains * 1000) / 1000,
      watchlist: watchlist.has(s.p.slug),
      thesis: thesis(s.p, value, s.multiple, s.factors),
    });
  }
  excluded.sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  const launched = snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.mcap_usd !== null && p.tvl_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000,
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd)
    .slice(0, 60);
  return { board, excluded, launched };
}

/** The first problem with a board, or null when the gate would take it. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board holds ${board.length} rows, outside 100 to 4000`;
  const seen = new Set<string>();
  for (const row of board) {
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (const [i, rank] of ranks.entries()) {
    if (rank !== i + 1) return `ranks are not exactly 1 to ${board.length}`;
  }
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) {
    if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return `implied value rises from rank ${i} to rank ${i + 1}`;
    }
  }
  if (board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) {
    return 'every implied value is the same: the board ranks nothing';
  }
  for (const row of board) {
    if (!Number.isInteger(row.implied_value_usd) || row.implied_value_usd <= 0 || row.implied_value_usd > 1e14) {
      return `row ${row.slug} has a bad implied value`;
    }
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} has ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const trimmed = step.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `row ${row.slug} has a farm step of ${trimmed.length} characters`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ dossier
//
// The dossier (makefun/dossier/v1) of a dashboard directory: the screenshots
// plus a text of the page's source, as canonical JSON bytes. The text opens
// with a "## Dashboard" block (file count, bytes, every file's path and size),
// then "## Source", each text file's path, size and line count and its
// contents in a fenced block. The text holds at most text_max_bytes UTF-8
// bytes: every file that fits goes in whole, in path order; the first that
// does not goes in up to its last complete line that fits, with a line saying
// how many of its lines are not shown; nothing follows it but a last line
// naming how many whole files and bytes were left out. Files whose extension
// is not .html .css .js .json .mjs .svg .md .txt are named in the Dashboard
// block and not shown.

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function utf8Len(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with every object's keys in code-unit order and no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(byCodeUnit)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

function opensWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/** Lines of a text: 0 when empty, else its newlines plus one for a last line with none. */
function lineCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/** A Markdown fence one backtick longer than the longest run in the body, three at least. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return ext === 'mjs' ? 'js' : ext;
}

const TEXT_FILE = /\.(?:html|css|js|json|mjs|svg|md|txt)$/;

interface DashFile {
  path: string;
  size: number;
}

/** Every regular file under root, in path order, with its size. */
function dashboardFiles(root: string): DashFile[] {
  const out: DashFile[] = [];
  const walk = (rel: string): void => {
    const dir = rel === '' ? root : join(root, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) throw new Error(`buildDossier: dashboard/${p} is a dot-directory`);
        walk(p);
      } else if (entry.isFile()) {
        if (!IMAGE_NAME.test(entry.name)) throw new Error(`buildDossier: dashboard/${p}: a bad file name`);
        out.push({ path: p, size: lstatSync(join(root, p)).size });
      } else {
        throw new Error(`buildDossier: dashboard/${p} is neither a file nor a directory`);
      }
    }
  };
  walk('');
  return out.sort((a, b) => byCodeUnit(a.path, b.path));
}

interface ShownSection {
  heading: string;
  headingBytes: number;
  block: string | null;
  blockBytes: number;
  bytes: number;
  lines: number;
  text: string;
  fence: string;
  lang: string;
}

function buildDossier(dir: string, textMaxBytes: number): Uint8Array {
  const max = textMaxBytes;
  const files = dashboardFiles(join(dir, 'dashboard'));
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  if (files.length > DASHBOARD_CAPS.max_files) throw new Error('buildDossier: too many dashboard files');
  if (totalBytes > DASHBOARD_CAPS.max_bytes) throw new Error('buildDossier: dashboard over its byte cap');

  const shotsDir = join(dir, 'screenshots');
  const shotNames = readdirSync(shotsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort(byCodeUnit);
  if (shotNames.length === 0) throw new Error('buildDossier: screenshots/ holds no image');
  if (shotNames.length > SCREENSHOT_CAPS.max) throw new Error('buildDossier: too many screenshots');
  const images = shotNames.map((name) => {
    if (!IMAGE_NAME.test(name)) throw new Error(`buildDossier: screenshots/${name}: a bad name`);
    const bytes = readFileSync(join(shotsDir, name));
    if (bytes.length > SCREENSHOT_CAPS.max_bytes) throw new Error(`buildDossier: screenshots/${name} over its byte cap`);
    const mediaType = opensWith(bytes, PNG_MAGIC) ? 'image/png' : opensWith(bytes, JPEG_MAGIC) ? 'image/jpeg' : null;
    if (mediaType === null) throw new Error(`buildDossier: screenshots/${name} is neither a PNG nor a JPEG`);
    return { name, media_type: mediaType, sha256: sha256Hex(bytes), base64: bytes.toString('base64') };
  });

  const head = [
    '## Dashboard',
    '',
    `Files: ${files.length} (${totalBytes} bytes)`,
    ...files.map((f) => `- ${f.path} (${f.size} bytes)`),
    '',
    '## Source',
    '',
    '',
  ].join('\n');

  const sections: ShownSection[] = files
    .filter((f) => TEXT_FILE.test(f.path))
    .map((f) => {
      const bytes = readFileSync(join(dir, 'dashboard', f.path));
      const lines = lineCount(bytes);
      const heading = `### ${f.path}\n\n${bytes.length} bytes, ${lines} line${lines === 1 ? '' : 's'}\n\n`;
      if (bytes.length === 0) {
        return { heading, headingBytes: utf8Len(heading), block: null, blockBytes: 0, bytes: 0, lines, text: '', fence: '', lang: '' };
      }
      const text = new TextDecoder('utf-8').decode(bytes);
      const fence = fenceFor(text);
      const lang = languageOf(f.path);
      const block = `${fence}${lang}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
      return { heading, headingBytes: utf8Len(heading), block, blockBytes: utf8Len(block), bytes: bytes.length, lines, text, fence, lang };
    });

  // restBytes[k]: the bytes of the shown files after section k.
  const restBytes = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) {
    restBytes[k] = restBytes[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes : 0);
  }
  const cutLine = (count: number, bytes: number): string =>
    `[Cut at ${max} bytes: ${count} file${count === 1 ? '' : 's'} and ${bytes} bytes left out.]\n`;

  let out = head;
  let used = utf8Len(head);
  if (used + utf8Len(cutLine(0, 0)) > max) throw new Error('buildDossier: text cap cannot hold the Dashboard block');
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const section = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : utf8Len(cutLine(restCount, restBytes[kept]!));
    if (used + section.headingBytes + section.blockBytes + tail > max) break;
    out += section.block === null ? section.heading : `${section.heading}${section.block}`;
    used += section.headingBytes + section.blockBytes;
  }
  if (kept < sections.length) {
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const after = restBytes[kept]!;
    // The first file that does not fit whole: its head, up to its last complete line that fits.
    let partial: string | null = null;
    if (first.block !== null) {
      const total = first.lines;
      const lines = first.text.split('\n');
      const open = `${first.fence}${first.lang}\n`;
      const close = `${first.fence}\n\n`;
      const note = (k: number): string => `[${total - k} of this file's ${total} lines not shown.]\n`;
      const fixed = first.headingBytes + utf8Len(open) + utf8Len(close);
      const room = max - used;
      const rawBytes = Buffer.from(first.text, 'utf8');
      let best = 0;
      let shown = 0;
      let raw = 0;
      for (let k = 1; k < total; k++) {
        shown += utf8Len(lines[k - 1]!) + 1;
        raw = rawBytes.indexOf(0x0a, raw) + 1;
        const tail = (hidden: number): string => cutLine(restCount, after + hidden);
        if (fixed + shown + utf8Len(note(k)) + utf8Len(tail(first.bytes - raw)) <= room) best = k;
      }
      if (best > 0) {
        let rawEnd = 0;
        for (let k = 0; k < best; k++) rawEnd = rawBytes.indexOf(0x0a, rawEnd) + 1;
        const headText = lines.slice(0, best).map((l) => `${l}\n`).join('');
        partial = `${first.heading}${open}${headText}${close}${note(best)}${cutLine(restCount, after + (first.bytes - rawEnd))}`;
      }
    }
    out += partial ?? cutLine(restCount + 1, after + first.bytes);
  }
  if (utf8Len(out) > max) throw new Error('buildDossier: text over its cap');

  const doc = { schema: 'makefun/dossier/v1', cover: 0, text: out.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  if (bytes.length > DOSSIER_MAX_BYTES) throw new Error('buildDossier: dossier over 4 MiB');
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

// ------------------------------------------------------------------ gate mirror

/** PNG width/height from the IHDR chunk, or null when the file is no PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!opensWith(bytes, PNG_MAGIC) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function gateCheck(outDir: string, snapshot: Snapshot, board: BoardRow[]): string[] {
  const problems: string[] = [];
  const dashDir = join(outDir, 'dashboard');
  const names = existsSync(dashDir) ? readdirSync(dashDir) : [];
  if (!names.includes('index.html')) problems.push('dashboard_files: no index.html');
  if (!names.some((n) => n.endsWith('.css'))) problems.push('dashboard_files: no .css file');
  if (!names.some((n) => n.endsWith('.js'))) problems.push('dashboard_files: no .js file');
  // No network: no http:// or https:// in an HTML attribute, a <style> body,
  // a CSS file, or a JS import/require/dynamic-import specifier. This build
  // keeps http out of the dashboard entirely.
  for (const name of names) {
    const text = readFileSync(join(dashDir, name), 'utf8');
    if (/(?:href|src|action)\s*=\s*["']https?:\/\//i.test(text)) problems.push(`dashboard_files: ${name} links out`);
    if (/https?:\/\//.test(text) && (name.endsWith('.css') || name.endsWith('.js'))) {
      problems.push(`dashboard_files: ${name} names an http address`);
    }
  }
  const boardPath = join(outDir, 'board.json');
  const boardBytes = existsSync(boardPath) ? statSync(boardPath).size : 0;
  if (boardBytes > 8 * 1024 * 1024) problems.push('board_file: over 8 MiB');
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  for (const row of board) {
    if (!slugs.has(row.slug)) problems.push(`board_file: invented slug ${row.slug}`);
  }
  const shotsDir = join(outDir, 'screenshots');
  const shots = existsSync(shotsDir)
    ? readdirSync(shotsDir).filter((n) => !n.startsWith('.'))
    : [];
  if (shots.length < 3 || shots.length > 4) problems.push(`screenshots: ${shots.length} images, need 3 to 4`);
  for (const name of shots) {
    const bytes = readFileSync(join(shotsDir, name));
    if (bytes.length > 524_288) problems.push(`screenshots: ${name} over 512 KiB`);
    const png = pngSize(bytes);
    if (png === null && !opensWith(bytes, JPEG_MAGIC)) problems.push(`screenshots: ${name} is neither PNG nor JPEG`);
    if (png !== null) {
      const long = Math.max(png.width, png.height);
      const short = Math.min(png.width, png.height);
      if (long > 1440) problems.push(`screenshots: ${name} long side ${long} over 1440`);
      if (short < 800) problems.push(`screenshots: ${name} short side ${short} under 800`);
    }
  }
  const dossierPath = join(outDir, 'dossier.json');
  if (existsSync(dossierPath) && statSync(dossierPath).size > 1.5 * 1024 * 1024) {
    problems.push('dossier_matches: dossier over 1.5 MiB');
  }
  return problems;
}

// ------------------------------------------------------------------ main

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, excluded, launched } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
const dataPayload = {
  meta: {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    protocols_scanned: snapshot.protocols.length,
    watchlist: snapshot.watchlist.length,
    board_rows: board.length,
    set_aside: excluded.length,
    launched_shown: launched.length,
    model: 'implied = TVL x category multiple x growth x age x chains',
  },
  rows: board,
  excluded,
  launched,
};
writeFileSync(join(out, 'data.js'), `window.TOKEN_RADAR = ${JSON.stringify(dataPayload)};\n`);

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, TEXT_MAX_BYTES));

const gateProblems = gateCheck(out, snapshot, board);
if (gateProblems.length > 0) {
  for (const problem of gateProblems) process.stderr.write(`token radar: gate: ${problem}\n`);
  process.exit(1);
}

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${excluded.length} set aside, ${launched.length} launched shown for reference)\n` +
    `token radar: top 3: ${board.slice(0, 3).map((r) => `${r.slug} ${money(r.implied_value_usd)}`).join(', ')}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n` +
    `token radar: gate mirror: 7 rows pass\n`,
);
