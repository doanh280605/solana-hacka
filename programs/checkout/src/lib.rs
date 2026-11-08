use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{self, Mint, Token, TokenAccount, TransferChecked},
};

declare_id!("7cW6fScgHCAWBo9YDQEhuS6brFjssJSmomRN11Xa9iKY");

pub const MAX_LIFETIME_SECONDS: i64 = 24 * 60 * 60;
pub const MINT_DECIMALS: u8 = 6;
pub const V2_SCHEMA_VERSION: u16 = 2;
pub const V2_TERMS_DOMAIN: &[u8] = b"osid:terms:v2\0";

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

    /// Additive V2 funding: V1 accounts and instruction encodings remain unchanged.
    pub fn fund_v2(
        ctx: Context<FundV2>,
        job_id: [u8; 32],
        amount: u64,
        expires_at: i64,
        quote_expires_at: i64,
        input_hash: [u8; 32],
        spec_hash: [u8; 32],
        terms_hash: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_quote_v2(amount, expires_at, quote_expires_at, now)?;
        require!(input_hash != [0; 32], CheckoutError::EmptyCommitment);
        require!(spec_hash != [0; 32], CheckoutError::EmptyCommitment);
        require!(terms_hash != [0; 32], CheckoutError::EmptyCommitment);
        let job = JobV2 {
            schema_version: V2_SCHEMA_VERSION,
            buyer: ctx.accounts.buyer.key(),
            merchant: ctx.accounts.merchant.key(),
            provider: ctx.accounts.provider.key(),
            mint: ctx.accounts.mint.key(),
            job_id,
            amount,
            expires_at,
            quote_expires_at,
            input_hash,
            spec_hash,
            terms_hash,
            result_hash: [0; 32],
            submitted_at: 0,
            state: JobV2State::Funded,
            bump: ctx.bumps.job,
            vault_bump: ctx.bumps.vault,
        };
        require!(
            compute_terms_hash_v2(ctx.program_id, &ctx.accounts.job.key(), &job) == terms_hash,
            CheckoutError::TermsMismatch
        );
        ctx.accounts.job.set_inner(job);
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
    }

    /// A single immutable manifest commitment. This does not certify AI quality.
    pub fn submit_v2(ctx: Context<SubmitV2>, result_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        validate_submission_v2(&ctx.accounts.job, &result_hash, now)?;
        ctx.accounts.job.result_hash = result_hash;
        ctx.accounts.job.submitted_at = now;
        ctx.accounts.job.state = JobV2State::Submitted;
        Ok(())
    }

    pub fn approve_v2(ctx: Context<ApproveV2>, result_hash: [u8; 32]) -> Result<()> {
        validate_approval_v2(
            &ctx.accounts.job,
            &result_hash,
            Clock::get()?.unix_timestamp,
        )?;
        let job = &ctx.accounts.job;
        let bump = [job.bump];
        let signer_seeds: &[&[u8]] = &[b"job_v2", job.buyer.as_ref(), job.job_id.as_ref(), &bump];
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
        ctx.accounts.job.state = JobV2State::Released;
        Ok(())
    }

    pub fn refund_v2(ctx: Context<RefundV2>) -> Result<()> {
        validate_refund_v2(&ctx.accounts.job, Clock::get()?.unix_timestamp)?;
        let job = &ctx.accounts.job;
        let bump = [job.bump];
        let signer_seeds: &[&[u8]] = &[b"job_v2", job.buyer.as_ref(), job.job_id.as_ref(), &bump];
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
        ctx.accounts.job.state = JobV2State::Refunded;
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

#[derive(Accounts)]
#[instruction(job_id: [u8; 32])]
pub struct FundV2<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: The recorded merchant must own the canonical ATA below.
    pub merchant: UncheckedAccount<'info>,
    /// CHECK: Only its nonzero public key is recorded; submission requires its signature.
    #[account(constraint = provider.key() != Pubkey::default() @ CheckoutError::InvalidProvider)]
    pub provider: UncheckedAccount<'info>,
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
        space = 8 + JobV2::INIT_SPACE,
        seeds = [b"job_v2", buyer.key().as_ref(), job_id.as_ref()],
        bump
    )]
    pub job: Account<'info, JobV2>,
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
pub struct SubmitV2<'info> {
    pub provider: Signer<'info>,
    #[account(
        mut,
        seeds = [b"job_v2", job.buyer.as_ref(), job.job_id.as_ref()],
        bump = job.bump,
        has_one = provider @ CheckoutError::UnauthorizedProvider,
        constraint = job.schema_version == V2_SCHEMA_VERSION @ CheckoutError::InvalidVersion
    )]
    pub job: Account<'info, JobV2>,
}

