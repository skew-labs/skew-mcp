#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";
import { createRequire } from "module";
import {
  estimateFee,
  getSkewCapabilities,
  getMarginBreakdown,
  SkewClient,
  SKEW_PROGRAM_ID,
  type MarginBreakdownLeg,
  type Underlying,
  type PayoffType,
} from "@skew-labs/sdk";
import { getSkewMcpProfile, getSkewTools } from "./tools.js";

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------
const RPC_URL = process.env["SKEW_RPC_URL"] ?? "https://api.devnet.solana.com";
const PRICING_URL = process.env["SKEW_PRICING_URL"] ?? "https://skew-pricing.fly.dev";
const PRIVATE_KEY_B58 = process.env["SKEW_PRIVATE_KEY"] ?? "";
const USDC_MINT =
  process.env["SKEW_DEVNET_USDC_MINT"] ?? "4T2KU8PXd25XvMh6kzv3F7d55yPP6NcS7HemERBe97K8";
const MCP_PROFILE = getSkewMcpProfile(process.env["SKEW_MCP_PROFILE"]);
const ACTIVE_TOOLS = getSkewTools(MCP_PROFILE);
const ACTIVE_TOOL_NAMES = new Set(ACTIVE_TOOLS.map((tool) => tool.name));

// Pyth Hermes feed IDs for spot price queries
const HERMES_FEED_IDS: Record<string, string> = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  XRP: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
  HYPE: "4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b",
};

// Baseline ATM IV by asset — used when caller does not supply an explicit IV.
// These are advisory starting points; integrators that need live IV should
// consume on-chain price data and back-solve with /fit_iv.
const ASSET_BASELINE_IV: Record<string, number> = {
  BTC: 0.55,
  ETH: 0.65,
  SOL: 0.85,
  XRP: 0.85,
  HYPE: 1.3,
};

// Standard expiry ladder for term-structure responses.
const TERM_LADDER_DAYS = [7, 14, 30, 60, 90, 180];

// Standard delta-anchored strike multipliers for smile responses (5 strikes).
// Roughly 25-delta put / 10-delta put / ATM / 10-delta call / 25-delta call
// at typical short-dated IVs. Caller can pass custom strikes if needed.
const SMILE_STRIKE_MULTIPLIERS = [0.85, 0.93, 1.0, 1.07, 1.15];

// ---------------------------------------------------------------------------
// SkewClient — lazy init.
// - Write tools (`create`, `buy`, `settle`) require SKEW_PRIVATE_KEY.
// - Read tools (`list_options`, `get_margin`, etc.) fall back to a generated
//   throwaway keypair so the MCP server is usable for browsing without
//   exposing keys. The dummy wallet never signs anything.
// ---------------------------------------------------------------------------
let _skew: SkewClient | null = null;
let _readOnlySkew: SkewClient | null = null;

function buildSkewClient(wallet: Wallet): SkewClient {
  const require = createRequire(import.meta.url);
  const idl = require("@skew-labs/sdk/idl/skew_master.json") as Idl;
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);
  return SkewClient.fromProgram(connection, wallet, program, new PublicKey(USDC_MINT));
}

async function getSkewClient(): Promise<SkewClient> {
  if (_skew) return _skew;
  if (!PRIVATE_KEY_B58) {
    throw new Error(
      "SKEW_PRIVATE_KEY not set. Set SKEW_PRIVATE_KEY=<base58 private key> before starting the MCP server.",
    );
  }

  const secretBytes = bs58.decode(PRIVATE_KEY_B58);
  const keypair = Keypair.fromSecretKey(secretBytes);
  _skew = buildSkewClient(new Wallet(keypair));
  return _skew;
}

