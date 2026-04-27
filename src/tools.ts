import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool catalog for @skew-labs/mcp.
 *
 * Each tool wraps either an on-chain instruction (via @skew-labs/sdk) or a
 * `skew-pricing` HTTP endpoint. Tool descriptions are user-facing and have
 * to be intelligible to the language model that will pick which tool to
 * call. They intentionally avoid naming the off-chain pricing engine's
 * internal estimator framework — the framework is implementation detail and
 * is not part of this package's public surface.
 */
export const SKEW_TOOLS: Tool[] = [
  // ──────────────────────────────────────────────────────────────────────
  // Lifecycle (write tools — require SKEW_PRIVATE_KEY)
  // ──────────────────────────────────────────────────────────────────────
  {
    name: "skew_create_option",
    description:
      "Create an options contract on Skew (Solana devnet). Deposits USDC collateral and mints an option SPL token. Returns the option PDA address. Supported assets: BTC, ETH, SOL, XRP, HYPE. Payoffs: digital_call, digital_put, vanilla_call, vanilla_put, capped_call, capped_put, range_accrual.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: {
          type: "string",
          enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
          description: "Underlying asset",
        },
        payoff: {
          type: "string",
          enum: [
            "digital_call",
            "digital_put",
            "vanilla_call",
            "vanilla_put",
            "capped_call",
            "capped_put",
            "range_accrual",
          ],
          description: "Option payoff type",
        },
        strike: {
          type: "number",
          description: "Strike price in USD (e.g. 80000 for $80k BTC call)",
        },
        expiry: {
          type: "string",
          description: "Expiry in ISO 8601 UTC format (e.g. 2026-05-10T16:00:00Z)",
        },
        notional: {
          type: "number",
          description: "Max payoff in USDC (e.g. 1000 for $1,000)",
        },
        upperBound: {
          type: "number",
          description:
            "Required for range_accrual and capped_call/put: upper bound or cap strike in USD",
        },
      },
      required: ["underlying", "payoff", "strike", "expiry", "notional"],
    },
  },
  {
    name: "skew_buy_option",
    description:
      "Buy an existing option on Skew devnet. Pays premium from buyer's USDC ATA to the creator. Returns the transaction signature.",
    inputSchema: {
      type: "object",
      properties: {
        option_address: {
          type: "string",
          description: "Option PDA address (base58), returned by skew_create_option",
        },
        premium_usd: {
          type: "number",
          description: "Premium to pay in USD (e.g. 25.0 for $25 USDC)",
        },
      },
      required: ["option_address", "premium_usd"],
    },
  },
  {
    name: "skew_settle_option",
    description:
      "Settle an expired option on Skew devnet. Reads the Pyth price, pays ITM payoff to holder, returns residual to creator. Permissionless — anyone can call.",
    inputSchema: {
      type: "object",
      properties: {
        option_address: {
          type: "string",
          description: "Option PDA address (base58) to settle",
        },
      },
      required: ["option_address"],
    },
  },

  // ──────────────────────────────────────────────────────────────────────
  // Read tools (no wallet required)
  // ──────────────────────────────────────────────────────────────────────
  {
    name: "skew_get_fair_value",
    description:
      "Get a suggested fair-value premium for an option from the Skew pricing service. Returns price in USD plus delta, gamma, vega, theta, rho. Advisory only — the on-chain program does not read this number.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: {
          type: "string",
          enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
          description: "Underlying asset",
        },
        payoff: {
          type: "string",
          enum: [
            "digital_call",
            "digital_put",
            "vanilla_call",
            "vanilla_put",
            "capped_call",
            "capped_put",
            "range_accrual",
          ],
        },
        strike: {
          type: "number",
          description: "Strike price in USD",
        },
        expiry: {
          type: "string",
          description: "Expiry in ISO 8601 UTC format",
        },
        notional: {
          type: "number",
          description: "Notional in USD",
        },
        upperBound: {
          type: "number",
          description: "For range_accrual / capped: upper bound in USD",
        },
      },
      required: ["underlying", "payoff", "strike", "expiry", "notional"],
    },
  },
  {
    name: "skew_get_spot",
    description:
      "Get the current spot price for a supported asset from Pyth Network (Hermes REST). Returns USD price and confidence interval.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: {
          type: "string",
          enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
          description: "Asset to query",
        },
      },
      required: ["underlying"],
    },
  },
  {
    name: "skew_list_options",
    description:
      "List recent options on Skew devnet. Queries on-chain via Solana RPC. Returns option addresses, type, status, expiry, and strike.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Max number of options to return (default 10, max 50)",
        },
        underlying: {
          type: "string",
          enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
          description: "Filter by underlying asset (optional)",
        },
      },
      required: [],
    },
  },

  // ──────────────────────────────────────────────────────────────────────
  // Volatility tools (v0.2.0 — read-only, advisory)
  // ──────────────────────────────────────────────────────────────────────
  {
    name: "skew_get_iv_smile",
    description:
      "Get the implied-volatility smile for one expiry — IV across a strike ladder, plus 25-delta risk reversal and butterfly. Useful for spotting skew (puts vs calls relative pricing) before you write or buy.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: {
          type: "string",
          enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
          description: "Asset to query",
        },
        expiry_days: {
          type: "number",
          description: "Days to expiry (e.g. 7, 14, 30)",
        },
      },
      required: ["underlying", "expiry_days"],
    },
  },
  {
    name: "skew_get_term_structure",
    description:
      "Get ATM implied volatility across a standard expiry ladder (7d, 14d, 30d, 60d, 90d, 180d). The shape tells you whether the market expects near-term or far-term volatility — flat = stable, downward-sloping = backwardation = market expects calmer future, upward-sloping = contango.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: {
          type: "string",
          enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
          description: "Asset to query",
        },
      },
      required: ["underlying"],
    },
  },
  {
    name: "skew_get_volatility_summary",
    description:
      "Get a one-shot volatility view for an asset — current spot, ATM 30-day IV, smile skew (put vs call), term-structure shape, and a generic vol-view label (stable / elevated / compressing). Designed to answer questions like 'how do you see BTC vol next week?' in a single call.",
    inputSchema: {
      type: "object",
      properties: {
        underlying: {
          type: "string",
          enum: ["BTC", "ETH", "SOL", "XRP", "HYPE"],
          description: "Asset to query",
        },
      },
      required: ["underlying"],
    },
  },
];
