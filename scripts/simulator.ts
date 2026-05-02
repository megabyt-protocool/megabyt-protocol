type TierId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

interface Ticket {
  id: number;
  numbers: number[];
  crypto: number;
  tier: TierId | 255;
  prize: number;
}

const CONFIG = {
  ticketPrice: 2, // USDT
  totalTickets: 1000,
  prizePoolPercent: 0.75, // 75%
  maxNumber: 72,
  numbersPerTicket: 6,
  maxCrypto: 10,
};

// Mesma linha de tiers que você vinha usando no protocolo.
// Soma = 10000 bps = 100%
const TIER_BPS: Record<TierId, number> = {
  1: 5500, // 6 + crypto
  2: 1200, // 6
  3: 800,  // 5 + crypto
  4: 600,  // 5
  5: 500,  // 4 + crypto
  6: 400,  // 4
  7: 300,  // 3 + crypto
  8: 300,  // 3
  9: 250,  // 2 + crypto
  10: 150, // 2
};

const WINNING_NUMBERS = [7, 14, 21, 28, 35, 42];
const WINNING_CRYPTO = 3;

function sortNumbers(numbers: number[]): number[] {
  return [...numbers].sort((a, b) => a - b);
}

function generateUniqueNumbers(count: number, max: number): number[] {
  const set = new Set<number>();

  while (set.size < count) {
    const value = Math.floor(Math.random() * max) + 1;
    set.add(value);
  }

  return sortNumbers(Array.from(set));
}

function countMatches(ticketNumbers: number[], winningNumbers: number[]): number {
  const winningSet = new Set(winningNumbers);
  return ticketNumbers.filter((n) => winningSet.has(n)).length;
}

function determineTier(matches: number, cryptoHit: boolean): TierId | 255 {
  if (matches === 6 && cryptoHit) return 1;
  if (matches === 6) return 2;
  if (matches === 5 && cryptoHit) return 3;
  if (matches === 5) return 4;
  if (matches === 4 && cryptoHit) return 5;
  if (matches === 4) return 6;
  if (matches === 3 && cryptoHit) return 7;
  if (matches === 3) return 8;
  if (matches === 2 && cryptoHit) return 9;
  if (matches === 2) return 10;

  return 255; // sem prêmio
}

function generateRandomTickets(count: number): Ticket[] {
  const tickets: Ticket[] = [];

  for (let i = 0; i < count; i++) {
    tickets.push({
      id: i + 1,
      numbers: generateUniqueNumbers(CONFIG.numbersPerTicket, CONFIG.maxNumber),
      crypto: Math.floor(Math.random() * CONFIG.maxCrypto) + 1,
      tier: 255,
      prize: 0,
    });
  }

  // Massa de teste forçada para garantir tabela útil
  if (tickets.length >= 10) {
    tickets[0].numbers = [7, 14, 21, 28, 35, 42];
    tickets[0].crypto = 3; // Tier 1

    tickets[1].numbers = [7, 14, 21, 28, 35, 42];
    tickets[1].crypto = 9; // Tier 2

    tickets[2].numbers = [7, 14, 21, 28, 35, 50];
    tickets[2].crypto = 3; // Tier 3

    tickets[3].numbers = [7, 14, 21, 28, 35, 51];
    tickets[3].crypto = 8; // Tier 4

    tickets[4].numbers = [7, 14, 21, 28, 60, 61];
    tickets[4].crypto = 3; // Tier 5

    tickets[5].numbers = [7, 14, 21, 28, 62, 63];
    tickets[5].crypto = 8; // Tier 6

    tickets[6].numbers = [7, 14, 21, 64, 65, 66];
    tickets[6].crypto = 3; // Tier 7

    tickets[7].numbers = [7, 14, 21, 67, 68, 69];
    tickets[7].crypto = 8; // Tier 8

    tickets[8].numbers = [7, 14, 70, 71, 72, 1];
    tickets[8].crypto = 3; // Tier 9

    tickets[9].numbers = [7, 14, 70, 71, 72, 2];
    tickets[9].crypto = 8; // Tier 10

    for (let i = 0; i < 10; i++) {
      tickets[i].numbers = sortNumbers(tickets[i].numbers);
    }
  }

  return tickets;
}

function settleTickets(tickets: Ticket[]) {
  const revenue = CONFIG.totalTickets * CONFIG.ticketPrice;
  const totalPrizePool = revenue * CONFIG.prizePoolPercent;

  const winnersCount: Record<TierId, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
    6: 0,
    7: 0,
    8: 0,
    9: 0,
    10: 0,
  };

  for (const ticket of tickets) {
    const matches = countMatches(ticket.numbers, WINNING_NUMBERS);
    const cryptoHit = ticket.crypto === WINNING_CRYPTO;
    const tier = determineTier(matches, cryptoHit);

    ticket.tier = tier;

    if (tier !== 255) {
      winnersCount[tier] += 1;
    }
  }

  for (const tierKey of Object.keys(TIER_BPS)) {
    const tier = Number(tierKey) as TierId;
    const tierPool = (totalPrizePool * TIER_BPS[tier]) / 10000;
    const count = winnersCount[tier];
    const prizePerWinner = count > 0 ? tierPool / count : 0;

    for (const ticket of tickets) {
      if (ticket.tier === tier) {
        ticket.prize = prizePerWinner;
      }
    }
  }

  return {
    revenue,
    totalPrizePool,
    winnersCount,
    tickets,
  };
}

function printReport(result: ReturnType<typeof settleTickets>) {
  console.log("\n=== RELATÓRIO MEGABYT SIMULATOR ===");
  console.log(`Ticket Price: ${CONFIG.ticketPrice.toFixed(2)} USDT`);
  console.log(`Total Tickets: ${CONFIG.totalTickets}`);
  console.log(`Total Arrecadado: ${result.revenue.toFixed(2)} USDT`);
  console.log(`Pool de Prêmios (75%): ${result.totalPrizePool.toFixed(2)} USDT`);
  console.log(`Números sorteados: ${WINNING_NUMBERS.join(", ")}`);
  console.log(`Crypto sorteado: ${WINNING_CRYPTO}\n`);

  console.log("=== PRIZE TABLE ===");

  for (const tierKey of Object.keys(TIER_BPS)) {
    const tier = Number(tierKey) as TierId;
    const tierPool = (result.totalPrizePool * TIER_BPS[tier]) / 10000;
    const count = result.winnersCount[tier];
    const prizePerWinner = count > 0 ? tierPool / count : 0;

    console.log(
      `Tier ${tier} | winners: ${count} | tier pool: ${tierPool.toFixed(2)} USDT | prize/winner: ${prizePerWinner.toFixed(2)} USDT`
    );
  }

  const paidTickets = result.tickets.filter((t) => t.tier !== 255);

  console.log("\n=== EXEMPLOS DE TICKETS PREMIADOS ===");

  for (const ticket of paidTickets.slice(0, 15)) {
    console.log(
      `Ticket #${ticket.id} | numbers: [${ticket.numbers.join(", ")}] | crypto: ${ticket.crypto} | tier: ${ticket.tier} | prize: ${ticket.prize.toFixed(2)} USDT`
    );
  }

  console.log(`\nTotal de tickets premiados: ${paidTickets.length}`);
}

function main() {
  const tickets = generateRandomTickets(CONFIG.totalTickets);
  const result = settleTickets(tickets);
  printReport(result);
}

main();

