// =========================================================
//  Helpers de pontuacao de ticket — SORTEIO DIARIO E MENSAL
//
//  As 2 funcoes abaixo sao copia BYTE A BYTE (so `fn` -> `pub fn`, sem
//  nenhuma mudanca de logica, tipo ou nome) das funcoes privadas que ja
//  existiam em instructions/settle_tickets.rs. Extraidas pra ca pra o
//  settle_monthly_tickets.rs poder reusar exatamente a mesma logica de
//  classificacao de tier sem duplicar codigo — um ticket tem que cair no
//  mesmo tier no mensal e no diario pra hits/crypto_hit identicos.
//
//  settle_tickets.rs NAO foi alterado: continua com suas proprias copias
//  privadas, identicas a estas. Zero risco pro caminho diario ja
//  testado/implantado.
// =========================================================

pub fn count_hits(ticket_numbers: &[u8], result_numbers: &[u8]) -> u8 {
    let mut hits = 0u8;

    for n in ticket_numbers.iter() {
        if result_numbers.contains(n) {
            hits += 1;
        }
    }

    hits
}

/// Classifica um ticket em um tier de premio baseado em acertos.
///
/// Formula dinamica baseada em deficit (quantos numeros o ticket errou):
///
///   deficit 0 → tier 0 (com crypto) / tier 1 (sem crypto)
///   deficit 1 → tier 2 / tier 3
///   deficit 2 → tier 4 / tier 5
///   deficit 3 → tier 6 / tier 7
///   deficit 4 → tier 8 / tier 9
///   deficit > 4 → tier 255 (sem premio)
///
/// Funciona para qualquer numbers_count (6..=25), adaptando automaticamente
/// as fases do sistema. Exemplo:
///   - Fase 1 (6 numeros): premia 6, 5, 4, 3, 2 acertos
///   - Fase 10 (25 numeros): premia 25, 24, 23, 22, 21 acertos
pub fn resolve_tier(hits: u8, crypto_hit: bool, numbers_count: u8) -> u8 {
    if hits > numbers_count {
        return 255;
    }
    let deficit = numbers_count - hits;
    if deficit > 4 {
        return 255;
    }
    let base = deficit * 2;
    if crypto_hit { base } else { base + 1 }
}

// =========================================================
//  Testes de paridade: garantem que este modulo produz resultado
//  IDENTICO as copias privadas de settle_tickets.rs. Mesmo raciocinio
//  dos testes de paridade em randomness.rs — se algum dia
//  settle_tickets.rs mudar essa logica sem espelhar aqui (ou vice-versa),
//  este teste trava a divergencia em vez de deixar o mensal classificar
//  tickets diferente do diario silenciosamente.
// =========================================================
#[cfg(test)]
mod parity_tests {
    use super::*;

    // Copias EXATAS das funcoes privadas de settle_tickets.rs, coladas
    // aqui so pro teste de paridade.
    mod settle_tickets_copy {
        pub fn count_hits(ticket_numbers: &[u8], result_numbers: &[u8]) -> u8 {
            let mut hits = 0u8;
            for n in ticket_numbers.iter() {
                if result_numbers.contains(n) {
                    hits += 1;
                }
            }
            hits
        }

        pub fn resolve_tier(hits: u8, crypto_hit: bool, numbers_count: u8) -> u8 {
            if hits > numbers_count {
                return 255;
            }
            let deficit = numbers_count - hits;
            if deficit > 4 {
                return 255;
            }
            let base = deficit * 2;
            if crypto_hit { base } else { base + 1 }
        }
    }

    #[test]
    fn count_hits_e_identico_ao_de_settle_tickets() {
        let cases: [(&[u8], &[u8]); 4] = [
            (&[1, 2, 3, 4, 5, 6], &[1, 2, 3, 4, 5, 6]),
            (&[1, 2, 3, 4, 5, 6], &[7, 8, 9, 10, 11, 12]),
            (&[10, 20, 30], &[10, 40, 30, 50]),
            (&[], &[1, 2, 3]),
        ];

        for (ticket_numbers, result_numbers) in cases {
            assert_eq!(
                count_hits(ticket_numbers, result_numbers),
                settle_tickets_copy::count_hits(ticket_numbers, result_numbers)
            );
        }
    }

    #[test]
    fn resolve_tier_e_identico_ao_de_settle_tickets() {
        for numbers_count in [6u8, 7, 10, 25] {
            for hits in 0..=numbers_count {
                for crypto_hit in [true, false] {
                    assert_eq!(
                        resolve_tier(hits, crypto_hit, numbers_count),
                        settle_tickets_copy::resolve_tier(hits, crypto_hit, numbers_count),
                        "numbers_count={} hits={} crypto_hit={}",
                        numbers_count, hits, crypto_hit
                    );
                }
            }
        }
    }
}
