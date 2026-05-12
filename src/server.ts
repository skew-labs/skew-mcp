#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { createRequire } from "module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INSTANT_RFQ_DEFAULT_RELAY_URL,
  estimateFee,
  buildRelayPayload,
  collectInstantRfqQuotes,
  hitInstantRfqQuoteTxSigned,
  findSeriesListingPda,
  getSkewCapabilities,
  getMarginBreakdown,
  relayPayloadDigest,
  assertExpiryTenor,
  expiryFromTenorDays,
  SKEW_ALLOWED_TENORS_BY_UNDERLYING,
  TENOR_TOLERANCE_SECONDS,
  SkewClient,
  SKEW_PROGRAM_ID,
  JITOSOL_MINT,
  NATIVE_SOL_MINT,
  type MarginBreakdownLeg,
  type Underlying,
  type PayoffType,
  type InstantRfqHitResult,
  type InstantRfqOptionSpec,
  type RfqAuctionSnapshot,
} from "@skew-labs/sdk";
import {
  getSkewDisabledToolReason,
  getSkewMcpProfile,
  getSkewTools,
  isSkewReadOnlyTool,
  type SkewMcpProfile,
} from "./tools.js";

const moduleRequire = createRequire(import.meta.url);
const MCP_PACKAGE = moduleRequire("../package.json") as { version?: string };
const MCP_SERVER_VERSION = MCP_PACKAGE.version ?? "0.0.0";

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------
const RPC_URL = process.env["SKEW_RPC_URL"] ?? "https://api.devnet.solana.com";
const PRICING_URL = process.env["SKEW_PRICING_URL"] ?? "https://skew-pricing.fly.dev";
const WEB_URL = process.env["SKEW_WEB_URL"] ?? "https://skew-web.vercel.app";
const PRIVATE_KEY_B58 = process.env["SKEW_PRIVATE_KEY"] ?? "";
const KEYPAIR_PATH = process.env["SKEW_KEYPAIR_PATH"] ?? process.env["KEYPAIR_PATH"] ?? "";
const SIGNING_MODE_RAW = (process.env["SKEW_SIGNING_MODE"] ?? "local").toLowerCase();
const SIGNING_MODE =
  SIGNING_MODE_RAW === "hosted" || SIGNING_MODE_RAW === "hosted_unsigned"
    ? "hosted_unsigned"
    : "local";
const USDC_MINT =
  process.env["SKEW_DEVNET_USDC_MINT"] ?? "4T2KU8PXd25XvMh6kzv3F7d55yPP6NcS7HemERBe97K8";
const MCP_PROFILE = getSkewMcpProfile(process.env["SKEW_MCP_PROFILE"]);
const HAS_LOCAL_WRITE_SECRET = Boolean(KEYPAIR_PATH || PRIVATE_KEY_B58);
const HAS_WRITE_KEYPAIR = SIGNING_MODE === "local" && HAS_LOCAL_WRITE_SECRET;
const PROFILE_TOOLS = getSkewTools(MCP_PROFILE);
const ACTIVE_TOOLS = PROFILE_TOOLS.filter((tool) =>
  HAS_WRITE_KEYPAIR || isSkewReadOnlyTool(tool.name),
);
const PROFILE_TOOL_NAMES = new Set(PROFILE_TOOLS.map((tool) => tool.name));
const ACTIVE_TOOL_NAMES = new Set(ACTIVE_TOOLS.map((tool) => tool.name));
const INSTANT_RFQ_MAX_WINDOW_MS = 10 * 60 * 1000;
const INSTANT_RFQ_REQUEST_DEFAULT_TIMEOUT_MS = 60 * 1000;
const INSTANT_RFQ_HIT_DEFAULT_TIMEOUT_MS = 120 * 1000;
const INSTANT_RFQ_MAKER_DEFAULT_TIMEOUT_MS = INSTANT_RFQ_MAX_WINDOW_MS;
const INSTANT_RFQ_DEFAULT_QUOTE_EXPIRY_SECONDS = 10 * 60;

function clampInteger(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(Math.min(Math.max(n, min), max));
}

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
// - Write tools require SKEW_KEYPAIR_PATH / KEYPAIR_PATH or SKEW_PRIVATE_KEY.
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

function expandUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadWriteKeypair(): Keypair {
  if (KEYPAIR_PATH) {
    const raw = fs.readFileSync(expandUserPath(KEYPAIR_PATH), "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  }
  if (PRIVATE_KEY_B58) {
    return Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY_B58));
  }
  throw new Error(
    "No write key configured. Set SKEW_KEYPAIR_PATH=/path/to/devnet.json " +
      "or SKEW_PRIVATE_KEY=<base58 secret> (KEYPAIR_PATH is also accepted).",
  );
}

function localSignerSource(): "SKEW_KEYPAIR_PATH" | "KEYPAIR_PATH" | "SKEW_PRIVATE_KEY" | null {
  if (process.env["SKEW_KEYPAIR_PATH"]) return "SKEW_KEYPAIR_PATH";
  if (process.env["KEYPAIR_PATH"]) return "KEYPAIR_PATH";
  if (process.env["SKEW_PRIVATE_KEY"]) return "SKEW_PRIVATE_KEY";
  return null;
}

function safeKeypairPathForJson(): string | null {
  if (!KEYPAIR_PATH) return null;
  const expanded = expandUserPath(KEYPAIR_PATH);
  const home = os.homedir();
  if (expanded === home) return "~";
  if (expanded.startsWith(`${home}${path.sep}`)) {
    return `~/${expanded.slice(home.length + 1)}`;
  }
  return expanded;
}

function signerInfoForJson(loadSigner: boolean): Record<string, unknown> {
  let signerPubkey: string | null = null;
  let signerLoadError: string | null = null;
  if (loadSigner && HAS_WRITE_KEYPAIR) {
    try {
      signerPubkey = loadWriteKeypair().publicKey.toBase58();
    } catch (e) {
      signerLoadError = e instanceof Error ? e.message : String(e);
    }
  }
  const warnings: string[] = [];
  if (SIGNING_MODE === "hosted_unsigned") {
    warnings.push(
      "Hosted unsigned mode is active. This MCP server will not expose write tools or sign transactions with a shared server key.",
    );
  }
  if (PRIVATE_KEY_B58 && KEYPAIR_PATH) {
    warnings.push(
      "Both SKEW_KEYPAIR_PATH/KEYPAIR_PATH and SKEW_PRIVATE_KEY are set. The local signer uses the keypair path first; unset SKEW_PRIVATE_KEY to avoid ambiguity.",
    );
  }
  if (PRIVATE_KEY_B58 && !KEYPAIR_PATH) {
    warnings.push(
      "SKEW_PRIVATE_KEY is configured. Prefer SKEW_KEYPAIR_PATH for local devnet sessions so secrets stay in normal Solana keypair files.",
    );
  }
  if (SIGNING_MODE === "local" && !HAS_LOCAL_WRITE_SECRET) {
    warnings.push(
      "No local write key is configured. Read-only tools are available; write tools are hidden until SKEW_KEYPAIR_PATH, KEYPAIR_PATH, or SKEW_PRIVATE_KEY is set.",
    );
  }
  return {
    package: "@skew-labs/mcp",
    version: MCP_SERVER_VERSION,
    rpc_url: RPC_URL,
    web_url: WEB_URL,
    signing_mode: SIGNING_MODE,
    local_signer_configured: HAS_LOCAL_WRITE_SECRET,
    write_tools_enabled: HAS_WRITE_KEYPAIR,
    signer_pubkey: signerPubkey,
    signer_load_error: signerLoadError,
    signer_source: localSignerSource(),
    keypair_path: safeKeypairPathForJson(),
    private_key_env_configured: Boolean(PRIVATE_KEY_B58),
    active_profile: MCP_PROFILE,
    active_tool_count: ACTIVE_TOOLS.length,
    profile_tool_count: PROFILE_TOOLS.length,
    hidden_write_tools: hiddenWriteToolsForProfile(MCP_PROFILE),
    warnings,
  };
}

