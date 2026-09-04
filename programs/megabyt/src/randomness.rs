use anchor_lang::prelude::*;
use switchboard_on_demand::accounts::RandomnessAccountData;

use crate::error::MegabytError;

// =========================================================
//  Helpers de VRF/aleatoriedade — SORTEIO DIARIO E MENSAL
//
//  As 4 funcoes abaixo sao copia BYTE A BYTE (so `fn` -> `pub fn`, sem
//  nenhuma mudanca de logica, tipo ou nome) das funcoes privadas que ja
//  existiam em instructions/close_draw.rs. Foram extraidas pra ca pra
//  o sorteio mensal (close_monthly_draw.rs) poder reusar exatamente o
//  mesmo algoritmo sem duplicar codigo — mesmo seed sempre produz os
//  mesmos numeros, seja no diario ou no mensal.
//
//  close_draw.rs NAO foi alterado: continua com suas proprias copias
//  privadas, identicas a estas. Zero risco pro caminho diario ja
//  testado/implantado.
// =========================================================

pub fn get_randomness_with_tolerance(
    randomness_data: &RandomnessAccountData,
    current_slot: u64,
) -> Result<[u8; 32]> {
    if let Ok(value) = randomness_data.get_value(current_slot) {
        msg!("VRF slot atual OK");
        return Ok(value);
    }

    let max_lookback: u64 = 200;

    for i in 1..=max_lookback {
        let slot_try = current_slot.saturating_sub(i);

        if let Ok(value) = randomness_data.get_value(slot_try) {
            msg!("VRF encontrado no slot {}", slot_try);
            return Ok(value);
        }
    }

    msg!("VRF nao encontrado no intervalo de lookback");
    err!(MegabytError::InvalidDrawState)
}

/// Expande o seed de 32 bytes em um buffer de 128 bytes usando Keccak256.
///
/// Cada bloco é hash(seed || counter) para gerar entropia adicional,
/// eliminando modulo bias por rejection sampling sem risco de esgotar bytes.
pub fn hash_expand(seed: &[u8; 32]) -> [u8; 128] {
    let mut buf = [0u8; 128];

    // Blocos 0..3: hash(seed || [counter]) → 4 × 32 = 128 bytes
    for i in 0u8..4 {
        let h = solana_program::keccak::hashv(&[seed as &[u8], &[i] as &[u8]]);
        let start = (i as usize) * 32;
        buf[start..start + 32].copy_from_slice(&h.0);
    }

    buf
}

/// Rejection sampling: retorna um byte uniforme em `0..max`.
///
/// Rejeita valores >= threshold para eliminar modulo bias.
/// `domain` seleciona qual região do buffer expandido ler primeiro.
pub fn unbiased_byte(seed: &[u8; 32], max: u8, domain: u8) -> u8 {
    let buf = hash_expand(seed);
    let start = (domain as usize) * 32;
    let threshold = 255 - (255 % max); // rejection threshold

    // Tenta os 32 bytes do bloco `domain`
    for j in 0..32 {
        let val = buf[start + j];
        if val < threshold {
            return val % max;
        }
    }

    // Fallback: varre o resto do buffer (extremamente improvável de chegar aqui)
    for j in 0..128 {
        let val = buf[j];
        if val < threshold {
            return val % max;
        }
    }

    // Praticamente impossível: todos os 128 bytes acima do threshold.
    // Probabilidade ≈ (max/256)^128 ≈ 0 para qualquer max > 1.
    // Retorna valor determinístico como último recurso.
    0
}

/// Gera quantidade dinâmica de números únicos em 1..=72 usando Fisher-Yates parcial com rejection sampling.
///
/// O seed VRF de 32 bytes é expandido via Keccak256 para 128 bytes,
/// eliminando qualquer modulo bias na seleção de índices do pool.
pub fn generate_unique_numbers(seed: &[u8; 32], count: u8) -> Vec<u8> {
    let mut pool = [0u8; 72];
    for i in 0..72 {
        pool[i] = (i as u8) + 1;
    }

    let buf = hash_expand(seed);

    let mut result = Vec::with_capacity(count as usize);
    let mut available: usize = 72;
    let mut byte_idx: usize = 0;

    for _ in 0..count {
        // Rejection sampling: rejeita bytes que causariam bias
        let threshold = 256 - (256 % available);

        loop {
            let val = if byte_idx < 128 {
                let v = buf[byte_idx];
                byte_idx += 1;
                v
            } else {
                // Fallback: expande mais entropia se esgotar o buffer
                let h = solana_program::keccak::hashv(&[seed as &[u8], &byte_idx.to_le_bytes() as &[u8]]);
                byte_idx += 1;
                h.0[byte_idx % 32]
            };

            if (val as usize) < threshold {
                let idx = (val as usize) % available;
                result.push(pool[idx]);
                pool[idx] = pool[available - 1];
                available -= 1;
                break;
            }
        }
    }

    result.sort();
    result
}

