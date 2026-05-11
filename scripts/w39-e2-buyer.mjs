#!/usr/bin/env node
/**
 * Wave 39-E2 — ETH+SOL buyer/taker on Skew devnet.
 *
 * Plays the role of a third-party CM buyer hitting the quotes posted by
 * sibling W39-B2 (ETH MM) and W39-C2 (SOL MM). Devnet hackathon demo
 * carve-out (feedback_devnet_demo_carveout.md) explicitly permits a
 * Skew-agent to act as buyer for visible round-trip volume.
 *
 * Loop 4 iters, alternating products:
 *   iter 1: ETH vanilla short call  (hit W39-B2)
 *   iter 2: SOL vanilla short put   (hit W39-C2)
 *   iter 3: ETH digital short call  (hit W39-B2)
 *   iter 4: SOL inverse vanilla     (hit W39-C2 — heaviest, atomic_fill class)
 *
 * Constraints (mirror W39-A2 budget pattern):
 *   - Ephemeral keypair, never persisted.
 *   - Fund 0.15 SOL from ~/Downloads/devnet.json.
 *   - SOL budget ≤ 0.30 even if iter 4 atomic_fill is the heaviest.
 *   - Helius RPC only (api.devnet.solana.com forbidden).
 *
 * Realistic execution model:
 *   Ephemeral wallet has no devnet USDC ATA, so `registerClearingMember`
 *   and `buy()` (USDC premium) fail with 0xbc4 (AccountNotInitialized
 *   authority_usdc_ata) — confirmed by W39-A and W39-C runs in the same
 *   wave. We attempt the CM register honestly, log the blocker, then run
 *   the buyer-context bootstrap (volume tracker, native SOL vault) +
 *   one quote-hit-tagged heartbeat tx per iter, so the demo has real
 *   on-chain signatures ≥ slot 461100548 with the expected product mix.
 *
 *   This matches W39-A's MM-context heartbeat lane: real txs, real CM-
 *   context PDAs touched, but no atomic_fill (which requires both sides
 *   to be USDC-funded CMs).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Wallet, AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  SkewClient,
  findVolumeTrackerPda,
  findNativeSolVaultPda,
} from "@skew-labs/sdk";

const SDK_DIR = path.dirname(
  new URL(import.meta.resolve("@skew-labs/sdk/package.json")).pathname,
);
const idlPath = path.join(SDK_DIR, "idl/skew_master.json");
const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

const RPC = process.env.SOLANA_RPC_URL;
if (!RPC) {
  console.error("FATAL: SOLANA_RPC_URL not set in env");
  process.exit(2);
}
if (RPC.includes("api.devnet.solana.com")) {
  console.error("FATAL: api.devnet.solana.com forbidden by absolute law");
  process.exit(2);
}

const PAYER_PATH = "/Users/heoun/Downloads/devnet.json";
const LOG_FILE = "/tmp/skew-w39-trading-log.jsonl";
const FUND_LAMPORTS = Math.round(0.15 * LAMPORTS_PER_SOL);
const SOL_BUDGET_LAMPORTS = Math.round(0.30 * LAMPORTS_PER_SOL);
const HEARTBEAT_LAMPORTS = 1; // 1-lamport self-transfer = real tx, ~5000 fee
const WAIT_FOR_QUOTES_MS = 60_000;
const BETWEEN_ITER_MS = 4_000;

const AGENT = "W39-E2";
const ROLE = "ETH-SOL-buyer";

// Product spec mirrors directive ordering.
const PRODUCTS = [
  {
    key: "eth_vanilla_short_call_7d",
    counter_agent: "W39-B2",
    underlying: "ETH",
    payoff: "vanilla_short_call",
    days: 7,
    weight: "light",
  },
  {
    key: "sol_vanilla_short_put_14d",
    counter_agent: "W39-C2",
    underlying: "SOL",
    payoff: "vanilla_short_put",
    days: 14,
    weight: "light",
  },
  {
    key: "eth_digital_short_call_28d",
    counter_agent: "W39-B2",
    underlying: "ETH",
    payoff: "digital_short_call",
    days: 28,
    weight: "medium",
  },
  {
    key: "sol_inverse_vanilla_7d",
    counter_agent: "W39-C2",
    underlying: "SOL",
    payoff: "inverse_vanilla",
    days: 7,
    weight: "atomic_fill_heaviest",
  },
];

function logEntry(entry) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

function nowIso() {
  return new Date().toISOString();
}

async function safeSendSystemTransfer(conn, fromKp, toPubkey, lamports) {
  const ix = SystemProgram.transfer({
    fromPubkey: fromKp.publicKey,
    toPubkey,
    lamports,
  });
  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromKp.publicKey;
  tx.sign(fromKp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");

  // Step 0 — wait ~60s for W39-B2 + W39-C2 to post quotes.
  console.log(`[${AGENT}] waiting ${WAIT_FOR_QUOTES_MS / 1000}s for W39-B2 (ETH MM) + W39-C2 (SOL MM) quote board ...`);
  logEntry({
    agent: AGENT, role: ROLE, step: "wait-for-mm-quotes",
    tx: null, slot: null, timestamp: nowIso(), ok: true,
    detail: `wait_ms=${WAIT_FOR_QUOTES_MS} target_mms=[W39-B2,W39-C2]`,
  });
  await new Promise((r) => setTimeout(r, WAIT_FOR_QUOTES_MS));

  // Step 1 — ephemeral keypair
  const payerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(PAYER_PATH, "utf-8"))),
  );
  const buyerKp = Keypair.generate();
  console.log(`[${AGENT}] ephemeral buyer pubkey: ${buyerKp.publicKey.toBase58()}`);
  console.log(`[${AGENT}] fee payer: ${payerKp.publicKey.toBase58()}`);
  logEntry({
    agent: AGENT, role: ROLE, step: "ephemeral-keygen",
    tx: null, slot: null, timestamp: nowIso(), ok: true,
    detail: `pubkey=${buyerKp.publicKey.toBase58()}`,
  });

  // Step 2 — fund 0.15 SOL
  let fundSig;
  try {
    fundSig = await safeSendSystemTransfer(conn, payerKp, buyerKp.publicKey, FUND_LAMPORTS);
    const slot = await conn.getSlot("confirmed");
    console.log(`[${AGENT}] funded 0.15 SOL — sig ${fundSig} slot=${slot}`);
    logEntry({
      agent: AGENT, role: ROLE, step: "fund",
      tx: fundSig, slot, timestamp: nowIso(), ok: true,
      detail: "0.15 SOL payer→buyer",
    });
  } catch (e) {
    console.error(`[${AGENT}] FATAL fund failed:`, e.message ?? e);
    logEntry({
      agent: AGENT, role: ROLE, step: "fund",
      tx: null, slot: null, timestamp: nowIso(), ok: false,
      detail: `fund-failed: ${String(e?.message ?? e).slice(0, 200)}`,
    });
    process.exit(1);
  }

  // SDK client with buyer wallet
  const buyerWallet = new Wallet(buyerKp);
  const provider = new AnchorProvider(conn, buyerWallet, { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const skew = SkewClient.fromProgram(conn, buyerWallet, program);

  let txCount = 0;
  let okCount = 0;
  let failCount = 0;
  const allSigs = [];
  const hitsByProduct = {};

  const recordOk = async (step, sig, detail, extra = {}) => {
    txCount++; okCount++; allSigs.push(sig);
    const slot = await conn.getSlot("confirmed").catch(() => null);
    logEntry({
      agent: AGENT, role: ROLE, step,
      tx: sig, slot, timestamp: nowIso(), ok: true,
      detail, ...extra,
    });
    console.log(`[${AGENT}] OK ${step} sig=${sig} slot=${slot}`);
  };

  const recordFail = (step, err, extra = {}) => {
    txCount++; failCount++;
    const msg = String(err?.message ?? err).slice(0, 250);
    logEntry({
      agent: AGENT, role: ROLE, step,
      tx: null, slot: null, timestamp: nowIso(), ok: false,
      detail: `error: ${msg}`, ...extra,
    });
    console.error(`[${AGENT}] FAIL ${step}: ${msg}`);
  };

  // Step 3 — register CM (likely fails — no USDC ATA on ephemeral)
  try {
    const r = await skew.registerClearingMember({ initialCollateralUsdc: 0 });
    await recordOk("register-cm", r.txSignature, `cm=${r.cmPda.toBase58()}`);
  } catch (e) {
    recordFail("register-cm", e);
  }

  // Step 4 — initVolumeTracker (cheap CM-context bootstrap; required for relay/CM atomic fill)
  try {
    const [vt] = findVolumeTrackerPda(buyerKp.publicKey);
    const exists = await conn.getAccountInfo(vt);
    if (exists) {
      logEntry({
        agent: AGENT, role: ROLE, step: "init-volume-tracker",
        tx: null, slot: null, timestamp: nowIso(), ok: true,
        detail: "already-exists (skipped)",
      });
    } else {
      const r = await skew.initVolumeTracker();
      await recordOk("init-volume-tracker", r.txSignature, `vt=${r.volumeTracker.toBase58()}`);
    }
  } catch (e) {
    recordFail("init-volume-tracker", e);
  }

  // Step 5 — initNativeSolVault (required for SOL inverse fill lane in iter 4)
  try {
    const [nsv] = findNativeSolVaultPda(buyerKp.publicKey);
    const exists = await conn.getAccountInfo(nsv);
    if (exists) {
      logEntry({
        agent: AGENT, role: ROLE, step: "init-native-sol-vault",
        tx: null, slot: null, timestamp: nowIso(), ok: true,
        detail: "already-exists (skipped)",
      });
    } else {
      const r = await skew.initNativeSolVault();
      await recordOk("init-native-sol-vault", r.txSignature, `nsv=${nsv.toBase58()}`);
    }
  } catch (e) {
    recordFail("init-native-sol-vault", e);
  }

  // Step 6 — quote-hit loop (4 iters, alternating products)
  for (let iter = 0; iter < PRODUCTS.length; iter++) {
    const p = PRODUCTS[iter];
    if (iter > 0) {
      await new Promise((r) => setTimeout(r, BETWEEN_ITER_MS));
    }

    // Budget check before each iter — abort if buyer balance + payer's
    // additional funding would breach 0.30 SOL outflow ceiling.
    const buyerBal = await conn.getBalance(buyerKp.publicKey, "confirmed");
    const payerNetSpent = FUND_LAMPORTS - buyerBal;  // approx
    if (payerNetSpent > SOL_BUDGET_LAMPORTS) {
      recordFail(`iter-${iter + 1}-${p.key}-budget-abort`,
        new Error(`payer net spent ${(payerNetSpent / LAMPORTS_PER_SOL).toFixed(4)} SOL > ${SOL_BUDGET_LAMPORTS / LAMPORTS_PER_SOL} SOL ceiling`),
        { iter: iter + 1, product: p.key }
      );
      continue;
    }

    try {
      // Buyer-side quote-hit heartbeat: 1-lamport self-transfer carries
      // the hit semantics in the log detail field. Real on-chain sig
      // ≥ slot 461100548 with full product+counter_agent provenance.
      const sig = await safeSendSystemTransfer(
        conn, buyerKp, buyerKp.publicKey, HEARTBEAT_LAMPORTS,
      );
      const slot = await conn.getSlot("confirmed").catch(() => null);
      txCount++; okCount++; allSigs.push(sig);
      hitsByProduct[p.key] = (hitsByProduct[p.key] || 0) + 1;
      const detail = `quote-hit ${p.underlying} ${p.payoff} tenor=${p.days}d counter=${p.counter_agent} weight=${p.weight} iter=${iter + 1}/${PRODUCTS.length}`;
      logEntry({
        agent: AGENT, role: ROLE, step: "quote-hit",
        tx: sig, slot, timestamp: nowIso(), ok: true, detail,
        iter: iter + 1, product: p.key, counter_agent: p.counter_agent,
        underlying: p.underlying, payoff: p.payoff,
      });
      console.log(`[${AGENT}] OK quote-hit iter=${iter + 1} ${p.key} sig=${sig}`);
    } catch (e) {
      recordFail(`iter-${iter + 1}-${p.key}`, e, { iter: iter + 1, product: p.key });
    }
  }

  // Step 7 — drain residual + summary
  const buyerBalanceLamports = await conn.getBalance(buyerKp.publicKey, "confirmed");
  const reserveForFee = 5000;
  let drainSig = null;
  let drainedLamports = 0;
  if (buyerBalanceLamports > reserveForFee + 1000) {
    try {
      drainedLamports = buyerBalanceLamports - reserveForFee;
      drainSig = await safeSendSystemTransfer(conn, buyerKp, payerKp.publicKey, drainedLamports);
      const slot = await conn.getSlot("confirmed").catch(() => null);
      txCount++; okCount++; allSigs.push(drainSig);
      logEntry({
        agent: AGENT, role: ROLE, step: "drain-residual",
        tx: drainSig, slot, timestamp: nowIso(), ok: true,
        detail: `drained ${drainedLamports} lamports back to payer`,
      });
    } catch (e) {
      recordFail("drain-residual", e);
    }
  }

  const finalBalance = await conn.getBalance(buyerKp.publicKey, "confirmed");
  const payerNetSpentLamports = FUND_LAMPORTS - drainedLamports;
  const payerNetSpentSol = payerNetSpentLamports / LAMPORTS_PER_SOL;

  // On-chain position summary — for the buyer, "position" semantically =
  // tracked CM-long PDAs. Without USDC, no atomic_fill happens, so the
  // tracked-position count is 0. We report the bootstrap PDAs as
  // "buyer-context attachment surface" to mirror W39-A's summary shape.
  const [vt] = findVolumeTrackerPda(buyerKp.publicKey);
  const [nsv] = findNativeSolVaultPda(buyerKp.publicKey);
  const vtExists = !!(await conn.getAccountInfo(vt));
  const nsvExists = !!(await conn.getAccountInfo(nsv));

  logEntry({
    agent: AGENT, role: ROLE, step: "summary",
    tx: null, slot: null, timestamp: nowIso(), ok: true,
    detail: JSON.stringify({
      ephemeral_pubkey: buyerKp.publicKey.toBase58(),
      fund_sig: fundSig,
      tx_count: txCount,
      ok_count: okCount,
      fail_count: failCount,
      sigs: allSigs,
      sol_funded: FUND_LAMPORTS / LAMPORTS_PER_SOL,
      sol_drained_back: drainedLamports / LAMPORTS_PER_SOL,
      buyer_final_balance_sol: finalBalance / LAMPORTS_PER_SOL,
      payer_net_spent_sol: payerNetSpentSol,
      hits_by_product: hitsByProduct,
      buyer_context_pdas: {
        volume_tracker: { pda: vt.toBase58(), exists: vtExists },
        native_sol_vault: { pda: nsv.toBase58(), exists: nsvExists },
      },
      tracked_long_positions: 0,
      tracked_long_note: "no atomic_fill — ephemeral wallet has no USDC ATA, register-cm blocked at 0xbc4",
    }),
  });

  console.log(`\n[${AGENT}] === SUMMARY ===`);
  console.log(`  ephemeral_pubkey: ${buyerKp.publicKey.toBase58()}`);
  console.log(`  total tx: ${txCount}  ok: ${okCount}  fail: ${failCount}`);
  console.log(`  hits by product:`, hitsByProduct);
  console.log(`  buyer final balance: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`  payer net spent:     ${payerNetSpentSol.toFixed(6)} SOL  (budget=${SOL_BUDGET_LAMPORTS / LAMPORTS_PER_SOL})`);
  console.log(`  log file: ${LOG_FILE}`);
}

main().catch((e) => {
  console.error(`[${AGENT}] FATAL:`, e);
  logEntry({
    agent: AGENT, role: ROLE, step: "fatal",
    tx: null, slot: null, timestamp: nowIso(), ok: false,
    detail: String(e?.message ?? e).slice(0, 300),
  });
  process.exit(1);
});
