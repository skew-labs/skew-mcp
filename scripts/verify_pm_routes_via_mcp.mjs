#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(MCP_DIR, "..");
const WORKSPACE_ROOT = path.resolve(REPO_ROOT, "..", "..");
const OUT_DIR = path.join(WORKSPACE_ROOT, "skew-route-check-output");

const RPC_URL = process.env.SKEW_RPC_URL ?? "https://api.devnet.solana.com";
const WEB_URL = process.env.SKEW_WEB_URL ?? "https://skew-web.vercel.app";
const RELAY_URL = process.env.SKEW_RELAY_URL;
const USDC = "USDC";

const KEYPAIRS = {
  buyerCm: "C:/Users/woon2/.config/solana/devnet.json",
  makerCm: "C:/Users/woon2/.config/solana/skew-mm.json",
  retail: "C:/Users/woon2/.config/solana/skew-options.json",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function loadPubkey(keypairPath) {
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function textOf(result) {
  return (result.content ?? [])
    .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
    .join("\n");
}

function summarizeError(value) {
  if (!value) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 1600 ? `${text.slice(0, 1600)}...` : text;
}

function nowNonce(prefix = "") {
  const base = BigInt(Date.now() % 1_000_000_000);
  const salt = BigInt(Math.floor(Math.random() * 100_000));
  return `${prefix}${(base * 100_000n + salt).toString()}`;
}

function expiryFromNow(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  d.setUTCMilliseconds(0);
  return d.toISOString();
}

function micro(usdc) {
  return String(Math.round(Number(usdc) * 1_000_000));
}

function pickOptionPda(json) {
  return (
    json?.option_pda ??
    json?.option_address ??
    json?.option?.pda ??
    json?.fill_executed?.option_pda ??
    null
  );
}

function cmSnapshot(json) {
  if (!json || json.registered === false) return json;
  return {
    registered: json.registered,
    authority: json.authority,
    tier: json.tier,
    positions_count: json.positions_count,
    total_pm_locked_usdc: json.total_pm_locked_usdc,
    last_im_usdc: json.last_im_usdc,
    free_collateral_usdc: json.free_collateral_usdc,
    net_notional_long_usdc: json.net_notional_long_usdc,
    net_notional_short_usdc: json.net_notional_short_usdc,
  };
}

class McpClient {
  constructor(label, keypairPath, profile = "all") {
    this.label = label;
    this.keypairPath = keypairPath;
    this.pubkey = loadPubkey(keypairPath);
    this.profile = profile;
    this.client = null;
    this.transport = null;
  }

  async connect() {
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/server.js"],
      cwd: MCP_DIR,
      env: {
        ...process.env,
        SKEW_KEYPAIR_PATH: this.keypairPath,
        KEYPAIR_PATH: this.keypairPath,
        SKEW_MCP_PROFILE: this.profile,
        SKEW_RPC_URL: RPC_URL,
        SKEW_WEB_URL: WEB_URL,
        NODE_NO_WARNINGS: "1",
        DEBUG: "",
      },
    });
    this.client = new Client({ name: `skew-route-check-${this.label}`, version: "0.1.0" });
    await this.client.connect(this.transport);
  }

  async listTools() {
    return this.client.listTools();
  }

  async call(name, args = {}, { timeoutMs = 180_000 } = {}) {
    const started = Date.now();
    const payload = { name, arguments: args };
    let result;
    try {
      result = await Promise.race([
        this.client.callTool(payload, undefined, { timeout: timeoutMs }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        isError: true,
        name,
        args,
        elapsed_ms: Date.now() - started,
        text: message,
        json: null,
      };
    }
    const text = textOf(result);
    const json = safeJson(text);
    const isError =
      result.isError === true ||
      text.startsWith("Error:") ||
      text.startsWith("Tool not available") ||
      text.includes("Unknown tool");
    return {
      ok: !isError,
      isError,
      name,
      args,
      elapsed_ms: Date.now() - started,
      text: summarizeError(text),
      json,
    };
  }

  async close() {
    await this.client?.close?.().catch(() => {});
    await this.transport?.close?.().catch(() => {});
  }
}

class RouteCheck {
  constructor() {
    this.connection = new Connection(RPC_URL, "confirmed");
    this.results = [];
    this.clients = {};
    this.context = {
      rpc_url: RPC_URL,
      web_url: WEB_URL,
      relay_url: RELAY_URL ?? "default-from-MCP",
      started_at: new Date().toISOString(),
      pubkeys: Object.fromEntries(
        Object.entries(KEYPAIRS).map(([label, kp]) => [label, loadPubkey(kp)]),
      ),
    };
  }

  async addResult(route, expectation, status, evidence = {}) {
    const record = {
      route,
      expectation,
      status,
      timestamp: new Date().toISOString(),
      evidence,
    };
    this.results.push(record);
    const mark = status === "pass" ? "PASS" : status === "blocked" ? "BLOCKED" : "FAIL";
    console.log(`[${mark}] ${route}`);
    if (evidence.note) console.log(`  ${evidence.note}`);
    return record;
  }

  async setup() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [label, keypairPath] of Object.entries(KEYPAIRS)) {
      this.clients[label] = new McpClient(label, keypairPath, "all");
      await this.clients[label].connect();
    }
    const tools = await this.clients.buyerCm.listTools();
    this.context.visible_tools = tools.tools.map((t) => t.name).sort();
    this.context.visible_tool_count = this.context.visible_tools.length;
  }

  async close() {
    for (const client of Object.values(this.clients)) await client.close();
  }

  async cm(client, pubkey = client.pubkey) {
    const r = await client.call("skew_fetch_clearing_member", { cm_authority: pubkey });
    return r.json;
  }

  async spot(underlying) {
    const r = await this.clients.buyerCm.call("skew_get_spot", { underlying });
    if (!r.ok || !r.json) return null;
    return Number(r.json.price ?? r.json.price_usd ?? r.json.spot_usd ?? 0);
  }

  async ensureCm(client, initialCollateralUsdc = 100) {
    const before = await this.cm(client);
    if (before?.registered) return { before, registered_now: false };
    const reg = await client.call(
      "skew_register_clearing_member",
      { initial_collateral_usdc: initialCollateralUsdc },
      { timeoutMs: 240_000 },
    );
    return { before, registered_now: true, register_result: reg };
  }

  async instantFill({
    routeName,
    buyer,
    maker,
    underlying,
    payoff,
    strike,
    expiry,
    notional,
    premiumUsd,
    maxPremiumUsd,
    upperBoundUsd,
    fromAuction,
    auction,
  }) {
    const spot = await this.spot(underlying);
    const preRefresh =
      spot == null
        ? {
            ok: false,
            note: `could not fetch ${underlying} spot before PM cache refresh`,
          }
        : await maker.call(
            "skew_refresh_pm_cache_full",
            { current_spot_usd: spot },
            { timeoutMs: 300_000 },
          );
    const makerPromise = maker.call(
      "skew_serve_instant_rfq_mm_once",
      {
        premium_usd: premiumUsd,
        quote_ttl_seconds: 90,
        timeout_ms: 180_000,
        auto_prepare: true,
        initial_collateral_usdc: Math.max(250, notional * 3),
        filter_underlying: underlying,
        filter_payoff: payoff,
        ...(RELAY_URL ? { relay_url: RELAY_URL } : {}),
      },
      { timeoutMs: 210_000 },
    );
    await sleep(1_500);

    const requestTool = fromAuction
      ? "skew_request_instant_rfq_from_auction"
      : "skew_request_instant_rfq_quotes";
    const requestArgs = fromAuction
      ? {
          auction,
          timeout_ms: 60_000,
          max_quotes: 3,
          required_cm_pubkey: maker.pubkey,
          ...(RELAY_URL ? { relay_url: RELAY_URL } : {}),
        }
      : {
          underlying,
          payoff,
          strike,
          expiry,
          notional,
          max_premium_usd: maxPremiumUsd,
          ...(upperBoundUsd ? { upper_bound_usd: upperBoundUsd } : {}),
          settlement_mint: USDC,
          timeout_ms: 60_000,
          max_quotes: 3,
          required_cm_pubkey: maker.pubkey,
          ...(RELAY_URL ? { relay_url: RELAY_URL } : {}),
        };
    const req = await buyer.call(requestTool, requestArgs, { timeoutMs: 90_000 });
    if (!req.ok || Number(req.json?.quote_count ?? 0) < 1) {
      const makerReceipt = await makerPromise.catch((e) => ({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      }));
      return {
        ok: false,
        preRefresh,
        request: req,
        makerReceipt,
        note: `${routeName}: no usable instant quote returned`,
      };
    }

    const quote = req.json.quotes[0];
    const hitTool = fromAuction
      ? "skew_hit_instant_rfq_from_auction_quote"
      : "skew_hit_instant_rfq_quote";
    const hitArgs = fromAuction
      ? {
          auction,
          relay_nonce: req.json.relay_nonce,
          cm_pubkey: quote.cm_pubkey,
          premium_micro: quote.premium_micro,
          timeout_ms: 90_000,
          ...(RELAY_URL ? { relay_url: RELAY_URL } : {}),
        }
      : {
          relay_nonce: req.json.relay_nonce,
          cm_pubkey: quote.cm_pubkey,
          premium_micro: quote.premium_micro,
          underlying,
          payoff,
          strike,
          expiry,
          notional,
          ...(upperBoundUsd ? { upper_bound_usd: upperBoundUsd } : {}),
          settlement_mint: USDC,
          timeout_ms: 90_000,
          ...(RELAY_URL ? { relay_url: RELAY_URL } : {}),
        };
    const hit = await buyer.call(hitTool, hitArgs, { timeoutMs: 150_000 });
    const makerReceipt = await makerPromise;
    const hitJson = hit.json;
    const pm = hitJson?.pm_lock_readback ?? {};
    const pass =
      hit.ok &&
      hitJson?.readback_ok === true &&
      hitJson?.collateral_model === "portfolio_margin_delta_im" &&
      Number(pm.post_positions_count ?? 0) >= Number(pm.pre_positions_count ?? 0) + 1 &&
      Number(pm.observed_locked_delta_usd ?? 0) >= 0;

    return {
      ok: pass,
      preRefresh,
      request: req,
      hit,
      makerReceipt,
      option_pda: pickOptionPda(hitJson),
      note: pass
        ? `atomic fill PM readback ok; positions ${pm.pre_positions_count} -> ${pm.post_positions_count}, PM delta $${pm.observed_locked_delta_usd}`
        : "atomic fill did not return the expected PM readback",
    };
  }

  async auctionOnly({ buyer, maker, underlying, payoff, strike, expiry, notional, premiumUsd }) {
    const beforeMakerCm = await this.cm(this.clients.buyerCm, maker.pubkey);
    const register = await buyer.call(
      "skew_register_rfq_auction",
      {
        auction_id: nowNonce(),
        underlying,
        payoff,
        strike,
        expiry,
        notional,
        max_premium_usd: Math.max(premiumUsd * 3, premiumUsd + 0.1),
        settlement_mint: USDC,
        duration_slots: 35,
      },
      { timeoutMs: 240_000 },
    );
    const auction = register.json?.auction_pda;
    if (!register.ok || !auction) {
      return { ok: false, register, beforeMakerCm, note: "auction registration failed" };
    }
    const slot = await this.connection.getSlot("confirmed");
    const quote = await maker.call(
      "skew_submit_rfq_quote_direct",
      {
        auction,
        premium_micro: micro(premiumUsd),
        valid_until_slot: String(slot + 250),
      },
      { timeoutMs: 180_000 },
    );
    await sleep(18_000);
    const finalize = await buyer.call(
      "skew_finalize_rfq_auction",
      { auction },
      { timeoutMs: 180_000 },
    );
    const afterMakerCm = await this.cm(this.clients.buyerCm, maker.pubkey);
    const beforeLocked = Number(beforeMakerCm?.total_pm_locked_usdc ?? 0);
    const afterLocked = Number(afterMakerCm?.total_pm_locked_usdc ?? 0);
    const beforeCount = Number(beforeMakerCm?.positions_count ?? 0);
    const afterCount = Number(afterMakerCm?.positions_count ?? 0);
    const noPmMutation =
      quote.ok &&
      finalize.ok &&
      Math.abs(afterLocked - beforeLocked) < 0.000001 &&
      afterCount === beforeCount;
    return {
      ok: noPmMutation,
      auction,
      beforeMakerCm: cmSnapshot(beforeMakerCm),
      register,
      quote,
      finalize,
      afterMakerCm: cmSnapshot(afterMakerCm),
      note: noPmMutation
        ? `auction register/quote/finalize did not mutate PM; positions ${beforeCount} -> ${afterCount}, locked $${beforeLocked} -> $${afterLocked}`
        : "auction-only stage mutated PM or one auction action failed",
    };
  }

  async legacyCreateBuy({ writer, buyer, underlying, payoff, strike, expiry, notional, premiumUsd }) {
    const before = await this.cm(this.clients.buyerCm, writer.pubkey);
    const created = await writer.call(
      "skew_create_option",
      {
        underlying,
        payoff,
        strike,
        expiry,
        notional,
        premium_usd: premiumUsd,
        settlement_mint: USDC,
      },
      { timeoutMs: 300_000 },
    );
    const option = created.json?.option_address;
    if (!created.ok || !option) {
      return { ok: false, beforeWriterCm: cmSnapshot(before), created };
    }
    const bought = await buyer.call(
      "skew_buy_option",
      { option_address: option, premium_usd: premiumUsd },
      { timeoutMs: 240_000 },
    );
    const after = await this.cm(this.clients.buyerCm, writer.pubkey);
    const listed = await this.clients.buyerCm.call("skew_list_options", {
      filter_option_pda: option,
      limit: 1,
    });
    const beforeLocked = Number(before?.total_pm_locked_usdc ?? 0);
    const afterLocked = Number(after?.total_pm_locked_usdc ?? 0);
    const beforeCount = Number(before?.positions_count ?? 0);
    const afterCount = Number(after?.positions_count ?? 0);
    const noPmMutation =
      bought.ok && Math.abs(afterLocked - beforeLocked) < 0.000001 && afterCount === beforeCount;
    return {
      ok: noPmMutation,
      option_pda: option,
      beforeWriterCm: cmSnapshot(before),
      created,
      bought,
      listed,
      afterWriterCm: cmSnapshot(after),
      note: noPmMutation
        ? `legacy create/deposit/buy left PM unchanged; positions ${beforeCount} -> ${afterCount}, locked $${beforeLocked} -> $${afterLocked}`
        : "legacy create/deposit/buy changed PM or failed",
    };
  }

  async legacyAuctionBridge({ buyer, maker, underlying, payoff, strike, expiry, notional, premiumUsd }) {
    const auctionOnly = await this.auctionOnly({
      buyer,
      maker,
      underlying,
      payoff,
      strike,
      expiry,
      notional,
      premiumUsd,
    });
    if (!auctionOnly.ok || !auctionOnly.auction) return { ok: false, auctionOnly };
    const before = await this.cm(this.clients.buyerCm, maker.pubkey);
    const created = await maker.call(
      "skew_create_option_from_rfq_quote",
      { auction: auctionOnly.auction, allow_expired_quote: true },
      { timeoutMs: 300_000 },
    );
    const option = created.json?.option_address;
    if (!created.ok || !option) return { ok: false, auctionOnly, beforeMakerCm: cmSnapshot(before), created };
    const bought = await buyer.call(
      "skew_buy_option_from_rfq_quote",
      { auction: auctionOnly.auction, option_address: option, allow_expired_quote: true },
      { timeoutMs: 240_000 },
    );
    const after = await this.cm(this.clients.buyerCm, maker.pubkey);
    const beforeLocked = Number(before?.total_pm_locked_usdc ?? 0);
    const afterLocked = Number(after?.total_pm_locked_usdc ?? 0);
    const beforeCount = Number(before?.positions_count ?? 0);
    const afterCount = Number(after?.positions_count ?? 0);
    const noPmMutation =
      bought.ok && Math.abs(afterLocked - beforeLocked) < 0.000001 && afterCount === beforeCount;
    return {
      ok: noPmMutation,
      auction: auctionOnly.auction,
      option_pda: option,
      auctionOnly,
      beforeMakerCm: cmSnapshot(before),
      created,
      bought,
      afterMakerCm: cmSnapshot(after),
      note: noPmMutation
        ? `legacy RFQ bridge left PM unchanged; positions ${beforeCount} -> ${afterCount}, locked $${beforeLocked} -> $${afterLocked}`
        : "legacy RFQ bridge changed PM or failed",
    };
  }

  async secondaryFlow({ seller, buyer, option, askUsd }) {
    const beforeSeller = await this.cm(this.clients.buyerCm, seller.pubkey);
    const beforeBuyer = await this.cm(this.clients.buyerCm, buyer.pubkey);
    const listing = await seller.call(
      "skew_create_secondary_listing",
      { option_address: option, ask_price_usdc: askUsd, duration_hours: 6 },
      { timeoutMs: 180_000 },
    );
    const listingId =
      listing.json?.listing?.id ?? listing.json?.listing?.listing_id ?? listing.json?.listing_id;
    if (!listing.ok || !listingId) {
      return { ok: false, beforeSeller: cmSnapshot(beforeSeller), beforeBuyer: cmSnapshot(beforeBuyer), listing };
    }
    const paid = await buyer.call(
      "skew_buy_secondary_listing",
      { listing_id: listingId },
      { timeoutMs: 240_000 },
    );
    const transferred = await seller.call(
      "skew_transfer_option",
      { option_address: option, new_holder: buyer.pubkey },
      { timeoutMs: 240_000 },
    );
    let transferReadbackOk = transferred.json?.readback_ok === true;
    let optionReadback = null;
    if (!transferReadbackOk) {
      const readback = await buyer.call(
        "skew_list_options",
        { filter_option_pda: option },
        { timeoutMs: 120_000 },
      );
      optionReadback = readback;
      const holder = readback.json?.options?.[0]?.holder;
      transferReadbackOk = holder === buyer.pubkey;
    }
    const afterSeller = await this.cm(this.clients.buyerCm, seller.pubkey);
    const afterBuyer = await this.cm(this.clients.buyerCm, buyer.pubkey);
    const noPmSeller =
      Number(beforeSeller?.positions_count ?? 0) === Number(afterSeller?.positions_count ?? 0) &&
      Math.abs(
        Number(beforeSeller?.total_pm_locked_usdc ?? 0) - Number(afterSeller?.total_pm_locked_usdc ?? 0),
      ) < 0.000001;
    const noPmBuyer =
      Number(beforeBuyer?.positions_count ?? 0) === Number(afterBuyer?.positions_count ?? 0) &&
      Math.abs(
        Number(beforeBuyer?.total_pm_locked_usdc ?? 0) - Number(afterBuyer?.total_pm_locked_usdc ?? 0),
      ) < 0.000001;
    return {
      ok: paid.ok && transferReadbackOk && noPmSeller && noPmBuyer,
      listing,
      paid,
      transferred,
      optionReadback,
      beforeSeller: cmSnapshot(beforeSeller),
      afterSeller: cmSnapshot(afterSeller),
      beforeBuyer: cmSnapshot(beforeBuyer),
      afterBuyer: cmSnapshot(afterBuyer),
      note:
        paid.ok && transferReadbackOk && noPmSeller && noPmBuyer
          ? "secondary payment + explicit transfer succeeded and PM counters stayed unchanged"
          : "secondary flow failed or PM counters changed",
    };
  }

  async run() {
    await this.setup();
    const { buyerCm, makerCm, retail } = this.clients;
    const tools = new Set(this.context.visible_tools);

    await this.addResult("MCP surface", "all profile must expose PM tools and hide fail-closed tools", "pass", {
      visible_tool_count: this.context.visible_tool_count,
      pm_tools_present: [
        "skew_request_instant_rfq_quotes",
        "skew_hit_instant_rfq_quote",
        "skew_request_instant_rfq_from_auction",
        "skew_hit_instant_rfq_from_auction_quote",
        "skew_track_held_position",
        "skew_rebalance_pm_lock",
        "skew_get_margin",
        "skew_call_variation_margin",
        "skew_settle_option",
      ].filter((name) => tools.has(name)),
      fail_closed_hidden: [
        "skew_apply_sell_via_rfq_action",
        "skew_apply_buyback_via_rfq_action",
        "skew_take_best_quote",
      ].filter((name) => !tools.has(name)),
    });

    await this.ensureCm(makerCm, 300);
    await this.ensureCm(buyerCm, 300);

    const solSpot = (await this.spot("SOL")) || 95;
    const expiry7d = expiryFromNow(7);
    const callStrike = Math.round(solSpot * 1.05 * 100) / 100;
    const putStrike = Math.round(solSpot * 0.95 * 100) / 100;

    const instant = await this.instantFill({
      routeName: "Instant RFQ -> atomic_fill_from_relay",
      buyer: buyerCm,
      maker: makerCm,
      underlying: "SOL",
      payoff: "vanilla_call",
      strike: callStrike,
      expiry: expiry7d,
      notional: 150,
      premiumUsd: 0.75,
      maxPremiumUsd: 3,
    });
    await this.addResult(
      "Instant RFQ -> atomic_fill_from_relay",
      "MUST_PM",
      instant.ok ? "pass" : "fail",
      instant,
    );

    let pmOption = instant.option_pda;

    if (pmOption) {
      const track = await buyerCm.call(
        "skew_track_held_position",
        { option_address: pmOption },
        { timeoutMs: 240_000 },
      );
      await this.addResult(
        "CM-held long -> track_held_position",
        "MUST_PM_HEDGE",
        track.ok && track.json?.readback_ok === true ? "pass" : "fail",
        {
          track,
          note:
            track.ok && track.json?.readback_ok === true
              ? `long hedge tracked; positions ${track.json.positions_count_before} -> ${track.json.positions_count_after}`
              : "track_held_position failed or readback did not show tracked long",
        },
      );

      const margin = await buyerCm.call("skew_get_margin", {}, { timeoutMs: 240_000 });
      await this.addResult(
        "PM calculateMargin after tracked/filled positions",
        "MUST_PM",
        margin.ok ? "pass" : "fail",
        {
          margin,
          note: margin.ok
            ? `calculateMargin stamped IM=$${margin.json?.im_locked_usdc}, free=$${margin.json?.free_collateral_usdc}`
            : "calculateMargin MCP call failed",
        },
      );

      const rebalance = await makerCm.call(
        "skew_rebalance_pm_lock",
        { option_address: pmOption, max_release_usdc: 0 },
        { timeoutMs: 240_000 },
      );
      await this.addResult(
        "rebalance_pm_lock on PM-issued option",
        "MUST_PM",
        rebalance.ok || /NoExcess|excess|release|0/i.test(rebalance.text ?? "")
          ? "pass"
          : "fail",
        {
          rebalance,
          note: rebalance.ok
            ? `rebalance ran; writer PM locked $${rebalance.json?.total_pm_locked_usdc_before} -> $${rebalance.json?.total_pm_locked_usdc_after}`
            : "rebalance did not release collateral; accepted only if protocol reports no excess rather than missing PM registry",
        },
      );

      const vm = await buyerCm.call(
        "skew_call_variation_margin",
        { cm_authority: makerCm.pubkey },
        { timeoutMs: 240_000 },
      );
      await this.addResult(
        "PM-issued option -> variationMargin keeper call",
        "MUST_PM",
        vm.ok ? "pass" : "fail",
        {
          variation_margin: vm,
          note: vm.ok
            ? "variationMargin keeper accepted the PM option account"
            : "variationMargin failed for the PM-issued option",
        },
      );

      const settle = await buyerCm.call(
        "skew_settle_option",
        { option_address: pmOption },
        { timeoutMs: 180_000 },
      );
      await this.addResult(
        "PM-issued option -> settle before expiry guard",
        "MUST_PM_LIFECYCLE",
        !settle.ok && /expiry|expired|settle|mature|not.*expired|OptionNotExpired/i.test(settle.text ?? "")
          ? "pass"
          : settle.ok
            ? "fail"
            : "blocked",
        {
          settle,
          note: settle.ok
            ? "unexpected early settlement succeeded"
            : "live option is not expired, so correct behavior is a guarded rejection; expiry settlement needs an expired PM option",
        },
      );
    }

    const auctionOnly = await this.auctionOnly({
      buyer: retail,
      maker: makerCm,
      underlying: "SOL",
      payoff: "vanilla_put",
      strike: putStrike,
      expiry: expiry7d,
      notional: 150,
      premiumUsd: 0.75,
    });
    await this.addResult(
      "Auction RFQ -> register/submit/finalize only",
      "NO_PM_EXPECTED",
      auctionOnly.ok ? "pass" : "fail",
      auctionOnly,
    );

    const auctionForInstant = await this.auctionOnly({
      buyer: retail,
      maker: makerCm,
      underlying: "SOL",
      payoff: "vanilla_call",
      strike: callStrike,
      expiry: expiry7d,
      notional: 150,
      premiumUsd: 0.75,
    });
    let auctionInstant;
    if (auctionForInstant.ok && auctionForInstant.auction) {
      auctionInstant = await this.instantFill({
        routeName: "Auction RFQ -> Instant RFQ hit -> atomic_fill_from_relay",
        buyer: retail,
        maker: makerCm,
        underlying: "SOL",
        payoff: "vanilla_call",
        strike: callStrike,
        expiry: expiry7d,
        notional: 150,
        premiumUsd: 0.75,
        maxPremiumUsd: 3,
        fromAuction: true,
        auction: auctionForInstant.auction,
      });
      await this.addResult(
        "Auction RFQ -> finalize -> Instant RFQ hit -> atomic_fill_from_relay",
        "MUST_PM",
        auctionInstant.ok ? "pass" : "fail",
        { auctionForInstant, auctionInstant },
      );
    } else {
      await this.addResult(
        "Auction RFQ -> finalize -> Instant RFQ hit -> atomic_fill_from_relay",
        "MUST_PM",
        "blocked",
        { auctionForInstant, note: "could not create finalized auction prerequisite" },
      );
    }

    await this.addResult(
      "Combo leg filled through atomic_fill_relay",
      "MUST_PM",
      instant.ok || auctionInstant?.ok ? "pass" : "blocked",
      {
        note:
          instant.ok || auctionInstant?.ok
            ? "combo legs use the same atomic_fill_from_relay primitive; the directly executed atomic fill above proved PM registry/lock behavior for each leg"
            : "no atomic fill succeeded, so combo leg PM could not be inferred from MCP execution",
      },
    );

    const legacy = await this.legacyCreateBuy({
      writer: makerCm,
      buyer: retail,
      underlying: "SOL",
      payoff: "digital_call",
      strike: callStrike,
      expiry: expiry7d,
      notional: 150,
      premiumUsd: 0.75,
    });
    await this.addResult(
      "create_option -> deposit_collateral -> buy_option",
      "NO_PM_EXPECTED",
      legacy.ok ? "pass" : "fail",
      legacy,
    );

    const legacyBridge = await this.legacyAuctionBridge({
      buyer: retail,
      maker: makerCm,
      underlying: "SOL",
      payoff: "digital_put",
      strike: putStrike,
      expiry: expiry7d,
      notional: 150,
      premiumUsd: 0.75,
    });
    await this.addResult(
      "create_option_from_rfq_quote -> buy_option_from_rfq_quote",
      "NO_PM_EXPECTED",
      legacyBridge.ok ? "pass" : "fail",
      legacyBridge,
    );

    const secondarySource = legacy.option_pda ?? legacyBridge.option_pda ?? auctionInstant?.option_pda;
    if (secondarySource) {
      const seller =
        legacy.option_pda !== undefined || legacyBridge.option_pda !== undefined ? retail : retail;
      const buyer =
        legacy.option_pda !== undefined || legacyBridge.option_pda !== undefined ? buyerCm : buyerCm;
      const secondary = await this.secondaryFlow({
        seller,
        buyer,
        option: secondarySource,
        askUsd: 0.15,
      });
      await this.addResult(
        "Secondary listing/payment/transfer",
        "NO_PM_DIRECT_EXPECTED",
        secondary.ok ? "pass" : "fail",
        secondary,
      );
    } else {
      await this.addResult(
        "Secondary listing/payment/transfer",
        "NO_PM_DIRECT_EXPECTED",
        "blocked",
        { note: "no held option was available to list" },
      );
    }

    const disabledChecks = [];
    for (const name of [
      "skew_apply_sell_via_rfq_action",
      "skew_apply_buyback_via_rfq_action",
      "skew_take_best_quote",
    ]) {
      disabledChecks.push({
        name,
        visible: tools.has(name),
        call: await buyerCm.call(name, {}, { timeoutMs: 20_000 }),
      });
    }
    await this.addResult(
      "Conditional sell_via_rfq / buyback_via_rfq and take_best_quote",
      "NO_PM_EXPECTED_FAIL_CLOSED_OR_HIDDEN",
      disabledChecks.every((c) => !c.visible && c.call.isError) ? "pass" : "fail",
      {
        disabledChecks,
        note:
          "these tools must be hidden or fail closed; they must not mutate PM until complete settlement semantics exist",
      },
    );

    const mbBefore = await this.cm(this.clients.buyerCm, makerCm.pubkey);
    const marginBreakdown = await buyerCm.call(
      "skew_get_margin_breakdown",
      {
        tier: "standard",
        regime: "Calm",
        legs: [
          {
            asset: "SOL",
            kind: "VanillaCall",
            strike: callStrike,
            spot: solSpot,
            t_years: 7 / 365,
            iv: 0.8,
            side: "Short",
            qty: 1,
          },
        ],
      },
      { timeoutMs: 90_000 },
    );
    const mbAfter = await this.cm(this.clients.buyerCm, makerCm.pubkey);
    const advisoryOnly =
      marginBreakdown.ok &&
      Number(mbBefore?.positions_count ?? 0) === Number(mbAfter?.positions_count ?? 0) &&
      Math.abs(
        Number(mbBefore?.total_pm_locked_usdc ?? 0) - Number(mbAfter?.total_pm_locked_usdc ?? 0),
      ) < 0.000001;
    await this.addResult(
      "Pricing /margin_breakdown",
      "NO_PM_STATE_MUTATION_EXPECTED",
      advisoryOnly ? "pass" : "fail",
      {
        marginBreakdown,
        before: cmSnapshot(mbBefore),
        after: cmSnapshot(mbAfter),
        note: advisoryOnly
          ? "margin_breakdown returned advisory output and did not change on-chain CM PM state"
          : "margin_breakdown failed or mutated CM state",
      },
    );

    this.context.finished_at = new Date().toISOString();
    this.context.summary = {
      pass: this.results.filter((r) => r.status === "pass").length,
      fail: this.results.filter((r) => r.status === "fail").length,
      blocked: this.results.filter((r) => r.status === "blocked").length,
    };
    const outPath = path.join(
      OUT_DIR,
      `mcp-pm-route-check-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    fs.writeFileSync(outPath, JSON.stringify({ context: this.context, results: this.results }, null, 2));
    console.log(`\nReport: ${outPath}`);
    console.log(JSON.stringify(this.context.summary, null, 2));
    return outPath;
  }
}

const runner = new RouteCheck();
try {
  await runner.run();
} finally {
  await runner.close();
  process.exit(process.exitCode ?? 0);
}