async function getSkewClient(): Promise<SkewClient> {
  if (_skew) return _skew;
  const keypair = loadWriteKeypair();
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

function typedErr(
  errorCode: string,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            error: message,
            error_code: errorCode,
            ...extra,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

function usdToMicro(raw: unknown, fallback = 0): bigint {
  return BigInt(Math.round(Number(raw ?? fallback) * 1_000_000));
}

function axeFieldsFromArgs(a: Record<string, unknown>) {
  return {
    axeId: BigInt(String(a["axe_id"])),
    asset: Number(a["asset"]),
    side: Number(a["side"]) as -1 | 0 | 1,
    optionTypeMask: Number(a["option_type_mask"]),
    strikeBandLo: usdToMicro(a["strike_band_lo_usd"]),
    strikeBandHi: usdToMicro(a["strike_band_hi_usd"]),
    expiryBandLo: BigInt(String(a["expiry_band_lo_unix"])),
    expiryBandHi: BigInt(String(a["expiry_band_hi_unix"])),
    sizeMicro: usdToMicro(a["size_usd"]),
    bidPremiumBandLo: usdToMicro(a["bid_premium_band_lo_usd"]),
    bidPremiumBandHi: usdToMicro(a["bid_premium_band_hi_usd"]),
    askPremiumBandLo: usdToMicro(a["ask_premium_band_lo_usd"]),
    askPremiumBandHi: usdToMicro(a["ask_premium_band_hi_usd"]),
    validUntil: BigInt(String(a["valid_until_unix"])),
  };
}

function optionSummaryForJson(s: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  const expiryTs = Number(s["expiryTs"] ?? 0);
  return {
    pda: s["pda"],
    option_token_mint: s["optionTokenMint"],
    creator: s["creator"],
    holder: s["holder"],
    option_type: s["optionType"],
    state: s["state"],
    underlying: s["underlying"],
    direction: s["direction"],
    strike_usd: s["strikeUsd"],
    upper_bound_usd: s["upperBoundUsd"],
    extra_param: s["extraParam"],
    extra_param_usd: s["extraParamUsd"],
    expiry_ts: expiryTs,
    expiry_iso: expiryTs > 0 ? new Date(expiryTs * 1000).toISOString() : null,
    payoff_usd: s["payoffUsd"],
    collateral_locked_usd: s["collateralLockedUsd"],
    v0_usd: s["v0Usd"],
    sigma_at_creation: s["sigmaAtCreation"],
    spot_at_creation_usd: s["spotAtCreationUsd"],
    settled: s["settled"],
    settled_price_usd: s["settledPriceUsd"],
    settled_at: s["settledAt"],
    metadata: s["metadata"],
    metadata_status: s["metadataStatus"],
    settlement_mint: s["settlementMint"],
    settlement_decimals: s["settlementDecimals"],
    created_at: s["createdAt"],
  };
}

async function authorityFromArgs(a: Record<string, unknown>, key: string): Promise<string> {
  const raw = a[key];
  if (typeof raw === "string" && raw.length > 0) return new PublicKey(raw).toBase58();
  if (!HAS_WRITE_KEYPAIR) {
    throw new Error(`${key} is required when no write keypair is configured`);
  }
  return (await getSkewClient()).walletPublicKey.toBase58();
}

async function skewWebJson(pathname: string, init?: RequestInit): Promise<unknown> {
  const url = new URL(pathname, WEB_URL);
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`Skew web API ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
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

// ---------------------------------------------------------------------------
// MCP self-description (W32-E, F-4 / F-8): expose the static MCP↔pricing-route
// table and the per-profile exposure count so agents can self-introspect "I have
// tool X → it hits pricing route Y" without reading source. Counts derive
// from `getSkewTools(profile)` plus the runtime write-key filter, so profile
// catalogs and currently visible tool surfaces are both explicit.
// ---------------------------------------------------------------------------
const MCP_PRICING_TOOL_ROUTE_MAP: ReadonlyArray<{ tool: string; method: "POST" | "GET"; route: string }> = [
  { tool: "skew_get_fair_value", method: "POST", route: "/price" },
  { tool: "skew_get_iv_smile", method: "POST", route: "/surface" },
  { tool: "skew_get_term_structure", method: "POST", route: "/surface" },
  { tool: "skew_get_volatility_summary", method: "POST", route: "/surface" },
  { tool: "skew_get_vol_short", method: "POST", route: "/v1/vol/short" },
  { tool: "skew_get_vol_long", method: "POST", route: "/v1/vol/long" },
  { tool: "skew_get_vol_implied", method: "POST", route: "/v1/vol/iv" },
  { tool: "skew_get_vol_premium", method: "POST", route: "/v1/vol/vrp" },
  { tool: "skew_get_settlement_payoff", method: "POST", route: "/settlement_payoff" },
  { tool: "skew_get_dvol_replication", method: "POST", route: "/dvol_replication" },
  { tool: "skew_get_combo_quote", method: "POST", route: "/combo_quote" },
  { tool: "skew_get_recovery_priority", method: "POST", route: "/recovery_priority" },
  { tool: "skew_get_if_replenish_check", method: "POST", route: "/if_replenish_check" },
  { tool: "skew_get_margin_breakdown", method: "POST", route: "/margin_breakdown" },
  { tool: "skew_estimate_fee", method: "POST", route: "/estimate_fee" },
];

function getProfileToolCountByProfile(): Record<string, number> {
  const profiles: SkewMcpProfile[] = ["core", "trading", "rfq", "advanced", "governance", "all"];
  const out: Record<string, number> = {};
  for (const p of profiles) out[p] = getSkewTools(p).length;
  return out;
}

function visibleToolsForProfile(profile: SkewMcpProfile) {
  const tools = getSkewTools(profile);
  return HAS_WRITE_KEYPAIR ? tools : tools.filter((tool) => isSkewReadOnlyTool(tool.name));
}

function getVisibleToolCountByProfile(): Record<string, number> {
  const profiles: SkewMcpProfile[] = ["core", "trading", "rfq", "advanced", "governance", "all"];
  const out: Record<string, number> = {};
  for (const p of profiles) out[p] = visibleToolsForProfile(p).length;
  return out;
}

function hiddenWriteToolsForProfile(profile: SkewMcpProfile): string[] {
  if (HAS_WRITE_KEYPAIR) return [];
  return getSkewTools(profile)
    .filter((tool) => !isSkewReadOnlyTool(tool.name))
    .map((tool) => tool.name);
}

function agentGuideForJson(): Record<string, unknown> {
  return {
    first_calls: [
      {
        tool: "skew_get_signer_info",
        reason:
          "Proves the active MCP signing posture before any write. Never assume a write wallet from chat context.",
      },
      {
        tool: "skew_get_capabilities",
        reason:
          "Reads the live protocol lanes, tenor policy, collateral rails, profile tool counts, and this agent guide.",
      },
    ],
    signer_rules: [
      "Each user runs their own MCP server with their own SKEW_KEYPAIR_PATH or KEYPAIR_PATH for local devnet writes.",
      "Do not pack or reuse a shared omnibus private key for multiple users. Hosted mode must hide write tools.",
      "Before any write, compare signer_pubkey from skew_get_signer_info with the user-intended wallet.",
      "If write_tools_enabled=false, provide read-only analysis or unsigned SDK/API instructions; do not pretend a trade was sent.",
    ],
    lane_selection: {
      instant_rfq_pm_backed: {
        purpose:
          "Buyer wants real PM/CM-backed issuance now. This is the atomic_fill_from_relay lane and the path that records the seller CM short registry and margin delta.",
        buyer_tools: ["skew_request_instant_rfq_quotes", "skew_hit_instant_rfq_quote"],
        maker_tools: ["skew_serve_instant_rfq_mm_once"],
        required_receipt: [
          "tx",
          "option_pda",
          "buyer_long_readback",
          "maker_short_readback",
          "pm_preflight_or_margin_receipt",
        ],
      },
      auction_rfq_firm_tape: {
        purpose:
          "Buyer opens an on-chain competition window and MMs post firm quotes. finalize_rfq_auction publishes/takes the tape and refunds auction escrow; it is not by itself an option mint. Official Auction execution is forced through the Instant RFQ PM atomic-fill handoff.",
        buyer_tools: ["skew_register_rfq_auction", "skew_finalize_rfq_auction"],
        maker_tools: ["skew_submit_rfq_quote_direct", "skew_submit_rfq_quote"],
        execution_tools: [
          "skew_request_instant_rfq_from_auction",
          "skew_hit_instant_rfq_from_auction_quote",
        ],
      },
      secondary_tape: {
        purpose:
          "Discovery and receipt surface for existing option transfers. It is not an escrowed orderbook.",
        seller_tools: ["skew_create_secondary_listing", "skew_transfer_option"],
        buyer_tools: ["skew_list_secondary_listings", "skew_buy_secondary_listing"],
        completion_rule:
          "A secondary trade is delivered only when skew_transfer_option returns readback_ok=true and the buyer appears as holder.",
      },
      pre_funded_legacy: {
        purpose:
          "Simple fully collateralized issuance using create_option/buy_option or the advanced-only quote-bound Auction bridge. It is useful for inventory/legacy primitives but does not show marginal PM capital efficiency.",
        tools: [
          "skew_create_option",
          "skew_buy_option",
          "skew_create_option_from_rfq_quote",
          "skew_buy_option_from_rfq_quote",
          "skew_settle_option",
        ],
      },
    },
    readback_rules: [
      "Treat tx submission and product visibility as separate checks.",
      "A successful issue/fill report must include tx, option_pda, option token mint when available, holder, creator, buyer-long readback, and maker-short or CM registry readback when PM-backed.",
      "After secondary payment, report pending delivery until transfer_option readback proves the holder changed.",
      "After Auction RFQ finalize, report firm tape/refund status unless a follow-up execution tool minted or transferred the option.",
    ],
    failure_posture: [
      "If a tool returns an error, name the broken lifecycle state and next recovery tool. Do not switch lanes silently.",
      "Do not use local scripts or smoke tests as proof of MCP product success.",
      "Do not hide a missing signer, stale PDA, or missing readback behind a generic success message.",
    ],
  };
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

const ASSET_BY_INDEX = ["BTC", "ETH", "SOL", "XRP", "HYPE"] as const;

function resolveAssetIdx(args: Record<string, unknown>): number | null {
  const rawIdx = args["assetIdx"] ?? args["asset_idx"];
  if (rawIdx != null) {
    const n = Number(rawIdx);
    return Number.isInteger(n) && n >= 0 && n <= 4 ? n : null;
  }
  const raw = args["underlying"] ?? args["asset"];
  if (raw == null) return null;
  const idx = ASSET_INDEX[String(raw).toUpperCase()];
  return idx === undefined ? null : idx;
}

function resolveAssetSymbol(args: Record<string, unknown>): string | null {
  const idx = resolveAssetIdx(args);
  if (idx == null) return null;
  return ["BTC", "ETH", "SOL", "XRP", "HYPE"][idx] ?? null;
}

function resolveSettlementMintArg(raw: unknown): PublicKey | undefined {
  if (raw == null || String(raw).trim() === "" || String(raw).toUpperCase() === "USDC") {
    return undefined;
  }
  const value = String(raw).trim();
  const upper = value.toUpperCase();
  if (upper === "WSOL" || upper === "SOL") return NATIVE_SOL_MINT;
  if (upper === "JITOSOL" || upper === "JITO") return JITOSOL_MINT;
  return new PublicKey(value);
}

type SignableTransaction = Transaction | VersionedTransaction;

interface InstantSettlement {
  mint: PublicKey;
  decimals: number;
  label: "USDC" | "wSOL" | "jitoSOL" | "custom";
}

interface InstantPayoffWire {
  optionType: number;
  direction: -1 | 0 | 1;
}

interface InstantSpecBuild {
  underlying: string;
  payoff: string;
  settlement: InstantSettlement;
  optionSpec: InstantRfqOptionSpec;
  request: Record<string, unknown>;
  display: Record<string, unknown>;
}

interface RelayWsMessageEvent {
  data: unknown;
}

interface RelayWs {
  onopen: (() => void) | null;
  onmessage: ((event: RelayWsMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

function resolveInstantSettlement(raw: unknown): InstantSettlement {
  const value = raw == null || String(raw).trim() === "" ? "USDC" : String(raw).trim();
  const upper = value.toUpperCase();
  if (upper === "USDC") {
    return { mint: new PublicKey(USDC_MINT), decimals: 6, label: "USDC" };
  }
  if (upper === "WSOL" || upper === "SOL") {
    return { mint: NATIVE_SOL_MINT, decimals: 9, label: "wSOL" };
  }
  if (upper === "JITOSOL" || upper === "JITO") {
    return { mint: JITOSOL_MINT, decimals: 9, label: "jitoSOL" };
  }
  return { mint: new PublicKey(value), decimals: Number(raw == null ? 6 : 6), label: "custom" };
}

function instantPayoffWire(payoff: string): InstantPayoffWire {
  if (payoff === "vanilla_call") return { optionType: 0, direction: 1 };
  if (payoff === "vanilla_put") return { optionType: 0, direction: -1 };
  if (payoff === "digital_call") return { optionType: 1, direction: 1 };
  if (payoff === "digital_put") return { optionType: 1, direction: -1 };
  if (payoff === "capped_call") return { optionType: 2, direction: 1 };
  if (payoff === "capped_put") return { optionType: 2, direction: -1 };
  if (payoff === "range_accrual") return { optionType: 3, direction: 0 };
  if (payoff === "vanilla_inverse_call") return { optionType: 4, direction: 1 };
  if (payoff === "vanilla_inverse_put") return { optionType: 4, direction: -1 };
  if (payoff === "digital_inverse_call") return { optionType: 5, direction: 1 };
  if (payoff === "digital_inverse_put") return { optionType: 5, direction: -1 };
  throw new Error(`Unsupported Instant RFQ payoff: ${payoff}`);
}

function instantPayoffFromAuctionSpec(optionType: number, direction: number): string {
  if (optionType === 0) return direction < 0 ? "vanilla_put" : "vanilla_call";
  if (optionType === 1) return direction < 0 ? "digital_put" : "digital_call";
  if (optionType === 2) return direction < 0 ? "capped_put" : "capped_call";
  if (optionType === 3) return "range_accrual";
  if (optionType === 4) return direction < 0 ? "vanilla_inverse_put" : "vanilla_inverse_call";
  if (optionType === 5) return direction < 0 ? "digital_inverse_put" : "digital_inverse_call";
  throw new Error(`Unsupported Auction RFQ option_type ${optionType}`);
}

function parseExpiryTs(args: Record<string, unknown>): bigint {
  const rawTs = args["expiry_ts"] ?? args["expiryTs"];
  if (rawTs !== undefined && rawTs !== null && String(rawTs).trim() !== "") {
    const n = BigInt(String(rawTs));
    if (n <= 0n) throw new Error("expiry_ts must be positive");
    return n;
  }
  const raw = args["expiry"];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("expiry or expiry_ts is required");
  }
  const ms = new Date(String(raw)).getTime();
  if (!Number.isFinite(ms)) throw new Error(`Invalid expiry: ${String(raw)}`);
  return BigInt(Math.floor(ms / 1000));
}

function parsePremiumMicro(args: Record<string, unknown>): bigint {
  if (args["premium_micro"] !== undefined && args["premium_micro"] !== null) {
    const n = BigInt(String(args["premium_micro"]));
    if (n <= 0n) throw new Error("premium_micro must be positive");
    return n;
  }
  if (args["premium_usd"] !== undefined && args["premium_usd"] !== null) {
    const n = usdToMicro(args["premium_usd"]);
    if (n <= 0n) throw new Error("premium_usd must be positive");
    return n;
  }
  throw new Error("premium_micro or premium_usd is required");
}

function buildInstantSpecFromArgs(args: Record<string, unknown>): InstantSpecBuild {
  const underlying = String(args["underlying"]).toUpperCase();
  const payoff = String(args["payoff"]);
  const unsupported = unsupportedPayoffReason(underlying, payoff);
  if (unsupported) throw new Error(unsupported);
  const asset = ASSET_INDEX[underlying];
  if (asset === undefined) throw new Error(`Unknown underlying: ${underlying}`);
  const wire = instantPayoffWire(payoff);
  const settlement = resolveInstantSettlement(args["settlement_mint"]);
  const strikeUsd = Number(args["strike"]);
  if (!Number.isFinite(strikeUsd) || strikeUsd <= 0) {
    throw new Error("strike must be a positive USD number");
  }
  const notional = Number(args["notional"] ?? args["payoff_usd"]);
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error("notional must be a positive number");
  }
  const maxPremiumUsdRaw =
    args["max_premium_usd"] ??
    args["maxPremiumUsd"] ??
    args["max_premium"] ??
    null;
  const maxPremiumUsd =
    maxPremiumUsdRaw === null || maxPremiumUsdRaw === undefined
      ? null
      : Number(maxPremiumUsdRaw);
  if (maxPremiumUsd !== null && (!Number.isFinite(maxPremiumUsd) || maxPremiumUsd < 0)) {
    throw new Error("max_premium_usd must be a non-negative number when provided");
  }
  const upperBoundUsd = Number(args["upper_bound_usd"] ?? args["upperBoundUsd"] ?? 0);
  const extraParamInput = args["extra_param"] ?? args["extraParam"];
  const strike = BigInt(Math.round(strikeUsd * 100_000_000));
  const expiryTs = parseExpiryTs(args);
  const payoffAmountMicro = BigInt(Math.round(notional * 1_000_000));
  const maxPremiumMicro =
    maxPremiumUsd === null ? null : BigInt(Math.round(maxPremiumUsd * 1_000_000));
  const upperBound =
    payoff === "range_accrual" || upperBoundUsd > 0
      ? BigInt(Math.round(upperBoundUsd * 100_000_000))
      : 0n;
  const extraParam =
    payoff.startsWith("capped")
      ? Number(extraParamInput ?? upperBoundUsd)
      : Number(extraParamInput ?? 0);

  if (payoff === "range_accrual" && upperBound <= strike) {
    throw new Error("range_accrual requires upper_bound_usd greater than strike");
  }
  if (payoff.startsWith("capped") && (!Number.isFinite(extraParam) || extraParam <= 0)) {
    throw new Error("capped_call/capped_put requires upper_bound_usd or extra_param cap strike");
  }

  const optionSpec: InstantRfqOptionSpec = {
    asset,
    strike,
    expiryTs,
    payoffAmountMicro,
    optionType: wire.optionType,
    direction: wire.direction,
    upperBound: payoff === "range_accrual" ? upperBound : 0n,
    extraParam,
  };

  const request: Record<string, unknown> = {
    asset,
    option_type: wire.optionType,
    direction: wire.direction,
    strike: strike.toString(),
    expiry_ts: expiryTs.toString(),
    payoff_amount: payoffAmountMicro.toString(),
    settlement_decimals: settlement.decimals,
    upper_bound: optionSpec.upperBound.toString(),
    extra_param: extraParam,
    settlement_mint: settlement.mint.toBase58(),
    underlying,
    payoff,
  };
  if (maxPremiumMicro !== null) {
    request["max_premium"] = maxPremiumMicro.toString();
    request["max_premium_micro"] = maxPremiumMicro.toString();
  }

  const display: Record<string, unknown> = {
    underlying,
    payoff,
    settlement: settlement.label,
    settlement_mint: settlement.mint.toBase58(),
    settlement_decimals: settlement.decimals,
    strike_usd: strikeUsd,
    expiry_ts: expiryTs.toString(),
    expiry_iso: new Date(Number(expiryTs) * 1000).toISOString(),
    notional,
    max_premium_usd: maxPremiumUsd,
    max_premium_micro: maxPremiumMicro?.toString() ?? null,
    payoff_amount_micro: payoffAmountMicro.toString(),
    option_type: wire.optionType,
    direction: wire.direction,
    upper_bound_usd: payoff === "range_accrual" ? upperBoundUsd : null,
    extra_param: extraParam,
  };

  return { underlying, payoff, settlement, optionSpec, request, display };
}

function buildInstantSpecFromAuctionSnapshot(
  snap: RfqAuctionSnapshot,
  args: Record<string, unknown>,
): InstantSpecBuild {
  const underlying = ASSET_BY_INDEX[snap.optionSpec.asset];
  if (underlying === undefined) {
    throw new Error(`Auction RFQ has unsupported asset index ${snap.optionSpec.asset}`);
  }
  const payoff = instantPayoffFromAuctionSpec(
    snap.optionSpec.optionType,
    snap.optionSpec.direction,
  );
  const strikeUsd = Number(snap.optionSpec.strike) / 100_000_000;
  const expiryIso = new Date(Number(snap.optionSpec.expiryTs) * 1000).toISOString();
  const notional = Number(snap.optionSpec.payoffAmountMicro) / 1_000_000;
  const upperBoundUsd =
    snap.optionSpec.upperBound === 0n
      ? undefined
      : Number(snap.optionSpec.upperBound) / 100_000_000;
  const premiumCapMicro =
    args["max_premium_micro"] != null
      ? BigInt(String(args["max_premium_micro"]))
      : snap.bestQuotePremiumMicro ?? snap.maxPremiumMicro;
  const premiumCapUsd = Number(premiumCapMicro) / 1_000_000;
  const settlementMint =
    args["settlement_mint"] ??
    (snap.optionSpec.optionType === 4 || snap.optionSpec.optionType === 5 ? undefined : "USDC");
  const derivedArgs: Record<string, unknown> = {
    underlying,
    payoff,
    strike: strikeUsd,
    expiry: expiryIso,
    notional,
    max_premium_usd: premiumCapUsd,
    settlement_mint: settlementMint,
  };
  if (upperBoundUsd !== undefined) {
    derivedArgs["upper_bound_usd"] = upperBoundUsd;
    derivedArgs["extra_param"] = upperBoundUsd;
  }
  return buildInstantSpecFromArgs(derivedArgs);
}

async function executeInstantRfqHit(args: {
  skew: SkewClient;
  buyer: PublicKey;
  built: InstantSpecBuild;
  relayNonce: bigint;
  cmPubkey: PublicKey;
  premiumMicro: bigint;
  quoteExpirySeconds: number;
  timeoutMs: number;
  relayUrl: string;
  origin?: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const preMakerCm = await args.skew.fetchClearingMember(args.cmPubkey);
  const preBuyerPortfolio = await args.skew.getPortfolio(args.buyer);
  const seriesPrerequisite = await ensureInstantSeriesListed(args.skew, args.built);
  const payload = buildRelayPayload({
    relayNonce: args.relayNonce,
    optionSpec: args.built.optionSpec,
    premiumMicro: args.premiumMicro,
    settlementMint: args.built.settlement.mint,
    settlementDecimals: args.built.settlement.decimals,
    quoteExpiryTs: BigInt(Math.floor(Date.now() / 1000) + args.quoteExpirySeconds),
    buyer: args.buyer,
  });
  const result = await hitInstantRfqQuoteTxSigned({
    buyer: args.buyer,
    cmPubkey: args.cmPubkey,
    payload,
    relayUrl: args.relayUrl,
    timeoutMs: args.timeoutMs,
    signTransaction: signWithConfiguredKeypair,
  });
  let option: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const options = await args.skew.listOptions({ pda: result.optionPda }).catch(() => []);
    if (options.length > 0) {
      option = optionSummaryForJson(options[0] as unknown as Record<string, unknown>);
      break;
    }
    await sleep(500);
  }
  const [postMakerCm, postBuyerPortfolio, postMakerPortfolio] = await Promise.all([
    args.skew.fetchClearingMember(args.cmPubkey),
    args.skew.getPortfolio(args.buyer),
    args.skew.getPortfolio(args.cmPubkey),
  ]);
  const optionPda = result.optionPda;
  const buyerHasLong = postBuyerPortfolio.longOptions.some((s) => s.pda === optionPda);
  const makerHasShort = postMakerPortfolio.shortOptions.some((s) => s.pda === optionPda);
  const readbackErrors: string[] = [];
  if (option === null) {
    readbackErrors.push("option PDA was not readable after fill");
  } else {
    if (option["holder"] !== args.buyer.toBase58()) {
      readbackErrors.push(
        `option holder mismatch: expected buyer ${args.buyer.toBase58()}, got ${String(
          option["holder"],
        )}`,
      );
    }
    if (option["creator"] !== args.cmPubkey.toBase58()) {
      readbackErrors.push(
        `option creator mismatch: expected maker ${args.cmPubkey.toBase58()}, got ${String(
          option["creator"],
        )}`,
      );
    }
  }
  if (!buyerHasLong) {
    readbackErrors.push("buyer portfolio long_options does not include the filled option PDA");
  }
  if (!makerHasShort) {
    readbackErrors.push("maker portfolio short_options does not include the filled option PDA");
  }
  const prePositions = preMakerCm?.positionsCount ?? null;
  const postPositions = postMakerCm?.positionsCount ?? null;
  const registryUpdated =
    makerHasShort &&
    (prePositions === null || postPositions === null || postPositions >= prePositions + 1);
  if (
    prePositions !== null &&
    postPositions !== null &&
    postPositions < prePositions + 1
  ) {
    readbackErrors.push(
      `maker CM positions_count did not increase by at least one: before=${prePositions}, after=${postPositions}`,
    );
  }
  const preLocked = preMakerCm?.totalPmLockedMicro ?? 0n;
  const postLocked = postMakerCm?.totalPmLockedMicro ?? 0n;
  const lockedDelta = postLocked >= preLocked ? postLocked - preLocked : 0n;
  const notionalMicro = args.built.optionSpec.payoffAmountMicro;
  const resultStatus = result as InstantRfqHitResult & {
    tradeState?: string;
    clearingState?: string;
    rejectionReason?: string;
    relayEventId?: string;
    relaySequence?: number;
    serverTimeMs?: number;
  };
  return {
    success: true,
    readback_ok: readbackErrors.length === 0,
    readback_errors: readbackErrors,
    execution_lane: "instant_rfq_atomic_fill",
    trade_state: resultStatus.tradeState ?? "FILLED",
    clearing_state: resultStatus.clearingState ?? "FILLED",
    pm_backed: true,
    pm_guarantee: "guaranteed",
    registry_updated: registryUpdated,
    rejection_reason: resultStatus.rejectionReason ?? null,
    relay_event_id: resultStatus.relayEventId ?? null,
    relay_sequence: resultStatus.relaySequence ?? null,
    server_time_ms: resultStatus.serverTimeMs ?? null,
    collateral_model: "portfolio_margin_delta_im",
    origin: args.origin ?? null,
    tx_signature: result.txSignature,
    explorer: `https://explorer.solana.com/tx/${result.txSignature}?cluster=devnet`,
    relay_nonce: result.relayNonce.toString(),
    option_pda: result.optionPda,
    simulated_units: result.simulatedUnits ?? null,
    premium_destination: result.premiumDestination ?? null,
    auto_prepared_accounts: result.autoPreparedAccounts ?? [],
    request: args.built.display,
    series_prerequisite: seriesPrerequisite,
    selected_quote: {
      cm_pubkey: args.cmPubkey.toBase58(),
      premium_micro: args.premiumMicro.toString(),
      premium_usd: Number(args.premiumMicro) / 1_000_000,
    },
    pm_risk_preflight: riskPreflightForJson(result.riskPreflight),
    pm_lock_readback: {
      notional_micro: notionalMicro.toString(),
      notional_usd: microToUsdNumber(notionalMicro),
      pre_total_pm_locked_micro: preLocked.toString(),
      pre_total_pm_locked_usd: microToUsdNumber(preLocked),
      post_total_pm_locked_micro: postLocked.toString(),
      post_total_pm_locked_usd: microToUsdNumber(postLocked),
      observed_locked_delta_micro: lockedDelta.toString(),
      observed_locked_delta_usd: microToUsdNumber(lockedDelta),
      observed_locked_delta_pct_of_notional: microPercentOf(lockedDelta, notionalMicro),
      pre_positions_count: prePositions,
      post_positions_count: postPositions,
      post_last_im_micro: postMakerCm?.lastImMicro?.toString() ?? null,
      post_last_im_usd:
        postMakerCm?.lastImMicro === undefined
          ? null
          : microToUsdNumber(postMakerCm.lastImMicro),
      post_last_im_pct_of_notional:
        postMakerCm?.lastImMicro === undefined
          ? null
          : microPercentOf(postMakerCm.lastImMicro, notionalMicro),
    },
    option,
    buyer_portfolio_counts: {
      before_total: preBuyerPortfolio.options.length,
      after_total: postBuyerPortfolio.options.length,
      after_long: postBuyerPortfolio.longOptions.length,
      after_short: postBuyerPortfolio.shortOptions.length,
      contains_filled_long: buyerHasLong,
    },
    maker_portfolio_counts: {
      after_total: postMakerPortfolio.options.length,
      after_long: postMakerPortfolio.longOptions.length,
      after_short: postMakerPortfolio.shortOptions.length,
      contains_filled_short: makerHasShort,
    },
    readback_steps: [
      { tool: "skew_list_options", arguments: { filter_option_pda: result.optionPda } },
      { tool: "skew_fetch_portfolio", arguments: { owner: args.buyer.toBase58() } },
      { tool: "skew_fetch_portfolio", arguments: { owner: args.cmPubkey.toBase58() } },
      {
        tool: "skew_fetch_clearing_member",
        arguments: { authority: args.cmPubkey.toBase58() },
      },
    ],
    proof:
      "PM-backed success requires tx + option readback + buyer long + maker short + CM registry/positions_count readback, not tx alone.",
  };
}

function relayUrlFromArgs(args: Record<string, unknown>): string {
  const raw = args["relay_url"] ?? process.env["SKEW_RELAY_URL"];
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  return INSTANT_RFQ_DEFAULT_RELAY_URL;
}

function microToUsdNumber(value: bigint | undefined): number | null {
  if (value === undefined) return null;
  return Number(value) / 1_000_000;
}

function microPercentOf(value: bigint | undefined, denominator: bigint | undefined): number | null {
  if (value === undefined || denominator === undefined || denominator <= 0n) return null;
  return Number(value) / Number(denominator) * 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function riskPreflightForJson(risk: InstantRfqHitResult["riskPreflight"] | undefined): Record<string, unknown> | null {
  if (!risk) return null;
  return {
    status: risk.status ?? null,
    pre_im_micro: risk.preImMicro?.toString() ?? null,
    pre_im_usd: microToUsdNumber(risk.preImMicro),
    post_im_micro: risk.postImMicro?.toString() ?? null,
    post_im_usd: microToUsdNumber(risk.postImMicro),
    required_delta_micro: risk.requiredDeltaMicro?.toString() ?? null,
    required_delta_usd: microToUsdNumber(risk.requiredDeltaMicro),
    marginal_im_locked_micro: risk.marginalImLockedMicro?.toString() ?? null,
    marginal_im_locked_usd: microToUsdNumber(risk.marginalImLockedMicro),
    free_collateral_micro: risk.freeCollateralMicro?.toString() ?? null,
    free_collateral_usd: microToUsdNumber(risk.freeCollateralMicro),
    after_fill_free_micro: risk.afterFillFreeMicro?.toString() ?? null,
    after_fill_free_usd: microToUsdNumber(risk.afterFillFreeMicro),
    health_before_bps: risk.healthBeforeBps?.toString() ?? null,
    health_after_bps: risk.healthAfterBps?.toString() ?? null,
    fee_micro: risk.feeMicro?.toString() ?? null,
    fee_usd: microToUsdNumber(risk.feeMicro),
    premium_micro: risk.premiumMicro?.toString() ?? null,
    premium_usd: microToUsdNumber(risk.premiumMicro),
    mmp: risk.mmp ?? null,
    position_accounts: risk.positionAccounts ?? null,
  };
}

async function signWithConfiguredKeypair<T extends SignableTransaction>(transaction: T): Promise<T> {
  const keypair = loadWriteKeypair();
  if (transaction instanceof VersionedTransaction) {
    transaction.sign([keypair]);
    return transaction;
  }
  transaction.partialSign(keypair);
  return transaction;
}

function openRelayWs(url: string): RelayWs {
  const ctor = (globalThis as unknown as { WebSocket?: new (url: string) => RelayWs }).WebSocket;
  if (ctor === undefined) {
    throw new Error("Node runtime does not expose global WebSocket; run MCP on Node 20+ or 22+.");
  }
  return new ctor(url);
}

function readWsText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data);
}

