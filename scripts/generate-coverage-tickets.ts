import * as fs from "fs";
import * as path from "path";

type TicketData = {
  index: number;
  pairIndex: number;
  numbers: number[];
  crypto: number;
};

const MIN_NUMBER = 1;
const MAX_NUMBER = 72;
const TICKET_SIZE = 6;
const CRYPTOS = [1, 2, 3, 4];
const OUTPUT_FILE = path.resolve("scripts/coverage-tickets-10224.json");

function sortNumbers(numbers: number[]): number[] {
  return [...numbers].sort((a, b) => a - b);
}

function assertValidTicket(numbers: number[], crypto: number) {
  if (numbers.length !== TICKET_SIZE) {
    throw new Error(`Ticket inválido: precisa ter ${TICKET_SIZE} números.`);
  }

  const unique = new Set(numbers);
  if (unique.size !== TICKET_SIZE) {
    throw new Error(`Ticket inválido: números repetidos -> ${numbers.join(",")}`);
  }

  for (const n of numbers) {
    if (n < MIN_NUMBER || n > MAX_NUMBER) {
      throw new Error(`Ticket inválido: número fora do intervalo -> ${n}`);
    }
  }

  if (crypto < 1 || crypto > 10) {
    throw new Error(`Crypto inválido: ${crypto}`);
  }
}

/**
 * Monta um ticket válido contendo obrigatoriamente a dupla [a, b].
 * Os 4 números restantes são preenchidos de forma determinística,
 * sem repetir, usando números válidos entre 1 e 72.
 */
function buildTicketFromPair(a: number, b: number, crypto: number): number[] {
  if (a === b) {
    throw new Error(`Par inválido: números iguais (${a}, ${b})`);
  }

  const chosen = new Set<number>();
  chosen.add(a);
  chosen.add(b);

  // Estratégia:
  // 1) tenta preencher com saltos espalhados para evitar padrão excessivo
  // 2) se faltar, completa linearmente
  const preferredOffsets = [7, 13, 21, 34, 55, 3, 17, 29, 41, 63];

  for (const offset of preferredOffsets) {
    const candidate = ((a + b + crypto + offset - 1) % MAX_NUMBER) + 1;
    if (!chosen.has(candidate)) {
      chosen.add(candidate);
    }
    if (chosen.size === TICKET_SIZE) {
      const result = sortNumbers(Array.from(chosen));
      assertValidTicket(result, crypto);
      return result;
    }
  }

  for (let n = MIN_NUMBER; n <= MAX_NUMBER; n++) {
    if (!chosen.has(n)) {
      chosen.add(n);
    }
    if (chosen.size === TICKET_SIZE) {
      const result = sortNumbers(Array.from(chosen));
      assertValidTicket(result, crypto);
      return result;
    }
  }

  throw new Error(`Não foi possível completar ticket para par (${a}, ${b})`);
}

function generateAllPairs(): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];

  for (let i = MIN_NUMBER; i <= MAX_NUMBER - 1; i++) {
    for (let j = i + 1; j <= MAX_NUMBER; j++) {
      pairs.push([i, j]);
    }
  }

  return pairs;
}

function generateCoverageTickets(): TicketData[] {
  const pairs = generateAllPairs();
  const tickets: TicketData[] = [];

  let index = 0;

  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
    const [a, b] = pairs[pairIndex];

    for (const crypto of CRYPTOS) {
      const numbers = buildTicketFromPair(a, b, crypto);

      tickets.push({
        index,
        pairIndex,
        numbers,
        crypto,
      });

      index++;
    }
  }

  return tickets;
}

function summarizeTickets(tickets: TicketData[]) {
  const cryptosCount = new Map<number, number>();
  const seenPairs = new Set<string>();

  for (const ticket of tickets) {
    cryptosCount.set(ticket.crypto, (cryptosCount.get(ticket.crypto) ?? 0) + 1);

    const pairKey = `${ticket.numbers[0]}-${ticket.numbers[1]}-${ticket.pairIndex}`;
    seenPairs.add(pairKey);

    assertValidTicket(ticket.numbers, ticket.crypto);
  }

  console.log("=== RESUMO ===");
  console.log("Total tickets:", tickets.length);
  console.log("Esperado:", 2556 * 4);
  console.log("Distribuição por crypto:");
  for (const crypto of CRYPTOS) {
    console.log(`  crypto ${crypto}:`, cryptosCount.get(crypto) ?? 0);
  }

  console.log("\nPrimeiros 10 tickets:");
  for (const ticket of tickets.slice(0, 10)) {
    console.log(
      `#${ticket.index} | pairIndex=${ticket.pairIndex} | numbers=[${ticket.numbers.join(", ")}] | crypto=${ticket.crypto}`
    );
  }

  console.log("\nÚltimos 5 tickets:");
  for (const ticket of tickets.slice(-5)) {
    console.log(
      `#${ticket.index} | pairIndex=${ticket.pairIndex} | numbers=[${ticket.numbers.join(", ")}] | crypto=${ticket.crypto}`
    );
  }
}

function main() {
  console.log("=== Gerando 10.224 tickets com cobertura total de duplas ===");

  const tickets = generateCoverageTickets();

  if (tickets.length !== 10224) {
    throw new Error(`Quantidade errada de tickets: ${tickets.length}`);
  }

  summarizeTickets(tickets);

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(tickets, null, 2), "utf-8");

  console.log("\nArquivo salvo em:");
  console.log(OUTPUT_FILE);
  console.log("\nOK: cobertura total pronta.");
}

main();

