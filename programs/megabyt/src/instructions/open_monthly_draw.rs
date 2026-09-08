use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Token, TokenAccount, Transfer};

use crate::constants::{DRAWN_NUMBERS, MAX_DRAWS_PER_MONTH};
use crate::error::MegabytError;
use crate::state::{Draw, GlobalState, MonthlyDraw, MonthlyState};

/// Abre um novo sorteio mensal cobrindo o intervalo [first_draw_id, last_draw_id]
/// de sorteios diarios.
///
/// Faz, tudo na mesma transacao (atomico por construcao — se qualquer passo
/// falhar, a transacao inteira reverte, inclusive a CPI de transferencia):
///   1. Valida o range e recalcula tickets_target a partir das Draws passadas
///      em remaining_accounts (D5 do plano — nunca confia num numero informado).
///   2. Tira o snapshot de global_state.monthly_pool (uma unica leitura).
///   3. Debita esse snapshot do contador (proximas contribuicoes vao pro
///      contador ja zerado, acumulando pro mes seguinte).
///   4. Faz o sweep fisico prize_vault -> monthly_vault no valor EXATO do
///      snapshot (mesma variavel usada no debito, nunca recalculada) — isso
///      e o que garante que o sweep nunca encosta no que esta pendente de
///      pagamento aos ganhadores diarios (ver prova na descricao da Etapa 3A).
///   5. Grava o MonthlyDraw com o split 75% jackpot / 25% cascata.
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, OpenMonthlyDraw<'info>>,
    first_draw_id: u64,
    last_draw_id: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    require!(first_draw_id > 0 && first_draw_id <= last_draw_id, MegabytError::InvalidMonthlyRange);

    let range_len_u64 = last_draw_id
        .checked_sub(first_draw_id)
        .ok_or(MegabytError::MathOverflow)?
        .checked_add(1)
        .ok_or(MegabytError::MathOverflow)?;
    require!(range_len_u64 <= MAX_DRAWS_PER_MONTH, MegabytError::InvalidMonthlyRange);
    let range_len = range_len_u64 as usize;

    // Impede gap ou sobreposicao com o mes anterior. No primeiro mes
    // (last_covered_draw_id == 0) aceita qualquer first_draw_id.
    let last_covered = ctx.accounts.monthly_state.last_covered_draw_id;
    if last_covered > 0 {
        require!(
            first_draw_id == last_covered.checked_add(1).ok_or(MegabytError::MathOverflow)?,
            MegabytError::InvalidMonthlyRange
        );
    }

    // -------------------------------------------------------------
    //  Recalcula tickets_target a partir das Draws do range (D5).
    //  Exige exatamente `range_len` contas, cada uma dentro do range e sem
    //  repeticao — por contagem (pombos), isso forca que o conjunto passado
    //  seja EXATAMENTE o range inteiro, nem a mais nem a menos.
    // -------------------------------------------------------------
    require!(ctx.remaining_accounts.len() == range_len, MegabytError::InvalidMonthlyRange);

    let mut seen = vec![false; range_len];
    let mut tickets_target: u64 = 0;

    for draw_info in ctx.remaining_accounts.iter() {
        let draw: Account<'info, Draw> = Account::try_from(draw_info)?;

        require!(
            draw.id >= first_draw_id && draw.id <= last_draw_id,
            MegabytError::InvalidMonthlyRange
        );
        // So aceita draws ja fechadas (vendas encerradas, tickets_sold final).
        // Nunca uma diaria em andamento (status 0).
        require!(draw.status >= 1, MegabytError::DrawNotReady);

        let idx = (draw.id - first_draw_id) as usize;
        require!(!seen[idx], MegabytError::InvalidMonthlyRange);
        seen[idx] = true;

        tickets_target = tickets_target
            .checked_add(draw.tickets_sold)
            .ok_or(MegabytError::MathOverflow)?;
    }

    require!(tickets_target > 0, MegabytError::NoTicketsSold);

    // -------------------------------------------------------------
    //  Snapshot + debito + sweep fisico — mesma variavel do inicio ao fim.
    // -------------------------------------------------------------
    let snapshot = ctx.accounts.global_state.monthly_pool;

    ctx.accounts.global_state.monthly_pool = ctx
        .accounts
        .global_state
        .monthly_pool
        .checked_sub(snapshot)
        .ok_or(MegabytError::MathOverflow)?;

    if snapshot > 0 {
        let signer_seeds: &[&[u8]] = &[b"vault-authority-v3", &[ctx.bumps.vault_authority]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.prize_vault.to_account_info(),
            to: ctx.accounts.monthly_vault.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();

        transfer(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, &[signer_seeds]),
            snapshot,
        )?;
    }

    // Split 75% jackpot / 25% cascata. cascade_pool = snapshot - jackpot_pool
    // (nao snapshot*25/100) pra nao perder residuo de arredondamento — a
    // soma dos dois bate exata com o snapshot sempre.
    let jackpot_pool = snapshot
        .checked_mul(75)
        .ok_or(MegabytError::MathOverflow)?
        .checked_div(100)
        .ok_or(MegabytError::MathOverflow)?;
    let cascade_pool = snapshot
        .checked_sub(jackpot_pool)
        .ok_or(MegabytError::MathOverflow)?;

    // -------------------------------------------------------------
    //  Grava o MonthlyDraw e atualiza o MonthlyState.
    // -------------------------------------------------------------
    let numbers_count = ctx.accounts.global_state.numbers_count;

    let next_id = ctx
        .accounts
        .monthly_state
        .current_monthly_id
        .checked_add(1)
        .ok_or(MegabytError::MathOverflow)?;

    let monthly_draw = &mut ctx.accounts.monthly_draw;
    monthly_draw.id = next_id;
    monthly_draw.first_draw_id = first_draw_id;
    monthly_draw.last_draw_id = last_draw_id;
    monthly_draw.tickets_target = tickets_target;
    monthly_draw.tickets_processed = 0;
    monthly_draw.tickets_paid = 0;
    monthly_draw.pool_snapshot = snapshot;
    monthly_draw.jackpot_pool = jackpot_pool;
    monthly_draw.cascade_pool = cascade_pool;
    monthly_draw.numbers_count = numbers_count;
    // O sorteio sempre tira DRAWN_NUMBERS (6) numeros, qualquer fase.
    monthly_draw.result_numbers = vec![0u8; DRAWN_NUMBERS as usize];
    monthly_draw.result_crypto = 0;
    monthly_draw.randomness_account = Pubkey::default();
    monthly_draw.commit_slot = 0;
    monthly_draw.random_seed = [0u8; 32];
    monthly_draw.randomness_requested = false;
    monthly_draw.randomness_fulfilled = false;
    monthly_draw.monthly_winner_counts = [0; 10];
    monthly_draw.monthly_prize_per_tier = [0; 10];
    monthly_draw.jackpot_hit = false;
    monthly_draw.jackpot_winner_count = 0;
    monthly_draw.rollover_to_next_month = 0;
    monthly_draw.status = 0;
    monthly_draw.bump = ctx.bumps.monthly_draw;

    let monthly_state = &mut ctx.accounts.monthly_state;
    monthly_state.current_monthly_id = next_id;
    monthly_state.last_covered_draw_id = last_draw_id;
    monthly_state.last_monthly_open_at = clock.unix_timestamp;

    msg!("MONTHLY DRAW OPENED");
    msg!("id={}", next_id);
    msg!("range=[{}, {}]", first_draw_id, last_draw_id);
    msg!("tickets_target={}", tickets_target);
    msg!("pool_snapshot={}", snapshot);
    msg!("jackpot_pool={}", jackpot_pool);
    msg!("cascade_pool={}", cascade_pool);

    Ok(())
}

#[derive(Accounts)]
#[instruction(first_draw_id: u64, last_draw_id: u64)]
pub struct OpenMonthlyDraw<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(
        mut,
        seeds = [b"monthly-state-v3"],
        bump = monthly_state.bump
    )]
    pub monthly_state: Box<Account<'info, MonthlyState>>,

    #[account(
        init,
        payer = admin,
        space = MonthlyDraw::len(),
        seeds = [
            b"monthly-draw-v3",
            (monthly_state.current_monthly_id + 1).to_le_bytes().as_ref()
        ],
        bump
    )]
    pub monthly_draw: Box<Account<'info, MonthlyDraw>>,

    #[account(
        mut,
        constraint = prize_vault.key() == global_state.prize_vault @ MegabytError::InvalidPrizeVault
    )]
    pub prize_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = monthly_vault.key() == monthly_state.monthly_vault @ MegabytError::InvalidMonthlyVault
    )]
    pub monthly_vault: Box<Account<'info, TokenAccount>>,

    /// CHECK: PDA usada somente como autoridade dos vaults SPL
    #[account(
        seeds = [b"vault-authority-v3"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