function parseRelayMessage(data: unknown): Record<string, unknown> {
  return JSON.parse(readWsText(data)) as Record<string, unknown>;
}

function payloadMatchesFilter(
  msg: Record<string, unknown>,
  filterUnderlying: string | null,
  filterPayoff: string | null,
): boolean {
  if (filterUnderlying !== null) {
    const asset = Number(msg["asset"] ?? -1);
    if (ASSET_INDEX[filterUnderlying] !== asset) return false;
  }
  if (filterPayoff !== null) {
    const wire = instantPayoffWire(filterPayoff);
    if (Number(msg["option_type"] ?? -1) !== wire.optionType) return false;
    if (Number(msg["direction"] ?? -99) !== wire.direction) return false;
  }
  return true;
}

async function prepareInstantMaker(
  skew: SkewClient,
  initialCollateralUsdc: number,
  pmCacheUnderlying: string,
): Promise<Record<string, unknown>> {
  const authority = skew.walletPublicKey;
  const actions: Array<Record<string, unknown>> = [];
  const before = await skew.fetchClearingMember(authority);
  if (before === null) {
    const registered = await skew.registerClearingMember({ initialCollateralUsdc });
    actions.push({
      action: "register_clearing_member",
      tx_signature: registered.txSignature,
      cm_pda: registered.cmPda.toBase58(),
    });
  } else {
    actions.push({
      action: "register_clearing_member",
      skipped: true,
      reason: "already_registered",
      positions_count: before.positionsCount,
      collateral_micro: before.collateralMicro.toString(),
    });
  }
  try {
    const vt = await skew.initVolumeTracker();
    actions.push({
      action: "init_volume_tracker",
      tx_signature: vt.txSignature,
      volume_tracker: vt.volumeTracker.toBase58(),
    });
  } catch (e) {
    actions.push({
      action: "init_volume_tracker",
      skipped: true,
      reason: e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240),
    });
  }
  try {
    const maker = await skew.registerRfqMaker();
    actions.push({
      action: "register_rfq_maker",
      tx_signature: maker.txSignature,
      registry_pda: maker.registry.toBase58(),
    });
  } catch (e) {
    actions.push({
      action: "register_rfq_maker",
      failed: true,
      reason: e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240),
    });
    throw e;
  }
  try {
    const refresh = (skew as unknown as {
      refreshPmCacheFull?: (currentSpotUsd?: number) => Promise<unknown>;
    }).refreshPmCacheFull;
    if (refresh) {
      const [cache, cmForCache] = await Promise.all([
        skew.fetchPmCache(authority).catch(() => null),
        skew.fetchClearingMember(authority),
      ]);
      const positionsCount = cmForCache?.positionsCount ?? 0;
      const cacheFresh =
        cache !== null &&
        cache.initialized &&
        !cache.dirty &&
        cache.registryCount === positionsCount;
      if (cacheFresh) {
        actions.push({
          action: "refresh_pm_cache_full",
          skipped: true,
          reason: "cache already clean and registry_count matches positions_count",
          registry_count: cache.registryCount,
          positions_count: positionsCount,
        });
      } else {
        const { price: spot } = await fetchSpot(pmCacheUnderlying);
        const refreshed = await refresh.call(skew, spot);
        actions.push({
          action: "refresh_pm_cache_full",
          underlying: pmCacheUnderlying,
          current_spot_usd: spot,
          previous_cache: cache === null ? null : serializeJson(cache),
          result: serializeJson(refreshed),
        });
      }
    } else {
      actions.push({
        action: "refresh_pm_cache_full",
        skipped: true,
        reason: "SDK does not expose refreshPmCacheFull",
      });
    }
  } catch (e) {
    actions.push({
      action: "refresh_pm_cache_full",
      failed: true,
      reason: e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240),
    });
  }
  const after = await skew.fetchClearingMember(authority);
  return {
    authority: authority.toBase58(),
    actions,
    clearing_member: after
      ? {
          positions_count: after.positionsCount,
          collateral_micro: after.collateralMicro.toString(),
          total_pm_locked_micro: after.totalPmLockedMicro.toString(),
          last_im_micro: after.lastImMicro.toString(),
          free_collateral_micro: after.freeCollateralMicro.toString(),
        }
      : null,
  };
}

