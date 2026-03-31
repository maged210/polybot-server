#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
//  DERIVE API KEYS — Generate Polymarket CLOB credentials
//  
//  This script performs L1 authentication (EIP-712 signature)
//  to derive your L2 API credentials (apiKey, secret, passphrase).
//  
//  Usage: node scripts/derive-api-keys.js
//  Save the output to your .env file
// ════════════════════════════════════════════════════════════

require("dotenv").config();
const { ClobClient } = require("@polymarket/clob-client");
const { Wallet } = require("@ethersproject/wallet");

async function main() {
  console.log("\n🔑 POLYBOT — API Key Derivation\n");

  if (!process.env.PRIVATE_KEY) {
    console.error("❌ Set PRIVATE_KEY in .env first");
    process.exit(1);
  }

  const wallet = new Wallet(process.env.PRIVATE_KEY);
  const address = await wallet.getAddress();
  console.log(`Wallet: ${address}\n`);

  console.log("Deriving CLOB API credentials via EIP-712 signature...\n");

  try {
    const client = new ClobClient(
      "https://clob.polymarket.com",
      137, // Polygon
      wallet
    );

    const creds = await client.createOrDeriveApiKey();

    console.log("✅ API Credentials derived successfully!\n");
    console.log("Add these to your .env file:\n");
    console.log("─".repeat(60));
    console.log(`POLYMARKET_API_KEY=${creds.apiKey}`);
    console.log(`POLYMARKET_SECRET=${creds.secret}`);
    console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);
    console.log("─".repeat(60));
    console.log("\n⚠️  Keep these secret! Never commit to git.\n");

    // Verify they work
    const authedClient = new ClobClient(
      "https://clob.polymarket.com",
      137,
      wallet,
      creds,
      parseInt(process.env.SIGNATURE_TYPE || "0"),
      process.env.FUNDER_ADDRESS || address
    );

    const ok = await authedClient.getOk();
    console.log(`Connection test: ${ok ? "✓ PASSED" : "✗ FAILED"}`);
    
    const time = await authedClient.getServerTime();
    console.log(`Server time: ${time}`);
    console.log("\nYou're all set! Start the bot with: npm start\n");
  } catch (e) {
    console.error(`❌ Derivation failed: ${e.message}`);
    console.error("\nCommon issues:");
    console.error("  - Invalid private key format (needs 0x prefix)");
    console.error("  - Network error (check internet connection)");
    console.error("  - CLOB API down (try again later)");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
