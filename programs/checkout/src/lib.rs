use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY");

pub const MAX_LIFETIME_SECONDS: i64 = 24 * 60 * 60;
pub const MINT_DECIMALS: u8 = 6;

#[program]
pub mod checkout {
    use super::*;

    /// A deployment authority fixes the sole supported legacy SPL mint once.
    /// There is deliberately no update or close instruction for this config.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        ctx.accounts.config.set_inner(Config {
            authority: ctx.accounts.authority.key(),
            mint: ctx.accounts.mint.key(),
            bump: ctx.bumps.config,
        });
        Ok(())
    }

    pub fn fund(ctx: Context<Fund>, job_id: [u8; 32], amount: u64, expires_at: i64) -> Result<()> {
        validate_quote(amount, expires_at, Clock::get()?.unix_timestamp)?;

        ctx.accounts.job.set_inner(Job {
            buyer: ctx.accounts.buyer.key(),
            merchant: ctx.accounts.merchant.key(),
            mint: ctx.accounts.mint.key(),
            job_id,
            amount,
            expires_at,
            state: JobState::Funded,
            bump: ctx.bumps.job,
            vault_bump: ctx.bumps.vault,
        });

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.buyer_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )
        // Account creation, all bound fields and the token transfer roll back
        // together on error. `init`, never `init_if_needed`, prevents replay.
    }

    pub fn approve(ctx: Context<Approve>) -> Result<()> {
        validate_approval(&ctx.accounts.job, Clock::get()?.unix_timestamp)?;
        let job = &ctx.accounts.job;
        let bump = [job.bump];
        let signer_seeds: &[&[u8]] = &[b"job", job.buyer.as_ref(), job.job_id.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.merchant_token.to_account_info(),
                    authority: job.to_account_info(),
                },
                &[signer_seeds],
            ),
            job.amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.job.state = JobState::Released;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        validate_refund(&ctx.accounts.job, Clock::get()?.unix_timestamp)?;
        let job = &ctx.accounts.job;
        let bump = [job.bump];
        let signer_seeds: &[&[u8]] = &[b"job", job.buyer.as_ref(), job.job_id.as_ref(), &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.buyer_token.to_account_info(),
                    authority: job.to_account_info(),
                },
                &[signer_seeds],
            ),
            job.amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.job.state = JobState::Refunded;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = mint.decimals == MINT_DECIMALS @ CheckoutError::InvalidMintDecimals)]
    pub mint: Account<'info, Mint>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key()) @ CheckoutError::InvalidProgramData
    )]
    pub program: Program<'info, crate::program::Checkout>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ CheckoutError::UnauthorizedInitializer
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(job_id: [u8; 32])]
pub struct Fund<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Only the public key is bound; its canonical legacy-token ATA
    /// below must exist and have this key as its token authority.
    pub merchant: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(address = config.mint @ CheckoutError::WrongMint)]
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer,
        address = get_associated_token_address_with_program_id(&buyer.key(), &mint.key(), &token_program.key()) @ CheckoutError::WrongDestination
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    #[account(
        token::mint = mint,
        token::authority = merchant,
        address = get_associated_token_address_with_program_id(&merchant.key(), &mint.key(), &token_program.key()) @ CheckoutError::WrongDestination
    )]
    pub merchant_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = buyer,
        space = 8 + Job::INIT_SPACE,
        seeds = [b"job", buyer.key().as_ref(), job_id.as_ref()],
        bump
    )]
    pub job: Account<'info, Job>,
    #[account(
        init,
        payer = buyer,
        seeds = [b"vault", job.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = job,
        token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Approve<'info> {
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"job", job.buyer.as_ref(), job.job_id.as_ref()],
        bump = job.bump,
        has_one = buyer @ CheckoutError::UnauthorizedBuyer,
        has_one = mint @ CheckoutError::WrongMint
    )]
    pub job: Account<'info, Job>,
    #[account(
        mut,
        seeds = [b"vault", job.key().as_ref()],
        bump = job.vault_bump,
        token::mint = mint,
        token::authority = job,
        constraint = vault.delegate.is_none() @ CheckoutError::UnsafeVault,
        constraint = vault.close_authority.is_none() @ CheckoutError::UnsafeVault
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        constraint = merchant_token.owner == job.merchant @ CheckoutError::WrongDestination,
        address = get_associated_token_address_with_program_id(&job.merchant, &mint.key(), &token_program.key()) @ CheckoutError::WrongDestination
    )]
    pub merchant_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"job", job.buyer.as_ref(), job.job_id.as_ref()],
        bump = job.bump,
        has_one = buyer @ CheckoutError::UnauthorizedBuyer,
        has_one = mint @ CheckoutError::WrongMint
    )]
    pub job: Account<'info, Job>,
    #[account(
        mut,
        seeds = [b"vault", job.key().as_ref()],
        bump = job.vault_bump,
        token::mint = mint,
        token::authority = job,
        constraint = vault.delegate.is_none() @ CheckoutError::UnsafeVault,
        constraint = vault.close_authority.is_none() @ CheckoutError::UnsafeVault
    )]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = buyer,
        address = get_associated_token_address_with_program_id(&buyer.key(), &mint.key(), &token_program.key()) @ CheckoutError::WrongDestination
    )]
    pub buyer_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
}

