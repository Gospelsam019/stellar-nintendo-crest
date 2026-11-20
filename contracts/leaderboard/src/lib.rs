#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, vec, Address, BytesN, Env, IntoVal, Symbol, Val, Vec};

const MAX_TOP_PLAYERS: u32 = 50;
const MAX_PAGE_SIZE: u32   = 20;
const CHUNK_SIZE: u32      = 20;
const TTL_BUMP: u32 = 3_153_600;
const TTL_HIGH: u32 = 6_307_200;

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LeaderboardError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    UnauthorizedCaller = 3,
    InvalidPoints      = 4,
    NotAdmin           = 5,
}

// OPT: was 4 separate keys per user (Points, TotalBets, WonBets, LostBets).
//      Now 1 key per user (Stats) — saves 3 storage reads + 3 writes on
//      every add_pts call and 3 reads on every get_stats call.
//      TopPlayerSlot retained as a reverse lookup for O(1) in-place update.
//      TopPlayerCount moves to instance storage (free to read with other keys).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    MarketContract,
    ReferralContract,
    // Lever G: token address so reward() can mint IPRED internally — one
    // cross-call from the market instead of two (add_pts + mint).
    TokenContract,
    Stats(Address),        // was: Points + TotalBets + WonBets + LostBets (4 keys → 1)
    TopPlayerAt(u32),
    TopPlayerCount,
    TopPlayerSlot(Address),
    MinPoints,             // u64 — points of the weakest entry currently in the top list
    MinSlot,               // u32 — slot index of that weakest entry
    // OPT: top leaderboard partitioned into fixed-size chunks of CHUNK_SIZE
    //      ranked records. Only the affected chunk(s) are rewritten on an
    //      insert/update, avoiding monolithic-array write amplification.
    LeaderboardChunk(u32),
}

// OPT: PlayerEntry now embeds points directly (avoids a Stats read during sort)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerEntry {
    pub address: Address,
    pub points:  u64,
}

// External-facing stats struct (ABI stable)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerStats {
    pub points:     u64,
    pub total_bets: u32,
    pub won_bets:   u32,
    pub lost_bets:  u32,
}

// Internal packed stats — single storage slot per user
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStats {
    pub points:   u64,
    pub won_bets: u32,
    pub lost_bets: u32,
    // OPT: total_bets removed — derived as won_bets + lost_bets + pending.
    //      Since prediction_market no longer calls record_bet, we compute
    //      total_bets at read time: won + lost (fully settled bets only).
    //      This eliminates the won_bets vs total_bets drift issue too.
}

#[contract]
pub struct LeaderboardContract;

#[contractimpl]
impl LeaderboardContract {