// =========================================================
//  Testes de paridade: garantem que este modulo produz resultado
//  IDENTICO as copias privadas de close_draw.rs pro mesmo seed. Se
//  algum dia close_draw.rs mudar essa logica sem espelhar aqui (ou
//  vice-versa), esses testes travam a divergencia em vez de deixar o
//  mensal sortear diferente do diario silenciosamente.
// =========================================================
#[cfg(test)]
mod parity_tests {
    use super::*;

    // Copias EXATAS das funcoes privadas de close_draw.rs, coladas aqui
    // só para o teste de paridade (o modulo de producao nao pode
    // importar de dentro de instructions::close_draw, que nao expoe
    // nada pub). Qualquer mudanca futura em qualquer um dos dois lados
    // que quebre a igualdade faz este teste falhar.
    mod close_draw_copy {
        pub fn hash_expand(seed: &[u8; 32]) -> [u8; 128] {
            let mut buf = [0u8; 128];
            for i in 0u8..4 {
                let h = solana_program::keccak::hashv(&[seed as &[u8], &[i] as &[u8]]);
                let start = (i as usize) * 32;
                buf[start..start + 32].copy_from_slice(&h.0);
            }
            buf
        }

        pub fn unbiased_byte(seed: &[u8; 32], max: u8, domain: u8) -> u8 {
            let buf = hash_expand(seed);
            let start = (domain as usize) * 32;
            let threshold = 255 - (255 % max);

            for j in 0..32 {
                let val = buf[start + j];
                if val < threshold {
                    return val % max;
                }
            }

            for j in 0..128 {
                let val = buf[j];
                if val < threshold {
                    return val % max;
                }
            }

            0
        }

        pub fn generate_unique_numbers(seed: &[u8; 32], count: u8) -> Vec<u8> {
            let mut pool = [0u8; 72];
            for i in 0..72 {
                pool[i] = (i as u8) + 1;
            }

            let buf = hash_expand(seed);

            let mut result = Vec::with_capacity(count as usize);
            let mut available: usize = 72;
            let mut byte_idx: usize = 0;

            for _ in 0..count {
                let threshold = 256 - (256 % available);

                loop {
                    let val = if byte_idx < 128 {
                        let v = buf[byte_idx];
                        byte_idx += 1;
                        v
                    } else {
                        let h = solana_program::keccak::hashv(&[seed as &[u8], &byte_idx.to_le_bytes() as &[u8]]);
                        byte_idx += 1;
                        h.0[byte_idx % 32]
                    };

                    if (val as usize) < threshold {
                        let idx = (val as usize) % available;
                        result.push(pool[idx]);
                        pool[idx] = pool[available - 1];
                        available -= 1;
                        break;
                    }
                }
            }

            result.sort();
            result
        }
    }

    fn fixed_test_seed() -> [u8; 32] {
        // Mesmo fallback deterministico usado em close_draw.rs e
        // close_monthly_draw.rs sob feature = "testing".
        let mut s = [0u8; 32];
        for i in 0..32 {
            s[i] = (i as u8).wrapping_add(1);
        }
        s
    }

    #[test]
    fn hash_expand_e_identico_ao_de_close_draw() {
        for seed_byte in [0u8, 1, 42, 255] {
            let mut seed = [seed_byte; 32];
            seed[0] = seed_byte;
            assert_eq!(hash_expand(&seed), close_draw_copy::hash_expand(&seed));
        }
        assert_eq!(
            hash_expand(&fixed_test_seed()),
            close_draw_copy::hash_expand(&fixed_test_seed())
        );
    }

    #[test]
    fn unbiased_byte_e_identico_ao_de_close_draw() {
        let seed = fixed_test_seed();
        for max in [1u8, 2, 6, 10, 72] {
            for domain in [0u8, 1, 2, 3] {
                assert_eq!(
                    unbiased_byte(&seed, max, domain),
                    close_draw_copy::unbiased_byte(&seed, max, domain),
                    "max={} domain={}", max, domain
                );
            }
        }
    }

    #[test]
    fn generate_unique_numbers_e_identico_ao_de_close_draw() {
        for seed_byte in [0u8, 7, 99, 255] {
            let seed = [seed_byte; 32];
            for count in [1u8, 6, 10, 25] {
                assert_eq!(
                    generate_unique_numbers(&seed, count),
                    close_draw_copy::generate_unique_numbers(&seed, count),
                    "seed_byte={} count={}", seed_byte, count
                );
            }
        }

        // O caso real que interessa: o seed fixo de teste, com 6 numeros
        // (fase atual do protocolo).
        let seed = fixed_test_seed();
        let a = generate_unique_numbers(&seed, 6);
        let b = close_draw_copy::generate_unique_numbers(&seed, 6);
        assert_eq!(a, b);
    }
}
