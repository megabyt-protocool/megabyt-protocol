import random

NUM_PLAYERS = 100000000
TICKET_PRICE = 2
PRIZE_POOL_PERCENT = 0.75

PROGRESS_STEP = 10000000

PRIZE_DISTRIBUTION = {
    "6+crypto": 0.50,
    "6": 0.15,
    "5+crypto": 0.10,
    "5": 0.08,
    "4+crypto": 0.07,
    "4": 0.05,
    "3+crypto": 0.03,
    "3": 0.015,
    "2+crypto": 0.005
}

def generate_ticket():
    numbers = random.sample(range(1, 51), 6)
    crypto = random.randint(1, 10)
    return numbers, crypto

def count_matches(ticket, winning):
    return len(set(ticket) & set(winning))

def main():

    winning_numbers = random.sample(range(1, 51), 6)
    winning_crypto = random.randint(1, 10)

    winners = {
        "6+crypto":0,
        "6":0,
        "5+crypto":0,
        "5":0,
        "4+crypto":0,
        "4":0,
        "3+crypto":0,
        "3":0,
        "2+crypto":0
    }

    print("\nIniciando simulação...\n")

    for i in range(1, NUM_PLAYERS + 1):

        numbers, crypto = generate_ticket()
        matches = count_matches(numbers, winning_numbers)

        crypto_hit = crypto == winning_crypto

        if matches == 6 and crypto_hit:
            winners["6+crypto"] += 1

        elif matches == 6:
            winners["6"] += 1

        elif matches == 5 and crypto_hit:
            winners["5+crypto"] += 1

        elif matches == 5:
            winners["5"] += 1

        elif matches == 4 and crypto_hit:
            winners["4+crypto"] += 1

        elif matches == 4:
            winners["4"] += 1

        elif matches == 3 and crypto_hit:
            winners["3+crypto"] += 1

        elif matches == 3:
            winners["3"] += 1

        elif matches == 2 and crypto_hit:
            winners["2+crypto"] += 1

        if i % PROGRESS_STEP == 0:
            print(f"Processado: {i:,} apostas")

    total_collected = NUM_PLAYERS * TICKET_PRICE
    prize_pool = total_collected * PRIZE_POOL_PERCENT

    print("\nSIMULAÇÃO FINALIZADA")
    print("---------------------")

    print("Jogadores:", NUM_PLAYERS)
    print("Preço ticket:", TICKET_PRICE)

    print("\nArrecadação total:", total_collected)
    print("Prize Pool:", prize_pool)

    print("\nNúmeros sorteados:", winning_numbers)
    print("Cripto sorteada:", winning_crypto)

    print("\nRESULTADO DAS FAIXAS\n")

    monthly_accumulator = 0

    for tier in winners:

        num_winners = winners[tier]
        tier_prize = prize_pool * PRIZE_DISTRIBUTION[tier]

        if num_winners > 0:

            prize_each = tier_prize / num_winners

            if prize_each < 1:
                monthly_accumulator += tier_prize
                print(tier, "→ prêmio < $1 acumulado:", round(tier_prize,2))

            else:
                print(
                    tier,
                    "| ganhadores:", num_winners,
                    "| total:", round(tier_prize,2),
                    "| cada:", round(prize_each,2)
                )

        else:
            print(tier, "| sem ganhadores")

    print("\nACUMULADO MENSAL (< $1):", round(monthly_accumulator,2))


if __name__ == "__main__":
    main()