    pub fn initialize(
        env: Env,
        admin: Address,
        market_contract: Address,
        referral_contract: Address,
    ) -> Result<(), LeaderboardError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(LeaderboardError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::MarketContract, &market_contract);
        env.storage().instance().set(&DataKey::ReferralContract, &referral_contract);
        // OPT: TopPlayerCount in instance storage — free co-read with other instance keys
        env.storage().instance().set(&DataKey::TopPlayerCount, &0_u32);
        Ok(())
    }

    // ── Upgradeability & Config (admin only) ──────────────────────────────────

    /// Replace this contract's WASM in place. Admin only. Storage preserved.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Re-point the trusted market and referral contracts. Admin only.
    /// Needed if the market/referral are redeployed to new addresses.
    pub fn set_contracts(
        env: Env,
        admin: Address,
        market_contract: Address,
        referral_contract: Address,
    ) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::MarketContract, &market_contract);
        env.storage().instance().set(&DataKey::ReferralContract, &referral_contract);
        Ok(())
    }

    pub fn set_token(env: Env, admin: Address, token_contract: Address) -> Result<(), LeaderboardError> {
        Self::require_admin(&env, &admin)?;
        admin.require_auth();
        env.storage().instance().set(&DataKey::TokenContract, &token_contract);
        Ok(())
    }

    pub fn reward(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        tokens: i128,
        is_winner: bool,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        // 1) Points / win-loss — identical to add_pts.
        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        s.points += points;
        if is_winner { s.won_bets += 1; } else { s.lost_bets += 1; }
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);
        Self::upsert_top(&env, &user, s.points);

        // 2) Mint IPRED internally (the second cross-call the market used to make).
        if tokens > 0 {
            let token: Address = env.storage().instance().get(&DataKey::TokenContract)
                .ok_or(LeaderboardError::NotInitialized)?;
            let this = env.current_contract_address();
            let _: Val = env.invoke_contract(
                &token,
                &Symbol::new(&env, "mint"),
                vec![&env, this.into_val(&env), user.into_val(&env), tokens.into_val(&env)],
            );
        }
        Ok(())
    }

    // OPT: 1 storage read+write instead of 4 separate reads + 2 writes
    pub fn add_pts(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        is_winner: bool,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_market_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });

        s.points += points;
        if is_winner { s.won_bets += 1; } else { s.lost_bets += 1; }
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);

        Self::upsert_top(&env, &user, s.points);
        Ok(())
    }

    pub fn reward_bonus(
        env: Env,
        caller: Address,
        user: Address,
        points: u64,
        tokens: i128,
    ) -> Result<(), LeaderboardError> {
        caller.require_auth();
        Self::require_referral_contract(&env, &caller)?;
        if points == 0 { return Err(LeaderboardError::InvalidPoints); }

        let sk = DataKey::Stats(user.clone());
        let mut s: UserStats = env.storage().persistent().get(&sk)
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        s.points += points;
        env.storage().persistent().set(&sk, &s);
        env.storage().persistent().extend_ttl(&sk, TTL_BUMP, TTL_HIGH);
        Self::upsert_top(&env, &user, s.points);

        if tokens > 0 {
            let token: Address = env.storage().instance().get(&DataKey::TokenContract)
                .ok_or(LeaderboardError::NotInitialized)?;
            let this = env.current_contract_address();
            let _: Val = env.invoke_contract(
                &token,
                &Symbol::new(&env, "mint"),
                vec![&env, this.into_val(&env), user.into_val(&env), tokens.into_val(&env)],
            );
        }
        Ok(())
    }

    // ── Chunked top-leaderboard storage helpers ───────────────────────────────

    /// Read the chunk at `chunk_idx` (empty Vec if unset).
    fn read_chunk(env: &Env, chunk_idx: u32) -> Vec<PlayerEntry> {
        env.storage().persistent()
            .get(&DataKey::LeaderboardChunk(chunk_idx))
            .unwrap_or_else(|| Vec::new(env))
    }

    /// Persist a single chunk and bump its TTL.
    fn write_chunk(env: &Env, chunk_idx: u32, chunk: &Vec<PlayerEntry>) {
        let key = DataKey::LeaderboardChunk(chunk_idx);
        env.storage().persistent().set(&key, chunk);
        env.storage().persistent().extend_ttl(&key, TTL_BUMP, TTL_HIGH);
    }

    /// Read the entry at global rank `slot`, spanning chunk boundaries.
    fn read_slot(env: &Env, slot: u32) -> Option<PlayerEntry> {
        let chunk_idx = slot / CHUNK_SIZE;
        let offset = slot % CHUNK_SIZE;
        let chunk = Self::read_chunk(env, chunk_idx);
        chunk.get(offset)
    }

    /// Write the entry at global rank `slot`, rewriting only its chunk.
    fn write_slot(env: &Env, slot: u32, entry: &PlayerEntry) {
        let chunk_idx = slot / CHUNK_SIZE;
        let offset = slot % CHUNK_SIZE;
        let mut chunk = Self::read_chunk(env, chunk_idx);
        if offset < chunk.len() {
            chunk.set(offset, entry.clone());
        } else {
            chunk.push_back(entry.clone());
        }
        Self::write_chunk(env, chunk_idx, &chunk);
    }

    /// Append an entry at the end of the current top list, rewriting only the
    /// tail chunk.
    fn push_slot(env: &Env, slot: u32, entry: &PlayerEntry) {
        let chunk_idx = slot / CHUNK_SIZE;
        let mut chunk = Self::read_chunk(env, chunk_idx);
        chunk.push_back(entry.clone());
        Self::write_chunk(env, chunk_idx, &chunk);
    }

    /// Insert/update `user` in the top list. Only the chunks touched by the
    /// shift are rewritten (at most two per insertion), instead of the whole
    /// monolithic array.
    fn upsert_top(env: &Env, user: &Address, points: u64) {
        let count: u32 = env.storage().instance().get(&DataKey::TopPlayerCount).unwrap_or(0);
        let entry = PlayerEntry { address: user.clone(), points };

        // Existing entry: update in place if points changed.
        if let Some(slot) = env.storage().persistent().get::<_, u32>(&DataKey::TopPlayerSlot(user.clone())) {
            let old = Self::read_slot(env, slot).unwrap_or(entry.clone());
            if old.points == points {
                return;
            }
            Self::write_slot(env, slot, &entry);
            Self::resort_from(env, slot, count);
            return;
        }

        // New entry: append then bubble up to its sorted position.
        if count < MAX_TOP_PLAYERS {
            Self::push_slot(env, count, &entry);
            env.storage().persistent().set(&DataKey::TopPlayerSlot(user.clone()), &count);
            env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(user.clone()), TTL_BUMP, TTL_HIGH);
            env.storage().instance().set(&DataKey::TopPlayerCount, &(count + 1));
            Self::resort_from(env, count, count + 1);
        } else {
            // Full list: only insert if it beats the weakest entry.
            let min_points: u64 = env.storage().instance().get(&DataKey::MinPoints).unwrap_or(0);
            if points <= min_points {
                return;
            }
            let min_slot: u32 = env.storage().instance().get(&DataKey::MinSlot).unwrap_or(0);
            let evicted = Self::read_slot(env, min_slot);
            if let Some(e) = evicted {
                env.storage().persistent().remove(&DataKey::TopPlayerSlot(e.address));
            }
            Self::write_slot(env, min_slot, &entry);
            env.storage().persistent().set(&DataKey::TopPlayerSlot(user.clone()), &min_slot);
            env.storage().persistent().extend_ttl(&DataKey::TopPlayerSlot(user.clone()), TTL_BUMP, TTL_HIGH);
            Self::resort_from(env, min_slot, count);
        }
    }

    /// Re-establish sorted order from `start` to `end` (exclusive), rewriting
    /// only the chunks that actually change.
    fn resort_from(env: &Env, start: u32, end: u32) {
        if end <= start + 1 {
            Self::refresh_min(env, end);
            return;
        }
        let mut i = start;
        while i + 1 < end {
            let a = Self::read_slot(env, i);
            let b = Self::read_slot(env, i + 1);
            match (a, b) {
                (Some(mut left), Some(mut right)) => {
                    if right.points > left.points {
                        // Swap the two entries and update reverse-lookup slots.
                        env.storage().persistent().set(&DataKey::TopPlayerSlot(left.address.clone()), &(i + 1));
                        env.storage().persistent().set(&DataKey::TopPlayerSlot(right.address.clone()), &i);
                        core::mem::swap(&mut left, &mut right);
                        Self::write_slot(env, i, &left);
                        Self::write_slot(env, i + 1, &right);
                    }
                }
                _ => break,
            }
            i += 1;
        }
        Self::refresh_min(env, end);
    }

    /// Recompute the weakest-entry cache (MinPoints / MinSlot) from the tail.
    fn refresh_min(env: &Env, count: u32) {
        if count == 0 {
            env.storage().instance().set(&DataKey::MinPoints, &0_u64);
            env.storage().instance().set(&DataKey::MinSlot, &0_u32);
            return;
        }
        let last = count - 1;
        if let Some(e) = Self::read_slot(env, last) {
            env.storage().instance().set(&DataKey::MinPoints, &e.points);
            env.storage().instance().set(&DataKey::MinSlot, &last);
        }
    }

    // ── Query APIs (unchanged surface, now chunk-backed) ──────────────────────

    pub fn get_top_players(env: Env, page: u32, page_size: u32) -> Vec<PlayerEntry> {
        let count: u32 = env.storage().instance().get(&DataKey::TopPlayerCount).unwrap_or(0);
        let size = if page_size == 0 || page_size > MAX_PAGE_SIZE { MAX_PAGE_SIZE } else { page_size };
        let start = page.saturating_mul(size);
        let mut out = Vec::new(&env);
        if start >= count {
            return out;
        }
        let end = core::cmp::min(start + size, count);
        let mut i = start;
        while i < end {
            if let Some(e) = Self::read_slot(&env, i) {
                out.push_back(e);
            }
            i += 1;
        }
        out
    }

    pub fn get_top_player_count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::TopPlayerCount).unwrap_or(0)
    }

    pub fn get_stats(env: Env, user: Address) -> PlayerStats {
        let s: UserStats = env.storage().persistent().get(&DataKey::Stats(user))
            .unwrap_or(UserStats { points: 0, won_bets: 0, lost_bets: 0 });
        PlayerStats {
            points:     s.points,
            total_bets: s.won_bets + s.lost_bets,
            won_bets:   s.won_bets,
            lost_bets:  s.lost_bets,
        }
    }

    // ── Auth helpers ──────────────────────────────────────────────────────────

    fn require_admin(env: &Env, admin: &Address) -> Result<(), LeaderboardError> {
        let stored: Address = env.storage().instance().get(&DataKey::Admin)
            .ok_or(LeaderboardError::NotInitialized)?;
        if &stored != admin {
            return Err(LeaderboardError::NotAdmin);
        }
        Ok(())
    }

    fn require_market_contract(env: &Env, caller: &Address) -> Result<(), LeaderboardError> {
        let stored: Address = env.storage().instance().get(&DataKey::MarketContract)
            .ok_or(LeaderboardError::NotInitialized)?;
        if &stored != caller {
            return Err(LeaderboardError::UnauthorizedCaller);
        }
        Ok(())
    }

    fn require_referral_contract(env: &Env, caller: &Address) -> Result<(), LeaderboardError> {
        let stored: Address = env.storage().instance().get(&DataKey::ReferralContract)
            .ok_or(LeaderboardError::NotInitialized)?;
        if &stored != caller {
            return Err(LeaderboardError::UnauthorizedCaller);
        }
        Ok(())
    }
}
