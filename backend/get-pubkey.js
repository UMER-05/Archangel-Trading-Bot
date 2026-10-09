import { Keypair } from "@solana/web3.js";

console.log("=== GENERATING NEW SOLANA KEYPAIR ===\n");

const keypair = Keypair.generate();
const secretKey = Array.from(keypair.secretKey);
const publicKey = keypair.publicKey.toBase58();

console.log("Public Key:", publicKey);
console.log("\nSecret Key (for .env file):");
console.log(`SECRET_KEY=[${secretKey.join(",")}]`);
console.log("\nAdd these to your .env:");
console.log(`BACKEND_RECEIVER_WALLET=${publicKey}`);
console.log(`ADMIN_WALLET_PUBKEY=${publicKey}`);
console.log(`ADMIN_WALLET_SECRET=[${secretKey.join(",")}]`);
