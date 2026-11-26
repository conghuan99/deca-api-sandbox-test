# DECA API Sandbox Helper

A community script for DECA's free "Try a test in the API sandbox" task.
It uses **test USDC on Base Sepolia**: no real money, no ads.

## Disclaimer & security
- Unofficial. Reward points are decided by DECA and may change.
- The script creates a **throwaway wallet** (saved in `.wallet.json`) that only holds test tokens. **Never** enter your real wallet's private key into any script.
- Your API key sits in plain text in `.env` (git-ignored). Never share or upload `.env` or `.wallet.json`.

## Requirements
Windows + PowerShell, [Node.js 20+](https://nodejs.org), a DECA account.

## Steps
1. **Create an API key:** DECA dashboard -> MCP & API -> New key. Tick `read`, `quote` and `test`, then copy the key (it is shown only once).
2. **Download this repo** (Code -> Download ZIP), unzip it, and open PowerShell in the folder.
3. **Create your config file:**
   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```
   Paste your key after `DECA_API_KEY=` and save. (Optional: write your own idea on the `IDEA=` line. Avoid crypto, finance, health, gambling or dating topics.)
4. **Run:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\run.ps1
   ```
5. The script prints a wallet address. Go to https://faucet.circle.com, choose **USDC + Base Sepolia**, paste the address and request tokens. Keep the PowerShell window open: the script waits for the tokens and continues by itself.
6. When you see `PAID`, you are done. Wait about 10 minutes, then refresh the Rewards page.

## Common errors
- `over_cap`: only if you get this error, edit the key and raise its per-test cap to at least the total shown in the quote. Lower it again or delete the key when you are done.
- `scope_missing`: edit the key and tick all three scopes: `read`, `quote`, `test`.
- `quote_expired`: run the script again.
- "already ran": run again with `.\run.ps1 -Again`.