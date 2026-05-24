use anchor_lang::prelude::*;
use crate::error::MegabytError;

/// Valida que os números do ticket atendem aos requisitos:
/// - Quantidade correta de números (conforme fase)
/// - Todos entre 1 e 72
/// - Sem duplicatas
pub fn validate_numbers(numbers: &[u8], expected_count: u8) -> Result<()> {
    require!(
        numbers.len() == expected_count as usize,
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
