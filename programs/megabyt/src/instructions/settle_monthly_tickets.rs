use anchor_lang::prelude::*;
use anchor_lang::system_program::{create_account, CreateAccount};

use crate::error::MegabytError;
use crate::scoring::{count_hits, resolve_tier};
use crate::state::{GlobalState, MonthlyClaim, MonthlyDraw, Ticket};

/// Repontua um lote de tickets contra o resultado VRF do sorteio mensal.
/// Molde: settle_tickets.rs (diario) + o padrao de lote via
/// remaining_accounts + a dedup via MonthlyClaim (D7 do plano).
///
/// Cada item do lote em `remaining_accounts` vem em PARES ordenados:
///     [ticket_1, claim_1, ticket_2, claim_2, ...]
///
/// LIMITE DE TAMANHO DE TRANSACAO: cada ticket ocupa 2 contas, entao o
/// teto pratico e' ~10-13 tickets por chamada numa transacao legada
/// (1232 bytes). Os scripts de operacao do mensal (settle + pay + producao)
/// precisam batcher respeitando isso — validado no teste
/// tests/monthly_finalize_payouts.ts (batch de 15 estourou, 10 passou).
///
/// `ticket_i` e' somente-leitura (nunca mutado aqui — o mensal nao toca em
/// Ticket, so cria a MonthlyClaim). `claim_i` e' a PDA
/// ["m-claim", monthly_draw, ticket_i] — ainda NAO existe on-chain; e'
/// criada manualmente aqui via CPI ao System Program (a macro
/// `#[account(init)]` do Anchor so funciona em contas nomeadas da struct,
/// nao em remaining_accounts).
///
/// =========================================================
///  DIFERENCA IMPORTANTE DE COMPORTAMENTO NO REENVIO — LEIA ANTES DE
///  ESCREVER O SCRIPT DE SETTLE MENSAL:
///
///  O settle_tickets.rs DIARIO, se um ticket do lote ja estiver
///  `settled`, da `continue` silenciosamente (pula so aquele ticket, o
///  resto do lote continua e a transacao inteira tem sucesso). Isso torna
///  reenviar um lote parcialmente sobreposto seguro por padrao.
///
///  Aqui NAO e' assim: se QUALQUER ticket do lote ja tiver uma
///  MonthlyClaim (foi processado antes, mesmo que em outro lote), a
///  criacao da conta falha com `MonthlyTicketAlreadyClaimed` e a
///  TRANSACAO INTEIRA reverte — nenhum dos outros tickets do mesmo lote
///  e' processado, mesmo que fossem todos novos.
///
///  Motivo: a dedup aqui e' "criar conta ou falhar" (equivalente ao
///  `#[account(init)]`), nao uma checagem de flag que da pra pular. Isso e'
///  intencional (D7 do plano), mas significa que um script que reenvia
///  lotes precisa montar cada lote SO com tickets que ainda nao tem
///  MonthlyClaim — nunca incluir um ticket ja processado "por garantia".
///  Ler `monthly_draw.tickets_processed` e' insuficiente pra saber quais
///  tickets especificos ja foram feitos; o script precisa rastrear isso
///  por fora (ex: tentar `getAccountInfo` da claim antes de incluir o
///  ticket no proximo lote) ou processar em ordem estritamente crescente
///  sem sobreposicao entre lotes.
///
///  EXCECAO — reenvio depois que o settlement JA TERMINOU 100%
///  (tickets_processed >= tickets_target): nesse caso o guard de "ja
///  completo" no topo do handler retorna Ok(()) ANTES de sequer entrar no
///  loop — reenviar o lote inteiro (mesmo com tickets ja reivindicados) e'
///  um no-op seguro, sem erro. So o reenvio NO MEIO do processamento (
///  settlement ainda incompleto) hard-falha por duplicata. As duas coisas
///  sao intencionais: a primeira e' idempotencia segura pro caso comum de
///  "resposta da tx se perdeu mas ela confirmou" (mesma licao do
///  pay_winners_batch, Etapa 1); a segunda e' o que protege contra um
///  script contar o mesmo ticket 2x enquanto ainda esta processando.
/// =========================================================
pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleMonthlyTickets<'info>>,
    batch_size: u32,
) -> Result<()> {
    let program_id = ctx.program_id;

    // Aceita status 1 (fechado, settlement em andamento) OU 2 (ja
    // completo) — mesma logica do settle_tickets.rs diario e da mesma
    // correcao de idempotencia que fizemos no pay_winners_batch (Etapa 1):
    // sem isso, reenviar a chamada que COMPLETA o settlement seria
    // rejeitado com DrawNotReady mesmo sem nada de errado.
    require!(
        ctx.accounts.monthly_draw.status == 1 || ctx.accounts.monthly_draw.status == 2,
        MegabytError::DrawNotReady
    );

    // Guard: settlement ja completo — nada a fazer.
    if ctx.accounts.monthly_draw.tickets_processed >= ctx.accounts.monthly_draw.tickets_target {
        msg!("SETTLE MONTHLY: ja completo. Nada a fazer.");
        ctx.accounts.monthly_draw.status = 2;
        return Ok(());
    }

    let monthly_draw_key = ctx.accounts.monthly_draw.key();
    let first_draw_id = ctx.accounts.monthly_draw.first_draw_id;
    let last_draw_id = ctx.accounts.monthly_draw.last_draw_id;
    let result_numbers = ctx.accounts.monthly_draw.result_numbers.clone();
    let result_crypto = ctx.accounts.monthly_draw.result_crypto;

    let remaining_capacity = ctx
        .accounts
        .monthly_draw
        .tickets_target
        .checked_sub(ctx.accounts.monthly_draw.tickets_processed)
        .ok_or(MegabytError::MathOverflow)?;

    let max_batch = core::cmp::max(batch_size, 1) as usize;

    let admin_ai = ctx.accounts.admin.to_account_info();
    let system_program_ai = ctx.accounts.system_program.to_account_info();
    let rent = Rent::get()?;
    let claim_space = MonthlyClaim::LEN;
    let claim_lamports = rent.minimum_balance(claim_space);

    let mut processed_now: u64 = 0;

    for pair in ctx.remaining_accounts.chunks_exact(2).take(max_batch) {
        if processed_now >= remaining_capacity {
            break;
        }

        let ticket_info = &pair[0];
        let claim_info = &pair[1];
        let ticket_key = ticket_info.key();

        let ticket: Account<'info, Ticket> = Account::try_from(ticket_info)?;

        // So aceita tickets de draws diarias dentro do range coberto por
        // este sorteio mensal. ticket.draw_id e' gravado pelo PROGRAMA em
        // buy_ticket/buy_ticket_with_referral/claim_bonus_ticket a partir
        // de uma conta draw_state com seeds auto-referenciais
        // (seeds=[b"draw-v3", draw_state.id], bump=draw_state.bump) — o
        // cliente nao consegue forjar esse valor, entao confiar nele sem
        // checar a pubkey da Draw tambem e' seguro.
        require!(
            ticket.draw_id >= first_draw_id && ticket.draw_id <= last_draw_id,
            MegabytError::InvalidTicket
        );

        // Deriva a PDA esperada da claim e confere que o cliente passou a
        // conta certa (nao um endereco arbitrario).
        let (expected_claim, claim_bump) = Pubkey::find_program_address(
            &[b"m-claim", monthly_draw_key.as_ref(), ticket_key.as_ref()],
            program_id,
        );
        require!(claim_info.key() == expected_claim, MegabytError::InvalidTicket);

        // Dedup: se a claim ja existe (ja tem lamports, ou seja, ja foi
        // criada antes), rejeita com um erro claro em vez de deixar o
        // CPI de create_account falhar com uma mensagem generica do
        // System Program. Ver nota grande no topo do arquivo sobre o
        // efeito disso no lote inteiro.
        require!(claim_info.lamports() == 0, MegabytError::MonthlyTicketAlreadyClaimed);

        let hits = count_hits(&ticket.numbers, &result_numbers);
        let crypto_hit = ticket.crypto == result_crypto || ticket.crypto_number == result_crypto;
        // Classificacao pelo tamanho do SORTEIO (result_numbers), nunca
        // pelo tamanho da cartela: cobrir os numeros sorteados = jackpot,
        // tenha a cartela 6 numeros ou 20. Mesma regra do diario
        // (settle_tickets.rs) — logica unica em scoring::resolve_tier.
        let tier = resolve_tier(hits, crypto_hit, result_numbers.len() as u8);

        let bump_seed = [claim_bump];
        let signer_seeds: &[&[u8]] = &[
            b"m-claim",
            monthly_draw_key.as_ref(),
            ticket_key.as_ref(),
            &bump_seed,
        ];

        create_account(
            CpiContext::new_with_signer(
                system_program_ai.clone(),
                CreateAccount {
                    from: admin_ai.clone(),
                    to: claim_info.clone(),
                },
                &[signer_seeds],
            ),
            claim_lamports,
            claim_space as u64,
            program_id,
        )?;

        let claim_data = MonthlyClaim {
            monthly_draw: monthly_draw_key,
            ticket: ticket_key,
            owner: ticket.owner,
            tier,
            paid: false,
            bump: claim_bump,
        };

        {
            let mut data = claim_info.try_borrow_mut_data()?;
            claim_data.try_serialize(&mut *data)?;
        }

        if tier <= 9 {
            let idx = tier as usize;
            ctx.accounts.monthly_draw.monthly_winner_counts[idx] = ctx
                .accounts
                .monthly_draw
                .monthly_winner_counts[idx]
                .checked_add(1)
                .ok_or(MegabytError::MathOverflow)?;
        }

        processed_now = processed_now.checked_add(1).ok_or(MegabytError::MathOverflow)?;
    }

    let monthly_draw = &mut ctx.accounts.monthly_draw;

    monthly_draw.tickets_processed = monthly_draw
        .tickets_processed
        .checked_add(processed_now)
        .ok_or(MegabytError::MathOverflow)?;

    if monthly_draw.tickets_processed > monthly_draw.tickets_target {
        monthly_draw.tickets_processed = monthly_draw.tickets_target;
    }

    if monthly_draw.tickets_processed >= monthly_draw.tickets_target {
        monthly_draw.status = 2;
    }

    msg!("MONTHLY SETTLEMENT");
    msg!("monthly_id={}", monthly_draw.id);
    msg!("processed_now={}", processed_now);
    msg!("tickets_processed={}", monthly_draw.tickets_processed);
    msg!("tickets_target={}", monthly_draw.tickets_target);
    msg!("status={}", monthly_draw.status);
    msg!("monthly_winner_counts={:?}", monthly_draw.monthly_winner_counts);

    Ok(())
}

#[derive(Accounts)]
pub struct SettleMonthlyTickets<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [b"global-state-v3"],
        bump,
        has_one = admin @ MegabytError::Unauthorized
    )]
    pub global_state: Box<Account<'info, GlobalState>>,

    #[account(
        mut,
        seeds = [b"monthly-draw-v3", &monthly_draw.id.to_le_bytes()],
        bump = monthly_draw.bump
    )]
    pub monthly_draw: Box<Account<'info, MonthlyDraw>>,

    pub system_program: Program<'info, System>,
}
