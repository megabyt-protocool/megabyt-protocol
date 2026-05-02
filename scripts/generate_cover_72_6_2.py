#!/usr/bin/env python3
from __future__ import annotations

import itertools
import json
import math
import os
import sys
from pathlib import Path

try:
    from ortools.sat.python import cp_model
except ImportError:
    print("ERRO: ortools não instalado.")
    print("Instale com: python3 -m pip install ortools")
    sys.exit(1)


# ============================================================
# CONFIG
# ============================================================
V = 72          # universo 1..72
K = 6           # tamanho do jogo
NUM_BLOCKS = 180
TIME_LIMIT_SEC = 1800   # 30 min
NUM_WORKERS = 8
OUT_DIR = Path("artifacts_cover_72_6_2")

# Segurança: 72 choose 2 = 2556
ALL_PAIRS = [(a, b) for a in range(1, V + 1) for b in range(a + 1, V + 1)]
PAIR_INDEX = {p: i for i, p in enumerate(ALL_PAIRS)}


# ============================================================
# HELPERS
# ============================================================
def choose(n: int, r: int) -> int:
    return math.comb(n, r)


def verify_cover(blocks: list[list[int]]) -> tuple[bool, list[tuple[int, int]]]:
    """Verifica se todos os pares estão cobertos."""
    covered = set()
    for block in blocks:
        s = sorted(block)
        if len(s) != K:
            raise ValueError(f"Bloco inválido com tamanho != {K}: {block}")
        if len(set(s)) != K:
            raise ValueError(f"Bloco com repetição: {block}")
        for x in s:
            if not (1 <= x <= V):
                raise ValueError(f"Número fora do intervalo 1..{V}: {x}")
        for p in itertools.combinations(s, 2):
            covered.add(p)

    missing = [p for p in ALL_PAIRS if p not in covered]
    return (len(missing) == 0, missing)


def save_outputs(blocks: list[list[int]]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    txt_path = OUT_DIR / "cover_72_6_2_180_games.txt"
    json_path = OUT_DIR / "cover_72_6_2_180_games.json"

    with txt_path.open("w", encoding="utf-8") as f:
        f.write("# 180 jogos cobrindo todas as duplas de 1..72\n")
        f.write(f"# universo={V}, bloco={K}, jogos={len(blocks)}\n\n")
        for i, block in enumerate(blocks, start=1):
            f.write(f"{i:03d}: {block}\n")

    with json_path.open("w", encoding="utf-8") as f:
        json.dump(
            {
                "universe": V,
                "block_size": K,
                "num_blocks": len(blocks),
                "blocks": blocks,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"\nArquivos salvos em:")
    print(f" - {txt_path}")
    print(f" - {json_path}")


# ============================================================
# MODEL
# ============================================================
def build_model():
    model = cp_model.CpModel()

    # x[b][n] = 1 se o bloco b contém o número n
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    for b in range(NUM_BLOCKS):
        for n in range(1, V + 1):
            x[(b, n)] = model.NewBoolVar(f"x_b{b}_n{n}")

    # Cada bloco tem exatamente 6 números
    for b in range(NUM_BLOCKS):
        model.Add(sum(x[(b, n)] for n in range(1, V + 1)) == K)

    # Balanceamento opcional forte:
    # média exata de incidência por número = (180 * 6) / 72 = 15
    # Isso ajuda a busca. Se ficar muito restritivo no seu ambiente,
    # podemos relaxar depois.
    for n in range(1, V + 1):
        model.Add(sum(x[(b, n)] for b in range(NUM_BLOCKS)) == 15)

    # Cobertura de pares:
    # Para cada par (a,b), deve existir pelo menos um bloco com ambos.
    #
    # Usamos y[pair_idx][block] = 1 se o bloco block cobre esse par.
    # Relação:
    #   y <= x_a
    #   y <= x_b
    #   y >= x_a + x_b - 1
    #
    # E depois:
    #   OR_b y[pair, b]
    # isto é, pelo menos um bloco cobre cada par.
    y: dict[tuple[int, int], cp_model.IntVar] = {}

    for p_idx, (a, b) in enumerate(ALL_PAIRS):
        lits = []
        for block in range(NUM_BLOCKS):
            yvar = model.NewBoolVar(f"y_p{p_idx}_b{block}")
            y[(p_idx, block)] = yvar

            model.Add(yvar <= x[(block, a)])
            model.Add(yvar <= x[(block, b)])
            model.Add(yvar >= x[(block, a)] + x[(block, b)] - 1)

            lits.append(yvar)

        model.AddBoolOr(lits)

    # Simetria leve:
    # fixa o número 1 no primeiro bloco, para reduzir equivalências bobas
    model.Add(x[(0, 1)] == 1)

    return model, x


# ============================================================
# SOLVE
# ============================================================
def solve_exact():
    print("=== GERADOR EXATO C(72,6,2) COM 180 JOGOS ===")
    print(f"Universo: 1..{V}")
    print(f"Tamanho do jogo: {K}")
    print(f"Jogos alvo: {NUM_BLOCKS}")
    print(f"Duplas totais: {choose(V, 2)}")
    print(f"Duplas por jogo: {choose(K, 2)}")
    print()

    model, x = build_model()

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = TIME_LIMIT_SEC
    solver.parameters.num_search_workers = NUM_WORKERS
    solver.parameters.log_search_progress = True
    solver.parameters.random_seed = 42

    print("Iniciando solver...")
    status = solver.Solve(model)

    status_name = solver.StatusName(status)
    print(f"\nStatus do solver: {status_name}")

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        print("Nenhuma solução viável encontrada dentro do tempo.")
        print("Isso NÃO prova que 180 é impossível; só significa que o solver não achou a tempo.")
        return None

    blocks: list[list[int]] = []
    for b in range(NUM_BLOCKS):
        nums = [n for n in range(1, V + 1) if solver.Value(x[(b, n)]) == 1]
        nums.sort()
        blocks.append(nums)

    ok, missing = verify_cover(blocks)

    print(f"\nTotal de blocos gerados: {len(blocks)}")
    print(f"Verificação de cobertura: {'OK' if ok else 'FALHOU'}")

    if not ok:
        print(f"Pares faltando: {len(missing)}")
        print("Primeiros pares faltando:", missing[:20])
        return None

    # Estatísticas simples
    pair_multiplicity = {pair: 0 for pair in ALL_PAIRS}
    for block in blocks:
        for pair in itertools.combinations(block, 2):
            pair_multiplicity[pair] += 1

    mult_values = list(pair_multiplicity.values())
    min_mult = min(mult_values)
    max_mult = max(mult_values)
    avg_mult = sum(mult_values) / len(mult_values)

    print("\n=== ESTATÍSTICAS ===")
    print(f"Cobertura mínima por dupla: {min_mult}")
    print(f"Cobertura máxima por dupla: {max_mult}")
    print(f"Cobertura média por dupla: {avg_mult:.4f}")

    save_outputs(blocks)

    print("\n=== PRIMEIROS 20 JOGOS ===")
    for i, block in enumerate(blocks[:20], start=1):
        print(f"{i:03d}: {block}")

    return blocks


if __name__ == "__main__":
    try:
        solve_exact()
    except KeyboardInterrupt:
        print("\nExecução interrompida pelo usuário.")
        sys.exit(130)
    except Exception as e:
        print(f"\nERRO: {e}")
        raise