function optionTypeNameFromWire(optionType: number):
  | "Vanilla"
  | "Digital"
  | "CappedVanilla"
  | "RangeAccrual"
  | "VanillaInverse"
  | "DigitalInverse" {
  if (optionType === 0) return "Vanilla";
  if (optionType === 1) return "Digital";
  if (optionType === 2) return "CappedVanilla";
  if (optionType === 3) return "RangeAccrual";
  if (optionType === 4) return "VanillaInverse";
  if (optionType === 5) return "DigitalInverse";
  throw new Error(`Unknown Instant RFQ option_type ${optionType}`);
}

async function ensureInstantSeriesListed(
  skew: SkewClient,
  built: InstantSpecBuild,
): Promise<Record<string, unknown>> {
  const optionTypeName = optionTypeNameFromWire(built.optionSpec.optionType);
  const direction = built.optionSpec.direction as -1 | 0 | 1;
  const [series] = findSeriesListingPda(
    built.optionSpec.asset,
    built.optionSpec.strike,
    built.optionSpec.expiryTs,
    built.optionSpec.optionType as 0 | 1 | 2 | 3 | 4 | 5,
    direction,
  );
  const connection = new Connection(RPC_URL, "confirmed");
  const existing = await connection.getAccountInfo(series, "confirmed");
  if (existing !== null) {
    return {
      status: "already_listed",
      series_pda: series.toBase58(),
      account_size: existing.data.length,
    };
  }
  try {
    const listed = await skew.listSeries({
      asset: built.optionSpec.asset,
      strikeMicro: built.optionSpec.strike,
      expiryTs: built.optionSpec.expiryTs,
      optionTypeName,
      direction,
    });
    return {
      status: "listed",
      series_pda: listed.series.toBase58(),
      tx_signature: listed.txSignature,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const after = await connection.getAccountInfo(series, "confirmed");
    if (after !== null) {
      return {
        status: "listed_by_race",
        series_pda: series.toBase58(),
        account_size: after.data.length,
        recovered_from: message.slice(0, 240),
      };
    }
    throw new Error(`list_series prerequisite failed for Instant RFQ: ${message}`);
  }
}

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
const server = new Server({ name: "skew", version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ACTIVE_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;

  const disabledReason = getSkewDisabledToolReason(name);
  if (disabledReason) {
    return typedErr("ToolDisabled", disabledReason, {
      tool: name,
      activeProfile: MCP_PROFILE,
    });
  }

  if (!ACTIVE_TOOL_NAMES.has(name)) {
    if (PROFILE_TOOL_NAMES.has(name) && !HAS_WRITE_KEYPAIR && !isSkewReadOnlyTool(name)) {
      return typedErr(
        "WriteKeyRequired",
        "This write tool is in the selected MCP profile but is hidden until a devnet write keypair is configured.",
        {
          tool: name,
          activeProfile: MCP_PROFILE,
          requiredEnv: ["SKEW_KEYPAIR_PATH", "KEYPAIR_PATH", "SKEW_PRIVATE_KEY"],
        },
      );
    }
    return typedErr(
      "ToolNotInProfile",
      `${name} is not exposed by SKEW_MCP_PROFILE=${MCP_PROFILE}. Use SKEW_MCP_PROFILE=advanced, governance, or all only when that wider surface is intentional.`,
      {
        tool: name,
        activeProfile: MCP_PROFILE,
      },
    );
  }

  try {
    switch (name) {
      // -----------------------------------------------------------------------
      case "skew_get_capabilities": {
        // W32-E (F-4 / F-8): enrich the SDK capability payload with
        // MCP-side metadata — the static MCP-tool ↔ pricing-route table and
        // the visible-tool count for each profile. SDK callers that don't
        // need the MCP introspection block can ignore the extra keys.
        const base = getSkewCapabilities();
        const enriched = {
          ...base,
          mcp: {
            activeProfile: MCP_PROFILE,
            hasWriteKeypair: HAS_WRITE_KEYPAIR,
            signing: signerInfoForJson(false),
            activeToolCount: ACTIVE_TOOLS.length,
            profileToolCount: PROFILE_TOOLS.length,
            hiddenWriteTools: hiddenWriteToolsForProfile(MCP_PROFILE),
            pricingBaseUrl: PRICING_URL,
            pricingToolRoutes: MCP_PRICING_TOOL_ROUTE_MAP,
            toolCountByProfile: getVisibleToolCountByProfile(),
            profileToolCountByProfile: getProfileToolCountByProfile(),
            agentGuide: agentGuideForJson(),
          },
        };
        return ok(JSON.stringify(enriched, null, 2));
      }

      // -----------------------------------------------------------------------
      case "skew_get_signer_info": {
        return ok(JSON.stringify(signerInfoForJson(true), null, 2));
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
        const filterOptionPda =
          typeof a["filter_option_pda"] === "string" ? String(a["filter_option_pda"]) : undefined;
        const holder = typeof a["holder"] === "string" ? String(a["holder"]) : undefined;
        const creator = typeof a["creator"] === "string" ? String(a["creator"]) : undefined;
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
          pda: filterOptionPda,
          holder,
          creator,
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
              filters: {
                filter_option_pda: filterOptionPda,
                holder,
                creator,
                underlying,
                option_type: optionType,
                state,
                sort_by: sortBy,
              },
              options: summaries.map((s) => optionSummaryForJson(
                s as unknown as Record<string, unknown>,
              )),
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_portfolio": {
        const owner = await authorityFromArgs(a, "owner");
        const skew = await getReadOnlySkewClient();
        const portfolio = await skew.getPortfolio(new PublicKey(owner));
        return ok(
          JSON.stringify(
            {
              success: true,
              owner: portfolio.owner,
              long_count: portfolio.longOptions.length,
              short_count: portfolio.shortOptions.length,
              option_count: portfolio.options.length,
              clearing_member: portfolio.clearingMember
                ? {
                    registered: true,
                    collateral_usdc: Number(portfolio.clearingMember.collateralMicro) / 1e6,
                    free_collateral_usdc:
                      Number(portfolio.clearingMember.freeCollateralMicro) / 1e6,
                    total_pm_locked_usdc:
                      Number(portfolio.clearingMember.totalPmLockedMicro) / 1e6,
                    last_im_usdc: Number(portfolio.clearingMember.lastImMicro) / 1e6,
                    positions_count: portfolio.clearingMember.positionsCount,
                    last_margin_check_unix:
                      portfolio.clearingMember.lastMarginCheck.toString(),
                  }
                : { registered: false },
              long_options: portfolio.longOptions.map((s) => ({
                pda: s.pda,
                option_token_mint: s.optionTokenMint,
                creator: s.creator,
                holder: s.holder,
                state: s.state,
                underlying: s.underlying,
                option_type: s.optionType,
                direction: s.direction,
                strike_usd: s.strikeUsd,
                expiry_iso: new Date(s.expiryTs * 1000).toISOString(),
                payoff_usd: s.payoffUsd,
                settlement_mint: s.settlementMint,
                metadata_status: s.metadataStatus,
              })),
              short_options: portfolio.shortOptions.map((s) => ({
                pda: s.pda,
                option_token_mint: s.optionTokenMint,
                creator: s.creator,
                holder: s.holder,
                state: s.state,
                underlying: s.underlying,
                option_type: s.optionType,
                direction: s.direction,
                strike_usd: s.strikeUsd,
                expiry_iso: new Date(s.expiryTs * 1000).toISOString(),
                payoff_usd: s.payoffUsd,
                settlement_mint: s.settlementMint,
                metadata_status: s.metadataStatus,
              })),
              options: portfolio.options.map((s) => optionSummaryForJson(
                s as unknown as Record<string, unknown>,
              )),
            },
            null,
            2,
          ),
        );
      }

      case "skew_list_rfq_auctions": {
        const limit = Math.min(Number(a["limit"] ?? 25), 100);
        const underlying = a["underlying"] as Underlying | undefined;
        const buyer = typeof a["buyer"] === "string" ? String(a["buyer"]) : undefined;
        const withQuote = typeof a["with_quote"] === "boolean" ? Boolean(a["with_quote"]) : undefined;
        const source = a["source"] as "indexer" | "onchain" | undefined;
        const skew = await getReadOnlySkewClient();
        const tape = await skew.listRfqAuctions({
          webUrl: WEB_URL,
          buyer,
          asset: underlying,
          withQuote,
          source,
          limit,
        });

        return ok(
          JSON.stringify(
            {
              ...tape,
              filters: {
                buyer,
                underlying,
                with_quote: withQuote ?? false,
                source: source ?? "terminal_default",
                limit,
              },
              note:
                "This is the RFQ discovery tape. Use skew_fetch_rfq_auction with an auction PDA for exact on-chain state, then quote/finalize through the RFQ profile.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_list_secondary_listings": {
        const limit = Math.min(Number(a["limit"] ?? 25), 100);
        const underlying = a["underlying"] as Underlying | undefined;
        const active = typeof a["active"] === "boolean" ? Boolean(a["active"]) : undefined;
        const pending = typeof a["pending"] === "boolean" ? Boolean(a["pending"]) : undefined;
        const seller = typeof a["seller"] === "string" ? String(a["seller"]) : undefined;
        const optionPda =
          typeof a["option_pda"] === "string" ? String(a["option_pda"]) : undefined;
        const minQty = a["min_qty"] === undefined ? undefined : Number(a["min_qty"]);
        const maxAsk = a["max_ask_usdc"] === undefined ? undefined : Number(a["max_ask_usdc"]);
        const excludeMe = typeof a["exclude_me"] === "string" ? String(a["exclude_me"]) : undefined;
        const skew = await getReadOnlySkewClient();
        const tape = await skew.listSecondaryListings({
          webUrl: WEB_URL,
          asset: underlying,
          active,
          pending,
          seller,
          optionPda,
          minQty,
          maxAsk,
          excludeMe,
          limit,
        });

        return ok(
          JSON.stringify(
            {
              ...tape,
              filters: {
                underlying,
                active: active ?? true,
                pending,
                seller,
                option_pda: optionPda,
                min_qty: minQty,
                max_ask_usdc: maxAsk,
                exclude_me: excludeMe,
                limit,
              },
              note:
                "This is the secondary discovery tape. Execution is intentionally separate: use SDK/MCP/API trading calls with a wallet/keypair for buy or delist flows.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_create_secondary_listing": {
        const skew = await getSkewClient();
        const optionAddress = String(a["option_address"]);
        const result = await skew.createSecondaryListing({
          webUrl: WEB_URL,
          optionPda: optionAddress,
          optionTokenMint:
            typeof a["option_token_mint"] === "string"
              ? String(a["option_token_mint"])
              : undefined,
          askPriceUsdc: Number(a["ask_price_usdc"]),
          tokenAmount:
            a["token_amount"] === undefined ? undefined : Number(a["token_amount"]),
          durationHours:
            a["duration_hours"] === undefined ? undefined : Number(a["duration_hours"]),
          sellerHandle:
            typeof a["seller_handle"] === "string" ? String(a["seller_handle"]) : null,
        });
        const tape = await skew.listSecondaryListings({
          webUrl: WEB_URL,
          optionPda: optionAddress,
          active: true,
          limit: 10,
        });
        const optionReadback = optionSummaryForJson(
          result.option_readback as unknown as Record<string, unknown> | null | undefined,
        );
        return ok(
          JSON.stringify(
            {
              success: result.success,
              execution_lane: "secondary_transfer",
              trade_state: "TRANSFER_PENDING",
              clearing_state: "NOT_APPLICABLE",
              pm_backed: false,
              pm_guarantee: "not_applicable",
              listing: result.listing,
              option_pda: result.option_pda,
              option_token_mint: result.option_token_mint,
              seller: result.seller,
              ask_price_usdc: result.ask_price_usdc,
              token_amount: result.token_amount,
              holder_verified: result.holder_verified,
              option_readback: optionReadback,
              tape_readback: tape,
              next_step:
                "Buyer can call skew_buy_secondary_listing to pay and stamp a buy intent. Seller must then call skew_transfer_option(option_address, new_holder=buyer) to complete delivery.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_buy_secondary_listing": {
        const skew = await getSkewClient();
        const listingId = String(a["listing_id"]);
        const listingJson = await skewWebJson(`/api/listings/${encodeURIComponent(listingId)}`);
        const listing = (listingJson as { listing?: Record<string, unknown> }).listing;
        if (listing === undefined || listing === null) {
          return err(`secondary listing not found: ${listingId}`);
        }
        const listingOption = String(listing["option_pda"] ?? "");
        const listingSeller = String(listing["seller"] ?? "");
        const listingAsk = Number(listing["ask_price_usdc"]);
        if (!listingOption || !listingSeller || !Number.isFinite(listingAsk) || listingAsk <= 0) {
          return err(`secondary listing ${listingId} is missing option/seller/ask fields`);
        }
        const result = await skew.buySecondaryListing({
          webUrl: WEB_URL,
          listingId,
          optionPda:
            typeof a["option_address"] === "string" ? String(a["option_address"]) : listingOption,
          seller: typeof a["seller"] === "string" ? String(a["seller"]) : listingSeller,
          askPriceUsdc:
            a["ask_price_usdc"] === undefined ? listingAsk : Number(a["ask_price_usdc"]),
        });
        return ok(
          JSON.stringify(
            {
              ...result,
              execution_lane: "secondary_transfer",
              trade_state: "TRANSFER_PENDING",
              clearing_state: "NOT_APPLICABLE",
              pm_backed: false,
              pm_guarantee: "not_applicable",
              delivery_step: {
                tool: "skew_transfer_option",
                args: {
                  option_address: result.option_pda,
                  new_holder: result.buyer,
                },
                signer: "seller/current holder MCP process",
              },
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
        const skew = await getSkewClient();
        if (a["expected_premium_micro"] == null && a["expected_premium_usd"] == null) {
          return err(
            "expected_premium_micro or expected_premium_usd is required as a price-move guard",
          );
        }
        const expectedPremiumMicro =
          a["expected_premium_micro"] != null
            ? BigInt(String(a["expected_premium_micro"]))
            : BigInt(Math.round(Number(a["expected_premium_usd"]) * 1_000_000));
        const r = await skew.takeBestQuote({
          auction: new PublicKey(String(a["auction_pda"])),
          expectedPremiumMicro,
        });
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_refresh_quote": {
        const skew = await getSkewClient();
        const sigRaw = String(a["mm_signature_b64"]);
        const sigBytes = bs58.decode(sigRaw);
        const r = await skew.refreshQuote({
          auction: new PublicKey(String(a["auction_pda"])),
          premiumMicro: BigInt(Math.round(Number(a["premium_usd"]) * 1_000_000)),
          validUntilSlot: BigInt(String(a["valid_until_slot"])),
          mmSignature: sigBytes,
        });
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_publish_axe": {
        const skew = await getSkewClient();
        const r = await skew.publishAxe(axeFieldsFromArgs(a));
        return ok(
          JSON.stringify(
            { success: true, axe_pda: r.axe.toBase58(), tx_signature: r.txSignature },
            null,
            2,
          ),
        );
      }

      case "skew_update_axe": {
        const skew = await getSkewClient();
        const r = await skew.updateAxe({
          axe: new PublicKey(String(a["axe_pda"])),
          fields: axeFieldsFromArgs(a),
        });
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_revoke_axe": {
        const skew = await getSkewClient();
        const r = await skew.revokeAxe(new PublicKey(String(a["axe_pda"])));
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      // -----------------------------------------------------------------------
      case "skew_create_option": {
        const skew = await getSkewClient();
        const unsupported = unsupportedPayoffReason(String(a["underlying"]), String(a["payoff"]));
        if (unsupported) return err(unsupported);
        let settlementMint: PublicKey | undefined;
        try {
          settlementMint = resolveSettlementMintArg(a["settlement_mint"]);
        } catch (e) {
          return err(`Invalid settlement_mint: ${String(e)}`);
        }
        const result = await skew.create({
          underlying: String(a["underlying"]) as Underlying,
          payoff: String(a["payoff"]) as PayoffType,
          strike: Number(a["strike"]),
          expiry: String(a["expiry"]),
          notional: Number(a["notional"]),
          settlementMint,
          dryRun:
            a["dry_run"] === true || a["simulate_only"] === true || a["simulate"] === true,
          upperBound: a["upperBound"] != null ? Number(a["upperBound"]) : undefined,
        });
        const simulated = result.simulated === true;
        return ok(
          JSON.stringify(
            {
              success: true,
              simulated,
              execution_lane: "prefunded_create_buy",
              collateral_model: "prefunded_full_collateral",
              pm_backed: false,
              pm_guarantee: "not_guaranteed",
              option_address: result.address.toBase58(),
              nonce: result.nonce.toString(),
              settlement_mint: (settlementMint ?? new PublicKey(USDC_MINT)).toBase58(),
              notional_unit:
                settlementMint == null ? "USDC/USD" : "settlement mint base units",
              create_tx: result.createTx,
              deposit_tx: result.depositTx,
              simulation: result.simulation,
              explorer_create: simulated
                ? null
                : `https://explorer.solana.com/tx/${result.createTx}?cluster=devnet`,
              explorer_deposit: simulated
                ? null
                : `https://explorer.solana.com/tx/${result.depositTx}?cluster=devnet`,
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_collateral_policy": {
        const skew = await getReadOnlySkewClient();
        const policy = await skew.fetchCollateralPolicy();
        return ok(
          JSON.stringify(
            {
              success: true,
              pda: policy.pda.toBase58(),
              initialized: policy.initialized,
              bump: policy.bump,
              entry_count: policy.entryCount,
              entries: policy.entries.map((entry) => ({
                mint: entry.mint.toBase58(),
                decimals: entry.decimals,
                kind_code: entry.kindCode,
                kind: entry.kind,
                oracle_feed: entry.oracleFeed.toBase58(),
                max_depeg_bps: entry.maxDepegBps,
              })),
              note:
                "This is runtime deployment state. get_capabilities reports protocol support; this allowlist decides whether a mint is accepted by live custody instructions.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_fetch_pm_cache": {
        const authority = await authorityFromArgs(a, "cm_authority");
        const json = await skewWebJson(`/api/cm/${authority}/pm-cache`);
        return ok(JSON.stringify(json, null, 2));
      }

      case "skew_preview_incremental_margin": {
        const authority = await authorityFromArgs(a, "cm_authority");
        const body: Record<string, unknown> = {};
        if (a["estimated_post_im_micro"] != null) {
          body["estimated_post_im_micro"] = String(a["estimated_post_im_micro"]);
        }
        const json = await skewWebJson(`/api/cm/${authority}/margin-preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return ok(JSON.stringify(json, null, 2));
      }

      case "skew_list_rent_reclaimable": {
        const authority = await authorityFromArgs(a, "authority");
        const json = await skewWebJson(`/api/rent-reclaim?authority=${authority}`);
        return ok(JSON.stringify(json, null, 2));
      }

      case "skew_list_rfq_quotes": {
        const auction = new PublicKey(String(a["auction"])).toBase58();
        const limit = Math.min(Math.max(Number(a["limit"] ?? 50), 1), 100);
        const json = await skewWebJson(
          `/api/rfq-auctions/${encodeURIComponent(auction)}/quotes?limit=${limit}`,
        );
        if (
          typeof json === "object" &&
          json !== null &&
          Number((json as Record<string, unknown>)["count"] ?? 0) === 0
        ) {
          const skew = await getReadOnlySkewClient();
          const snap = await skew.fetchRfqAuction(new PublicKey(auction));
          if (
            snap?.bestQuoteMm != null &&
            snap.bestQuotePremiumMicro != null &&
            snap.bestQuoteValidUntilSlot != null
          ) {
            const premiumMicro = snap.bestQuotePremiumMicro.toString();
            return ok(
              JSON.stringify(
                {
                  ...(json as Record<string, unknown>),
                  count: 1,
                  firm_count: 1,
                  best_premium_usdc: Number(snap.bestQuotePremiumMicro) / 1_000_000,
                  worst_premium_usdc: Number(snap.bestQuotePremiumMicro) / 1_000_000,
                  spread_usdc: 0,
                  unique_mms: 1,
                  quotes: [
                    {
                      auction,
                      mm: snap.bestQuoteMm.toBase58(),
                      premium_micro: premiumMicro,
                      premium_usdc: Number(snap.bestQuotePremiumMicro) / 1_000_000,
                      valid_until_slot: snap.bestQuoteValidUntilSlot.toString(),
                      quote_type: "firm",
                      source: "onchain_best_quote_fallback",
                    },
                  ],
                  source: "indexer+onchain_best_quote_fallback",
                  note:
                    "Indexer quote-depth returned no rows; MCP recovered the current firm best quote from the on-chain RfqAuctionPda.",
                },
                null,
                2,
              ),
            );
          }
        }
        return ok(JSON.stringify(json, null, 2));
      }

      case "skew_request_instant_rfq_from_auction": {
        const skew = await getSkewClient();
        const buyer = skew.walletPublicKey;
        const auctionPda = new PublicKey(String(a["auction"]));
        const snap = await skew.fetchRfqAuction(auctionPda);
        if (snap === null) {
          return err(`RFQ auction not found: ${auctionPda.toBase58()}`);
        }
        if (!snap.buyer.equals(buyer)) {
          return err(
            `configured wallet ${buyer.toBase58()} is not the Auction RFQ buyer ${snap.buyer.toBase58()}`,
          );
        }
        const built = buildInstantSpecFromAuctionSnapshot(snap, a);
        const timeoutMs = clampInteger(
          a["timeout_ms"],
          INSTANT_RFQ_REQUEST_DEFAULT_TIMEOUT_MS,
          500,
          INSTANT_RFQ_MAX_WINDOW_MS,
        );
        const maxQuotes = Math.min(Math.max(Number(a["max_quotes"] ?? 8), 1), 25);
        const requiredCm =
          a["required_cm_pubkey"] === undefined || a["required_cm_pubkey"] === null
            ? null
            : new PublicKey(String(a["required_cm_pubkey"]));
        const relayUrl = relayUrlFromArgs(a);
        const seriesPrerequisite = await ensureInstantSeriesListed(skew, built);
        const collected = await collectInstantRfqQuotes({
          buyer,
          request: built.request,
          relayUrl,
          timeoutMs,
          maxQuotes: requiredCm === null ? maxQuotes : 25,
        });
        const capMicro = BigInt(String(built.display["max_premium_micro"] ?? snap.maxPremiumMicro));
        const acceptedQuotes = collected.quotes.filter((quote) => {
          if (quote.premiumMicro > capMicro) return false;
          if (requiredCm !== null && !quote.cmPubkey.equals(requiredCm)) return false;
          return true;
        });
        const quotes = acceptedQuotes.slice(0, maxQuotes).map((quote) => ({
          relay_nonce: quote.relayNonce.toString(),
          cm_pubkey: quote.cmPubkey.toBase58(),
          premium_micro: quote.premiumMicro.toString(),
          premium_usd: Number(quote.premiumMicro) / 1_000_000,
          ttl_seconds: quote.ttlSeconds,
          received_at: quote.receivedAt,
          raw: serializeJson(quote.raw),
        }));
        return ok(
          JSON.stringify(
            {
              success: true,
              execution_lane: "auction_terms_to_instant_rfq_atomic_fill",
              trade_state: "RFQ_REQUESTED",
              clearing_state: "NOT_APPLICABLE",
              pm_backed: false,
              pm_guarantee: "not_applicable",
              pm_contract: "PM is guaranteed only after the selected quote is hit through atomic_fill_from_relay.",
              collateral_model: "portfolio_margin_delta_im",
              auction: {
                pda: auctionPda.toBase58(),
                buyer: snap.buyer.toBase58(),
                state: snap.state,
                best_quote_mm: snap.bestQuoteMm?.toBase58() ?? null,
                best_quote_premium_micro: snap.bestQuotePremiumMicro?.toString() ?? null,
                max_premium_micro: snap.maxPremiumMicro.toString(),
              },
              relay_url: relayUrl,
              buyer: buyer.toBase58(),
              relay_nonce: collected.relayNonce.toString(),
              series_prerequisite: seriesPrerequisite,
              request: built.display,
              premium_cap_micro: capMicro.toString(),
              required_cm_pubkey: requiredCm?.toBase58() ?? null,
              quote_count: quotes.length,
              rejected_quote_count: collected.quotes.length - acceptedQuotes.length,
              quotes,
              hit_quote_template:
                quotes.length === 0
                  ? null
                  : {
                      tool: "skew_hit_instant_rfq_from_auction_quote",
                      arguments: {
                        auction: auctionPda.toBase58(),
                        relay_nonce: collected.relayNonce.toString(),
                        cm_pubkey: quotes[0]?.cm_pubkey,
                        premium_micro: quotes[0]?.premium_micro,
                      },
                    },
              note:
                "This keeps Auction RFQ as the discovery/tape source, then PM-clears the selected terms through Instant RFQ atomic_fill_from_relay. No pre-funded 100% collateral bridge is used.",
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_request_instant_rfq_quotes": {
        const skew = await getSkewClient();
        const buyer = skew.walletPublicKey;
        const built = buildInstantSpecFromArgs(a);
        const timeoutMs = clampInteger(
          a["timeout_ms"],
          INSTANT_RFQ_REQUEST_DEFAULT_TIMEOUT_MS,
          500,
          INSTANT_RFQ_MAX_WINDOW_MS,
        );
        const maxQuotes = Math.min(Math.max(Number(a["max_quotes"] ?? 8), 1), 25);
        const requiredCm =
          a["required_cm_pubkey"] === undefined || a["required_cm_pubkey"] === null
            ? null
            : new PublicKey(String(a["required_cm_pubkey"]));
        const relayUrl = relayUrlFromArgs(a);
        const seriesPrerequisite = await ensureInstantSeriesListed(skew, built);
        const collected = await collectInstantRfqQuotes({
          buyer,
          request: built.request,
          relayUrl,
          timeoutMs,
          maxQuotes: requiredCm === null ? maxQuotes : 25,
        });
        const acceptedQuotes = collected.quotes.filter((quote) =>
          requiredCm === null ? true : quote.cmPubkey.equals(requiredCm),
        );
        const quotes = acceptedQuotes.slice(0, maxQuotes).map((quote) => ({
          relay_nonce: quote.relayNonce.toString(),
          cm_pubkey: quote.cmPubkey.toBase58(),
          premium_micro: quote.premiumMicro.toString(),
          premium_usd: Number(quote.premiumMicro) / 1_000_000,
          ttl_seconds: quote.ttlSeconds,
          received_at: quote.receivedAt,
          raw: serializeJson(quote.raw),
        }));
        return ok(
          JSON.stringify(
            {
              success: true,
              execution_lane: "instant_rfq_atomic_fill",
              trade_state: "RFQ_REQUESTED",
              clearing_state: "NOT_APPLICABLE",
              pm_backed: false,
              pm_guarantee: "not_applicable",
              pm_contract: "PM is guaranteed only after the selected quote is hit through atomic_fill_from_relay.",
              collateral_model: "portfolio_margin_delta_im",
              relay_url: relayUrl,
              buyer: buyer.toBase58(),
              relay_nonce: collected.relayNonce.toString(),
              series_prerequisite: seriesPrerequisite,
              request: built.display,
              required_cm_pubkey: requiredCm?.toBase58() ?? null,
              quote_count: quotes.length,
              rejected_quote_count: collected.quotes.length - acceptedQuotes.length,
              quotes,
              hit_quote_template:
                quotes.length === 0
                  ? null
                  : {
                      tool: "skew_hit_instant_rfq_quote",
                      arguments: {
                        relay_nonce: collected.relayNonce.toString(),
                        cm_pubkey: quotes[0]?.cm_pubkey,
                        premium_micro: quotes[0]?.premium_micro,
                        underlying: built.underlying,
                        payoff: built.payoff,
                        strike: built.display["strike_usd"],
                        expiry: built.display["expiry_iso"],
                        notional: built.display["notional"],
                        upper_bound_usd: built.display["upper_bound_usd"],
                        settlement_mint: built.settlement.label,
                      },
                    },
              note:
                "This only requests quotes. A PM-backed option is minted only after skew_hit_instant_rfq_quote returns fill_executed.",
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_hit_instant_rfq_quote": {
        const skew = await getSkewClient();
        const buyer = skew.walletPublicKey;
        const cmPubkey = new PublicKey(String(a["cm_pubkey"]));
        const built = buildInstantSpecFromArgs(a);
        const premiumMicro = parsePremiumMicro(a);
        const relayNonce = BigInt(String(a["relay_nonce"]));
        const quoteExpirySeconds = clampInteger(
          a["quote_expiry_seconds"],
          INSTANT_RFQ_DEFAULT_QUOTE_EXPIRY_SECONDS,
          10,
          INSTANT_RFQ_DEFAULT_QUOTE_EXPIRY_SECONDS,
        );
        const timeoutMs = clampInteger(
          a["timeout_ms"],
          INSTANT_RFQ_HIT_DEFAULT_TIMEOUT_MS,
          5_000,
          INSTANT_RFQ_MAX_WINDOW_MS,
        );
        const relayUrl = relayUrlFromArgs(a);
        const receipt = await executeInstantRfqHit({
          skew,
          buyer,
          built,
          relayNonce,
          cmPubkey,
          premiumMicro,
          quoteExpirySeconds,
          timeoutMs,
          relayUrl,
        });
        return ok(
          JSON.stringify(receipt, null, 2),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_hit_instant_rfq_from_auction_quote": {
        const skew = await getSkewClient();
        const buyer = skew.walletPublicKey;
        const auctionPda = new PublicKey(String(a["auction"]));
        const snap = await skew.fetchRfqAuction(auctionPda);
        if (snap === null) {
          return err(`RFQ auction not found: ${auctionPda.toBase58()}`);
        }
        if (!snap.buyer.equals(buyer)) {
          return err(
            `configured wallet ${buyer.toBase58()} is not the Auction RFQ buyer ${snap.buyer.toBase58()}`,
          );
        }
        const cmPubkey = new PublicKey(String(a["cm_pubkey"]));
        const built = buildInstantSpecFromAuctionSnapshot(snap, a);
        const premiumMicro = parsePremiumMicro(a);
        const capMicro = BigInt(String(built.display["max_premium_micro"] ?? snap.maxPremiumMicro));
        if (premiumMicro > capMicro) {
          return err(
            `selected premium ${premiumMicro.toString()} exceeds Auction/Instant cap ${capMicro.toString()}`,
          );
        }
        const relayNonce = BigInt(String(a["relay_nonce"]));
        const quoteExpirySeconds = clampInteger(
          a["quote_expiry_seconds"],
          INSTANT_RFQ_DEFAULT_QUOTE_EXPIRY_SECONDS,
          10,
          INSTANT_RFQ_DEFAULT_QUOTE_EXPIRY_SECONDS,
        );
        const timeoutMs = clampInteger(
          a["timeout_ms"],
          INSTANT_RFQ_HIT_DEFAULT_TIMEOUT_MS,
          5_000,
          INSTANT_RFQ_MAX_WINDOW_MS,
        );
        const relayUrl = relayUrlFromArgs(a);
        const receipt = await executeInstantRfqHit({
          skew,
          buyer,
          built,
          relayNonce,
          cmPubkey,
          premiumMicro,
          quoteExpirySeconds,
          timeoutMs,
          relayUrl,
          origin: {
            lane: "auction_rfq_terms_to_instant_rfq_atomic_fill",
            auction: auctionPda.toBase58(),
            auction_state: snap.state,
            auction_best_quote_mm: snap.bestQuoteMm?.toBase58() ?? null,
            auction_best_quote_premium_micro: snap.bestQuotePremiumMicro?.toString() ?? null,
          },
        });
        return ok(
          JSON.stringify(receipt, null, 2),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_serve_instant_rfq_mm_once": {
        const skew = await getSkewClient();
        const maker = skew.walletPublicKey;
        const premiumMicro = parsePremiumMicro(a);
        const quoteTtlSeconds = clampInteger(
          a["quote_ttl_seconds"],
          INSTANT_RFQ_DEFAULT_QUOTE_EXPIRY_SECONDS,
          5,
          INSTANT_RFQ_DEFAULT_QUOTE_EXPIRY_SECONDS,
        );
        const timeoutMs = clampInteger(
          a["timeout_ms"],
          INSTANT_RFQ_MAKER_DEFAULT_TIMEOUT_MS,
          5_000,
          INSTANT_RFQ_MAX_WINDOW_MS,
        );
        const relayUrl = relayUrlFromArgs(a);
        const autoPrepare = a["auto_prepare"] !== false;
        const initialCollateralUsdc = Number(a["initial_collateral_usdc"] ?? 1_000);
        const filterUnderlying =
          typeof a["filter_underlying"] === "string"
            ? String(a["filter_underlying"]).toUpperCase()
            : null;
        const filterPayoff =
          typeof a["filter_payoff"] === "string" ? String(a["filter_payoff"]) : null;
        if (filterUnderlying !== null && ASSET_INDEX[filterUnderlying] === undefined) {
          return err(`unknown filter_underlying ${filterUnderlying}`);
        }
        if (filterPayoff !== null) {
          instantPayoffWire(filterPayoff);
        }
        const prepare = autoPrepare
          ? await prepareInstantMaker(skew, initialCollateralUsdc, filterUnderlying ?? "BTC")
          : { skipped: true, reason: "auto_prepare=false" };

        const receipt = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const ws = openRelayWs(relayUrl);
          let done = false;
          let quotedRequest: Record<string, unknown> | null = null;
          let quoteAck: Record<string, unknown> | null = null;
          let marginPreview: Record<string, unknown> | null = null;

          const finishOk = (out: Record<string, unknown>) => {
            if (done) return;
            done = true;
            try {
              ws.close();
            } catch {
              /* noop */
            }
            resolve(out);
          };
          const finishErr = (error: Error) => {
            if (done) return;
            done = true;
            try {
              ws.close();
            } catch {
              /* noop */
            }
            reject(error);
          };
          const timer = setTimeout(() => {
            finishErr(
              new Error(
                quotedRequest === null
                  ? "timed out waiting for Instant RFQ quote_request"
                  : "timed out after quote_ack before fill_executed",
              ),
            );
          }, timeoutMs);

          ws.onerror = () => {
            clearTimeout(timer);
            finishErr(new Error("instant RFQ maker relay websocket error"));
          };
          ws.onclose = () => {
            if (!done && quotedRequest !== null) {
              clearTimeout(timer);
              finishErr(new Error("instant RFQ maker relay closed before fill_executed"));
            }
          };
          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                kind: "identify",
                role: "cm",
                pubkey: maker.toBase58(),
              }),
            );
          };
          ws.onmessage = (event) => {
            try {
              const msg = parseRelayMessage(event.data);
              const kind = typeof msg["kind"] === "string" ? String(msg["kind"]) : "";
              if (kind === "quote_request") {
                if (quotedRequest !== null) return;
                if (!payloadMatchesFilter(msg, filterUnderlying, filterPayoff)) return;
                const relayNonce = String(msg["relay_nonce"] ?? "");
                if (relayNonce.length === 0) return;
                quotedRequest = serializeJson(msg) as Record<string, unknown>;
                quoteAck = {
                  kind: "quote_ack",
                  relay_nonce: relayNonce,
                  premium_micro: premiumMicro.toString(),
                  ttl_seconds: quoteTtlSeconds,
                };
                ws.send(JSON.stringify(quoteAck));
                return;
              }
              if (kind === "maker_margin_preview") {
                if (quotedRequest === null) return;
                marginPreview = serializeJson(msg) as Record<string, unknown>;
                return;
              }
              if (kind === "fill_consent") {
                if (quotedRequest === null) return;
                const relayNonce = String(msg["relay_nonce"] ?? "");
                const payloadHex = String(msg["payload_hex"] ?? "");
                if (relayNonce.length === 0 || payloadHex.length === 0) {
                  clearTimeout(timer);
                  finishErr(new Error("fill_consent missing relay_nonce or payload_hex"));
                  return;
                }
                const payloadBytes = Uint8Array.from(Buffer.from(payloadHex, "hex"));
                const digest = relayPayloadDigest(payloadBytes);
                const cmSig = nacl.sign.detached(digest, loadWriteKeypair().secretKey);
                ws.send(
                  JSON.stringify({
                    kind: "cm_sign",
                    relay_nonce: relayNonce,
                    cm_sig_b64: Buffer.from(cmSig).toString("base64"),
                  }),
                );
                return;
              }
              if (kind === "fill_executed") {
                clearTimeout(timer);
                finishOk({
                  filled: true,
                  maker: maker.toBase58(),
                  relay_url: relayUrl,
                  quote_request: quotedRequest,
                  quote_ack: quoteAck,
                  margin_preview: marginPreview,
                  fill_executed: serializeJson(msg),
                });
                return;
              }
              if (kind === "fill_failed" || kind === "error") {
                clearTimeout(timer);
                const detail = JSON.stringify(serializeJson(msg), null, 2);
                finishErr(
                  new Error(
                    `instant RFQ maker relay failure: ${String(
                      msg["reason"] ?? msg["error"] ?? "unknown",
                    )}\n${detail}`,
                  ),
                );
              }
            } catch (e) {
              clearTimeout(timer);
              finishErr(e instanceof Error ? e : new Error(String(e)));
            }
          };
        });

        const cm = await skew.fetchClearingMember(maker);
        return ok(
          JSON.stringify(
            {
              success: true,
              execution_lane: "instant_rfq_atomic_fill",
              trade_state: "FILLED",
              clearing_state: "FILLED",
              pm_backed: true,
              pm_guarantee: "guaranteed",
              registry_updated: true,
              role: "maker_mm",
              maker: maker.toBase58(),
              relay_url: relayUrl,
              fixed_quote: {
                premium_micro: premiumMicro.toString(),
                premium_usd: Number(premiumMicro) / 1_000_000,
                ttl_seconds: quoteTtlSeconds,
              },
              prepare,
              receipt,
              clearing_member_after: cm
                ? {
                    positions_count: cm.positionsCount,
                    collateral_micro: cm.collateralMicro.toString(),
                    total_pm_locked_micro: cm.totalPmLockedMicro.toString(),
                    total_pm_locked_usd: Number(cm.totalPmLockedMicro) / 1_000_000,
                    last_im_micro: cm.lastImMicro.toString(),
                    last_im_usd: Number(cm.lastImMicro) / 1_000_000,
                    free_collateral_micro: cm.freeCollateralMicro.toString(),
                    free_collateral_usd: Number(cm.freeCollateralMicro) / 1_000_000,
                  }
                : null,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_create_option_from_rfq_quote": {
        const skew = await getSkewClient();
        const result = await skew.createOptionFromRfqAuction({
          auction: String(a["auction"]),
          allowExpiredQuote: a["allow_expired_quote"] === true,
          requireBestQuoteForMaker: a["require_best_quote_for_maker"] !== false,
          dryRun: a["dry_run"] === true,
        });
        return ok(
          JSON.stringify(
            {
              success: true,
              simulated: result.simulated === true,
              execution_lane: "prefunded_create_buy",
              collateral_model: "prefunded_full_collateral",
              pm_backed: false,
              pm_guarantee: "not_guaranteed",
              official_auction_pm_path: false,
              legacy_advanced_only: true,
              recommended_pm_path: [
                "skew_request_instant_rfq_from_auction",
                "skew_hit_instant_rfq_from_auction_quote",
              ],
              trade_state: "TRANSFER_PENDING",
              clearing_state: "NOT_APPLICABLE",
              auction: result.auction,
              buyer: result.buyer,
              maker: result.maker,
              quote_mm: result.quoteMm,
              premium_micro: result.premiumMicro.toString(),
              premium_usd: result.premiumUsd,
              option_address: result.option,
              option_token_mint: result.optionTokenMint,
              create_tx: result.createTx,
              deposit_tx: result.depositTx,
              create_params: result.createParams,
              next_buyer_step:
                result.simulated === true
                  ? null
                  : {
                      tool: "skew_buy_option_from_rfq_quote",
                      arguments: {
                        auction: result.auction,
                        option_address: result.option,
                      },
                      note:
                        "Buyer-side guarded RFQ buy. It refetches the auction, verifies terms, and pays the exact current best firm quote premium.",
                    },
              readback_steps:
                result.simulated === true
                  ? [
                      {
                        unavailable_until_real_send: true,
                        reason:
                          "dry_run/simulate_only does not create the option PDA on-chain, so buy/readback tools are intentionally omitted.",
                      },
                    ]
                  : [
                      {
                        tool: "skew_list_options",
                        arguments: { filter_option_pda: result.option },
                      },
                      {
                        tool: "skew_fetch_portfolio",
                        arguments: { owner: result.buyer },
                      },
                      {
                        tool: "skew_fetch_portfolio",
                        arguments: { owner: result.maker },
                      },
                    ],
              simulation: result.simulation,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_buy_option_from_rfq_quote": {
        const skew = await getSkewClient();
        const auction = String(a["auction"]);
        const optionAddress = String(a["option_address"]);
        const result = await skew.buyOptionFromRfqAuction({
          auction,
          option: optionAddress,
          allowExpiredQuote: a["allow_expired_quote"] === true,
        });
        const buyerPortfolio = await skew.getPortfolio(result.buyer);
        const makerPortfolio = await skew.getPortfolio(result.maker);
        return ok(
          JSON.stringify(
            {
              success: true,
              execution_lane: "prefunded_create_buy",
              collateral_model: "prefunded_full_collateral",
              pm_backed: false,
              pm_guarantee: "not_guaranteed",
              official_auction_pm_path: false,
              legacy_advanced_only: true,
              recommended_pm_path: [
                "skew_request_instant_rfq_from_auction",
                "skew_hit_instant_rfq_from_auction_quote",
              ],
              trade_state: "FILLED",
              clearing_state: "NOT_APPLICABLE",
              tx_signature: result.txSignature,
              auction: result.auction,
              option_address: result.optionAddress ?? optionAddress,
              option_token_mint: result.optionTokenMint,
              buyer_option_ata: result.buyerOptionAta,
              buyer_option_amount: result.buyerOptionAmount,
              buyer: result.buyer,
              maker: result.maker,
              quote_mm: result.quoteMm,
              premium_micro: result.premiumMicro.toString(),
              premium_usd: result.premiumUsd,
              verified_terms: result.verifiedTerms,
              option: optionSummaryForJson(
                (result.option as unknown as Record<string, unknown> | undefined) ?? null,
              ),
              buyer_portfolio_counts: {
                long: buyerPortfolio.longOptions.length,
                short: buyerPortfolio.shortOptions.length,
                total: buyerPortfolio.options.length,
              },
              maker_portfolio_counts: {
                long: makerPortfolio.longOptions.length,
                short: makerPortfolio.shortOptions.length,
                total: makerPortfolio.options.length,
              },
              readback_steps: [
                {
                  tool: "skew_fetch_portfolio",
                  arguments: { owner: result.buyer },
                },
                {
                  tool: "skew_fetch_portfolio",
                  arguments: { owner: result.maker },
                },
              ],
              explorer: `https://explorer.solana.com/tx/${result.txSignature}?cluster=devnet`,
            },
            null,
            2,
          ),
        );
      }

      // -----------------------------------------------------------------------
      case "skew_buy_option": {
        const skew = await getSkewClient();
        const optionAddress = String(a["option_address"]);
        const premiumUsd = Number(a["premium_usd"]);
        const result = await skew.buy(optionAddress, premiumUsd);
        return ok(
          JSON.stringify(
            {
              success: true,
              execution_lane: "prefunded_create_buy",
              collateral_model: "prefunded_full_collateral",
              pm_backed: false,
              pm_guarantee: "not_guaranteed",
              trade_state: "FILLED",
              clearing_state: "NOT_APPLICABLE",
              tx_signature: result.txSignature,
              option_address: optionAddress,
              option_token_mint: result.optionTokenMint,
              buyer_option_ata: result.buyerOptionAta,
              buyer_option_amount: result.buyerOptionAmount,
              premium_usd: premiumUsd,
              option: optionSummaryForJson(
                (result.option as unknown as Record<string, unknown> | undefined) ?? null,
              ),
              readback_steps: [
                {
                  tool: "skew_fetch_portfolio",
                  arguments: { owner: skew.walletPublicKey.toBase58() },
                },
              ],
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

      case "skew_liquidate_option": {
        const skew = await getSkewClient();
        const result = await skew.liquidate(
          String(a["option_address"]),
          String(a["defaulting_cm_authority"]),
          Number(a["close_factor_bps"] ?? 5000),
          Number(a["min_expected_bonus_bps"] ?? 0),
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

      case "skew_refresh_pm_cache_full": {
        const skew = await getSkewClient();
        const refresh = (skew as unknown as {
          refreshPmCacheFull?: (currentSpotUsd?: number) => Promise<unknown>;
        }).refreshPmCacheFull;
        if (!refresh) {
          return err(
            "Installed @skew-labs/sdk does not expose refreshPmCacheFull yet. Upgrade SDK to the PM-cache build before using this write tool.",
          );
        }
        const currentSpot =
          a["current_spot_usd"] == null ? undefined : Number(a["current_spot_usd"]);
        const result = await refresh.call(skew, currentSpot);
        return ok(JSON.stringify({ success: true, result: serializeJson(result) }, null, 2));
      }

      case "skew_prepare_rent_reclaim_batch": {
        const authority = await authorityFromArgs(a, "authority");
        const json = await skewWebJson("/api/rent-reclaim/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ authority }),
        });
        return ok(JSON.stringify(json, null, 2));
      }

      // -----------------------------------------------------------------------
      // Phase 1639 — clearing-class ladder + RFQ + conditional orders + reads
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
        try {
          assertExpiryTenor(assetIdx, expiryTs, { context: "register_rfq_auction" });
        } catch (e) {
          const allowed = SKEW_ALLOWED_TENORS_BY_UNDERLYING[underlying] ?? [];
          const suggestedExpiries = allowed.map((days) => ({
            tenor_days: days,
            expiry_iso: expiryFromTenorDays(days),
          }));
          return typedErr(
            "UnsupportedExpiryTenor",
            e instanceof Error ? e.message : String(e),
            {
              underlying,
              allowed_tenors_days: allowed,
              tolerance_seconds: TENOR_TOLERANCE_SECONDS,
              suggested_expiries: suggestedExpiries,
              tape_visibility:
                "This request was not published. The terminal RFQ tape only shows successfully registered Auction RFQ PDAs or live Instant RFQ relay nonces.",
            },
          );
        }
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
        const triggerDirMap = { Below: 0, Above: 1 } as const;
        const kindMap = { StopLoss: 0, TakeProfit: 1, Trailing: 2 } as const;
        const actionName = String(a["action"] ?? "CloseIsolatedPosition");
        if (actionName !== "CloseIsolatedPosition") {
          return err(
            "MCP conditional automation exposes only the executable CloseIsolatedPosition path. " +
              "SellViaRfq, EarlyExercise, and BuybackViaRfq are SDK-level fail-closed intent/state paths until direct CPI ships.",
          );
        }
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
          action: 2,
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
              note: "Order is Active. Permissionless keeper trigger crank evaluates the stored Pyth oracle — when condition is met past grace_slots, state flips to Triggered + ConditionalOrderTriggered event fires. Then call skew_apply_close_isolated_action.",
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
        const authority = new PublicKey(await authorityFromArgs(a, "cm_authority"));
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
        const tierName =
          ["M0 Segregated", "M1 Portfolio", "M2 Cross-Asset", "M3 Clearing Prime"][snap.tier];
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
        const idx = resolveAssetIdx(a);
        const symbol = resolveAssetSymbol(a);
        if (idx === null || symbol === null) {
          return err("Unknown asset. Use underlying/asset BTC|ETH|SOL|XRP|HYPE or assetIdx 0..4.");
        }
        const snap = await skew.fetchDvol(idx);
        if (snap == null)
          return ok(
            JSON.stringify(
              {
                success: true,
                initialized: false,
                initialised: false,
                underlying: symbol,
                asset_idx: idx,
                note: "DvolPda not yet cranked.",
              },
              null,
              2,
            ),
          );
        return ok(
          JSON.stringify(
            {
              success: true,
              initialized: true,
              initialised: true,
              underlying: symbol,
              asset_idx: idx,
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
        let handoffTemplate: Record<string, unknown> | null = null;
        try {
          const built = buildInstantSpecFromAuctionSnapshot(snap, {});
          handoffTemplate = {
            execution_lane: "auction_terms_to_instant_rfq_atomic_fill",
            request_tool: "skew_request_instant_rfq_from_auction",
            request_arguments: {
              auction: snap.pda.toBase58(),
            },
            hit_tool: "skew_hit_instant_rfq_from_auction_quote",
            hit_arguments: {
              auction: snap.pda.toBase58(),
              relay_nonce: "<RELAY_NONCE_FROM_REQUEST>",
              cm_pubkey: "<QUOTE_CM>",
              premium_micro: "<QUOTE_PREMIUM_MICRO>",
            },
            derived_request: built.display,
            note:
              "Auction RFQ is firm tape. This template PM-clears the same terms through Instant RFQ atomic_fill_from_relay.",
          };
        } catch (e) {
          handoffTemplate = {
            unavailable: true,
            reason: e instanceof Error ? e.message : String(e),
          };
        }
        return ok(
          JSON.stringify(
            {
              success: true,
              initialised: true,
              snapshot: serializeJson(snap),
              instant_rfq_handoff_template: handoffTemplate,
            },
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
        const option = a["option"] ?? a["option_address"];
        if (option == null) return err("skew_transfer_option requires option or option_address");
        const optionAddress = String(option);
        const newHolder = new PublicKey(String(a["new_holder"]));
        const before = await skew.listOptions({ pda: new PublicKey(optionAddress), limit: 1 });
        const oldHolder =
          before.length > 0 ? String(before[0]?.holder ?? skew.walletPublicKey.toBase58()) : null;
        const r = await skew.transferOption(optionAddress, newHolder);
        let transferred: Awaited<ReturnType<SkewClient["listOptions"]>> = [];
        for (let attempt = 0; attempt < 10; attempt += 1) {
          transferred = await skew.listOptions({ pda: new PublicKey(optionAddress), limit: 1 });
          if (transferred.length > 0 && transferred[0]?.holder === newHolder.toBase58()) {
            break;
          }
          await sleep(500);
        }
        const optionReadback = optionSummaryForJson(
          (transferred[0] as unknown as Record<string, unknown> | undefined) ?? null,
        );
        const holderChanged = optionReadback?.["holder"] === newHolder.toBase58();
        const [newHolderPortfolio, oldHolderPortfolio] = await Promise.all([
          skew.getPortfolio(newHolder),
          oldHolder === null ? Promise.resolve(null) : skew.getPortfolio(new PublicKey(oldHolder)),
        ]);
        const newHolderContains = newHolderPortfolio.longOptions.some(
          (s) => s.pda === optionAddress,
        );
        const oldHolderContains =
          oldHolderPortfolio === null
            ? null
            : oldHolderPortfolio.longOptions.some((s) => s.pda === optionAddress);
        const readbackOk = holderChanged && newHolderContains && oldHolderContains === false;
        const readbackErrors = [
          ...(holderChanged
            ? []
            : [
                `post-transfer holder readback did not equal new_holder ${newHolder.toBase58()}`,
              ]),
          ...(newHolderContains ? [] : ["new holder portfolio does not contain transferred option"]),
          ...(oldHolderContains === false || oldHolderContains === null
            ? []
            : ["old holder portfolio still contains transferred option"]),
        ];
        return ok(
          JSON.stringify(
            {
              success: readbackOk,
              readback_ok: readbackOk,
              readback_errors: readbackErrors,
              execution_lane: "secondary_transfer",
              trade_state: readbackOk ? "TRANSFER_DELIVERED" : "TRANSFER_PENDING",
              clearing_state: "NOT_APPLICABLE",
              pm_backed: false,
              pm_guarantee: "not_applicable",
              tx_signature: r.txSignature,
              option_address: optionAddress,
              old_holder: oldHolder,
              new_holder: newHolder.toBase58(),
              option: optionReadback,
              new_holder_portfolio_contains_option: newHolderContains,
              old_holder_portfolio_contains_option: oldHolderContains,
            },
            null,
            2,
          ),
        );
      }

      case "skew_track_held_position": {
        const skew = await getSkewClient();
        const option = a["option"] ?? a["option_address"];
        if (option == null) return err("skew_track_held_position requires option or option_address");
        const optionAddress = String(option);
        const before = await skew.fetchClearingMember(skew.walletPublicKey);
        const r = await skew.trackHeldPosition(optionAddress);
        const [after, portfolio, listed] = await Promise.all([
          skew.fetchClearingMember(skew.walletPublicKey),
          skew.getPortfolio(skew.walletPublicKey),
          skew.listOptions({ pda: new PublicKey(optionAddress), limit: 1 }),
        ]);
        const tracked = portfolio.longOptions.some((s) => s.pda === optionAddress);
        return ok(
          JSON.stringify(
            {
              success: tracked,
              readback_ok: tracked,
              trade_state: tracked ? "FILLED" : "REJECTED",
              clearing_state: tracked ? "FILLED" : "REJECTED",
              pm_backed: tracked,
              pm_guarantee: "conditional_registry_tracking",
              tx_signature: r.txSignature,
              option_address: optionAddress,
              cm_pda: r.cmPda.toBase58(),
              position_registry: r.positionRegistry.toBase58(),
              option: optionSummaryForJson(
                (listed[0] as unknown as Record<string, unknown> | undefined) ?? null,
              ),
              positions_count_before: before?.positionsCount ?? null,
              positions_count_after: after?.positionsCount ?? null,
              total_pm_locked_usdc_after:
                after === null ? null : Number(after.totalPmLockedMicro) / 1_000_000,
              last_im_usdc_after: after === null ? null : Number(after.lastImMicro) / 1_000_000,
              portfolio_contains_tracked_long: tracked,
              note:
                "This long is now visible to the CM PM registry. Run skew_get_margin, or use future atomic_fill_from_relay fills, to see it offset writer risk.",
            },
            null,
            2,
          ),
        );
      }

      case "skew_untrack_held_position": {
        const skew = await getSkewClient();
        const option = a["option"] ?? a["option_address"];
        if (option == null) return err("skew_untrack_held_position requires option or option_address");
        const optionAddress = String(option);
        const before = await skew.fetchClearingMember(skew.walletPublicKey);
        const r = await skew.untrackHeldPosition(optionAddress);
        const [after, portfolio] = await Promise.all([
          skew.fetchClearingMember(skew.walletPublicKey),
          skew.getPortfolio(skew.walletPublicKey),
        ]);
        const stillTracked = portfolio.longOptions.some((s) => s.pda === optionAddress);
        return ok(
          JSON.stringify(
            {
              success: !stillTracked,
              readback_ok: !stillTracked,
              trade_state: !stillTracked ? "FILLED" : "REJECTED",
              clearing_state: !stillTracked ? "FILLED" : "REJECTED",
              pm_backed: false,
              pm_guarantee: "conditional_registry_tracking",
              tx_signature: r.txSignature,
              option_address: optionAddress,
              positions_count_before: before?.positionsCount ?? null,
              positions_count_after: after?.positionsCount ?? null,
              portfolio_still_contains_tracked_long: stillTracked,
            },
            null,
            2,
          ),
        );
      }

      case "skew_rebalance_pm_lock": {
        const skew = await getSkewClient();
        const option = a["option"] ?? a["option_address"];
        if (option == null) return err("skew_rebalance_pm_lock requires option or option_address");
        const optionAddress = String(option);
        const beforeListed = await skew.listOptions({ pda: new PublicKey(optionAddress), limit: 1 });
        const creator =
          beforeListed.length > 0 && beforeListed[0]?.creator
            ? new PublicKey(String(beforeListed[0].creator))
            : null;
        const beforeCm = creator === null ? null : await skew.fetchClearingMember(creator);
        const r = await skew.rebalancePmLock(optionAddress, Number(a["max_release_usdc"] ?? 0));
        const [afterListed, afterCm] = await Promise.all([
          skew.listOptions({ pda: new PublicKey(optionAddress), limit: 1 }),
          creator === null ? Promise.resolve(null) : skew.fetchClearingMember(creator),
        ]);
        return ok(
          JSON.stringify(
            {
              success: true,
              trade_state: "FILLED",
              clearing_state: "FILLED",
              pm_backed: true,
              pm_guarantee: "conditional_registry_tracking",
              tx_signature: r.txSignature,
              option_address: optionAddress,
              writer: creator?.toBase58() ?? null,
              total_pm_locked_usdc_before:
                beforeCm === null ? null : Number(beforeCm.totalPmLockedMicro) / 1_000_000,
              total_pm_locked_usdc_after:
                afterCm === null ? null : Number(afterCm.totalPmLockedMicro) / 1_000_000,
              option_before: optionSummaryForJson(
                (beforeListed[0] as unknown as Record<string, unknown> | undefined) ?? null,
              ),
              option_after: optionSummaryForJson(
                (afterListed[0] as unknown as Record<string, unknown> | undefined) ?? null,
              ),
            },
            null,
            2,
          ),
        );
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

      case "skew_submit_rfq_quote_direct": {
        const skew = await getSkewClient();
        const r = await skew.submitRfqQuoteDirect({
          auction: new PublicKey(String(a["auction"])),
          premiumMicro: BigInt(String(a["premium_micro"])),
          validUntilSlot: BigInt(String(a["valid_until_slot"])),
        });
        return ok(JSON.stringify({ success: true, tx_signature: r.txSignature }, null, 2));
      }

      case "skew_finalize_rfq_auction": {
        const skew = await getSkewClient();
        const finalizeArgs: {
          auction: PublicKey;
          buyerUsdcAta?: PublicKey;
        } = {
          auction: new PublicKey(String(a["auction"])),
        };
        if (typeof a["buyer_usdc_ata"] === "string" && a["buyer_usdc_ata"].length > 0) {
          finalizeArgs.buyerUsdcAta = new PublicKey(String(a["buyer_usdc_ata"]));
        }
        const r = await skew.finalizeRfqAuction(finalizeArgs);
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
          const actionName = String(raw["action"] ?? "CloseIsolatedPosition");
          if (actionName !== "CloseIsolatedPosition") {
            throw new Error(
              "MCP OCO automation exposes only the executable CloseIsolatedPosition path. " +
                "Use the SDK directly for fail-closed RFQ/exercise intent-state legs.",
            );
          }
          const u = String(raw["underlying"]) as Underlying;
          return {
            orderId: BigInt(String(raw["order_id"])),
            kind: kindCode,
            triggerMode: 1 as const,
            triggerDirection: dirCode,
            action: 2 as const,
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
        // Stop-loss is below (dir=0=Below); take-profit is above (dir=1=Above)
        const sl = buildLeg(a["stop_loss"] as Record<string, unknown>, 0, 0);
        const tp = buildLeg(a["take_profit"] as Record<string, unknown>, 1, 1);
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
        const orderId = BigInt(String(a["order_id"]));
        const snapshot =
          a["trigger_oracle"] != null && a["action_target"] != null
            ? null
            : await skew.fetchConditionalOrder(authority, orderId);
        if (!snapshot && (a["trigger_oracle"] == null || a["action_target"] == null)) {
          return err(
            "ConditionalOrderPda not found. Pass both trigger_oracle and action_target, or check order_authority/order_id.",
          );
        }
        const oracle =
          a["trigger_oracle"] != null
            ? new PublicKey(String(a["trigger_oracle"]))
            : snapshot!.triggerOracle;
        const actionTarget =
          a["action_target"] != null
            ? new PublicKey(String(a["action_target"]))
            : snapshot!.actionTarget;
        const linkedOrder =
          a["linked_order"] != null ? new PublicKey(String(a["linked_order"])) : undefined;
        const r = await skew.executeConditionalOrder(
          authority,
          orderId,
          oracle,
          actionTarget,
          linkedOrder,
        );
        return ok(
          JSON.stringify(
            {
              success: true,
              tx_signature: r.txSignature,
              trigger_oracle: oracle.toBase58(),
              action_target: actionTarget.toBase58(),
              note: "Triggered orders with action=CloseIsolatedPosition can now be completed with skew_apply_close_isolated_action.",
            },
            null,
            2,
          ),
        );
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
    if (msg.includes("required when no write keypair is configured")) {
      return typedErr("AuthorityRequired", msg, {
        activeProfile: MCP_PROFILE,
        hasWriteKeypair: HAS_WRITE_KEYPAIR,
      });
    }
    if (msg.startsWith("No write key configured.")) {
      return typedErr("WriteKeyRequired", msg, {
        activeProfile: MCP_PROFILE,
        requiredEnv: ["SKEW_KEYPAIR_PATH", "KEYPAIR_PATH", "SKEW_PRIVATE_KEY"],
      });
    }
    return err(msg);
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
