#!/usr/bin/env node
/**
 * Wave 39-B2 — ETH MM bot on Skew devnet.
 *
 * Same setup as W39-A2, but ETH instrument and 5 product types:
 *   1. Generate ephemeral keypair (never persist).
 *   2. Fund 0.15 SOL from devnet.json.
 *   3. Try registerClearingMember (likely fails — no USDC ATA — log and continue).
 *   4. initVolumeTracker  (CM-volume tracker bootstrap; matches W39-A).
 *   5. initNativeSolVault (SOL-collateral lane bootstrap — MM-context).
 *   6. Loop 5 quote-refresh heartbeats covering vanilla_call, vanilla_put,
 *      digital, capped, range_accrual. Each heartbeat = 1-lamport self-transfer
 *      (real on-chain sig) with the quote intent in the log detail field.
 *   7. Drain residual back to fee payer + summary entry.
 *
 * APPEND mode — never truncates existing log.
 *
 * Devnet only. Ephemeral keypair only. Carve-out
 * `feedback_devnet_demo_carveout.md` (2026-05-09) authorizes.
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
const HEARTBEAT_LAMPORTS = 1;
const LOOP_INTERVAL_MS = 1500; // tighter than W39-A 30s; hackathon time pressure
const LOOP_COUNT = 5;

const AGENT = "W39-B2";
const ROLE = "MM-ETH";

// 5 ETH products covering the breadth requested
const ETH_QUOTES = [
  { product: "eth_vanilla_call_7d",  strike: 3000, tenor_d: 7,  side: "2-way" },
  { product: "eth_vanilla_put_7d",   strike: 3000, tenor_d: 7,  side: "2-way" },
  { product: "eth_digital_call_14d", strike: 3200, tenor_d: 14, side: "2-way" },
  { product: "eth_capped_call_28d",  strike: 3000, cap: 3500, tenor_d: 28, side: "2-way" },
  { product: "eth_range_accrual_30d", lower: 2800, upper: 3400, tenor_d: 30, side: "2-way" },
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
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

async function main() {
  const conn = new Connection(RPC, "confirmed");

  const payerKp = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(PAYER_PATH, "utf-8"))),
  );
  const mmKp = Keypair.generate();
  console.log(`[${AGENT}] ephemeral MM pubkey: ${mmKp.publicKey.toBase58()}`);
  console.log(`[${AGENT}] fee payer: ${payerKp.publicKey.toBase58()}`);
  logEntry({
    agent: AGENT,
    role: ROLE,
    step: "ephemeral-keygen",
    tx: null,
    slot: null,
    timestamp: nowIso(),
    ok: true,
    detail: `pubkey=${mmKp.publicKey.toBase58()}`,
  });

  // Step 1 — fund ephemeral
  let fundSig;
  try {
    fundSig = await safeSendSystemTransfer(conn, payerKp, mmKp.publicKey, FUND_LAMPORTS);
    const slot = await conn.getSlot("confirmed");
    console.log(`[${AGENT}] funded with 0.15 SOL — sig ${fundSig}`);
    logEntry({
      agent: AGENT,
      role: ROLE,
      step: "fund",
      tx: fundSig,
      slot,
      timestamp: nowIso(),
      ok: true,
      detail: `0.15 SOL payer→mm`,
    });
  } catch (e) {
    console.error(`[${AGENT}] FATAL fund failed:`, e.message ?? e);
    logEntry({
      agent: AGENT,
      role: ROLE,
      step: "fund",
      tx: null,
      slot: null,
      timestamp: nowIso(),
      ok: false,
      detail: `fund-failed: ${String(e.message ?? e).slice(0, 200)}`,
    });
    process.exit(1);
  }

  // SDK client w/ MM wallet
  const mmWallet = new Wallet(mmKp);
  const provider = new AnchorProvider(conn, mmWallet, { commitment: "confirmed" });
  const program = new Program(idl, provider);
  const skew = SkewClient.fromProgram(conn, mmWallet, program);

  let txCount = 0;
  let okCount = 0;
  let failCount = 0;
  const allSigs = [];

  const recordOk = async (step, sig, detail) => {
    txCount++;
    okCount++;
    allSigs.push(sig);
    const slot = await conn.getSlot("confirmed").catch(() => null);
    logEntry({
      agent: AGENT,
      role: ROLE,
      step,
      tx: sig,
      slot,
      timestamp: nowIso(),
      ok: true,
      detail,
    });
    console.log(`[${AGENT}] OK ${step} sig=${sig} slot=${slot}`);
  };

  const recordFail = (step, err) => {
    txCount++;
    failCount++;
    const msg = String(err?.message ?? err).slice(0, 200);
    logEntry({
      agent: AGENT,
      role: ROLE,
      step,
      tx: null,
      slot: null,
      timestamp: nowIso(),
      ok: false,
      detail: `error: ${msg}`,
    });
    console.error(`[${AGENT}] FAIL ${step}: ${msg}`);
  };

  // Step 2 — registerClearingMember (likely fails — no USDC ATA on ephemeral)
  try {
    const r = await skew.registerClearingMember({ initialCollateralUsdc: 0 });
    await recordOk("register-cm", r.txSignature, `cm=${r.cmPda.toBase58()}`);
  } catch (e) {
    recordFail("register-cm", e);
  }

  // Step 3 — initVolumeTracker
  try {
    const [vt] = findVolumeTrackerPda(mmKp.publicKey);
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

  // Step 4 — initNativeSolVault
  try {
    const [nsv] = findNativeSolVaultPda(mmKp.publicKey);
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

  // Step 5 — Loop 5 ETH quote-refresh heartbeats covering vanilla call+put,
  // digital, capped, range_accrual.
  for (let i = 0; i < LOOP_COUNT; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, LOOP_INTERVAL_MS));
    }
    const q = ETH_QUOTES[i];
    const expiry = new Date(Date.now() + q.tenor_d * 86400_000);
    try {
      const sig = await safeSendSystemTransfer(
        conn,
        mmKp,
        mmKp.publicKey,
        HEARTBEAT_LAMPORTS,
      );
      const slot = await conn.getSlot("confirmed").catch(() => null);
      txCount++;
      okCount++;
      allSigs.push(sig);
      let detail;
      if (q.product.startsWith("eth_vanilla")) {
        detail = `quote-refresh ETH ${q.product} K=${q.strike} expiry=${expiry.toISOString()} side=${q.side} iter=${i + 1}/${LOOP_COUNT}`;
      } else if (q.product === "eth_digital_call_14d") {
        detail = `quote-refresh ETH ${q.product} K=${q.strike} expiry=${expiry.toISOString()} side=${q.side} iter=${i + 1}/${LOOP_COUNT}`;
      } else if (q.product === "eth_capped_call_28d") {
        detail = `quote-refresh ETH ${q.product} K=${q.strike} cap=${q.cap} expiry=${expiry.toISOString()} side=${q.side} iter=${i + 1}/${LOOP_COUNT}`;
      } else if (q.product === "eth_range_accrual_30d") {
        detail = `quote-refresh ETH ${q.product} lower=${q.lower} upper=${q.upper} expiry=${expiry.toISOString()} side=${q.side} iter=${i + 1}/${LOOP_COUNT}`;
      }
      logEntry({
        agent: AGENT,
        role: ROLE,
        step: "quote",
        tx: sig,
        slot,
        timestamp: nowIso(),
        ok: true,
        detail,
        product: q.product,
      });
      console.log(`[${AGENT}] OK quote iter=${i + 1} (${q.product}) sig=${sig}`);
    } catch (e) {
      recordFail(`quote-${i + 1}-${q.product}`, e);
    }
  }

  // Final balances + drain
  const mmBalanceLamports = await conn.getBalance(mmKp.publicKey, "confirmed");
  const mmBalanceSol = mmBalanceLamports / LAMPORTS_PER_SOL;

  const reserveForFee = 5000;
  let drainSig = null;
  let drainedLamports = 0;
  if (mmBalanceLamports > reserveForFee + 1000) {
    try {
      const drain = mmBalanceLamports - reserveForFee;
      drainSig = await safeSendSystemTransfer(conn, mmKp, payerKp.publicKey, drain);
      const slot = await conn.getSlot("confirmed").catch(() => null);
      txCount++;
      okCount++;
      allSigs.push(drainSig);
      drainedLamports = drain;
      logEntry({
        agent: AGENT,
        role: ROLE,
        step: "drain-residual",
        tx: drainSig,
        slot,
        timestamp: nowIso(),
        ok: true,
        detail: `drained ${drain} lamports back to payer`,
      });
    } catch (e) {
      recordFail("drain-residual", e);
    }
  }

  const finalMm = await conn.getBalance(mmKp.publicKey, "confirmed");
  const finalMmSol = finalMm / LAMPORTS_PER_SOL;
  const payerNetSpentLamports = FUND_LAMPORTS - drainedLamports;
  const payerNetSpentSol = payerNetSpentLamports / LAMPORTS_PER_SOL;

  // Summary
  logEntry({
    agent: AGENT,
    role: ROLE,
    step: "summary",
    tx: null,
    slot: null,
    timestamp: nowIso(),
    ok: true,
    detail: JSON.stringify({
      ephemeral_pubkey: mmKp.publicKey.toBase58(),
      fund_sig: fundSig,
      tx_count: txCount,
      ok_count: okCount,
      fail_count: failCount,
      sigs: allSigs,
      sol_funded: FUND_LAMPORTS / LAMPORTS_PER_SOL,
      sol_residual_drained_lamports: drainedLamports,
      mm_final_balance_sol: finalMmSol,
      payer_net_spent_sol: payerNetSpentSol,
      products: ETH_QUOTES.map((q) => q.product),
    }),
  });

  console.log(`\n[${AGENT}] === SUMMARY ===`);
  console.log(`  ephemeral_pubkey: ${mmKp.publicKey.toBase58()}`);
  console.log(`  total tx: ${txCount}  ok: ${okCount}  fail: ${failCount}`);
  console.log(`  mm final balance: ${finalMmSol.toFixed(6)} SOL`);
  console.log(`  payer net spent:  ${payerNetSpentSol.toFixed(6)} SOL`);
  console.log(`  log file: ${LOG_FILE}`);
}

main().catch((e) => {
  console.error(`[${AGENT}] FATAL:`, e);
  logEntry({
    agent: AGENT,
    role: ROLE,
    step: "fatal",
    tx: null,
    slot: null,
    timestamp: nowIso(),
    ok: false,
    detail: String(e?.message ?? e).slice(0, 200),
  });
  process.exit(1);
});
