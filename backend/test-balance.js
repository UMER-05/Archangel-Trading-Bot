// Quick test to check wallet balance
import { Connection, PublicKey } from "@solana/web3.js";

const WALLET = "75iLdZ4G3BjPWDVcBi6QaGkSFvfSzqUGkZqtgUHY1Ab5";
const RPC_URL =
  "https://mainnet.helius-rpc.com/?api-key=a3262028-3dc9-483e-bc11-6381d992e273";

async function checkBalance() {
  console.log("Testing wallet balance...");
  console.log("Wallet:", WALLET);
  console.log("RPC:", RPC_URL);
  console.log("---");

  try {
    const connection = new Connection(RPC_URL, "confirmed");
    const publicKey = new PublicKey(WALLET);

    console.log("Fetching balance...");
    const lamports = await connection.getBalance(publicKey);
    const sol = lamports / 1e9;

    console.log("✅ Balance fetched successfully!");
    console.log("Lamports:", lamports);
    console.log("SOL:", sol.toFixed(4));

    if (sol === 0) {
      console.log("\n⚠️  WARNING: Wallet has 0 SOL!");
      console.log("Please fund this wallet to enable trading.");
      console.log("View wallet: https://solscan.io/account/" + WALLET);
    } else {
      console.log("\n✅ Wallet funded with", sol, "SOL");
    }
  } catch (error) {
    console.error("❌ Error fetching balance:", error.message);
    console.error("Full error:", error);
  }
}

checkBalance();
