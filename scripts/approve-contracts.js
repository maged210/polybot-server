#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
//  APPROVE CONTRACTS — Run once before your first trade
//  
//  This script approves Polymarket's exchange contracts to
//  spend your USDC and conditional tokens on Polygon.
//  
//  Usage: node scripts/approve-contracts.js
//  Requires: PRIVATE_KEY and POLYGON_RPC in .env
//  Cost: ~0.01 POL (Polygon gas token) per approval
// ════════════════════════════════════════════════════════════

require("dotenv").config();
const { Wallet } = require("@ethersproject/wallet");
const { JsonRpcProvider } = require("@ethersproject/providers");
const { Contract } = require("@ethersproject/contracts");
const { MaxUint256 } = require("@ethersproject/constants");
const { BigNumber } = require("@ethersproject/bignumber");

const CONTRACTS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  CTF: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  NEG_RISK_CTF_EXCHANGE: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  NEG_RISK_ADAPTER: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
};

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

const ERC1155_ABI = [
  "function setApprovalForAll(address operator, bool approved)",
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

async function main() {
  console.log("\n🔧 POLYBOT — Contract Approval Script\n");

  if (!process.env.PRIVATE_KEY) {
    console.error("❌ Set PRIVATE_KEY in .env first");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(process.env.POLYGON_RPC || "https://polygon-rpc.com");
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
  const address = await wallet.getAddress();

  console.log(`Wallet: ${address}`);
  
  // Check POL balance for gas
  const polBalance = await provider.getBalance(address);
  const polEth = parseFloat(polBalance.toString()) / 1e18;
  console.log(`POL balance: ${polEth.toFixed(4)} POL`);
  
  if (polEth < 0.01) {
    console.error("❌ Need at least 0.01 POL for gas fees. Send some POL to your wallet.");
    process.exit(1);
  }

  // Get current gas price and add margin
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice ? feeData.gasPrice.mul(2) : BigNumber.from("50000000000"); // 50 gwei fallback
  console.log(`Gas price: ${(parseFloat(gasPrice.toString()) / 1e9).toFixed(1)} gwei\n`);
  const txOpts = { gasPrice, gasLimit: 100000 };

  // Check both USDC.e (bridged, Polymarket uses this) and native USDC
  const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  
  const usdcE = new Contract(USDC_E, ERC20_ABI, wallet);
  const usdcNative = new Contract(USDC_NATIVE, ERC20_ABI, wallet);
  
  const balE = await usdcE.balanceOf(address);
  const balNative = await usdcNative.balanceOf(address);
  
  const balEFormatted = parseFloat(balE.toString()) / 1e6;
  const balNativeFormatted = parseFloat(balNative.toString()) / 1e6;
  
  console.log(`USDC.e balance (Polymarket uses this): $${balEFormatted.toFixed(2)}`);
  console.log(`Native USDC balance: $${balNativeFormatted.toFixed(2)}`);
  
  if (balEFormatted < 1 && balNativeFormatted > 1) {
    console.log("\n⚠️  You have native USDC but Polymarket needs USDC.e!");
    console.log("   Swap native USDC → USDC.e on https://app.uniswap.org (Polygon network)");
    console.log("   Or use https://wallet.polygon.technology/polygon/bridge to bridge");
    console.log("\n   Continuing with approvals anyway...\n");
  }

  // Use whichever USDC contract has balance, prefer USDC.e
  const usdc = balEFormatted > 0 ? usdcE : usdcNative;

  // ── Step 1: Approve USDC.e spending ──
  console.log("Step 1/4: Approving USDC.e for CTF Exchange...");
  const usdcAllowance1 = await usdcE.allowance(address, CONTRACTS.CTF_EXCHANGE);
  if (usdcAllowance1.gt(0)) {
    console.log("  ✓ Already approved");
  } else {
    const tx1 = await usdcE.approve(CONTRACTS.CTF_EXCHANGE, MaxUint256, txOpts);
    console.log(`  ⏳ TX: ${tx1.hash}`);
    await tx1.wait();
    console.log("  ✓ Approved");
  }

  console.log("Step 2/4: Approving USDC.e for Neg Risk CTF Exchange...");
  const usdcAllowance2 = await usdcE.allowance(address, CONTRACTS.NEG_RISK_CTF_EXCHANGE);
  if (usdcAllowance2.gt(0)) {
    console.log("  ✓ Already approved");
  } else {
    const tx2 = await usdcE.approve(CONTRACTS.NEG_RISK_CTF_EXCHANGE, MaxUint256, txOpts);
    console.log(`  ⏳ TX: ${tx2.hash}`);
    await tx2.wait();
    console.log("  ✓ Approved");
  }

  // ── Step 2: Approve Conditional Tokens ──
  const ctf = new Contract(CONTRACTS.CTF, ERC1155_ABI, wallet);

  console.log("Step 3/4: Approving CTF for CTF Exchange...");
  const isApproved1 = await ctf.isApprovedForAll(address, CONTRACTS.CTF_EXCHANGE);
  if (isApproved1) {
    console.log("  ✓ Already approved");
  } else {
    const tx3 = await ctf.setApprovalForAll(CONTRACTS.CTF_EXCHANGE, true, txOpts);
    console.log(`  ⏳ TX: ${tx3.hash}`);
    await tx3.wait();
    console.log("  ✓ Approved");
  }

  console.log("Step 4/4: Approving CTF for Neg Risk Exchange...");
  const isApproved2 = await ctf.isApprovedForAll(address, CONTRACTS.NEG_RISK_CTF_EXCHANGE);
  if (isApproved2) {
    console.log("  ✓ Already approved");
  } else {
    const tx4 = await ctf.setApprovalForAll(CONTRACTS.NEG_RISK_CTF_EXCHANGE, true, txOpts);
    console.log(`  ⏳ TX: ${tx4.hash}`);
    await tx4.wait();
    console.log("  ✓ Approved");
  }

  console.log("\n✅ All contracts approved! You're ready to trade on Polymarket.\n");
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
