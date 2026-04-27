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
  SkewClient,
  SKEW_PROGRAM_ID,
  type Underlying,
  type PayoffType,
} from "@skew-labs/sdk";
import { SKEW_TOOLS } from "./tools.js";

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------
const RPC_URL = process.env["SKEW_RPC_URL"] ?? "https://api.devnet.solana.com";
const PRICING_URL =
  process.env["SKEW_PRICING_URL"] ?? "https://skew-pricing.fly.dev";
const PRIVATE_KEY_B58 = process.env["SKEW_PRIVATE_KEY"] ?? "";
const USDC_MINT =
  process.env["SKEW_DEVNET_USDC_MINT"] ??
  "4T2KU8PXd25XvMh6kzv3F7d55yPP6NcS7HemERBe97K8";

// Pyth Hermes feed IDs for spot price queries
const HERMES_FEED_IDS: Record<string, string> = {
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  XRP: "ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
};

// Baseline ATM IV by asset — used when caller does not supply an explicit IV.
// These are advisory starting points; integrators that need live IV should
// consume on-chain price data and back-solve with /fit_iv.
const ASSET_BASELINE_IV: Record<string, number> = {
  BTC: 0.55,
  ETH: 0.65,
  SOL: 0.85,
  XRP: 0.85,
  HYPE: 1.30,
};

// Standard expiry ladder for term-structure responses.
const TERM_LADDER_DAYS = [7, 14, 30, 60, 90, 180];

// Standard delta-anchored strike multipliers for smile responses (5 strikes).
// Roughly 25-delta put / 10-delta put / ATM / 10-delta call / 25-delta call
// at typical short-dated IVs. Caller can pass custom strikes if needed.
const SMILE_STRIKE_MULTIPLIERS = [0.85, 0.93, 1.00, 1.07, 1.15];

// ---------------------------------------------------------------------------
// SkewClient — lazy init, requires SKEW_PRIVATE_KEY for write tools
// ---------------------------------------------------------------------------
let _skew: SkewClient | null = null;

async function getSkewClient(): Promise<SkewClient> {
  if (_skew) return _skew;
  if (!PRIVATE_KEY_B58) {
    throw new Error(
      "SKEW_PRIVATE_KEY not set. Set SKEW_PRIVATE_KEY=<base58 private key> before starting the MCP server.",
    );
  }

  const require = createRequire(import.meta.url);
  // Load IDL from the installed @skew-labs/sdk package
  const idl = require("@skew-labs/sdk/idl/skew_master.json") as Idl;

  const secretBytes = bs58.decode(PRIVATE_KEY_B58);
  const keypair = Keypair.fromSecretKey(secretBytes);
  const wallet = new Wallet(keypair);
  const connection = new Connection(RPC_URL, "confirmed");
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new Program(idl, provider);

  _skew = SkewClient.fromProgram(
    connection,
    wallet,
    program,
    new PublicKey(USDC_MINT),
  );
  return _skew;
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

const PRICING_DISCLAIMER =
  "Suggestion only. Not investment advice. The on-chain program does not read this number; settlement is governed solely by Pyth oracle data.";

async function fetchSpot(
  underlying: string,
): Promise<{ price: number; conf: number }> {
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
  const ALLOWED = new Set([
    "suggested",
    "delta",
    "gamma",
    "vega",
    "theta",
    "rho",
    "confidence",
  ]);
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
const server = new Server(
  { name: "skew", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: SKEW_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
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
        const upperBound =
          a["upperBound"] != null ? Number(a["upperBound"]) : undefined;

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
        const connection = new Connection(RPC_URL, "confirmed");

        const accounts = await connection.getProgramAccounts(SKEW_PROGRAM_ID, {
          dataSlice: { offset: 0, length: 0 },
          filters: [],
        });

        const sliced = accounts.slice(0, limit);
        return ok(
          JSON.stringify(
            {
              total_on_chain: accounts.length,
              returned: sliced.length,
              option_addresses: sliced.map((acc) => acc.pubkey.toBase58()),
              program: SKEW_PROGRAM_ID.toBase58(),
              rpc: RPC_URL,
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
        const strikes = SMILE_STRIKE_MULTIPLIERS.map((m) =>
          Math.round(spot * m),
        );
        const baselineIv = ASSET_BASELINE_IV[underlying] ?? 0.7;
        const raw = await fetchSurface(
          underlying,
          spot,
          strikes,
          [expiryDays],
          baselineIv,
        );
        const surface = applyHeuristicSurface(raw, spot, baselineIv);

        const points = surface.surface
          .filter((p) => p.expiry_days === expiryDays)
          .map((p) => ({
            strike_usd: p.strike,
            iv: Number(p.iv.toFixed(4)),
            delta: Number(p.delta.toFixed(4)),
          }));

        const atm = points.find(
          (p) => Math.abs(p.strike_usd - spot) === Math.min(...points.map((q) => Math.abs(q.strike_usd - spot))),
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
              note:
                "IV across the strike ladder for this expiry. risk_reversal_25d > 0 = call skew (calls richer than puts); < 0 = put skew.",
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
              note:
                "ATM IV across the standard expiry ladder. Compare front (7d) vs back (180d) to read the shape.",
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
        const baselineIv = ASSET_BASELINE_IV[underlying] ?? 0.7;

        const raw = await fetchSurface(
          underlying,
          spot,
          [Math.round(spot * 0.85), Math.round(spot), Math.round(spot * 1.15)],
          [7, 30, 90],
          baselineIv,
        );
        const surface = applyHeuristicSurface(raw, spot, baselineIv);

        const view = classifyVolView(surface.term_structure);
        const atm30d = surface.term_structure.find((t) => t.expiry_days === 30)
          ?.atm_iv ?? baselineIv;

        return ok(
          JSON.stringify(
            {
              underlying,
              spot_usd: spot,
              spot_confidence_usd: conf,
              atm_iv_30d: Number(atm30d.toFixed(4)),
              term_structure_summary: {
                front_7d_atm_iv: Number(
                  (surface.term_structure.find((t) => t.expiry_days === 7)
                    ?.atm_iv ?? baselineIv).toFixed(4),
                ),
                mid_30d_atm_iv: Number(atm30d.toFixed(4)),
                back_90d_atm_iv: Number(
                  (surface.term_structure.find((t) => t.expiry_days === 90)
                    ?.atm_iv ?? baselineIv).toFixed(4),
                ),
              },
              risk_reversal_25d: Number(surface.skew["25d_risk_reversal"].toFixed(4)),
              butterfly_25d: Number(surface.skew["25d_butterfly"].toFixed(4)),
              vol_view: view.label,
              vol_view_note: view.note,
              baseline_iv_used: { atm_30d: baselineIv, source: "heuristic-v1" },
              disclaimer: PRICING_DISCLAIMER,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_create_option": {
        const skew = await getSkewClient();
        const result = await skew.create({
          underlying: String(a["underlying"]) as Underlying,
          payoff: String(a["payoff"]) as PayoffType,
          strike: Number(a["strike"]),
          expiry: String(a["expiry"]),
          notional: Number(a["notional"]),
          upperBound:
            a["upperBound"] != null ? Number(a["upperBound"]) : undefined,
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
        const result = await skew.buy(
          String(a["option_address"]),
          Number(a["premium_usd"]),
        );
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
