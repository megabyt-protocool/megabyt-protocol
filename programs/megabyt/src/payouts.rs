use anchor_lang::prelude::*;

use crate::error::MegabytError;

// =========================================================
//  Cascata + divisao + anti-esmola — DIARIO E MENSAL
//
//  A funcao abaixo generaliza a matematica que ja existe INLINE no
//  handler de instructions/finalize_payouts.rs (diario) — la ela opera
//  direto sobre um array fixo [u64; 10] e draw.winner_counts, acoplada as
//  contas do diario, entao nao dava pra importar sem mexer no arquivo.
//  Aqui ela vira uma funcao pura sobre slices de qualquer tamanho, pra
//  finalize_monthly_payouts.rs poder reusar sobre os tiers 1..9 (o tier 0
//  do mensal e o jackpot, tratado separadamente).
//
//  finalize_payouts.rs (diario) NAO foi alterado: continua com a mesma
//  logica inline. O teste de paridade abaixo cola uma copia dessa logica
//  (fiel linha a linha) operando sobre [u64; 10] e compara contra esta
//  funcao rodando sobre um slice de 10 — confirma que a generalizacao nao
//  mudou o resultado.
// =========================================================

/// Aplica a cascata linear (tier sem vencedor -> pool desce pro proximo)
/// seguida da divisao por vencedor com regra anti-esmola, sobre um
/// conjunto de tiers CONTIGUOS.
///
/// `values[i]` entra com o pool alocado ao tier i (antes da cascata) e sai
/// com o valor POR VENCEDOR daquele tier (0 se nao houver vencedor, ou se
/// o individual cair abaixo do minimo).
///
/// Retorna o total que "sobrou" (carry final da cascata, apos o ultimo
/// tier + tiers abaixo do minimo anti-esmola + residuos de divisao) — o
/// chamador decide pra onde isso vai (global_state.monthly_pool no diario
/// e no mensal).
pub fn cascade_and_divide(
    values: &mut [u64],
    winner_counts: &[u64],
    min_prize_per_winner: u64,
) -> Result<u64> {
    require!(values.len() == winner_counts.len(), MegabytError::InvalidMonthlyRange);

    let n = values.len();

    // Passo 1: cascata linear.
    let mut carry: u64 = 0;
    for i in 0..n {
        values[i] = values[i].checked_add(carry).ok_or(MegabytError::MathOverflow)?;
        carry = 0;

        if winner_counts[i] == 0 {
            carry = values[i];
            values[i] = 0;
        }
    }

    let mut leftover: u64 = carry;

    // Passo 2: premio individual + anti-esmola + residuo.
    for i in 0..n {
        if winner_counts[i] > 0 && values[i] > 0 {
            let individual = values[i]
                .checked_div(winner_counts[i])
                .ok_or(MegabytError::MathOverflow)?;

            if individual < min_prize_per_winner {
                leftover = leftover
                    .checked_add(values[i])
                    .ok_or(MegabytError::MathOverflow)?;
                values[i] = 0;
            } else {
                let total_paid = individual
                    .checked_mul(winner_counts[i])
                    .ok_or(MegabytError::MathOverflow)?;
                let residual = values[i]
                    .checked_sub(total_paid)
                    .ok_or(MegabytError::MathOverflow)?;

                if residual > 0 {
                    leftover = leftover
                        .checked_add(residual)
                        .ok_or(MegabytError::MathOverflow)?;
                }

                values[i] = individual;
            }
        } else {
            values[i] = 0;
        }
    }

    Ok(leftover)
}

/// Divide um pool igualmente entre N vencedores (usado pelo jackpot do
/// sorteio mensal, tier 0 — que nao passa pela cascata porque nao tem
/// tier abaixo dele pra receber carry). Retorna (valor_por_vencedor,
/// residuo_da_divisao). So chamar com `winners > 0`.
pub fn split_evenly(pool: u64, winners: u64) -> Result<(u64, u64)> {
    require!(winners > 0, MegabytError::MathOverflow);

    let individual = pool.checked_div(winners).ok_or(MegabytError::MathOverflow)?;
    let paid = individual.checked_mul(winners).ok_or(MegabytError::MathOverflow)?;
    let residual = pool.checked_sub(paid).ok_or(MegabytError::MathOverflow)?;

    Ok((individual, residual))
}

// =========================================================
//  Teste de paridade: confirma que cascade_and_divide, rodando sobre um
//  slice de 10, produz EXATAMENTE o mesmo resultado que a logica inline
//  de finalize_payouts.rs (diario) — copiada aqui linha a linha.
// =========================================================
#[cfg(test)]
mod parity_tests {
    use super::*;

    const MIN_PRIZE: u64 = 1_000_000;

