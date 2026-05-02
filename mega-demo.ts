const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function spinAnimation() {
  const frames = [
    "[ 12 | 45 | 03 | 66 ]",
    "[ 22 | 18 | 71 | 09 ]",
    "[ 01 | 55 | 34 | 68 ]",
    "[ 42 | 12 | 08 | 55 ]"
  ];

  for (let i = 0; i < 8; i++) {
    process.stdout.write("\r" + frames[i % frames.length]);
    await sleep(200);
  }
  console.log();
}

async function main() {
  console.clear();

  console.log("\n🚀 MegaByt Protocol Demo v3\n");

  console.log("[1/5] 🏗️ Initializing Protocol...");
  await sleep(1000);
  console.log("GlobalState loaded | Vaults verified");

  console.log("\n[2/5] 🎟️ Simulating Organic Growth...");
  await sleep(1000);
  console.log("Users buying tickets...");
  console.log("Referral cashback: +5% distributed");

  console.log("\n[3/5] 🎲 Requesting VRF (Switchboard)...");
  await sleep(1000);
  console.log("Waiting for oracle...");

  await spinAnimation();

  console.log("\n[4/5] ✅ Randomness Fulfilled!");
  await sleep(1000);
  console.log("Processing tiers...");
  console.log("Tier 8 winner found");
  console.log("Tier 9 winners: 6");
  console.log("Tier 10 winners: 14");

  console.log("\n[5/5] 💰 Finalizing Payouts...");
  await sleep(1000);

  console.log("\n🎉 80% distributed back to players");
  console.log("🔥 Jackpot rolling over to next draw");

  console.log("\n=== DEMO COMPLETE ===");
  console.log("Math > Luck | Fully On-Chain | VRF Verified\n");
}

main();