#[derive(Accounts)]
pub struct ApproveV2<'info> {
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"job_v2", job.buyer.as_ref(), job.job_id.as_ref()],
        bump = job.bump,
        has_one = buyer @ CheckoutError::UnauthorizedBuyer,
        has_one = mint @ CheckoutError::WrongMint,
        constraint = job.schema_version == V2_SCHEMA_VERSION @ CheckoutError::InvalidVersion
    )]
    pub job: Account<'info, JobV2>,
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
pub struct RefundV2<'info> {
    pub buyer: Signer<'info>,
    #[account(
        mut,
        seeds = [b"job_v2", job.buyer.as_ref(), job.job_id.as_ref()],
        bump = job.bump,
        has_one = buyer @ CheckoutError::UnauthorizedBuyer,
        has_one = mint @ CheckoutError::WrongMint,
        constraint = job.schema_version == V2_SCHEMA_VERSION @ CheckoutError::InvalidVersion
    )]
    pub job: Account<'info, JobV2>,
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

/// Separate account/discriminator, layout and state enum preserve all V1 bytes.
#[account]
#[derive(InitSpace)]
pub struct JobV2 {
    pub schema_version: u16,
    pub buyer: Pubkey,
    pub merchant: Pubkey,
    pub provider: Pubkey,
    pub mint: Pubkey,
    pub job_id: [u8; 32],
    pub amount: u64,
    pub expires_at: i64,
    pub quote_expires_at: i64,
    pub input_hash: [u8; 32],
    pub spec_hash: [u8; 32],
    pub terms_hash: [u8; 32],
    pub result_hash: [u8; 32],
    pub submitted_at: i64,
    pub state: JobV2State,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum JobV2State {
    Funded,
    Submitted,
    Released,
    Refunded,
}

pub fn compute_terms_hash_v2(program_id: &Pubkey, job_address: &Pubkey, job: &JobV2) -> [u8; 32] {
    anchor_lang::solana_program::hash::hashv(&[
        V2_TERMS_DOMAIN,
        program_id.as_ref(),
        job_address.as_ref(),
        &job.job_id,
        job.buyer.as_ref(),
        job.merchant.as_ref(),
        job.provider.as_ref(),
        job.mint.as_ref(),
        &job.amount.to_le_bytes(),
        &job.expires_at.to_le_bytes(),
        &job.quote_expires_at.to_le_bytes(),
        &job.schema_version.to_le_bytes(),
        &job.input_hash,
        &job.spec_hash,
    ])
    .to_bytes()
}

fn validate_quote_v2(amount: u64, expires_at: i64, quote_expires_at: i64, now: i64) -> Result<()> {
    validate_quote(amount, expires_at, now)?;
    require!(now < quote_expires_at, CheckoutError::QuoteExpired);
    require!(
        quote_expires_at < expires_at,
        CheckoutError::InvalidDeadline
    );
    Ok(())
}

fn validate_submission_v2(job: &JobV2, result_hash: &[u8; 32], now: i64) -> Result<()> {
    require!(
        job.state == JobV2State::Funded,
        CheckoutError::AlreadySubmitted
    );
    require!(now < job.expires_at, CheckoutError::ApprovalExpired);
    require!(*result_hash != [0; 32], CheckoutError::EmptyCommitment);
    Ok(())
}

fn validate_approval_v2(job: &JobV2, result_hash: &[u8; 32], now: i64) -> Result<()> {
    require!(
        matches!(job.state, JobV2State::Funded | JobV2State::Submitted),
        CheckoutError::NotFunded
    );
    require!(
        job.state == JobV2State::Submitted,
        CheckoutError::NotSubmitted
    );
    require!(now < job.expires_at, CheckoutError::ApprovalExpired);
    require!(
        job.result_hash == *result_hash,
        CheckoutError::ResultMismatch
    );
    Ok(())
}

fn validate_refund_v2(job: &JobV2, now: i64) -> Result<()> {
    require!(
        matches!(job.state, JobV2State::Funded | JobV2State::Submitted),
        CheckoutError::NotFunded
    );
    require!(now >= job.expires_at, CheckoutError::RefundTooEarly);
    Ok(())
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
    #[msg("Only the recorded provider may submit a result")]
    UnauthorizedProvider,
    #[msg("Commitments must be nonzero SHA-256 hashes")]
    EmptyCommitment,
    #[msg("Terms commitment does not match the bound V2 job fields")]
    TermsMismatch,
    #[msg("The funding quote has expired")]
    QuoteExpired,
    #[msg("The provider has already submitted or this job is terminal")]
    AlreadySubmitted,
    #[msg("The provider must submit a result before buyer approval")]
    NotSubmitted,
    #[msg("Approval must bind the exact submitted result commitment")]
    ResultMismatch,
    #[msg("Unsupported job schema version")]
    InvalidVersion,
    #[msg("Provider public key must be nonzero")]
    InvalidProvider,
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

    fn job_v2(state: JobV2State) -> JobV2 {
        JobV2 {
            schema_version: V2_SCHEMA_VERSION,
            buyer: Pubkey::new_from_array([3; 32]),
            merchant: Pubkey::new_from_array([4; 32]),
            provider: Pubkey::new_from_array([5; 32]),
            mint: Pubkey::new_from_array([6; 32]),
            job_id: [7; 32],
            amount: 5_000_000,
            expires_at: 1_800,
            quote_expires_at: 600,
            input_hash: [8; 32],
            spec_hash: [9; 32],
            terms_hash: [10; 32],
            result_hash: [11; 32],
            submitted_at: 500,
            state,
            bump: 254,
            vault_bump: 253,
        }
    }

    #[test]
    fn v2_quote_validity_is_distinct_from_execution_deadline() {
        assert!(validate_quote_v2(1, 1_800, 600, 100).is_ok());
        assert!(validate_quote_v2(1, 1_800, 600, 599).is_ok());
        assert!(validate_quote_v2(1, 1_800, 600, 600).is_err());
        assert!(validate_quote_v2(1, 1_800, 600, 601).is_err());
        assert!(validate_quote_v2(1, 1_800, 1_800, 100).is_err());
        assert!(validate_quote_v2(1, 1_800, 1_801, 100).is_err());
        assert!(validate_quote_v2(0, 1_800, 600, 100).is_err());
        assert!(validate_quote_v2(1, i64::MAX, 600, i64::MIN).is_err());
    }

    #[test]
    fn v2_requires_one_nonzero_submission_then_exact_result_approval() {
        let funded = job_v2(JobV2State::Funded);
        assert!(validate_submission_v2(&funded, &[12; 32], 1_799).is_ok());
        assert!(validate_submission_v2(&funded, &[0; 32], 100).is_err());
        assert!(validate_submission_v2(&funded, &[12; 32], 1_800).is_err());
        assert!(validate_approval_v2(&funded, &funded.result_hash, 100).is_err());
        let submitted = job_v2(JobV2State::Submitted);
        assert!(validate_submission_v2(&submitted, &[12; 32], 100).is_err());
        assert!(validate_approval_v2(&submitted, &submitted.result_hash, 1_799).is_ok());
        assert!(validate_approval_v2(&submitted, &[12; 32], 100).is_err());
        assert!(validate_approval_v2(&submitted, &submitted.result_hash, 1_800).is_err());
    }

    #[test]
    fn v2_both_pending_states_refund_at_exact_expiry_and_terminals_stay_terminal() {
        for state in [JobV2State::Funded, JobV2State::Submitted] {
            let pending = job_v2(state);
            assert!(validate_refund_v2(&pending, 1_799).is_err());
            assert!(validate_refund_v2(&pending, 1_800).is_ok());
            assert!(validate_refund_v2(&pending, i64::MAX).is_ok());
        }
        for state in [JobV2State::Released, JobV2State::Refunded] {
            let terminal = job_v2(state);
            for now in [i64::MIN, 1_799, 1_800, i64::MAX] {
                assert!(validate_submission_v2(&terminal, &[12; 32], now).is_err());
                assert!(validate_approval_v2(&terminal, &terminal.result_hash, now).is_err());
                assert!(validate_refund_v2(&terminal, now).is_err());
            }
        }
    }

    #[test]
    fn v2_terms_commitment_matches_cross_language_vector_and_binds_every_field() {
        let program = Pubkey::new_from_array([1; 32]);
        let address = Pubkey::new_from_array([2; 32]);
        let mut job = job_v2(JobV2State::Funded);
        let digest = compute_terms_hash_v2(&program, &address, &job);
        assert_eq!(
            digest,
            [
                0x4e, 0xf1, 0x32, 0x7c, 0x01, 0x3d, 0x32, 0x19, 0x4a, 0x79, 0xfb, 0x33, 0x94, 0x98,
                0x3e, 0x06, 0xaa, 0x84, 0x61, 0xd0, 0x34, 0xce, 0xc7, 0x89, 0x63, 0xcc, 0xbf, 0xa9,
                0xc0, 0x44, 0xb3, 0xa6,
            ]
        );
        assert_ne!(compute_terms_hash_v2(&address, &address, &job), digest);
        assert_ne!(compute_terms_hash_v2(&program, &program, &job), digest);
        for field in 0..12 {
            job = job_v2(JobV2State::Funded);
            match field {
                0 => job.schema_version += 1,
                1 => job.buyer = Pubkey::new_unique(),
                2 => job.merchant = Pubkey::new_unique(),
                3 => job.provider = Pubkey::new_unique(),
                4 => job.mint = Pubkey::new_unique(),
                5 => job.job_id[0] ^= 1,
                6 => job.amount += 1,
                7 => job.expires_at += 1,
                8 => job.quote_expires_at += 1,
                9 => job.input_hash[0] ^= 1,
                10 => job.spec_hash[0] ^= 1,
                11 => job.terms_hash[0] ^= 1,
                _ => unreachable!(),
            }
            // Terms hash cannot include itself; the supplied value is checked separately.
            if field == 11 {
                assert_eq!(compute_terms_hash_v2(&program, &address, &job), digest);
            } else {
                assert_ne!(compute_terms_hash_v2(&program, &address, &job), digest);
            }
        }
    }

    #[test]
    fn v2_account_layout_is_fixed_and_cannot_reinterpret_v1() {
        let job = job_v2(JobV2State::Submitted);
        let encoded = job.try_to_vec().unwrap();
        assert_eq!(JobV2::INIT_SPACE, 325);
        assert_eq!(encoded.len(), JobV2::INIT_SPACE);
        assert_eq!(&encoded[0..2], &2u16.to_le_bytes());
        assert_eq!(&encoded[2..34], job.buyer.as_ref());
        assert_eq!(&encoded[34..66], job.merchant.as_ref());
        assert_eq!(&encoded[66..98], job.provider.as_ref());
        assert_eq!(&encoded[98..130], job.mint.as_ref());
        assert_eq!(&encoded[130..162], &job.job_id);
        assert_eq!(&encoded[162..170], &job.amount.to_le_bytes());
        assert_eq!(&encoded[170..178], &job.expires_at.to_le_bytes());
        assert_eq!(&encoded[178..186], &job.quote_expires_at.to_le_bytes());
        assert_eq!(&encoded[186..218], &job.input_hash);
        assert_eq!(&encoded[218..250], &job.spec_hash);
        assert_eq!(&encoded[250..282], &job.terms_hash);
        assert_eq!(&encoded[282..314], &job.result_hash);
        assert_eq!(&encoded[314..322], &job.submitted_at.to_le_bytes());
        assert_eq!(&encoded[322..325], &[1, 254, 253]);
        assert_ne!(Job::DISCRIMINATOR, JobV2::DISCRIMINATOR);
    }
}