    /// Copia fiel da logica inline de finalize_payouts.rs::handler, so
    /// reescrita como funcao pura sobre [u64; 10] pra comparar.
    fn finalize_daily_style(
        prize_per_tier: [u64; 10],
        winner_counts: [u64; 10],
    ) -> ([u64; 10], u64) {
        let mut tier_values = prize_per_tier;

        let mut carry: u64 = 0;
        for i in 0..10 {
            tier_values[i] = tier_values[i].checked_add(carry).unwrap();
            carry = 0;

            if winner_counts[i] == 0 {
                carry = tier_values[i];
                tier_values[i] = 0;
            }
        }

        let mut total_monthly_contribution: u64 = 0;
        if carry > 0 {
            total_monthly_contribution = total_monthly_contribution.checked_add(carry).unwrap();
        }

        let mut result = [0u64; 10];
        for i in 0..10 {
            if winner_counts[i] > 0 && tier_values[i] > 0 {
                let individual = tier_values[i].checked_div(winner_counts[i]).unwrap();

                if individual < MIN_PRIZE {
                    total_monthly_contribution = total_monthly_contribution
                        .checked_add(tier_values[i])
                        .unwrap();
                    result[i] = 0;
                } else {
                    let total_paid = individual.checked_mul(winner_counts[i]).unwrap();
                    let residual = tier_values[i].checked_sub(total_paid).unwrap();
                    if residual > 0 {
                        total_monthly_contribution =
                            total_monthly_contribution.checked_add(residual).unwrap();
                    }
                    result[i] = individual;
                }
            } else {
                result[i] = 0;
            }
        }

        (result, total_monthly_contribution)
    }

    #[test]
    fn cascade_and_divide_e_identico_a_logica_inline_do_diario() {
        let cases: [([u64; 10], [u64; 10]); 6] = [
            // Caso normal: todo tier tem vencedor.
            (
                [5_500_000, 1_200_000, 800_000, 600_000, 500_000, 400_000, 300_000, 300_000, 250_000, 150_000],
                [1, 2, 1, 3, 1, 1, 1, 1, 1, 1],
            ),
            // Gap no meio (tier 7 e 9 com vencedor, 8 sem — igual ao caso do AUDIT_REPORT).
            (
                [5_500_000, 1_200_000, 800_000, 600_000, 500_000, 400_000, 300_000, 300_000, 250_000, 150_000],
                [0, 0, 0, 0, 0, 0, 0, 1, 0, 1],
            ),
            // Todos vazios exceto o ultimo.
            (
                [5_500_000, 1_200_000, 800_000, 600_000, 500_000, 400_000, 300_000, 300_000, 250_000, 150_000],
                [0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
            ),
            // Ninguem ganhou nada.
            (
                [5_500_000, 1_200_000, 800_000, 600_000, 500_000, 400_000, 300_000, 300_000, 250_000, 150_000],
                [0; 10],
            ),
            // Anti-esmola: tier 9 tem vencedores demais pro premio individual passar de $1.
            (
                [5_500_000, 1_200_000, 800_000, 600_000, 500_000, 400_000, 300_000, 300_000, 250_000, 150_000],
                [1, 0, 0, 0, 0, 0, 0, 0, 0, 200],
            ),
            // Todo mundo ganha, pools pequenos (forca residuo de divisao).
            (
                [7, 13, 5, 9, 4, 6, 3, 3, 2, 1],
                [3, 4, 2, 5, 3, 2, 2, 2, 2, 1],
            ),
        ];

        for (prize_per_tier, winner_counts) in cases {
            let (expected_values, expected_leftover) =
                finalize_daily_style(prize_per_tier, winner_counts);

            let mut values = prize_per_tier;
            let leftover = cascade_and_divide(&mut values, &winner_counts, MIN_PRIZE).unwrap();

            assert_eq!(values, expected_values, "winner_counts={:?}", winner_counts);
            assert_eq!(leftover, expected_leftover, "winner_counts={:?}", winner_counts);

            // Conservacao: soma do que sobrou por tier (individual * count)
            // + leftover == soma original alocada.
            let total_in: u64 = prize_per_tier.iter().sum();
            let total_paid: u64 = (0..10).map(|i| values[i] * winner_counts[i]).sum();
            assert_eq!(total_paid + leftover, total_in, "conservacao quebrada");
        }
    }
}

// =========================================================
//  Testes do jackpot (split_evenly). Nao e' um teste de paridade — o
//  diario nao tem um jackpot separado da cascata (tier 0 la e' so mais um
//  tier na cascata). Testa diretamente a MESMA funcao usada dentro de
//  finalize_monthly_payouts.rs (nao uma reimplementacao paralela), porque
//  o cenario "jackpot com ganhador" e' inalcancavel pelo pipeline
//  completo de teste (VRF/tickets) neste ambiente: tier 0 exige
//  crypto_hit=true, mas crypto_count sai do initialize travado em 1 e o
//  seed determinístico de teste sempre produz result_crypto=9 — nunca
//  bate. Ver discussao na Sub-etapa 3D.
#[cfg(test)]
mod jackpot_tests {
    use super::*;

    #[test]
    fn jackpot_com_um_ganhador_nao_tem_residuo() {
        let (individual, residual) = split_evenly(10_000_000, 1).unwrap();
        assert_eq!(individual, 10_000_000);
        assert_eq!(residual, 0);
    }

    #[test]
    fn jackpot_com_varios_ganhadores_divide_igual() {
        let (individual, residual) = split_evenly(9_000_000, 3).unwrap();
        assert_eq!(individual, 3_000_000);
        assert_eq!(residual, 0);
    }

    #[test]
    fn jackpot_com_residuo_de_divisao() {
        let (individual, residual) = split_evenly(10_000_003, 3).unwrap();
        assert_eq!(individual, 3_333_334);
        assert_eq!(residual, 1);

        // Conservacao: pago a todos + residuo == pool original.
        assert_eq!(individual * 3 + residual, 10_000_003);
    }

    #[test]
    fn jackpot_dividir_por_zero_vencedores_e_erro() {
        assert!(split_evenly(1_000_000, 0).is_err());
    }
}
