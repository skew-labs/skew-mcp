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
  resolvePythFeed,
  type Underlying,
  type PayoffType,
} from "@skew/sdk";
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
  // Load IDL from the installed @skew/sdk package
  const idl = require("@skew/sdk/idl/skew_master.json") as Idl;

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

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "skew", version: "0.1.0" },
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

        // Fetch current spot from Pyth for the pricing request
        const { price: spot } = await fetchSpot(underlying).catch(() => ({ price: undefined as number | undefined, conf: 0 }));

        // POST /price — same field names as PriceRequest in server.rs
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
        return ok(
          JSON.stringify(
            {
              ...json,
              inputs: { underlying, payoff, strike_usd: strike, notional_usd: notional, expiry, spot_usd: spot },
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
