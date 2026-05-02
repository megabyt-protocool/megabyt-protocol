/**
 * MegaByt — Tokenomics Simulator
 * Simula distribuicao de premios, cascata, residuos e acumulado mensal
 *
 * Uso: npx ts-node --transpile-only scripts/simulate-tokenomics.ts
 * Env: TICKETS=100 (default), PRICE=1000000 (default 1 USDT)
 */

var TICKETS = parseInt(process.env.TICKETS || "100", 10);
var PRICE = parseInt(process.env.PRICE || "1000000", 10);
var MIN_PRIZE = 1000000; // 1 USDT min
var TIER_BPS = [5500, 1200, 800, 600, 500, 400, 300, 300, 250, 150];
var TIER_NAMES = ["6+crypto", "6", "5+crypto", "5", "4+crypto", "4", "3+crypto", "3", "2+crypto", "2"];
var GAP_BPS = 50;

function hr() { console.log("================================================================"); }

function simulateDraw(tickets, price) {
  var totalCollected = tickets * price;
  var dailyPool = Math.floor(totalCollected * 60 / 100);
  var monthlyBase = Math.floor(totalCollected * 15 / 100);
  var admin = Math.floor(totalCollected * 5 / 100);
  var security = Math.floor(totalCollected * 10 / 100);
  var referral = Math.floor(totalCollected * 5 / 100);
  var costs = Math.floor(totalCollected * 5 / 100);
  var monthlyEffective = monthlyBase + referral;

  // Tier pools
  var tierPools = [];
  for (var i = 0; i < 10; i++) {
    tierPools.push(Math.floor(dailyPool * TIER_BPS[i] / 10000));
  }

  // Simulate winners (probabilistic)
  var winnerCounts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  // Approximate: tier 9 (2 matches) ~ 10-15% of tickets
  // tier 8 ~ 3%, tier 7 ~ 5%, etc
  var probs = [0.00001, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.02, 0.03, 0.04, 0.12];
  for (var t = 0; t < 10; t++) {
    winnerCounts[t] = Math.floor(tickets * probs[t]);
  }

  // Cascata
  var carry = 0;
  var values = tierPools.slice();
  for (var c = 0; c < 10; c++) {
    if (winnerCounts[c] === 0) {
      carry += values[c];
      values[c] = 0;
    }
  }

  // Distribute carry to lowest active tiers
  if (carry > 0) {
    for (var d = 9; d >= 0; d--) {
      if (winnerCounts[d] > 0) {
        values[d] += carry;
        break;
      }
    }
  }

  // Prize per winner + residuals + min rule
  var totalMonthlyContrib = 0;
  var prizePerWinner = [];
  var redistributed = [];
  var residuals = [];

  for (var p = 0; p < 10; p++) {
    if (winnerCounts[p] > 0 && values[p] > 0) {
      var individual = Math.floor(values[p] / winnerCounts[p]);
      if (individual < MIN_PRIZE) {
        // Below $1 — entire pool goes to monthly
        totalMonthlyContrib += values[p];
        prizePerWinner.push(0);
        redistributed.push(values[p]);
        residuals.push(0);
      } else {
        var totalPaid = individual * winnerCounts[p];
        var residual = values[p] - totalPaid;
        totalMonthlyContrib += residual;
        prizePerWinner.push(individual);
        redistributed.push(0);
        residuals.push(residual);
      }
    } else {
      prizePerWinner.push(0);
      redistributed.push(0);
      residuals.push(0);
    }
  }

  return {
    tickets: tickets,
    price: price,
    totalCollected: totalCollected,
    dailyPool: dailyPool,
    monthlyBase: monthlyBase,
    monthlyEffective: monthlyEffective,
    admin: admin,
    security: security,
    costs: costs,
    tierPools: tierPools,
    winnerCounts: winnerCounts,
    values: values,
    prizePerWinner: prizePerWinner,
    redistributed: redistributed,
    residuals: residuals,
    totalMonthlyContrib: totalMonthlyContrib,
    totalWinners: winnerCounts.reduce(function(a, b) { return a + b; }, 0),
  };
}

function formatUSDT(val) {
  return (val / 1000000).toFixed(2) + " USDT";
}

function printSim(sim) {
  hr();
  console.log("  TOKENOMICS SIMULATION — " + sim.tickets + " tickets @ " + formatUSDT(sim.price));
  hr();
  console.log("");
  console.log("  Total Collected:    " + formatUSDT(sim.totalCollected));
  console.log("  Daily Pool (60%):   " + formatUSDT(sim.dailyPool));
  console.log("  Monthly (15+5%):    " + formatUSDT(sim.monthlyEffective));
  console.log("  Admin (5%):         " + formatUSDT(sim.admin));
  console.log("  Security (10%):     " + formatUSDT(sim.security));
  console.log("  Costs (5%):         " + formatUSDT(sim.costs));
  console.log("");

  console.log("  Tier | Name       | Pool        | Winners | Prize/each  | Redistributed | Residual");
  console.log("  -----+------------+-------------+---------+-------------+---------------+---------");
  for (var i = 0; i < 10; i++) {
    var name = TIER_NAMES[i];
    while (name.length < 10) name += " ";
    var pool = formatUSDT(sim.tierPools[i]);
    while (pool.length < 11) pool = " " + pool;
    var win = String(sim.winnerCounts[i]);
    while (win.length < 7) win = " " + win;
    var prize = sim.prizePerWinner[i] > 0 ? formatUSDT(sim.prizePerWinner[i]) : "    -    ";
    while (prize.length < 11) prize = " " + prize;
    var redist = sim.redistributed[i] > 0 ? formatUSDT(sim.redistributed[i]) : "     -     ";
    while (redist.length < 13) redist = " " + redist;
    var res = sim.residuals[i] > 0 ? formatUSDT(sim.residuals[i]) : "   -  ";
    console.log("    " + i + "  | " + name + " | " + pool + " | " + win + " | " + prize + " | " + redist + " | " + res);
  }

  console.log("");
  console.log("  Total Winners:        " + sim.totalWinners);
  console.log("  Monthly Contribution: " + formatUSDT(sim.totalMonthlyContrib));
  console.log("    (residuals + sub-$1 tiers)");
  console.log("");
}

console.log("");
console.log("================================================================");
console.log("  MEGABYT TOKENOMICS SIMULATOR");
console.log("================================================================");
console.log("");

var scenarios = [100, 500, 1000, 5000];
var cumulativeMonthly = 0;

for (var s = 0; s < scenarios.length; s++) {
  var sim = simulateDraw(scenarios[s], PRICE);
  printSim(sim);
  cumulativeMonthly += sim.totalMonthlyContrib + sim.monthlyEffective;
}

hr();
console.log("  MONTHLY JACKPOT PROJECTION (30 draws)");
hr();
console.log("");
var sim30 = simulateDraw(500, PRICE);
var monthly30 = (sim30.totalMonthlyContrib + sim30.monthlyEffective) * 30;
console.log("  If avg 500 tickets/draw x 30 draws/month:");
console.log("  Monthly jackpot: " + formatUSDT(monthly30));
console.log("");
hr();
console.log("  Simulation complete.");
hr();
console.log("");
