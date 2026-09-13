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
//
//  Etapa 4 (sub-etapa 4a): `tier_distribution` calcula, sem enumerar
//  nenhuma aposta, quantas das C(n,6) x k apostas "6 numeros + 1 crypto"
//  escondidas numa cartela caem em cada tier. Ainda NAO esta conectada
//  em nenhuma instrucao (settle continua usando so' `resolve_tier`, 1
//  tier por ticket) — isso e' fiacao pra sub-etapa 4d. Ver
//  PROGRESSO_MENSAL.md §3-C/§3-D pro plano completo e a matematica.
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

/// Calcula C(n, k) — de quantas formas da' pra escolher `k` itens dentre
/// um grupo de `n`, sem repetir e sem importar a ordem. Usa a formula
/// multiplicativa (`resultado = resultado * (n-i) / (i+1)`, pra
/// i=0..k), que e' sempre exata em cada passo (nunca gera fracao) — evita
/// calcular fatoriais gigantes (25! nem cabe em u128).
///
/// Dominio usado pela Etapa 4: `n` ate 25 (`Ticket::MAX_NUMBERS`), `k`
/// ate 6 (`DRAWN_NUMBERS`) — o maior valor possivel e' C(25,6)=177.100,
/// muito abaixo do teto de `u64`. Sem risco de overflow nesse dominio.
pub fn binomial(n: u8, k: u8) -> u64 {
    if k > n {
        return 0;
    }
    let k = k.min(n - k); // C(n,k) == C(n,n-k) — menos iteracoes
    let mut result: u128 = 1;
    for i in 0..k as u128 {
        result = result * (n as u128 - i) / (i + 1);
    }
    result as u64
}

/// Etapa 4 (sub-etapa 4c) — preco combinatorio da cartela: C(n,6) x k
/// apostas, cada uma valendo `base` (o preco de 1 aposta simples,
/// `global_state.ticket_price`). Reaproveita `binomial` da sub-etapa 4a.
///
/// Retorna `None` se a multiplicacao estourar `u64` — no dominio pratico
/// (n ate 25, k ate 10) isso so' aconteceria com um `base` absurdamente
/// grande (fora de qualquer cenario real), mas o guard fica por
/// seguranca (quem chama decide o erro, este modulo continua livre de
/// dependencia do anchor_lang).
pub fn combinatorial_price(n: u8, k: u8, base: u64, drawn_count: u8) -> Option<u64> {
    binomial(n, drawn_count)
        .checked_mul(k as u64)?
        .checked_mul(base)
}