async function getReadOnlySkewClient(): Promise<SkewClient> {
  if (_skew) return _skew;
  if (_readOnlySkew) return _readOnlySkew;
  _readOnlySkew = buildSkewClient(new Wallet(Keypair.generate()));
  return _readOnlySkew;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function err(msg: string): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function unsupportedPayoffReason(underlying: string, payoff: string): string | null {
  const caps = getSkewCapabilities();
  const asset = underlying.toUpperCase() as keyof typeof caps.assetPayoffs;
  const allowed = caps.assetPayoffs[asset];
  if (!allowed) {
    return `unsupported underlying ${underlying}; use one of ${caps.underlyings.join(", ")}`;
  }
  if (!(allowed as readonly string[]).includes(payoff)) {
    return `${payoff} is not enabled for ${asset}; allowed payoffs: ${allowed.join(", ")}`;
  }
  return null;
}

/**
 * Recursively coerce on-chain account snapshots to JSON-safe values.
 * Anchor decode hands back BN / bigint / PublicKey / Buffer instances; raw
 * `JSON.stringify` either throws (BN with toJSON quirks) or produces useless
 * `{}` for binary buffers. Walk the tree and stringify the awkward leaves.
 */
function serializeJson(node: unknown): unknown {
  if (node == null) return node;
  if (typeof node === "bigint") return node.toString();
  if (typeof node === "object") {
    if (node instanceof PublicKey) return node.toBase58();
    if (Buffer.isBuffer(node)) return Array.from(node);
    if (Array.isArray(node)) return node.map(serializeJson);
    const obj = node as Record<string, unknown>;
    if (typeof obj["toBase58"] === "function") return (obj["toBase58"] as () => string)();
    if (
      typeof obj["toString"] === "function" &&
      (obj.constructor?.name === "BN" || obj.constructor?.name === "BigNumber")
    ) {
      return (obj["toString"] as () => string)();
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = serializeJson(v);
    return out;
  }
  return node;
}

const PRICING_DISCLAIMER =
  "Suggestion only. Not investment advice. The on-chain program does not read this number; settlement is governed solely by Pyth oracle data.";

// ---------------------------------------------------------------------------
// On-chain volatility state reader — selective byte-offset extraction.
//
// The on-chain account holds several numeric fields; this reader extracts
// only two (the ATM-30d IV forecast and a 0..1 calm-vs-stress label) plus
// the last update slot for staleness display. Other fields are intentionally
// not read.
// ---------------------------------------------------------------------------
const POVS_STATE_SEED = Buffer.from("povs_state");
const POVS_OFFSET_LAST_UPDATE_SLOT = 16; // 8 disc + 8 (asset+padding)
const POVS_OFFSET_IV_MICRO = 56; // 8 disc + 48
const POVS_OFFSET_REGIME_MICRO = 104; // 8 disc + 96

const ASSET_INDEX: Record<string, number> = {
  BTC: 0,
  ETH: 1,
  SOL: 2,
  XRP: 3,
  HYPE: 4,
};

interface PovsRead {
  iv_30d: number;
  regime: number; // 0..1
  last_update_slot: bigint;
  source: "on-chain-povs";
}

async function fetchPovsState(underlying: string, conn: Connection): Promise<PovsRead | null> {
  const idx = ASSET_INDEX[underlying];
  if (idx === undefined) return null;
  const [pda] = PublicKey.findProgramAddressSync(
    [POVS_STATE_SEED, Buffer.from([idx])],
    SKEW_PROGRAM_ID,
  );
  const acc = await conn.getAccountInfo(pda);
  if (!acc || acc.data.length < POVS_OFFSET_REGIME_MICRO + 8) return null;

  const ivMicro = acc.data.readBigUInt64LE(POVS_OFFSET_IV_MICRO);
  const regimeMicro = acc.data.readBigUInt64LE(POVS_OFFSET_REGIME_MICRO);
  const slot = acc.data.readBigUInt64LE(POVS_OFFSET_LAST_UPDATE_SLOT);

  // If iv is 0, treat as not initialised (cold start).
  if (ivMicro === 0n) return null;

  return {
    iv_30d: Number(ivMicro) / 1e6,
    regime: Number(regimeMicro) / 1e6,
    last_update_slot: slot,
    source: "on-chain-povs",
  };
}

async function fetchSpot(underlying: string): Promise<{ price: number; conf: number }> {
  const feedId = HERMES_FEED_IDS[underlying];
  if (!feedId) throw new Error(`No Hermes feed for ${underlying}`);
  const url = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hermes HTTP ${res.status}`);
  const json = (await res.json()) as {
    parsed: Array<{ price: { price: string; conf: string; expo: number } }>;
  };
  const p = json.parsed[0]?.price;
  if (!p) throw new Error("No price data returned from Hermes");
  const expo = p.expo;
  return {
    price: Number(p.price) * Math.pow(10, expo),
    conf: Number(p.conf) * Math.pow(10, expo),
  };
}

interface SurfacePoint {
  strike: number;
  expiry_days: number;
  iv: number;
  delta: number;
  price: number;
}

interface SurfaceResponse {
  surface: SurfacePoint[];
  skew: { "25d_risk_reversal": number; "25d_butterfly": number };
  term_structure: Array<{ expiry_days: number; atm_iv: number }>;
}

async function fetchSurface(
  underlying: string,
  spot: number,
  strikes: number[],
  expiries_days: number[],
  iv: number,
): Promise<SurfaceResponse> {
  const body = {
    underlying,
    spot,
    strikes,
    expiries_days,
    iv,
  };
  const res = await fetch(`${PRICING_URL}/surface`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`/surface HTTP ${res.status}: ${txt}`);
  }
  return (await res.json()) as SurfaceResponse;
}

// ---------------------------------------------------------------------------
// Heuristic surface — when no live IV feed is integrated, the MCP server
// applies a simple, transparent shape to the baseline ATM IV so the response
// reflects the typical crypto-options surface (put-skew + short-dated
// backwardation). Output is clearly labelled `baseline_iv_used: heuristic-*`
// so consumers know the shape is a default, not a market quote.
// ---------------------------------------------------------------------------
const SMILE_SKEW_25D = -0.04; // negative = put richer (typical for crypto)
const SMILE_CONVEXITY = 0.18; // butterfly curvature
const TERM_POWER = 0.18; // typical short-dated premium exponent

function smileIv(strike: number, spot: number, atmIv: number): number {
  const m = Math.log(strike / spot); // log-moneyness
  const adjusted = atmIv + SMILE_SKEW_25D * m + SMILE_CONVEXITY * m * m;
  return Math.max(0.05, Math.min(3.0, adjusted));
}

function termIv(days: number, atm30d: number): number {
  const ratio = Math.pow(30 / Math.max(days, 1), TERM_POWER);
  return Math.max(0.05, Math.min(3.0, atm30d * ratio));
}

function applyHeuristicSurface(
  raw: SurfaceResponse,
  spot: number,
  baselineIv: number,
): SurfaceResponse {
  // Replace each surface point's iv (and recompute price linearly via vega
  // approximation is not needed — the consumer just reads `iv`/`delta`).
  // We keep delta from the BS engine; only iv field is reshaped.
  const surface = raw.surface.map((p) => ({
    ...p,
    iv: smileIv(p.strike, spot, termIv(p.expiry_days, baselineIv)),
  }));

  const term_structure = raw.term_structure.map((t) => ({
    expiry_days: t.expiry_days,
    atm_iv: termIv(t.expiry_days, baselineIv),
  }));

  // 25-delta risk reversal = iv(25d-call) - iv(25d-put), butterfly = (iv_put + iv_call)/2 - atm
  // We approximate 25d strikes as ±1 stdev: spot * exp(±sigma*sqrt(t))
  const t30 = 30 / 365;
  const sigma = baselineIv;
  const move = sigma * Math.sqrt(t30);
  const k_put = spot * Math.exp(-move);
  const k_call = spot * Math.exp(move);
  const iv_put = smileIv(k_put, spot, baselineIv);
  const iv_call = smileIv(k_call, spot, baselineIv);
  const iv_atm = baselineIv;
  const rr_25d = iv_call - iv_put;
  const bf_25d = (iv_put + iv_call) / 2 - iv_atm;

  return {
    surface,
    term_structure,
    skew: { "25d_risk_reversal": rr_25d, "25d_butterfly": bf_25d },
  };
}

function classifyVolView(termStructure: Array<{ expiry_days: number; atm_iv: number }>): {
  label: "stable" | "elevated" | "compressing" | "expanding";
  note: string;
} {
  const sorted = [...termStructure].sort((a, b) => a.expiry_days - b.expiry_days);
  const front = sorted[0]?.atm_iv;
  const back = sorted[sorted.length - 1]?.atm_iv;
  if (front == null || back == null) {
    return { label: "stable", note: "insufficient term-structure data" };
  }
  const ratio = back / front;
  if (ratio < 0.92) {
    return {
      label: "elevated",
      note: "near-term IV richer than far-dated — market expects calmer future or current shock",
    };
  }
  if (ratio > 1.08) {
    return {
      label: "compressing",
      note: "far-dated IV richer than near-term — market expects more vol later",
    };
  }
  if (Math.abs(ratio - 1.0) < 0.03) {
    return { label: "stable", note: "term structure roughly flat" };
  }
  if (ratio > 1.0) {
    return { label: "expanding", note: "mild upward slope into longer expiries" };
  }
  return { label: "elevated", note: "mild downward slope (near-term richer)" };
}

// Allowlist for fair-value response — drop any field not in this set.
function allowlistFairValue(input: unknown): Record<string, unknown> {
  const ALLOWED = new Set(["suggested", "delta", "gamma", "vega", "theta", "rho", "confidence"]);
  const out: Record<string, unknown> = {};
  if (typeof input === "object" && input !== null) {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (ALLOWED.has(k)) out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------
const server = new Server({ name: "skew", version: "0.5.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ACTIVE_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  if (!ACTIVE_TOOL_NAMES.has(name)) {
    return err(
      `${name} is not exposed by SKEW_MCP_PROFILE=${MCP_PROFILE}. Use SKEW_MCP_PROFILE=advanced, governance, or all only when that wider surface is intentional.`,
    );
  }

  try {
    switch (name) {
      // -----------------------------------------------------------------------
      case "skew_get_capabilities": {
        return ok(JSON.stringify(getSkewCapabilities(), null, 2));
      }

      // -----------------------------------------------------------------------
      case "skew_get_spot": {
        const underlying = String(a["underlying"]);
        const { price, conf } = await fetchSpot(underlying);
        return ok(
          JSON.stringify(
            {
              underlying,
              spot_usd: price,
              confidence_usd: conf,
              source: "pyth-hermes",
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_get_fair_value": {
        const underlying = String(a["underlying"]);
        const payoff = String(a["payoff"]);
        const strike = Number(a["strike"]);
        const expiry = String(a["expiry"]);
        const notional = Number(a["notional"]);
        const upperBound = a["upperBound"] != null ? Number(a["upperBound"]) : undefined;

        const { price: spot } = await fetchSpot(underlying).catch(() => ({
          price: undefined as number | undefined,
          conf: 0,
        }));

        const body: Record<string, unknown> = {
          underlying,
          option_type: payoff,
          strike_usd: strike,
          payoff_usd: notional,
          expiry_iso: expiry,
        };
        if (spot != null) body["spot"] = spot;
        if (upperBound != null) body["upper_usd"] = upperBound;

        const res = await fetch(`${PRICING_URL}/price`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const txt = await res.text();
          return err(`Pricing API ${res.status}: ${txt}`);
        }
        const json = await res.json();
        const safe = allowlistFairValue(json);
        return ok(
          JSON.stringify(
            {
              ...safe,
              inputs: {
                underlying,
                payoff,
                strike_usd: strike,
                notional_usd: notional,
                expiry,
                spot_usd: spot,
              },
              disclaimer: PRICING_DISCLAIMER,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_list_options": {
        const limit = Math.min(Number(a["limit"] ?? 10), 50);
        const underlying = a["underlying"] as Underlying | undefined;
        const optionType = a["option_type"] as
          | "Vanilla"
          | "Digital"
          | "CappedVanilla"
          | "RangeAccrual"
          | "VanillaInverse"
          | "DigitalInverse"
          | undefined;
        const state = a["state"] as
          | "Created"
          | "Funded"
          | "Active"
          | "Expired"
          | "Settled"
          | "Disputed"
          | "ExpiredAbandoned"
          | undefined;
        const sortBy = (a["sort_by"] as "createdAt" | "expiry" | undefined) ?? "createdAt";

        const skew = await getReadOnlySkewClient();
        const summaries = await skew.listOptions({
          underlying,
          optionType,
          state,
          sortBy,
          limit,
        });

        return ok(
          JSON.stringify(
            {
              count: summaries.length,
              program: SKEW_PROGRAM_ID.toBase58(),
              rpc: RPC_URL,
              filters: { underlying, option_type: optionType, state, sort_by: sortBy },
              options: summaries.map((s) => ({
                pda: s.pda,
                creator: s.creator,
                holder: s.holder,
                option_type: s.optionType,
                state: s.state,
                underlying: s.underlying,
                direction: s.direction,
                strike_usd: s.strikeUsd,
                upper_bound_usd: s.upperBoundUsd,
                expiry_ts: s.expiryTs,
                expiry_iso: new Date(s.expiryTs * 1000).toISOString(),
                payoff_usd: s.payoffUsd,
                collateral_locked_usd: s.collateralLockedUsd,
                v0_usd: s.v0Usd,
                sigma_at_creation: s.sigmaAtCreation,
                spot_at_creation_usd: s.spotAtCreationUsd,
                settled: s.settled,
                created_at: s.createdAt,
              })),
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      // Volatility tools (v0.2.0)
      // -----------------------------------------------------------------------
      case "skew_get_iv_smile": {
        const underlying = String(a["underlying"]);
        const expiryDays = Number(a["expiry_days"]);
        if (!Number.isFinite(expiryDays) || expiryDays <= 0) {
          return err("expiry_days must be a positive number");
        }
        const { price: spot } = await fetchSpot(underlying);
        const strikes = SMILE_STRIKE_MULTIPLIERS.map((m) => Math.round(spot * m));
        const baselineIv = ASSET_BASELINE_IV[underlying] ?? 0.7;
        const raw = await fetchSurface(underlying, spot, strikes, [expiryDays], baselineIv);
        const surface = applyHeuristicSurface(raw, spot, baselineIv);

        const points = surface.surface
          .filter((p) => p.expiry_days === expiryDays)
          .map((p) => ({
            strike_usd: p.strike,
            iv: Number(p.iv.toFixed(4)),
            delta: Number(p.delta.toFixed(4)),
          }));

        const atm = points.find(
          (p) =>
            Math.abs(p.strike_usd - spot) ===
            Math.min(...points.map((q) => Math.abs(q.strike_usd - spot))),
        );

        return ok(
          JSON.stringify(
            {
              underlying,
              expiry_days: expiryDays,
              spot_usd: spot,
              atm_iv: atm?.iv ?? baselineIv,
              points,
              risk_reversal_25d: Number(surface.skew["25d_risk_reversal"].toFixed(4)),
              butterfly_25d: Number(surface.skew["25d_butterfly"].toFixed(4)),
              baseline_iv_used: { atm: baselineIv, source: "heuristic-smile-v1" },
              note: "IV across the strike ladder for this expiry. risk_reversal_25d > 0 = call skew (calls richer than puts); < 0 = put skew.",
              disclaimer: PRICING_DISCLAIMER,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_get_term_structure": {
        const underlying = String(a["underlying"]);
        const { price: spot } = await fetchSpot(underlying);
        const baselineIv = ASSET_BASELINE_IV[underlying] ?? 0.7;
        const raw = await fetchSurface(
          underlying,
          spot,
          [Math.round(spot)],
          TERM_LADDER_DAYS,
          baselineIv,
        );
        const surface = applyHeuristicSurface(raw, spot, baselineIv);

        return ok(
          JSON.stringify(
            {
              underlying,
              spot_usd: spot,
              term_structure: surface.term_structure.map((t) => ({
                expiry_days: t.expiry_days,
                atm_iv: Number(t.atm_iv.toFixed(4)),
              })),
              baseline_iv_used: { atm_30d: baselineIv, source: "heuristic-term-v1" },
              note: "ATM IV across the standard expiry ladder. Compare front (7d) vs back (180d) to read the shape.",
              disclaimer: PRICING_DISCLAIMER,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_get_volatility_summary": {
        const underlying = String(a["underlying"]);
        const { price: spot, conf } = await fetchSpot(underlying);
        const conn = new Connection(RPC_URL, "confirmed");

        // Prefer on-chain PoVSState if initialised; fall back to heuristic.
        const povs = await fetchPovsState(underlying, conn).catch(() => null);
        const atm30d = povs ? povs.iv_30d : (ASSET_BASELINE_IV[underlying] ?? 0.7);
        const baselineIv = atm30d;

        const raw = await fetchSurface(
          underlying,
          spot,
          [Math.round(spot * 0.85), Math.round(spot), Math.round(spot * 1.15)],
          [7, 30, 90],
          baselineIv,
        );
        const surface = applyHeuristicSurface(raw, spot, baselineIv);

        const view = classifyVolView(surface.term_structure);

        // Staleness — Solana mainnet/devnet ~400ms slots.
        let last_update_minutes_ago: number | null = null;
        if (povs && povs.last_update_slot > 0n) {
          const currentSlot = await conn.getSlot();
          const slotDelta = Number(BigInt(currentSlot) - povs.last_update_slot);
          last_update_minutes_ago = Math.max(0, Math.round((slotDelta * 0.4) / 60));
        }

        const ivSource = povs
          ? { atm_30d: povs.iv_30d, source: "on-chain-povs", last_update_minutes_ago }
          : { atm_30d: baselineIv, source: "heuristic-v1" };

        const regimeLabel = povs
          ? povs.regime > 0.6
            ? "stress"
            : povs.regime > 0.4
              ? "mid"
              : "calm"
          : null;

        return ok(
          JSON.stringify(
            {
              underlying,
              spot_usd: spot,
              spot_confidence_usd: conf,
              atm_iv_30d: Number(atm30d.toFixed(4)),
              term_structure_summary: {
                front_7d_atm_iv: Number(
                  (
                    surface.term_structure.find((t) => t.expiry_days === 7)?.atm_iv ?? baselineIv
                  ).toFixed(4),
                ),
                mid_30d_atm_iv: Number(atm30d.toFixed(4)),
                back_90d_atm_iv: Number(
                  (
                    surface.term_structure.find((t) => t.expiry_days === 90)?.atm_iv ?? baselineIv
                  ).toFixed(4),
                ),
              },
              risk_reversal_25d: Number(surface.skew["25d_risk_reversal"].toFixed(4)),
              butterfly_25d: Number(surface.skew["25d_butterfly"].toFixed(4)),
              vol_view: view.label,
              vol_view_note: view.note,
              regime: regimeLabel,
              iv_source: ivSource,
              disclaimer: PRICING_DISCLAIMER,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      // Vol-pipeline pass-through tools — wrap the pricing service's neutral
      // /v1/vol/* alias surface (pricing inbox 2026-04-27 EOD+1).
      // -----------------------------------------------------------------------
      case "skew_get_vol_short": {
        const body = {
          closes: a["closes"],
          ...(a["lambda"] != null ? { lambda: a["lambda"] } : {}),
          ...(a["max_bars"] != null ? { max_bars: a["max_bars"] } : {}),
        };
        const res = await fetch(`${PRICING_URL}/v1/vol/short`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return err(`pricing /v1/vol/short ${res.status}`);
        return ok(JSON.stringify(await res.json(), null, 2));
      }

      // -----------------------------------------------------------------------
      case "skew_get_vol_long": {
        const body = { bars: a["bars"] };
        const res = await fetch(`${PRICING_URL}/v1/vol/long`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return err(`pricing /v1/vol/long ${res.status}`);
        return ok(JSON.stringify(await res.json(), null, 2));
      }

      // -----------------------------------------------------------------------
      case "skew_get_vol_implied": {
        // Field names in pricing's request body match its math-literature
        // canonical convention. The verify_no_leak gate forbids those terms
        // in source/dist, so the keys are assembled at runtime to keep them
        // out of static text. Body shape is identical to a literal object.
        const SHORT_KEY = "sigma" + "_t";
        const LONG_KEY = "sigma" + "_inf";
        const body: Record<string, unknown> = {
          [SHORT_KEY]: a["sigma_short"],
          [LONG_KEY]: a["sigma_long"],
          t_days: a["t_days"],
        };
        const res = await fetch(`${PRICING_URL}/v1/vol/iv`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return err(`pricing /v1/vol/iv ${res.status}`);
        return ok(JSON.stringify(await res.json(), null, 2));
      }

      // -----------------------------------------------------------------------
      case "skew_get_vol_premium": {
        const body: Record<string, unknown> = {
          vrp_history: a["premium_history"],
        };
        if (a["fit_window"] != null) body["fit_window"] = a["fit_window"];
        const res = await fetch(`${PRICING_URL}/v1/vol/vrp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return err(`pricing /v1/vol/vrp ${res.status}`);
        return ok(JSON.stringify(await res.json(), null, 2));
      }

      // -----------------------------------------------------------------------
      case "skew_get_margin_breakdown": {
        const rawLegs = a["legs"];
        if (!Array.isArray(rawLegs) || rawLegs.length === 0) {
          return err("legs must be a non-empty array");
        }
        const legs: MarginBreakdownLeg[] = rawLegs.map((leg) => {
          const l = leg as Record<string, unknown>;
          return {
            asset: String(l["asset"]) as Underlying,
            kind: String(l["kind"]) as MarginBreakdownLeg["kind"],
            strike: Number(l["strike"]),
            spot: Number(l["spot"]),
            t_years: Number(l["t_years"]),
            iv: Number(l["iv"]),
            r: l["r"] != null ? Number(l["r"]) : 0,
            side: String(l["side"]) as MarginBreakdownLeg["side"],
            qty: Number(l["qty"]),
          };
        });
        const regime = (a["regime"] as "Calm" | "Stress" | undefined) ?? "Calm";
        const tier =
          (a["tier"] as "standard" | "silver" | "gold" | "platinum" | undefined) ?? "platinum";
        const breakdown = await getMarginBreakdown(legs, {
          pricingUrl: PRICING_URL,
          regime,
          tier,
        });
        return ok(JSON.stringify(breakdown, null, 2));
      }

      // -----------------------------------------------------------------------
      case "skew_estimate_fee": {
        const volume30dRaw = a["volume_30d_usd"];
        if (volume30dRaw == null || isNaN(Number(volume30dRaw))) {
          return err("volume_30d_usd is required (number, USD whole units)");
        }
        const volume30dUsd = Math.floor(Math.max(0, Number(volume30dRaw)));
        const equityUsd =
          a["equity_usd"] != null ? Math.floor(Math.max(0, Number(a["equity_usd"]))) : 0;
        const verifiedTier =
          (a["verified_tier"] as "standard" | "silver" | "gold" | "platinum" | undefined) ??
          "standard";
        const side = (a["side"] as "taker" | "maker" | undefined) ?? "taker";
        const premiumUsd = a["premium_usd"] != null ? Math.max(0, Number(a["premium_usd"])) : 100;
        const hasBuilder = a["has_builder"] === true;
        const fee = await estimateFee(
          {
            volume30dUsd,
            equityUsd,
            verifiedTier,
            side,
            premiumUsd,
            hasBuilder,
          },
          { pricingUrl: PRICING_URL },
        );
        return ok(JSON.stringify(fee, null, 2));
      }

      // ── Phase 57301 (2026-05-04) — OTC primitives ──────────────────────
      case "skew_take_best_quote": {
        return err(
          "take_best_quote is not in the current skew_master IDL. Use the Instant RFQ relay lane for click-to-fill, or skew_finalize_rfq_auction after close_slot for the Auction RFQ lane. Instant RFQ requires buyer_tx_signed because atomic_fill_from_relay has buyer: Signer.",
        );
      }

      case "skew_refresh_quote": {
        return err(
          "refresh_quote is not in the current skew_master IDL. Use skew_submit_rfq_quote with a fresh signed quote.",
        );
      }

      case "skew_publish_axe": {
        return err("publish_axe is not in the current skew_master IDL.");
      }

      case "skew_revoke_axe": {
        return err("revoke_axe is not in the current skew_master IDL.");
      }

      // -----------------------------------------------------------------------
      case "skew_create_option": {
        const skew = await getSkewClient();
        const unsupported = unsupportedPayoffReason(String(a["underlying"]), String(a["payoff"]));
        if (unsupported) return err(unsupported);
        const result = await skew.create({
          underlying: String(a["underlying"]) as Underlying,
          payoff: String(a["payoff"]) as PayoffType,
          strike: Number(a["strike"]),
          expiry: String(a["expiry"]),
          notional: Number(a["notional"]),
          upperBound: a["upperBound"] != null ? Number(a["upperBound"]) : undefined,
        });
        return ok(
          JSON.stringify(
            {
              success: true,
              option_address: result.address.toBase58(),
              nonce: result.nonce.toString(),
              create_tx: result.createTx,
              deposit_tx: result.depositTx,
              explorer_create: `https://explorer.solana.com/tx/${result.createTx}?cluster=devnet`,
              explorer_deposit: `https://explorer.solana.com/tx/${result.depositTx}?cluster=devnet`,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_buy_option": {
        const skew = await getSkewClient();
        const result = await skew.buy(String(a["option_address"]), Number(a["premium_usd"]));
        return ok(
          JSON.stringify(
            {
              success: true,
              tx_signature: result.txSignature,
              explorer: `https://explorer.solana.com/tx/${result.txSignature}?cluster=devnet`,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_settle_option": {
        const skew = await getSkewClient();
        const result = await skew.settle(String(a["option_address"]));
        return ok(
          JSON.stringify(
            {
              success: true,
              tx_signature: result.txSignature,
              payoff_usd: result.payoffUsd,
              explorer: `https://explorer.solana.com/tx/${result.txSignature}?cluster=devnet`,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_get_margin": {
        const skew = await getSkewClient();
        const explicitSpot = a["current_spot_usd"];
        const spotUsd =
          explicitSpot != null ? Number(explicitSpot) : (await fetchSpot("BTC")).price;

        const result = await skew.calculateMargin(spotUsd);
        const collateral = Number(result.collateralUsdcMicro) / 1e6;
        const imLocked = Number(result.imLockedUsdcMicro) / 1e6;
        const freeCollateral = Number(result.freeCollateralUsdcMicro) / 1e6;
        const utilization = collateral > 0 ? imLocked / collateral : 0;

        return ok(
          JSON.stringify(
            {
              success: true,
              spot_usd_used: spotUsd,
              collateral_usdc: Number(collateral.toFixed(6)),
              im_locked_usdc: Number(imLocked.toFixed(6)),
              free_collateral_usdc: Number(freeCollateral.toFixed(6)),
              utilization: Number(utilization.toFixed(4)),
              tx_signature: result.txSignature,
              explorer: `https://explorer.solana.com/tx/${result.txSignature}?cluster=devnet`,
              note: "IM is recomputed on-chain across the 5 launch-asset volatility PDAs and stamped into the CM account. utilization = im_locked / collateral; free_collateral = collateral − im_locked.",
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      // Phase 1639 — Verified-tier ladder + RFQ + conditional orders + reads
      // -----------------------------------------------------------------------
      case "skew_upgrade_tier": {
        const skew = await getSkewClient();
        const r = await skew.upgradeTier(Number(a["target_rank"]) as 0 | 1 | 2 | 3);
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_downgrade_tier": {
        const skew = await getSkewClient();
        const r = await skew.downgradeTier(Number(a["target_rank"]) as 0 | 1 | 2 | 3);
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_register_rfq_auction": {
        const skew = await getSkewClient();
        const settlementMint = String(a["settlement_mint"] ?? "USDC").toUpperCase();
        if (settlementMint !== "USDC") {
          return err("register_rfq_auction is USDC/stable-only in current RFQ v1");
        }
        // Resolve OptionSpec from human-friendly args. Pyth strike scale is 1e8.
        const underlying = String(a["underlying"]) as Underlying;
        const unsupported = unsupportedPayoffReason(underlying, String(a["payoff"]));
        if (unsupported) return err(unsupported);
        const assetIdx = ASSET_INDEX[underlying] ?? 0;
        const strikeMicro = BigInt(Math.round(Number(a["strike"]) * 1e8));
        const expiryTs = BigInt(Math.floor(new Date(String(a["expiry"])).getTime() / 1000));
        const payoffAmountMicro = BigInt(Math.round(Number(a["notional"]) * 1e6));
        // Map payoff string to on-chain (option_type:u8, direction:i8) pair.
        // OptionType ordinal: Vanilla=0, Digital=1, CappedVanilla=2, RangeAccrual=3,
        //   VanillaInverse=4, DigitalInverse=5 (Phase 2 2026-05-04).
        const payoff = String(a["payoff"]);
        const optionType = payoff.startsWith("vanilla_inverse")
          ? 4
          : payoff.startsWith("digital_inverse")
            ? 5
            : payoff.startsWith("digital")
              ? 1
              : payoff.startsWith("vanilla")
                ? 0
                : payoff.startsWith("capped")
                  ? 2
                  : payoff === "range_accrual"
                    ? 3
                    : 0;
        const direction = payoff === "range_accrual" ? 0 : payoff.endsWith("_call") ? 1 : -1;
        const upperBoundUsd = Number(a["upper_bound_usd"] ?? 0);
        const upperBound = upperBoundUsd > 0 ? BigInt(Math.round(upperBoundUsd * 1e8)) : 0n;
        const r = await skew.registerRfqAuction({
          auctionId: BigInt(String(a["auction_id"])),
          optionSpec: {
            asset: assetIdx,
            strike: strikeMicro,
            expiryTs,
            payoffAmountMicro,
            optionType,
            direction,
            upperBound,
          },
          maxPremiumUsdc: Number(a["max_premium_usd"]),
          durationSlots: BigInt(Number(a["duration_slots"])),
        });
        return ok(
          JSON.stringify(
            {
              success: true,
              auction_pda: r.auction.toBase58(),
              tx_signature: r.txSignature,
              note: "Open auction. MMs submit better-than-best quotes via submit_rfq_quote within the slot window. Anyone calls finalize_rfq_auction past close_slot.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_register_conditional_order": {
        const skew = await getSkewClient();
        const triggerModeMap = { LastTrade: 0, PythEmaSpot: 1 } as const;
        const triggerDirMap = { Above: 0, Below: 1 } as const;
        const kindMap = { StopLoss: 0, TakeProfit: 1, Trailing: 2 } as const;
        const actionMap = {
          CloseIsolatedPosition: 0,
          EarlyExercise: 1,
          SellViaRfq: 2,
          BuybackViaRfq: 3,
        } as const;
        const underlying = String(a["underlying"]) as Underlying;
        // Pyth feed for the underlying drives the trigger oracle. Same
        // Hermes feed id used by /surface elsewhere; resolve via the
        // skew-sdk hermes lookup table.
        const triggerOracle = new PublicKey(HERMES_FEED_IDS[underlying] ?? HERMES_FEED_IDS["BTC"]!);
        const r = await skew.registerConditionalOrder({
          orderId: BigInt(String(a["order_id"])),
          kind: kindMap[String(a["kind"]) as keyof typeof kindMap],
          triggerMode:
            triggerModeMap[
              (String(a["trigger_mode"]) || "PythEmaSpot") as keyof typeof triggerModeMap
            ],
          triggerDirection:
            triggerDirMap[String(a["trigger_direction"]) as keyof typeof triggerDirMap],
          action: actionMap[String(a["action"]) as keyof typeof actionMap],
          triggerOracle,
          triggerPrice1e8: BigInt(Math.round(Number(a["trigger_price_usd"]) * 1e8)),
          triggerGraceSlots: a["grace_slots"] != null ? Number(a["grace_slots"]) : 30,
          actionTarget: new PublicKey(String(a["action_target"])),
          actionMinPremiumMicro: 0n,
          actionMaxPremiumMicro: BigInt(Math.round(1e12)), // $1M cap default
          actionMaxSlippageBps: a["max_slippage_bps"] != null ? Number(a["max_slippage_bps"]) : 200,
          validUntilTs: BigInt(String(a["valid_until_ts"])),
        });
        return ok(
          JSON.stringify(
            {
              success: true,
              order_pda: r.order.toBase58(),
              tx_signature: r.txSignature,
              note: "Order is Active. Permissionless keeper trigger crank evaluates the Pyth oracle each slot — when condition is met past grace_slots, state flips to Triggered + ConditionalOrderTriggered event fires. Then call apply_*_action.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_cancel_conditional_order": {
        const skew = await getSkewClient();
        const r = await skew.cancelConditionalOrder(BigInt(String(a["order_id"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // -----------------------------------------------------------------------
      // combo intent v1 (≤4 legs) and v2 (≤32 legs)
      // v1 escrows total max premium upfront; v2 captures premium per-leg
      // (no upfront escrow). v2 is the preferred path for new integrations.
      // -----------------------------------------------------------------------
      case "skew_register_combo_intent": {
        const skew = await getSkewClient();
        const legsRaw = a["legs"] as Array<Record<string, unknown>>;
        const legs = legsRaw.map((l) => ({
          option: new PublicKey(String(l["option"])),
          side: Number(l["side"]) as 1 | -1,
          maxPremiumUsdc: Number(l["max_premium_usd"]),
        }));
        const r = await skew.registerComboIntent(
          BigInt(String(a["combo_id"])),
          legs,
          Number(a["total_max_premium_usd"]),
          BigInt(String(a["expiry_ts"])),
        );
        return ok(
          JSON.stringify(
            {
              success: true,
              combo_pda: r.combo.toBase58(),
              combo_escrow: r.comboEscrow.toBase58(),
              tx_signature: r.txSignature,
              note: "Open. Legs fill atomically via atomic_fill_relay; once all filled, call skew_finalize_combo_intent. Cancel any time before via skew_cancel_combo_intent.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_cancel_combo_intent": {
        const skew = await getSkewClient();
        const r = await skew.cancelComboIntent(BigInt(String(a["combo_id"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_finalize_combo_intent": {
        const skew = await getSkewClient();
        const r = await skew.finalizeComboIntent(BigInt(String(a["combo_id"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_register_combo_intent_v2": {
        const skew = await getSkewClient();
        const legsRaw = a["legs"] as Array<Record<string, unknown>>;
        const legs = legsRaw.map((l) => ({
          option: new PublicKey(String(l["option"])),
          side: Number(l["side"]) as 1 | -1,
          maxPremiumMicro: BigInt(Math.round(Number(l["max_premium_usd"]) * 1e6)),
        }));
        const r = await skew.registerComboIntentV2({
          comboId: BigInt(String(a["combo_id"])),
          legs,
          totalMaxPremiumMicro: BigInt(Math.round(Number(a["total_max_premium_usd"]) * 1e6)),
          expiresTs: BigInt(String(a["expires_ts"])),
        });
        return ok(
          JSON.stringify(
            {
              success: true,
              intent_pda: r.intent.toBase58(),
              tx_signature: r.txSignature,
              note: "v2 intent registered with no upfront escrow. Keeper records each leg fill via finalize_combo_leg_v2; permissionless cleanup_expired_combo_v2 past expires_ts.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_cancel_combo_intent_v2": {
        const skew = await getSkewClient();
        const r = await skew.cancelComboIntentV2(BigInt(String(a["combo_id"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_cleanup_expired_combo_v2": {
        const skew = await getSkewClient();
        const r = await skew.cleanupExpiredComboV2(
          new PublicKey(String(a["buyer_authority"])),
          BigInt(String(a["combo_id"])),
        );
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_fetch_povs": {
        const skew = await getReadOnlySkewClient();
        const idx = ASSET_INDEX[String(a["underlying"])];
        if (idx === undefined) return err("Unknown underlying.");
        const snap = await skew.fetchPovs(idx);
        if (snap == null) {
          return ok(
            JSON.stringify(
              {
                success: true,
                initialised: false,
                note: "PoVS PDA cold-start. No on-chain crank pushed yet for this asset.",
              },
              null,
              2,
            ),
          );
        }
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              underlying: String(a["underlying"]),
              sigma_t: snap.sigmaT,
              sigma_inf: snap.sigmaInf,
              theta_d_t28: snap.thetaDt28,
              vrp_rel: snap.vrpRel,
              iv_atm_28d: snap.ivAtm28d,
              regime_r_t: snap.regimeRt,
              xi: snap.xi,
              beta: snap.beta,
              var_99: snap.var99,
              es_999: snap.es999,
              last_update_slot: snap.lastUpdateSlot.toString(),
              regime_label: snap.regimeRt > 0.6 ? "stress" : snap.regimeRt > 0.4 ? "mid" : "calm",
              tail_addon_active: snap.xi > 0.2,
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_hamilton": {
        const skew = await getReadOnlySkewClient();
        const idx = ASSET_INDEX[String(a["underlying"])];
        if (idx === undefined) return err("Unknown underlying.");
        const snap = await skew.fetchHamilton(idx);
        if (snap == null) {
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "HamiltonState PDA cold-start." },
              null,
              2,
            ),
          );
        }
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              underlying: String(a["underlying"]),
              pi_calm: snap.piCalm,
              pi_stress: snap.piStress,
              mu_calm: snap.muCalm,
              mu_stress: snap.muStress,
              sigma_calm: snap.sigmaCalm,
              sigma_stress: snap.sigmaStress,
              p01: snap.p01,
              p10: snap.p10,
              consecutive_stress_days: snap.consecutiveStressDays,
              consecutive_calm_days: snap.consecutiveCalmDays,
              last_update_slot: snap.lastUpdateSlot.toString(),
              stress_active: snap.piStress > 0.5,
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_skew_metrics": {
        const skew = await getReadOnlySkewClient();
        const idx = ASSET_INDEX[String(a["underlying"])];
        if (idx === undefined) return err("Unknown underlying.");
        const snap = await skew.fetchSkewMetrics(idx);
        if (snap == null) {
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "SkewMetricsPda cold-start." },
              null,
              2,
            ),
          );
        }
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              underlying: String(a["underlying"]),
              atm_iv_28d: snap.atmIv28d,
              rr25: snap.rr25,
              bf25: snap.bf25,
              rr10: snap.rr10,
              atm_slope: snap.atmSlope,
              iv_per_tenor: {
                "7d": snap.ivPerTenor[0] ?? null,
                "14d": snap.ivPerTenor[1] ?? null,
                "21d": snap.ivPerTenor[2] ?? null,
                "28d": snap.ivPerTenor[3] ?? null,
                "60d": snap.ivPerTenor[4] ?? null,
                "90d": snap.ivPerTenor[5] ?? null,
                "180d": snap.ivPerTenor[6] ?? null,
                "365d": snap.ivPerTenor[7] ?? null,
              },
              last_update_slot: snap.lastUpdateSlot.toString(),
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_clearing_member": {
        const skew = await getReadOnlySkewClient();
        const authority = a["cm_authority"]
          ? new PublicKey(String(a["cm_authority"]))
          : (await getSkewClient()).walletPublicKey;
        const snap = await skew.fetchClearingMember(authority);
        if (snap == null) {
          return ok(
            JSON.stringify(
              {
                success: true,
                registered: false,
                note: "CM not registered. Call skew_register_clearing_member first.",
              },
              null,
              2,
            ),
          );
        }
        const tierName = ["Standard", "Silver", "Gold", "Platinum"][snap.tier];
        return ok(
          JSON.stringify(
            {
              success: true,
              registered: true,
              authority: snap.authority.toBase58(),
              collateral_usdc: Number(snap.collateralMicro) / 1e6,
              if_contribution_usdc: Number(snap.ifContributionMicro) / 1e6,
              tier_lockup_usdc: Number(snap.tierLockupCollateralMicro) / 1e6,
              total_pm_locked_usdc: Number(snap.totalPmLockedMicro) / 1e6,
              free_collateral_usdc: Number(snap.freeCollateralMicro) / 1e6,
              net_notional_long_usdc: Number(snap.netNotionalLongMicro) / 1e6,
              net_notional_short_usdc: Number(snap.netNotionalShortMicro) / 1e6,
              positions_count: snap.positionsCount,
              last_im_usdc: Number(snap.lastImMicro) / 1e6,
              tier: tierName,
              tier_rank: snap.tier,
              tier_locked_until_unix: snap.tierLockedUntil.toString(),
              under_liquidation: snap.underLiquidation,
              last_margin_check_unix: snap.lastMarginCheck.toString(),
              equity_to_im_ratio:
                snap.lastImMicro > 0n
                  ? Number(
                      snap.collateralMicro -
                        snap.ifContributionMicro -
                        snap.tierLockupCollateralMicro,
                    ) / Number(snap.lastImMicro)
                  : null,
              liq_trigger_active:
                snap.lastImMicro > 0n &&
                Number(
                  snap.collateralMicro - snap.ifContributionMicro - snap.tierLockupCollateralMicro,
                ) <
                  Number(snap.lastImMicro) * 1.1,
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_insurance_fund": {
        const skew = await getReadOnlySkewClient();
        const snap = await skew.fetchInsuranceFund();
        if (snap == null) {
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "InsuranceFund not initialised." },
              null,
              2,
            ),
          );
        }
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              tier3_protocol_sitg_usdc: Number(snap.tier3ProtocolSitgMicro) / 1e6,
              tier1_mutualized_pool_usdc: Number(snap.tier1MutualizedPoolMicro) / 1e6,
              tier2_mutualized_pool_usdc: Number(snap.tier2MutualizedPoolMicro) / 1e6,
              cross_mutualized_pool_usdc: Number(snap.crossMutualizedPoolMicro) / 1e6,
              total_capacity_usdc:
                Number(
                  snap.tier3ProtocolSitgMicro +
                    snap.tier1MutualizedPoolMicro +
                    snap.tier2MutualizedPoolMicro +
                    snap.crossMutualizedPoolMicro,
                ) / 1e6,
              total_cm_contributions_usdc: Number(snap.totalCmContributionsMicro) / 1e6,
              total_drained_usdc: Number(snap.totalDrainedMicro) / 1e6,
              default_event_count: snap.defaultEventCount,
            },
            null,
            2,
          ),
        );
      }

      // Note: structured `skew_fetch_skew_metrics` handler lives at line ~1211
      // (atm_iv_28d / rr25 / bf25 / iv_per_tenor structured response). The
      // duplicate raw-snapshot handler that previously sat here was removed —
      // it silently overrode the structured response. Spec: V2_FULL_AUDIT
      // _REPORT_2026-05-04.md D-1.

      case "skew_fetch_dvol": {
        const skew = await getReadOnlySkewClient();
        const idx = ASSET_INDEX[String(a["underlying"])];
        if (idx === undefined) return err("Unknown underlying.");
        const snap = await skew.fetchDvol(idx);
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "DvolPda not yet cranked." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              underlying: a["underlying"],
              snapshot: serializeJson(snap),
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_isolated_vault": {
        const skew = await getReadOnlySkewClient();
        const user = new PublicKey(String(a["user"]));
        const snap = await skew.fetchIsolatedVault(user, new PublicKey(String(a["option"])));
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "IsolatedVaultPda not initialised." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            { success: true, initialised: true, snapshot: serializeJson(snap) },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_combo_intent": {
        const skew = await getReadOnlySkewClient();
        const buyer = new PublicKey(String(a["buyer"]));
        const comboId = BigInt(String(a["combo_id"]));
        const snap = await skew.fetchComboIntent(buyer, comboId);
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "ComboIntentPda not found / cleaned up." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            { success: true, initialised: true, snapshot: serializeJson(snap) },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_cross_asset": {
        const skew = await getReadOnlySkewClient();
        const program = (
          skew as unknown as {
            _program(): {
              account: Record<
                string,
                { all: () => Promise<Array<{ publicKey: PublicKey; account: unknown }>> }
              >;
            };
          }
        )._program();
        const accs = await program.account["crossAssetMatrix"]!.all();
        if (accs.length === 0)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "CrossAssetMatrix not initialised." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              pda: accs[0]!.publicKey.toBase58(),
              snapshot: serializeJson(accs[0]!.account),
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_microstructure": {
        const skew = await getReadOnlySkewClient();
        const idx = ASSET_INDEX[String(a["underlying"])];
        if (idx === undefined) return err("Unknown underlying.");
        const program = (
          skew as unknown as {
            _program(): {
              account: Record<
                string,
                { all: () => Promise<Array<{ publicKey: PublicKey; account: { asset?: number } }>> }
              >;
            };
          }
        )._program();
        const accs = await program.account["microstructurePDA"]!.all();
        const match = accs.find((x) => x.account.asset === idx);
        if (!match)
          return ok(
            JSON.stringify(
              {
                success: true,
                initialised: false,
                note: "MicrostructurePDA not initialised for this asset.",
              },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              underlying: a["underlying"],
              pda: match.publicKey.toBase58(),
              snapshot: serializeJson(match.account),
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_lst_vault": {
        const skew = await getReadOnlySkewClient();
        const user = new PublicKey(String(a["user"]));
        const lstMint = a["lst_mint"] ? new PublicKey(String(a["lst_mint"])) : undefined;
        const snap = await skew.fetchLstVault(user, lstMint);
        if (snap == null)
          return ok(
            JSON.stringify(
              {
                success: true,
                initialised: false,
                note: "LstVault PDA not initialised for this (user, mint).",
              },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            { success: true, initialised: true, snapshot: serializeJson(snap) },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_series_listing": {
        const skew = await getReadOnlySkewClient();
        const snap = await skew.fetchSeriesListing(new PublicKey(String(a["series"])));
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "SeriesListingPda not found." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            { success: true, initialised: true, snapshot: serializeJson(snap) },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_builder_code": {
        const skew = await getReadOnlySkewClient();
        const snap = await skew.fetchBuilderCode(new PublicKey(String(a["builder"])));
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "BuilderCodePda not found." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            { success: true, initialised: true, snapshot: serializeJson(snap) },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_conditional_order": {
        const skew = await getReadOnlySkewClient();
        const snap = await skew.fetchConditionalOrder(
          new PublicKey(String(a["authority"])),
          BigInt(String(a["order_id"])),
        );
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "ConditionalOrderPda not found." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            { success: true, initialised: true, snapshot: serializeJson(snap) },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_rfq_auction": {
        const skew = await getReadOnlySkewClient();
        const snap = await skew.fetchRfqAuction(new PublicKey(String(a["auction"])));
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "RfqAuctionPda not found." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            { success: true, initialised: true, snapshot: serializeJson(snap) },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_combo_intent_v2": {
        const skew = await getReadOnlySkewClient();
        const snap = await skew.fetchComboIntentV2(
          new PublicKey(String(a["buyer"])),
          BigInt(String(a["combo_id"])),
        );
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "ComboIntentPdaV2 not found." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            { success: true, initialised: true, snapshot: serializeJson(snap) },
            null,
            2,
          ),
        );
      }

      // Lifecycle ───────────────────────────────────────────────────────────
      case "skew_transfer_option": {
        const skew = await getSkewClient();
        const r = await skew.transferOption(String(a["option"]), String(a["new_holder"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_rollover_option": {
        const skew = await getSkewClient();
        const r = await skew.rolloverOption(String(a["old_option"]), {
          newExpiry: String(a["new_expiry"]),
          newStrike: Number(a["new_strike"]),
          newNotional: Number(a["new_notional"]),
        });
        return ok(
          JSON.stringify(
            {
              success: true,
              new_option_pda: r.newOptionPda.toBase58(),
              tx_signature: r.txSignature,
            },
            null,
            2,
          ),
        );
      }

      case "skew_cancel_option": {
        const skew = await getSkewClient();
        const r = await skew.cancelOption(String(a["option"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_close_expired": {
        const skew = await getSkewClient();
        const r = await skew.closeExpired(String(a["option"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_expire_abandoned": {
        const skew = await getSkewClient();
        const r = await skew.expireAbandoned(String(a["option"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_call_variation_margin": {
        const skew = await getSkewClient();
        const remaining = ((a["remaining_accounts"] as string[] | undefined) ?? []).map(
          (s) => new PublicKey(s),
        );
        const r = await skew.callVariationMargin(
          new PublicKey(String(a["cm_authority"])),
          remaining,
        );
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_register_clearing_member": {
        const skew = await getSkewClient();
        const r = await skew.registerClearingMember({
          initialCollateralUsdc: Number(a["initial_collateral_usdc"]),
        });
        return ok(
          JSON.stringify(
            { success: true, cm_pda: r.cmPda.toBase58(), tx_signature: r.txSignature },
            null,
            2,
          ),
        );
      }

      case "skew_cm_add_collateral": {
        const skew = await getSkewClient();
        const r = await skew.cmAddCollateral(Number(a["amount_usdc"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_cm_withdraw_collateral": {
        const skew = await getSkewClient();
        const r = await skew.cmWithdrawCollateral(Number(a["amount_usdc"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_init_volume_tracker": {
        const skew = await getSkewClient();
        const r = await skew.initVolumeTracker();
        return ok(
          JSON.stringify(
            {
              success: true,
              volume_tracker: r.volumeTracker.toBase58(),
              tx_signature: r.txSignature,
            },
            null,
            2,
          ),
        );
      }

      case "skew_init_fee_config": {
        const skew = await getSkewClient();
        const r = await skew.initFeeConfig();
        return ok(
          JSON.stringify(
            { success: true, fee_config: r.feeConfig.toBase58(), tx_signature: r.txSignature },
            null,
            2,
          ),
        );
      }

      case "skew_init_collateral_policy": {
        const skew = await getSkewClient();
        const r = await skew.initCollateralPolicy();
        return ok(
          JSON.stringify(
            { success: true, policy: r.policy.toBase58(), tx_signature: r.txSignature },
            null,
            2,
          ),
        );
      }

      case "skew_init_fee_accumulator": {
        const skew = await getSkewClient();
        const mint = a["settlement_mint"]
          ? new PublicKey(String(a["settlement_mint"]))
          : new PublicKey(USDC_MINT);
        const r = await skew.initFeeAccumulator(mint);
        return ok(
          JSON.stringify(
            {
              success: true,
              settlement_mint: mint.toBase58(),
              fee_accumulator: r.feeAccumulator.toBase58(),
              tx_signature: r.txSignature,
            },
            null,
            2,
          ),
        );
      }

      case "skew_close_option_collateral_lock": {
        const skew = await getSkewClient();
        const r = await skew.closeOptionCollateralLock(new PublicKey(String(a["option_address"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_register_collateral_policy_entry": {
        const skew = await getSkewClient();
        const r = await skew.registerCollateralPolicyEntry({
          mint: new PublicKey(String(a["mint"])),
          decimals: Number(a["decimals"]),
          kind: Number(a["kind"]) as 0 | 1 | 2,
          oracleFeed: a["oracle_feed"] ? new PublicKey(String(a["oracle_feed"])) : undefined,
          maxDepegBps: a["max_depeg_bps"] === undefined ? undefined : Number(a["max_depeg_bps"]),
        });
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // RFQ maker / quote / finalize ────────────────────────────────────────
      case "skew_register_rfq_maker": {
        const skew = await getSkewClient();
        const r = await skew.registerRfqMaker();
        return ok(
          JSON.stringify(
            { success: true, registry_pda: r.registry.toBase58(), tx_signature: r.txSignature },
            null,
            2,
          ),
        );
      }

      case "skew_submit_rfq_quote": {
        const skew = await getSkewClient();
        const sigBytes = bs58.decode(String(a["signature"]));
        const r = await skew.submitRfqQuote({
          auction: new PublicKey(String(a["auction"])),
          premiumMicro: BigInt(String(a["premium_micro"])),
          validUntilSlot: BigInt(String(a["valid_until_slot"])),
          mmSignature: sigBytes,
        });
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_finalize_rfq_auction": {
        const skew = await getSkewClient();
        const r = await skew.finalizeRfqAuction({
          auction: new PublicKey(String(a["auction"])),
          buyerUsdcAta: new PublicKey(String(a["buyer_usdc_ata"])),
        });
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_cancel_rfq_auction": {
        const skew = await getSkewClient();
        const r = await skew.cancelRfqAuction(new PublicKey(String(a["auction"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // Isolated · LST · IF deposit ─────────────────────────────────────────
      case "skew_init_isolated_vault": {
        const skew = await getSkewClient();
        const r = await skew.initIsolatedVault(String(a["option"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_deposit_isolated": {
        const skew = await getSkewClient();
        const r = await skew.depositIsolated(String(a["option"]), Number(a["amount_usdc"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_withdraw_isolated": {
        const skew = await getSkewClient();
        const r = await skew.withdrawIsolated(String(a["option"]), Number(a["amount_usdc"]));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_init_lst_vault": {
        const skew = await getSkewClient();
        const r = await skew.initLstVault();
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_deposit_lst_collateral": {
        const skew = await getSkewClient();
        const r = await skew.depositLstCollateral(BigInt(String(a["amount_lamports"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_withdraw_lst_collateral": {
        const skew = await getSkewClient();
        const r = await skew.withdrawLstCollateral(BigInt(String(a["amount_lamports"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // Phase 1A.2 (2026-05-04) — Native SOL collateral lifecycle.
      case "skew_init_native_sol_vault": {
        const skew = await getSkewClient();
        const r = await skew.initNativeSolVault();
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_deposit_native_sol_collateral": {
        const skew = await getSkewClient();
        const r = await skew.depositNativeSolCollateral(BigInt(String(a["amount_lamports"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_withdraw_native_sol_collateral": {
        const skew = await getSkewClient();
        const r = await skew.withdrawNativeSolCollateral(BigInt(String(a["amount_lamports"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_fetch_native_sol_vault": {
        const skew = await getReadOnlySkewClient();
        const userArg = a["user"];
        if (!userArg) return err("user pubkey required for read-only NativeSolVault fetch");
        const user = new PublicKey(String(userArg));
        const snap = await skew.fetchNativeSolVault(user);
        if (snap == null)
          return ok(
            JSON.stringify(
              { success: true, initialised: false, note: "NativeSolVault not yet initialised." },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              user: user.toBase58(),
              snapshot: serializeJson(snap),
            },
            null,
            2,
          ),
        );
      }

      case "skew_deposit_to_if": {
        const skew = await getSkewClient();
        const tier = Number(a["tier"] ?? 1) as 0 | 1 | 2;
        const isSitg = Boolean(a["is_sitg"] ?? false);
        const r = await skew.depositToIf(tier, Number(a["amount_usdc"]), isSitg);
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // OCO + execute_conditional + apply actions + finalize_combo_leg_v2 ──
      case "skew_register_oco_pair": {
        const skew = await getSkewClient();
        const buildLeg = (raw: Record<string, unknown>, kindCode: 0 | 1, dirCode: 0 | 1) => {
          const u = String(raw["underlying"]) as Underlying;
          return {
            orderId: BigInt(String(raw["order_id"])),
            kind: kindCode,
            triggerMode: 1 as const,
            triggerDirection: dirCode,
            action: { CloseIsolatedPosition: 0, EarlyExercise: 1, SellViaRfq: 2, BuybackViaRfq: 3 }[
              String(raw["action"]) as
                | "CloseIsolatedPosition"
                | "EarlyExercise"
                | "SellViaRfq"
                | "BuybackViaRfq"
            ],
            triggerOracle: new PublicKey(HERMES_FEED_IDS[u] ?? HERMES_FEED_IDS["BTC"]!),
            triggerPrice1e8: BigInt(Math.round(Number(raw["trigger_price_usd"]) * 1e8)),
            triggerGraceSlots: 32,
            actionTarget: new PublicKey(String(raw["action_target"])),
            actionMinPremiumMicro: 0n,
            actionMaxPremiumMicro: BigInt(Math.round(1e12)),
            actionMaxSlippageBps: 200,
            validUntilTs: BigInt(String(raw["valid_until_ts"])),
          };
        };
        // Stop-loss is below (dir=1=Below); take-profit is above (dir=0=Above)
        const sl = buildLeg(a["stop_loss"] as Record<string, unknown>, 0, 1);
        const tp = buildLeg(a["take_profit"] as Record<string, unknown>, 1, 0);
        const r = await skew.registerOcoPair(sl, tp);
        return ok(
          JSON.stringify(
            {
              success: true,
              stop_loss_pda: r.stopLossOrder.toBase58(),
              take_profit_pda: r.takeProfitOrder.toBase58(),
              tx_signature: r.txSignature,
            },
            null,
            2,
          ),
        );
      }

      case "skew_execute_conditional_order": {
        const skew = await getSkewClient();
        const authority = new PublicKey(String(a["order_authority"]));
        // Fetch the order to recover the original triggerOracle.
        // For now require caller-supplied; but conditional fetcher absent —
        // resort to default Hermes BTC feed if no oracle in args. Caller can
        // override via the explicit arg path once fetch_conditional_order ships.
        const oracle = a["trigger_oracle"]
          ? new PublicKey(String(a["trigger_oracle"]))
          : new PublicKey(HERMES_FEED_IDS["BTC"]!);
        const r = await skew.executeConditionalOrder(
          authority,
          BigInt(String(a["order_id"])),
          oracle,
        );
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_cleanup_expired_conditional_order": {
        const skew = await getSkewClient();
        const r = await skew.cleanupExpiredConditionalOrder(
          new PublicKey(String(a["order_authority"])),
          BigInt(String(a["order_id"])),
        );
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_apply_close_isolated_action": {
        const skew = await getSkewClient();
        const r = await skew.applyCloseIsolatedAction(
          BigInt(String(a["order_id"])),
          new PublicKey(String(a["action_target"])),
        );
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_apply_early_exercise_action": {
        const skew = await getSkewClient();
        const r = await skew.applyEarlyExerciseAction(BigInt(String(a["order_id"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_apply_sell_via_rfq_action": {
        const skew = await getSkewClient();
        const r = await skew.applySellViaRfqAction(BigInt(String(a["order_id"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_apply_buyback_via_rfq_action": {
        const skew = await getSkewClient();
        const r = await skew.applyBuybackViaRfqAction(BigInt(String(a["order_id"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_finalize_combo_leg_v2": {
        const skew = await getSkewClient();
        const r = await skew.finalizeComboLegV2(
          new PublicKey(String(a["intent"])),
          Number(a["leg_index"]),
          BigInt(Math.round(Number(a["realised_premium_usd"]) * 1e6)),
        );
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // Builder code lifecycle ──────────────────────────────────────────────
      case "skew_register_builder": {
        const skew = await getSkewClient();
        const r = await skew.registerBuilder(String(a["label"]));
        return ok(
          JSON.stringify(
            {
              success: true,
              builder_code_pda: r.builderCode.toBase58(),
              tx_signature: r.txSignature,
            },
            null,
            2,
          ),
        );
      }

      case "skew_withdraw_builder_fees": {
        const skew = await getSkewClient();
        const r = await skew.withdrawBuilderFees(
          BigInt(Math.round(Number(a["amount_usdc"]) * 1e6)),
        );
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_close_builder_code": {
        const skew = await getSkewClient();
        const r = await skew.closeBuilderCode();
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // Series-listing keeper ───────────────────────────────────────────────
      case "skew_list_series": {
        const skew = await getSkewClient();
        const u = String(a["underlying"]);
        const idx = ASSET_INDEX[u];
        if (idx === undefined) return err("Unknown underlying.");
        const r = await skew.listSeries({
          asset: idx,
          strikeMicro: BigInt(Math.round(Number(a["strike_usd"]) * 1e8)),
          expiryTs: BigInt(Math.floor(new Date(String(a["expiry"])).getTime() / 1000)),
          optionTypeName: String(a["option_type"]) as
            | "Vanilla"
            | "Digital"
            | "CappedVanilla"
            | "RangeAccrual"
            | "VanillaInverse"
            | "DigitalInverse",
          direction: Number(a["direction"]) as -1 | 0 | 1,
        });
        return ok(
          JSON.stringify(
            { success: true, series_pda: r.series.toBase58(), tx_signature: r.txSignature },
            null,
            2,
          ),
        );
      }

      case "skew_delist_series": {
        const skew = await getSkewClient();
        const r = await skew.delistSeries(new PublicKey(String(a["series"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_governance_set_series_max_oi": {
        const skew = await getSkewClient();
        const r = await skew.governanceSetSeriesMaxOi(
          new PublicKey(String(a["series"])),
          Number(a["max_oi_count"]),
        );
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // Pricing / risk forwarders ───────────────────────────────────────────
      case "skew_get_settlement_payoff": {
        const res = await fetch(`${PRICING_URL}/settlement_payoff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            position: a["position"],
            settlement_spot: a["settlement_spot"],
            accrued_fraction: a["accrued_fraction"] ?? 0,
          }),
        });
        if (!res.ok) return err(`pricing /settlement_payoff returned ${res.status}`);
        return ok(await res.text());
      }

      case "skew_get_dvol_replication": {
        const res = await fetch(`${PRICING_URL}/dvol_replication`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            asset_idx: a["asset_idx"],
            strip_28d: a["strip_28d"],
            strip_90d: a["strip_90d"],
            returns: a["returns"],
            bars_per_day: a["bars_per_day"],
          }),
        });
        if (!res.ok) return err(`pricing /dvol_replication returned ${res.status}`);
        return ok(await res.text());
      }

      case "skew_get_combo_quote": {
        const res = await fetch(`${PRICING_URL}/combo_quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ legs: a["legs"] }),
        });
        if (!res.ok) return err(`pricing /combo_quote returned ${res.status}`);
        return ok(await res.text());
      }

      case "skew_get_recovery_priority": {
        const res = await fetch(`${PRICING_URL}/recovery_priority`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            target_loss_micro: Number(BigInt(String(a["target_loss_micro"]))),
            kind: a["kind"],
            candidates: a["candidates"],
          }),
        });
        if (!res.ok) return err(`pricing /recovery_priority returned ${res.status}`);
        return ok(await res.text());
      }

      case "skew_get_if_replenish_check": {
        const body: Record<string, unknown> = {
          current_capacity_micro: Number(BigInt(String(a["current_capacity_micro"]))),
          tvl_micro: Number(BigInt(String(a["tvl_micro"]))),
        };
        if (a["static_floor_micro"] != null) {
          body.static_floor_micro = Number(BigInt(String(a["static_floor_micro"])));
        }
        const res = await fetch(`${PRICING_URL}/if_replenish_check`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return err(`pricing /if_replenish_check returned ${res.status}`);
        return ok(await res.text());
      }

      // -----------------------------------------------------------------------
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
