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

/// Valida que o crypto está no range válido (1-10)
pub fn validate_crypto(crypto: u8, max_cryptos: u8) -> Result<()> {
    require!(crypto >= 1 && crypto <= max_cryptos, MegabytError::InvalidCryptoNumber);
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
}