/// Never closed: terminal records permanently consume a buyer/job-ID pair.
#[account]
#[derive(InitSpace)]
pub struct Job {
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub job_id: [u8; 32],
    pub amount: u64,
    pub expires_at: i64,
    pub state: JobState,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum JobState {
    Funded,
    Released,
    Refunded,
}

fn validate_quote(amount: u64, expires_at: i64, now: i64) -> Result<()> {
    require!(amount > 0, CheckoutError::InvalidAmount);
    let lifetime = expires_at
        .checked_sub(now)
        .ok_or(CheckoutError::InvalidDeadline)?;
    require!(
        lifetime > 0 && lifetime <= MAX_LIFETIME_SECONDS,
        CheckoutError::InvalidDeadline
    );
    Ok(())
}

fn validate_approval(job: &Job, now: i64) -> Result<()> {
    require!(job.state == JobState::Funded, CheckoutError::NotFunded);
    require!(now < job.expires_at, CheckoutError::ApprovalExpired);
    Ok(())
}

fn validate_refund(job: &Job, now: i64) -> Result<()> {
    require!(job.state == JobState::Funded, CheckoutError::NotFunded);
    require!(now >= job.expires_at, CheckoutError::RefundTooEarly);
    Ok(())
}

#[error_code]
pub enum CheckoutError {
    #[msg("Amount must be positive")]
    InvalidAmount,
    #[msg("Deadline must be in the future and at most 24 hours away")]
    InvalidDeadline,
    #[msg("Only the original buyer may settle this job")]
    UnauthorizedBuyer,
    #[msg("The job is already settled")]
    NotFunded,
    #[msg("Approval must occur before the deadline")]
    ApprovalExpired,
    #[msg("Refund is available at or after the deadline")]
    RefundTooEarly,
    #[msg("Mint does not match the configured or recorded legacy SPL mint")]
    WrongMint,
    #[msg("Expected the recorded recipient's canonical legacy SPL token account")]
    WrongDestination,
    #[msg("The configured mock stablecoin must have six decimals")]
    InvalidMintDecimals,
    #[msg("Only this program's upgrade authority may initialize config")]
    UnauthorizedInitializer,
    #[msg("ProgramData must belong to this executable upgradeable program")]
    InvalidProgramData,
    #[msg("A vault must not have a delegate or alternate close authority")]
    UnsafeVault,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(state: JobState) -> Job {
        Job {
            buyer: Pubkey::new_unique(),
            merchant: Pubkey::new_unique(),
            mint: Pubkey::new_unique(),
            job_id: [7; 32],
            amount: 5_000_000,
            expires_at: 100,
            state,
            bump: 255,
            vault_bump: 255,
        }
    }

    #[test]
    fn quote_requires_positive_amount_and_bounded_future_deadline() {
        assert!(validate_quote(0, 101, 100).is_err());
        assert!(validate_quote(1, 100, 100).is_err());
        assert!(validate_quote(1, 99, 100).is_err());
        assert!(validate_quote(1, 101, 100).is_ok());
        assert!(validate_quote(u64::MAX, 100 + MAX_LIFETIME_SECONDS, 100).is_ok());
        assert!(validate_quote(1, 101 + MAX_LIFETIME_SECONDS, 100).is_err());
        assert!(validate_quote(1, i64::MAX, i64::MIN).is_err());
    }

    #[test]
    fn expiry_has_no_gap_or_overlap_between_approval_and_refund() {
        let funded = job(JobState::Funded);
        for now in [i64::MIN, 99] {
            assert!(validate_approval(&funded, now).is_ok());
            assert!(validate_refund(&funded, now).is_err());
        }
        for now in [100, 101, i64::MAX] {
            assert!(validate_approval(&funded, now).is_err());
            assert!(validate_refund(&funded, now).is_ok());
        }
    }

    #[test]
    fn every_terminal_action_is_irreversible_at_every_time_boundary() {
        for state in [JobState::Released, JobState::Refunded] {
            let terminal = job(state);
            for now in [i64::MIN, 99, 100, 101, i64::MAX] {
                assert!(validate_approval(&terminal, now).is_err());
                assert!(validate_refund(&terminal, now).is_err());
            }
        }
    }

    #[test]
    fn job_layout_matches_shared_decoder_and_account_allocation() {
        let funded = job(JobState::Funded);
        let encoded = funded.try_to_vec().unwrap();
        assert_eq!(Job::INIT_SPACE, 147);
        assert_eq!(encoded.len(), Job::INIT_SPACE);
        assert_eq!(&encoded[0..32], funded.buyer.as_ref());
        assert_eq!(&encoded[32..64], funded.merchant.as_ref());
        assert_eq!(&encoded[64..96], funded.mint.as_ref());
        assert_eq!(&encoded[96..128], &funded.job_id);
        assert_eq!(&encoded[128..136], &funded.amount.to_le_bytes());
        assert_eq!(&encoded[136..144], &funded.expires_at.to_le_bytes());
        assert_eq!(&encoded[144..147], &[0, 255, 255]);
        assert_eq!(Config::INIT_SPACE, 65);
    }
}
