import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, parseAbi, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";

const API = "https://app.decalabs.ai/api/agent";
const DECA_WALLET = "0x7fb30ed8d7a7b45ee7b98903d94d87d1b9c3dad2";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // test USDC on Base Sepolia
const WALLET_FILE = ".wallet.json";
const LAST_FILE = ".last-test.json";
const DEFAULT_PITCH =
  "A simple app for freelance designers that tracks unpaid invoices and sends polite, automatic payment reminders to clients, so designers do not have to chase money themselves.";

const log = (m = "") => console.log(m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function die(m: string): never {
  console.error("\nERROR: " + m);
  process.exit(1);
}

// Minimal .env reader (works on any Node 20+).
function loadEnv(file = ".env") {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

// Read a secret without echoing it (handles pasted text). Fallback when .env has no key.
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) die("No API key in .env and this is not an interactive window. Fill in .env and run again.");
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (c === "\u0003") process.exit(1); // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

function explain(err: any): string {
  const e = err?.error ?? err ?? {};
  const code = e.code ?? "unknown_error";
  const hints: Record<string, string> = {
    invalid_key: "The API key is not valid. Make sure you pasted the whole key (starts with deca_sk_).",
    key_revoked: "This key was revoked. Create a new one in MCP & API.",
    scope_missing: "The key is missing a scope. In MCP & API press Edit on the key and tick read, quote and test.",
    over_cap: "The option costs more than the key's cap per test. Edit the key in MCP & API and raise the per-test cap (for the default idea, 700 USD is enough). The throwaway wallet only holds test tokens, so this cannot spend real money.",
    over_month_cap: "Monthly cap reached. Edit the key in MCP & API and raise the monthly cap.",
    quote_expired: "The quote expired. Just run the script again.",
    quote_invalid: "The quote is not valid. Run the script again.",
    payment_invalid: "The payment was rejected. See the 'why' and 'next' fields below.",
    payment_failed: "The payment could not be settled. Check the wallet has test USDC on Base Sepolia.",
    payments_unavailable: "DECA's payment service is unavailable. Try again in a few minutes.",
    payments_not_open: "Real payments are off. This script only uses the sandbox, so please report this.",
    rate_limited: "Too many requests. Wait a minute and run again.",
    no_reliable_option: "DECA could not price this idea. Write a clearer description in IDEA in .env (who it is for and what it does).",
  };
  const parts = [`${code}: ${e.message ?? ""}`.trim()];
  if (hints[code]) parts.push("-> " + hints[code]);
  if (e.why) parts.push("why: " + e.why);
  if (e.next) parts.push("next: " + e.next);
  return parts.join("\n");
}

async function main() {
  loadEnv();
  log("=== DECA API sandbox task (free, test USDC only) ===\n");

  if (existsSync(LAST_FILE) && !process.argv.includes("--again")) {
    const last = JSON.parse(readFileSync(LAST_FILE, "utf8"));
    log(`You already ran a sandbox test (id: ${last.id}).`);
    log("Check the Rewards page. To run another test anyway: .\\run.ps1 -Again");
    return;
  }

  // 1) Throwaway wallet
  let privateKey: `0x${string}`;
  if (existsSync(WALLET_FILE)) {
    privateKey = JSON.parse(readFileSync(WALLET_FILE, "utf8")).privateKey;
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) die(`${WALLET_FILE} looks corrupted. Delete it to create a new wallet.`);
    log("Using your existing throwaway wallet.");
  } else {
    privateKey = generatePrivateKey();
    writeFileSync(WALLET_FILE, JSON.stringify({ privateKey }, null, 2));
    log(`Created a new throwaway wallet. Its key is saved in ${WALLET_FILE} (never share or upload this file).`);
  }
  const account = privateKeyToAccount(privateKey);
  log(`Wallet address: ${account.address}\n`);

  // 2) API key (from .env, otherwise ask)
  let apiKey = process.env.DECA_API_KEY?.trim() ?? "";
  if (apiKey.includes("paste_your")) apiKey = "";
  if (!apiKey) apiKey = await askHidden("No key found in .env. Paste your DECA API key (input is hidden), then press Enter: ");
  if (!apiKey) die("No API key entered.");
  if (!/^deca_sk_[A-Za-z0-9]{40}$/.test(apiKey)) log("Warning: this does not look like a DECA key (deca_sk_ + 40 characters). Continuing anyway.");

  // 3) Wait for test USDC
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const balance = async () =>
    Number(formatUnits(await publicClient.readContract({ address: USDC, abi, functionName: "balanceOf", args: [account.address] }), 6));

  let bal = 0;
  try { bal = await balance(); } catch {}
  if (bal < 1) {
    log("\nYour wallet has no test USDC yet. Do this now:");
    log("  1. Open https://faucet.circle.com");
    log("  2. Choose token: USDC, network: Base Sepolia");
    log(`  3. Paste this address: ${account.address}`);
    log("  4. Request the tokens, then leave this window open.\n");
    log("Waiting for the test USDC to arrive (up to 30 minutes)...");
    const deadline = Date.now() + 30 * 60_000;
    while (bal < 1) {
      if (Date.now() > deadline) die("Timed out waiting for test USDC. Request it again at the faucet, then run the script again.");
      await sleep(10_000);
      try { bal = await balance(); } catch {}
      process.stdout.write(".");
    }
    log("");
  }
  log(`Test USDC balance: ${bal}`);

  // 4) Quote
  const pitch = (process.env.IDEA ?? "").trim() || DEFAULT_PITCH;
  if (pitch.length < 20 || pitch.length > 2000) die("IDEA in .env must be 20-2000 characters.");
  const headers = { "content-type": "application/json", authorization: `Bearer ${apiKey}` };
  log("\nRequesting a quote...");
  const qRes = await fetch(`${API}/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idea: { name: "Sandbox idea", pitch } }),
  });
  const q: any = await qRes.json().catch(() => ({}));
  if (!qRes.ok || !q.quote_id) die(explain(q));
  const option = (q.options ?? []).find((o: any) => o.id === "signal") ?? q.options?.[0];
  if (!option) die("The quote has no options. Write a clearer description in IDEA in .env.");
  log(`Quote OK. Using option "${option.id}" (sandbox: you pay 1 test USDC, not ${option.total_usd} USD).`);
  if (option.within_cap === false) {
    log("Note: this option is above your key's per-test cap. If the payment is refused with over_cap, raise the cap in MCP & API.");
  }

  // 5) Pay in the sandbox (x402)
  const x402 = new x402HTTPClient(
    x402Client.fromConfig({
      schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(toClientEvmSigner(account)) }], // Base Sepolia
      spendControls: { maxAmountPerPayment: "$2" },
      policies: [(_v: any, reqs: any[]) => reqs.filter((r) => r.payTo.toLowerCase() === DECA_WALLET)],
    })
  );
  const body = JSON.stringify({
    quote_id: q.quote_id,
    option: option.id,
    sandbox: true,
    idempotency_key: randomUUID(),
  });
  const url = `${API}/tests`;

  log("Starting the sandbox test and paying 1 test USDC...");
  const ask = await fetch(url, { method: "POST", headers, body });
  const askBody: any = await ask.json().catch(() => null);
  log(`Ask status: ${ask.status}`);
  if (ask.status !== 402) die(explain(askBody));

  let paid: Response;
  try {
    const required = x402.getPaymentRequiredResponse((h: string) => ask.headers.get(h), askBody);
    const payment = await x402.createPaymentPayload(required);
    paid = await fetch(url, { method: "POST", headers: { ...headers, ...x402.encodePaymentSignatureHeader(payment) }, body });
  } catch (e: any) {
    die("Could not create the payment: " + (e?.message ?? e));
  }
  const paidBody: any = await paid.json().catch(() => null);
  log(`Paid status: ${paid.status}`);
  if (paid.status !== 201 && paid.status !== 202) die(explain(paidBody));

  const testId: string | undefined = paidBody?.test?.id ?? paidBody?.id;
  if (testId) writeFileSync(LAST_FILE, JSON.stringify({ id: testId, at: new Date().toISOString() }, null, 2));
  log("\nPAID. The task condition is met.");
  if (testId) log(`Test id: ${testId}`);
  const txUrl = paidBody?.test?.payment?.url;
  if (txUrl) log(`Transaction: ${txUrl}`);

  // 6) Watch the simulated run
  if (testId) {
    log("\nWatching the simulated test (about 8 minutes max). You can close the window; refresh the Rewards page in ~10 minutes.");
    let last = "";
    for (let i = 0; i < 16; i++) {
      try {
        const r = await fetch(`${API}/tests/${testId}`, { headers: { authorization: `Bearer ${apiKey}` } });
        const t: any = await r.json();
        const state = t?.test?.state;
        if (state && state !== last) {
          log(`  state: ${state}`);
          last = state;
        }
        if (["declined", "cancelled", "failed"].includes(state)) break;
      } catch {}
      await sleep(30_000);
    }
  }
  log("\nDone. Refresh the DECA Rewards page. If the task is not ticked after 15 minutes, contact DECA support with your test id and transaction link (never send your API key or wallet key).");
}

main().catch((e) => die(e?.message ?? String(e)));