/// Etapa 4 (sub-etapa 4a) — distribuicao de apostas por tier, SEM listar
/// nenhuma aposta.
///
/// A regra nova do jogo: uma cartela de `n` numeros e `k` cryptos vale
/// C(n,6) x k apostas simples de "6 numeros + 1 crypto" (ver
/// PROGRESSO_MENSAL.md §3-C). Cada aposta e' avaliada separadamente
/// contra o sorteio e o premio final do ticket e' a soma de todas.
///
/// Raciocinio ("grupos"): dos `n` numeros da cartela, `m` sao
/// "premiados" (sairam no sorteio — `m` vem de `count_hits`, sempre
/// 0..=6, nao importa o tamanho da cartela) e `n-m` sao "nao-premiados".
/// Uma aposta de 6 numeros com exatamente `j` premiados existe em
/// `C(m,j) x C(n-m,6-j)` formas (identidade de Vandermonde: somando pra
/// j=0..=6 da' exatamente C(n,6), sem listar nada — ver §3-D).
///
/// Cada uma dessas apostas-de-numeros combina com QUALQUER uma das `k`
/// cryptos escolhidas. `crypto_win` diz se a crypto sorteada esta' entre
/// as `k` (nao importa qual): se sim, exatamente 1 das k combinacoes
/// acerta a crypto (tier par, calculado via `resolve_tier`) e as outras
/// k-1 erram (tier impar); se nao, todas as k erram.
///
/// Retorna quantas apostas caem em cada um dos 10 tiers pagantes (indice
/// = tier). Apostas com deficit > 4 (menos de 2 dos 6 sorteados) nao
/// pagam nada e nao entram aqui.
pub fn tier_distribution(m: u8, n: u8, k: u8, crypto_win: bool, drawn_count: u8) -> [u64; 10] {
    let mut dist = [0u64; 10];
    if m > n || k == 0 || m > drawn_count {
        return dist;
    }

    let non_hits = n - m;
    for j in 0..=drawn_count.min(m) {
        let need_non_hits = drawn_count - j;
        let numbers_combos = binomial(m, j) * binomial(non_hits, need_non_hits);
        if numbers_combos == 0 {
            continue;
        }

        if crypto_win {
            let tier_hit = resolve_tier(j, true, drawn_count);
            if tier_hit <= 9 {
                dist[tier_hit as usize] += numbers_combos; // exatamente 1 das k acerta a crypto
            }
            let tier_miss = resolve_tier(j, false, drawn_count);
            if tier_miss <= 9 {
                dist[tier_miss as usize] += numbers_combos * (k as u64 - 1); // as outras k-1 erram
            }
        } else {
            let tier_miss = resolve_tier(j, false, drawn_count);
            if tier_miss <= 9 {
                dist[tier_miss as usize] += numbers_combos * k as u64; // nenhuma das k acerta
            }
        }
    }

    dist
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

// =========================================================
//  Testes da Etapa 4 (sub-etapa 4a) — distribuicao de combinacoes por
//  tier. `binomial` e `tier_distribution` sao funcoes puras — testadas
//  direto aqui, sem precisar de VRF/settle/conta nenhuma.
// =========================================================
#[cfg(test)]
mod tier_distribution_tests {
    use super::*;

    /// Sorteio padrao do MegaByt: 6 numeros.
    const DRAWN: u8 = 6;

    // ---- binomial() ----

    #[test]
    fn binomial_casos_base() {
        assert_eq!(binomial(0, 0), 1);
        assert_eq!(binomial(5, 0), 1);
        assert_eq!(binomial(5, 5), 1);
        assert_eq!(binomial(5, 6), 0); // k > n
    }

    #[test]
    fn binomial_valores_conhecidos() {
        assert_eq!(binomial(8, 6), 28);
        assert_eq!(binomial(10, 3), 120);
        assert_eq!(binomial(7, 6), 7);
        // O numero que motivou toda a analise de escala: teto da fase 10.
        assert_eq!(binomial(25, 6), 177_100);
    }

    #[test]
    fn binomial_e_simetrico() {
        for n in 0u8..=25 {
            for k in 0u8..=n {
                assert_eq!(binomial(n, k), binomial(n, n - k), "n={} k={}", n, k);
            }
        }
    }

    // ---- tier_distribution(): exemplo concreto da conversa (cartela de 7, acerta 5) ----

    #[test]
    fn cartela_de_7_acertando_5_da_2_apostas_de_5_acertos_e_5_de_4_acertos() {
        // n=7, m=5: grupo premiado tem 5, grupo nao-premiado tem 2.
        // Raciocinio "deixar 1 de fora": deixar de fora 1 dos 2
        // nao-premiados (2 formas) da' aposta de 5 acertos; deixar de
        // fora 1 dos 5 premiados (5 formas) da' aposta de 4 acertos.
        let dist_com_crypto = tier_distribution(5, 7, 1, true, DRAWN);
        // deficit=1 (5 acertos) com crypto -> tier 2; deficit=2 (4 acertos) com crypto -> tier 4
        assert_eq!(dist_com_crypto[2], 2, "5 acertos + crypto = tier 2");
        assert_eq!(dist_com_crypto[4], 5, "4 acertos + crypto = tier 4");
        let soma: u64 = dist_com_crypto.iter().sum();
        assert_eq!(soma, 7, "total de apostas pagantes = C(7,6) = 7 (k=1, nenhuma some)");

        let dist_sem_crypto = tier_distribution(5, 7, 1, false, DRAWN);
        assert_eq!(dist_sem_crypto[3], 2, "5 acertos sem crypto = tier 3");
        assert_eq!(dist_sem_crypto[5], 5, "4 acertos sem crypto = tier 5");
    }

    // ---- k=1 e n=DRAWN colapsa exatamente pro modelo das Etapas 1-3 ----

    #[test]
    fn cartela_do_tamanho_minimo_com_k1_colapsa_pro_resolve_tier_de_sempre() {
        // n == DRAWN(6): so' existe 1 aposta de numeros possivel (a
        // cartela inteira). Com k=1, tier_distribution tem que dar
        // EXATAMENTE o mesmo resultado que resolve_tier ja dava desde a
        // Etapa 1 — prova que a formula nova nao quebrou o caso antigo.
        for hits in 0u8..=DRAWN {
            for crypto_hit in [true, false] {
                let dist = tier_distribution(hits, DRAWN, 1, crypto_hit, DRAWN);
                let tier_esperado = resolve_tier(hits, crypto_hit, DRAWN);
                let soma: u64 = dist.iter().sum();
                if tier_esperado <= 9 {
                    assert_eq!(soma, 1, "hits={} crypto={}", hits, crypto_hit);
                    assert_eq!(dist[tier_esperado as usize], 1, "hits={} crypto={}", hits, crypto_hit);
                } else {
                    assert_eq!(soma, 0, "hits={} crypto={} deveria ser sem premio", hits, crypto_hit);
                }
            }
        }
    }

    // ---- bonus E2E da Etapa 3, revisitado sob a Etapa 4 ----

    #[test]
    fn cartela_de_8_cobrindo_os_6_sorteados_gera_28_apostas_em_3_tiers() {
        // O mesmo cenario do teste bonus E2E da Etapa 3
        // (tests/set_numbers_count.ts): cartela de 8 = os 6 sorteados +
        // 2 extras. Na Etapa 1-3 isso dava "tier 0 (jackpot)" inteiro.
        // Na Etapa 4, vira uma DISTRIBUICAO: a cartela ainda ganha o
        // jackpot (1 das 28 apostas), mas as outras 27 caem em tiers
        // menores.
        let dist = tier_distribution(6, 8, 1, true, DRAWN);
        assert_eq!(dist[0], 1, "1 aposta com os 6 numeros = jackpot");
        assert_eq!(dist[2], 12, "12 apostas com 5 dos 6 numeros");
        assert_eq!(dist[4], 15, "15 apostas com 4 dos 6 numeros");
        let soma: u64 = dist.iter().sum();
        assert_eq!(soma, 28, "C(8,6) = 28 apostas no total");
    }

    // ---- multi-crypto: k>1 espalha a mesma aposta-de-numeros entre "1 acerta" e "k-1 erram" ----

    #[test]
    fn multi_crypto_divide_certo_entre_acertou_e_errou() {
        // n=6 (so' 1 aposta de numeros possivel), hits=6 (deficit 0),
        // k=3 cryptos escolhidas.
        let com_acerto = tier_distribution(6, 6, 3, true, DRAWN);
        assert_eq!(com_acerto[0], 1, "exatamente 1 das 3 cryptos acerta -> tier 0 (jackpot)");
        assert_eq!(com_acerto[1], 2, "as outras 2 erram -> tier 1");
        assert_eq!(com_acerto.iter().sum::<u64>(), 3, "total = k = 3 apostas");

        let sem_acerto = tier_distribution(6, 6, 3, false, DRAWN);
        assert_eq!(sem_acerto[0], 0, "nenhuma das 3 acerta -> tier 0 fica vazio");
        assert_eq!(sem_acerto[1], 3, "todas as 3 erram -> tier 1");
        assert_eq!(sem_acerto.iter().sum::<u64>(), 3, "total = k = 3 apostas");
    }

    // ---- prova de conservacao por forca bruta: gera TODAS as C(n,6)
    // combinacoes de indices e conta na unha quantas tem j premiados,
    // compara com a formula dos grupos. Prova que o raciocinio bate com
    // a realidade, nao so' consigo mesmo. ----

    fn combinations(n: usize, k: usize) -> Vec<Vec<usize>> {
        fn recurse(start: usize, n: usize, k: usize, current: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
            if current.len() == k {
                out.push(current.clone());
                return;
            }
            for i in start..n {
                current.push(i);
                recurse(i + 1, n, k, current, out);
                current.pop();
            }
        }
        let mut out = Vec::new();
        let mut current = Vec::with_capacity(k);
        recurse(0, n, k, &mut current, &mut out);
        out
    }

    #[test]
    fn forca_bruta_confirma_a_formula_dos_grupos_pra_cartelas_pequenas() {
        // Ate n=12 (C(12,6)=924) e' barato enumerar de verdade.
        for n in 6usize..=12 {
            let combos = combinations(n, DRAWN as usize);
            for m in 0u8..=DRAWN.min(n as u8) {
                // indices 0..m sao "premiados", m..n sao "nao-premiados"
                // (rotulo arbitrario, so' pra contar).
                let mut brute = [0u64; 7]; // brute[j] = quantas combos tem exatamente j premiados
                for combo in &combos {
                    let j = combo.iter().filter(|&&idx| idx < m as usize).count();
                    brute[j] += 1;
                }
                for j in 0u8..=DRAWN {
                    let non_hits = n as u8 - m;
                    let need_non_hits = DRAWN - j;
                    let formula = binomial(m, j) * binomial(non_hits, need_non_hits);
                    assert_eq!(
                        brute[j as usize], formula,
                        "n={} m={} j={}: forca bruta={} formula={}",
                        n, m, j, brute[j as usize], formula
                    );
                }
            }
        }
    }

    // ---- prova de conservacao geral: soma dos tiers pagantes + apostas
    // sem premio = C(n,6) x k, pra todo o dominio pratico (n ate
    // MAX_NUMBERS=25, k ate ALL_CRYPTOS_COUNT=10). ----

    /// Quantas apostas completas (numeros+crypto) NAO pagam nada —
    /// implementacao independente de `tier_distribution`, so' pra provar
    /// conservacao nos testes (nao e' usada em producao).
    fn unpaid_combinations(m: u8, n: u8, k: u8, drawn_count: u8) -> u64 {
        if m > n || k == 0 || m > drawn_count {
            return 0;
        }
        let non_hits = n - m;
        let mut unpaid = 0u64;
        for j in 0..=drawn_count.min(m) {
            // deficit > 4 da' 255 independente de crypto_hit (o guard em
            // resolve_tier roda antes do branch da crypto) — checar com
            // `true` basta.
            if resolve_tier(j, true, drawn_count) > 9 {
                let need_non_hits = drawn_count - j;
                unpaid += binomial(m, j) * binomial(non_hits, need_non_hits) * k as u64;
            }
        }
        unpaid
    }

    #[test]
    fn conservacao_soma_c_n_6_vezes_k_no_dominio_pratico_inteiro() {
        for n in 6u8..=25 {
            for m in 0u8..=DRAWN.min(n) {
                for k in [1u8, 2, 5, 10] {
                    let esperado = binomial(n, DRAWN) * k as u64;

                    let dist_com = tier_distribution(m, n, k, true, DRAWN);
                    let soma_com: u64 = dist_com.iter().sum::<u64>() + unpaid_combinations(m, n, k, DRAWN);
                    assert_eq!(soma_com, esperado, "n={} m={} k={} crypto_win=true", n, m, k);

                    let dist_sem = tier_distribution(m, n, k, false, DRAWN);
                    let soma_sem: u64 = dist_sem.iter().sum::<u64>() + unpaid_combinations(m, n, k, DRAWN);
                    assert_eq!(soma_sem, esperado, "n={} m={} k={} crypto_win=false", n, m, k);
                }
            }
        }
    }

    // ---- combinatorial_price() (Etapa 4, sub-etapa 4c) ----

    #[test]
    fn preco_da_tabela_da_spec() {
        const BASE: u64 = 1_000_000; // 1 USDT (6 decimais), so' pra ter um numero redondo

        assert_eq!(combinatorial_price(6, 1, BASE, DRAWN), Some(1 * BASE), "6 numeros + 1 crypto = 1x base");
        assert_eq!(combinatorial_price(6, 2, BASE, DRAWN), Some(2 * BASE), "6 numeros + 2 cryptos = 2x base");
        assert_eq!(combinatorial_price(7, 1, BASE, DRAWN), Some(7 * BASE), "7 numeros + 1 crypto = 7x base");
        assert_eq!(combinatorial_price(8, 1, BASE, DRAWN), Some(28 * BASE), "8 numeros + 1 crypto = 28x base");
        assert_eq!(combinatorial_price(8, 2, BASE, DRAWN), Some(56 * BASE), "8 numeros + 2 cryptos = 56x base");
    }

    #[test]
    fn preco_no_teto_absoluto_nao_estoura_com_base_realista() {
        // C(25,6) x 10 cryptos x base generosa ($1000 USDT, 6 decimais) —
        // o pior caso pratico do dominio do jogo.
        let preco = combinatorial_price(25, 10, 1_000_000_000, DRAWN);
        assert_eq!(preco, Some(177_100u64 * 10 * 1_000_000_000));
    }

    #[test]
    fn preco_retorna_none_se_a_base_for_absurda_o_bastante_pra_estourar_u64() {
        // Nao e' um cenario real (base seria bilhoes de USDT por aposta),
        // mas o guard de overflow tem que funcionar mesmo assim.
        let preco = combinatorial_price(25, 10, u64::MAX, DRAWN);
        assert_eq!(preco, None);
    }
}
