use anchor_lang::prelude::*;
use crate::constants::DRAWN_NUMBERS;
use crate::error::MegabytError;

/// Valida que os números do ticket atendem aos requisitos:
/// - Etapa 3: cartela de TAMANHO VARIÁVEL. `max_count` (o antigo
///   `numbers_count` da fase) agora é um TETO, não mais um valor exato —
///   a cartela pode ter de DRAWN_NUMBERS (6, o mínimo pra ter chance de
///   cobrir o sorteio inteiro) até `max_count` números.
/// - Todos entre 1 e 72
/// - Sem duplicatas
pub fn validate_numbers(numbers: &[u8], max_count: u8) -> Result<()> {
    require!(
        numbers.len() >= DRAWN_NUMBERS as usize && numbers.len() <= max_count as usize,
        MegabytError::InvalidNumbersCount
    );

    for n in numbers.iter() {
        require!(*n >= 1 && *n <= 72, MegabytError::InvalidNumber);
    }

    for i in 0..numbers.len() {
        for j in (i + 1)..numbers.len() {
            require!(numbers[i] != numbers[j], MegabytError::DuplicateNumber);
        }
    }

    Ok(())
}

/// Valida as cryptos escolhidas na cartela (Etapa 4, sub-etapa 4b):
/// - Quantidade entre 1 e `max_picks` (`global_state.max_crypto_picks`,
///   teto de QUANTAS cryptos a cartela pode escolher)
/// - Todos os IDs dentro do pool disponível (1..=`max_ids`,
///   `global_state.crypto_count` — não muda de significado)
/// - Sem duplicata
pub fn validate_cryptos(cryptos: &[u8], max_ids: u8, max_picks: u8) -> Result<()> {
    require!(
        !cryptos.is_empty() && cryptos.len() <= max_picks as usize,
        MegabytError::InvalidCryptoCount
    );

    for c in cryptos.iter() {
        require!(*c >= 1 && *c <= max_ids, MegabytError::InvalidCryptoNumber);
    }

    for i in 0..cryptos.len() {
        for j in (i + 1)..cryptos.len() {
            require!(cryptos[i] != cryptos[j], MegabytError::DuplicateCrypto);
        }
    }

    Ok(())
}

// =========================================================
//  Testes da Etapa 3 — cartela de tamanho variável.
// =========================================================
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aceita_cartelas_de_6_a_10_com_teto_10() {
        for len in [6u8, 7, 8, 10] {
            let numbers: Vec<u8> = (1..=len).collect();
            assert!(validate_numbers(&numbers, 10).is_ok(), "len={} deveria ser aceito", len);
        }
    }

    #[test]
    fn rejeita_cartela_de_5_menor_que_drawn_numbers() {
        let numbers: Vec<u8> = (1..=5).collect();
        assert!(validate_numbers(&numbers, 10).is_err(), "5 < DRAWN_NUMBERS(6) deveria falhar mesmo com teto folgado");
    }

    #[test]
    fn rejeita_cartela_de_11_acima_do_teto_10() {
        let numbers: Vec<u8> = (1..=11).collect();
        assert!(validate_numbers(&numbers, 10).is_err());
    }

    #[test]
    fn rejeita_numero_fora_do_range_1_72() {
        let mut acima: Vec<u8> = (1..=6).collect();
        acima[0] = 73;
        assert!(validate_numbers(&acima, 25).is_err());

        let mut abaixo: Vec<u8> = (1..=6).collect();
        abaixo[0] = 0;
        assert!(validate_numbers(&abaixo, 25).is_err());
    }

    #[test]
    fn rejeita_duplicata() {
        let mut numbers: Vec<u8> = (1..=6).collect();
        numbers[5] = numbers[0];
        assert!(validate_numbers(&numbers, 25).is_err());
    }

    #[test]
    fn aceita_teto_maximo_25() {
        let numbers: Vec<u8> = (1..=25).collect();
        assert!(validate_numbers(&numbers, 25).is_ok());
    }

    // ---- validate_cryptos (Etapa 4, sub-etapa 4b) ----

    #[test]
    fn aceita_1_crypto_com_teto_1() {
        assert!(validate_cryptos(&[7], 10, 1).is_ok());
    }

    #[test]
    fn aceita_2_ou_mais_cryptos_com_teto_maior() {
        assert!(validate_cryptos(&[3, 7], 10, 3).is_ok());
        assert!(validate_cryptos(&[1, 2, 3], 10, 3).is_ok());
    }

    #[test]
    fn rejeita_lista_vazia() {
        assert!(validate_cryptos(&[], 10, 3).is_err());
    }

    #[test]
    fn rejeita_crypto_duplicada() {
        assert!(validate_cryptos(&[7, 7], 10, 3).is_err());
    }

    #[test]
    fn rejeita_crypto_fora_do_range_1_a_max_ids() {
        assert!(validate_cryptos(&[11], 10, 3).is_err(), "11 > crypto_count(10)");
        assert!(validate_cryptos(&[0], 10, 3).is_err(), "0 < 1");
    }

    #[test]
    fn rejeita_mais_cryptos_que_o_teto_max_picks() {
        assert!(validate_cryptos(&[1, 2, 3], 10, 2).is_err(), "3 escolhidas > teto de 2");
    }
}
