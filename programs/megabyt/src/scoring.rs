// =========================================================
//  Helpers de pontuacao de ticket — SORTEIO DIARIO E MENSAL
//
//  Fonte UNICA da logica de classificacao de tier. Tanto o caminho
//  diario (instructions/settle_tickets.rs) quanto o mensal
//  (instructions/settle_monthly_tickets.rs) importam `count_hits` e
//  `resolve_tier` daqui — um ticket com os mesmos acertos cai no MESMO
//  tier nos dois.
//
//  Historico: ate a Etapa 1 (correcao da formula de vitoria) cada arquivo
//  tinha sua propria copia privada dessas funcoes + um teste de paridade
//  garantindo que nao divergissem. Consolidado aqui numa fonte so.
// =========================================================

/// Conta quantos dos numeros SORTEADOS estao presentes na cartela do
/// ticket. Os numeros da cartela e do sorteio sao unicos (garantido por
/// `validate_numbers` e `generate_unique_numbers`), entao o resultado e'
/// exatamente `|cartela ∩ sorteio|` — independe do tamanho da cartela.
pub fn count_hits(ticket_numbers: &[u8], result_numbers: &[u8]) -> u8 {
    let mut hits = 0u8;

    for n in ticket_numbers.iter() {
        if result_numbers.contains(n) {
            hits += 1;
        }
    }

    hits
}

/// Classifica um ticket em um tier de premio.
///
/// A regra do jogo: o sorteio tira um numero fixo de bolas (`drawn_count`
/// — 6 no MegaByt). O ticket ganha conforme QUANTOS desses numeros
/// sorteados a cartela dele cobre. Uma cartela maior cobre mais facil —
/// isso e' vantagem, nao penalidade. O TAMANHO DA CARTELA NAO ENTRA AQUI.
///
///   deficit = drawn_count - hits   (numeros sorteados que a cartela nao cobriu)
///
///   deficit 0 → tier 0 (com crypto) / tier 1 (sem crypto)
///   deficit 1 → tier 2 / tier 3
///   deficit 2 → tier 4 / tier 5
///   deficit 3 → tier 6 / tier 7
///   deficit 4 → tier 8 / tier 9
///   deficit > 4 → tier 255 (sem premio)
///
/// A crypto conta a' parte: acertar a crypto deixa o tier par (base),
/// errar soma +1 (impar). Ex.: cobre os 6 + crypto = tier 0 (jackpot);
/// cobre os 6 sem crypto = tier 1.
pub fn resolve_tier(hits: u8, crypto_hit: bool, drawn_count: u8) -> u8 {
    // Guard de underflow: nao da' pra acertar mais numeros sorteados do
    // que foram sorteados. Inalcancavel na pratica (hits vem de count_hits
    // contra o mesmo result_numbers), mantido so por seguranca.
    if hits > drawn_count {
        return 255;
    }
    let deficit = drawn_count - hits;
    if deficit > 4 {
        return 255;
    }
    let base = deficit * 2;
    if crypto_hit { base } else { base + 1 }
}

// =========================================================
//  Testes da formula. `resolve_tier` e' funcao pura — testada direto aqui
//  porque o pipeline completo de settle (VRF + tickets) trava o resultado
//  de teste em [5,17,27,32,51,57] + crypto 9 e nao consegue exercitar
//  cenarios como "cartela grande cobrindo o sorteio inteiro".
// =========================================================
#[cfg(test)]
mod formula_tests {
    use super::*;

    /// Sorteio padrao do MegaByt: 6 numeros.
    const DRAWN: u8 = 6;

    #[test]
    fn cobre_os_6_com_crypto_e_jackpot() {
        assert_eq!(resolve_tier(6, true, DRAWN), 0);
    }

    #[test]
    fn cobre_os_6_sem_crypto_e_tier_1() {
        assert_eq!(resolve_tier(6, false, DRAWN), 1);
    }

    #[test]
    fn cartela_grande_que_cobre_os_6_ganha_jackpot() {
        // A PROVA DO BUG CORRIGIDO: cartela de 10 numeros contendo os 6
        // sorteados. count_hits conta a intersecao (6), e resolve_tier usa
        // o tamanho do SORTEIO (6), nao o da cartela (10).
        // Antes da Etapa 1, o mensal passava ticket.numbers.len() = 10 →
        // deficit = 10 - 6 = 4 → tier 8 (nao jackpot).
        let sorteio = [5u8, 17, 27, 32, 51, 57];
        let cartela = [5u8, 17, 27, 32, 51, 57, 1, 2, 3, 99];
        let hits = count_hits(&cartela, &sorteio);
        assert_eq!(hits, 6);
        assert_eq!(resolve_tier(hits, true, sorteio.len() as u8), 0);
        assert_eq!(resolve_tier(hits, false, sorteio.len() as u8), 1);
    }

    #[test]
    fn cartela_grande_cobrindo_5_de_6_e_tier_proporcional() {
        assert_eq!(resolve_tier(5, true, DRAWN), 2);
        assert_eq!(resolve_tier(5, false, DRAWN), 3);
    }

    #[test]
    fn cobre_1_de_6_nao_premia() {
        assert_eq!(resolve_tier(1, false, DRAWN), 255);
        assert_eq!(resolve_tier(1, true, DRAWN), 255);
    }

    #[test]
    fn cartela_de_8_cobrindo_4_e_tier_5() {
        let sorteio = [5u8, 17, 27, 32, 51, 57];
        let cartela = [5u8, 17, 27, 32, 9, 10, 11, 12]; // cobre 4 dos 6
        let hits = count_hits(&cartela, &sorteio);
        assert_eq!(hits, 4);
        assert_eq!(resolve_tier(hits, false, sorteio.len() as u8), 5);
        assert_eq!(resolve_tier(hits, true, sorteio.len() as u8), 4);
    }

    #[test]
    fn count_hits_conta_intersecao_com_cartela_maior_que_o_sorteio() {
        assert_eq!(
            count_hits(&[5, 17, 27, 32, 51, 57, 1, 2, 3, 99], &[5, 17, 27, 32, 51, 57]),
            6
        );
    }

    #[test]
    fn count_hits_zero_quando_cartela_nao_cobre_nada() {
        assert_eq!(count_hits(&[1, 2, 3, 4, 5, 6], &[7, 8, 9, 10, 11, 12]), 0);
    }

    #[test]
    fn tabela_completa_de_deficit_com_e_sem_crypto() {
        // deficit 0..=4 → tiers 0..=9 ; deficit > 4 → 255
        for deficit in 0u8..=4 {
            let hits = DRAWN - deficit;
            assert_eq!(resolve_tier(hits, true, DRAWN), deficit * 2);
            assert_eq!(resolve_tier(hits, false, DRAWN), deficit * 2 + 1);
        }
        assert_eq!(resolve_tier(1, true, DRAWN), 255);
        assert_eq!(resolve_tier(0, false, DRAWN), 255);
    }
}
