#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Connection, Keypair } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.resolve(__dirname, "..");
const RELAY_URL = process.env.SKEW_RELAY_URL ?? "ws://127.0.0.1:8788/subscribe";
const RPC_URL = process.env.SKEW_RPC_URL ?? "https://api.devnet.solana.com";
const buyerKp = process.env.SKEW_BUYER_KEYPAIR ?? "C:/Users/woon2/.config/solana/skew-options.json";
const makerKp = process.env.SKEW_MAKER_KEYPAIR ?? "C:/Users/woon2/.config/solana/skew-mm.json";

function pubkeyOf(kpPath) {
  const raw = JSON.parse(fs.readFileSync(kpPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
}

function textOf(result) {
  return (result.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

class Mcp {
  constructor(label, kpPath) {
    this.label = label;
    this.kpPath = kpPath;
    this.pubkey = pubkeyOf(kpPath);
  }

  async connect() {
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/server.js"],
      cwd: MCP_DIR,
      env: {
        ...process.env,
        SKEW_KEYPAIR_PATH: this.kpPath,
        KEYPAIR_PATH: this.kpPath,
        SKEW_MCP_PROFILE: "all",
        NODE_NO_WARNINGS: "1",
        DEBUG: "",
      },
    });
    this.client = new Client({ name: `local-relay-recheck-${this.label}`, version: "0.1.0" });
    await this.client.connect(this.transport);
  }

  async call(name, args = {}, timeoutMs = 180_000) {
    try {
      const result = await Promise.race([
        this.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timeout ${name}`)), timeoutMs),
        ),
      ]);
      const text = textOf(result);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // keep raw text
      }
      return { ok: result.isError !== true && !text.startsWith("Error:"), text, json };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e), json: null };
    }
  }

  async close() {
    await this.client?.close?.().catch(() => {});
  }
}

const buyer = new Mcp("buyer", buyerKp);
const maker = new Mcp("maker", makerKp);
await buyer.connect();
await maker.connect();

try {
  const connection = new Connection(RPC_URL, "confirmed");
  const spotRes = await buyer.call("skew_get_spot", { underlying: "SOL" });
  const spot = Number(spotRes.json?.price ?? spotRes.json?.price_usd ?? 95);
  const refreshCache = await maker.call(
    "skew_refresh_pm_cache_full",
    { current_spot_usd: spot },
    300_000,
  );
  console.log("refreshPmCache", refreshCache.ok, refreshCache.text.slice(0, 1000));
  const strike = Math.round(spot * 1.05 * 100) / 100;
  const expiry = new Date(Date.now() + 7 * 86_400_000);
  expiry.setUTCMilliseconds(0);
  const expiryIso = expiry.toISOString();
  console.log(JSON.stringify({ buyer: buyer.pubkey, maker: maker.pubkey, RELAY_URL, strike, expiryIso }, null, 2));

  const auctionId = String(
    BigInt(Date.now() % 1_000_000_000) * 100_000n + BigInt(Math.floor(Math.random() * 100_000)),
  );
  const register = await buyer.call(
    "skew_register_rfq_auction",
    {
      auction_id: auctionId,
      underlying: "SOL",
      payoff: "vanilla_call",
      strike,
      expiry: expiryIso,
      notional: 150,
      max_premium_usd: 2.25,
      settlement_mint: "USDC",
      duration_slots: 35,
    },
    240_000,
  );
  console.log("register", register.ok, register.text.slice(0, 700));
  if (!register.json?.auction_pda) throw new Error("auction registration did not return auction_pda");

  const auction = register.json.auction_pda;
  const slot = await connection.getSlot("confirmed");
  const quote = await maker.call(
    "skew_submit_rfq_quote_direct",
    { auction, premium_micro: "750000", valid_until_slot: String(slot + 250) },
    180_000,
  );
  console.log("quote", quote.ok, quote.text.slice(0, 700));
  await new Promise((resolve) => setTimeout(resolve, 18_000));

  const finalize = await buyer.call("skew_finalize_rfq_auction", { auction }, 180_000);
  console.log("finalize", finalize.ok, finalize.text.slice(0, 700));

  const makerPromise = maker.call(
    "skew_serve_instant_rfq_mm_once",
    {
      premium_usd: 0.75,
      quote_ttl_seconds: 90,
      timeout_ms: 180_000,
      auto_prepare: true,
      initial_collateral_usdc: 450,
      filter_underlying: "SOL",
      filter_payoff: "vanilla_call",
      relay_url: RELAY_URL,
    },
    210_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const request = await buyer.call(
    "skew_request_instant_rfq_from_auction",
    {
      auction,
      timeout_ms: 20_000,
      max_quotes: 3,
      required_cm_pubkey: maker.pubkey,
      relay_url: RELAY_URL,
    },
    90_000,
  );
  console.log("request", request.ok, request.text.slice(0, 1200));
  if (!request.ok || Number(request.json?.quote_count ?? 0) < 1) {
    console.log("maker", await makerPromise);
    throw new Error("local relay did not return an auction-derived instant quote");
  }

  const selected = request.json.quotes[0];
  const hit = await buyer.call(
    "skew_hit_instant_rfq_from_auction_quote",
    {
      auction,
      relay_nonce: request.json.relay_nonce,
      cm_pubkey: selected.cm_pubkey,
      premium_micro: selected.premium_micro,
      timeout_ms: 90_000,
      relay_url: RELAY_URL,
    },
    150_000,
  );
  console.log("hit", hit.ok, hit.text.slice(0, 2400));
  const makerReceipt = await makerPromise;
  console.log("makerReceipt", makerReceipt.ok, makerReceipt.text.slice(0, 2400));

  if (!hit.ok || hit.json?.readback_ok !== true) {
    process.exitCode = 1;
  }
} finally {
  await buyer.close();
  await maker.close();
  process.exit(process.exitCode ?? 0);
}
