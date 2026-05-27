const fs = require('fs');
const path = require('path');
const {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');

const STATE_PATH = path.join(__dirname, 'data', 'rewards-state.json');
const ONE_HOUR_MS = Number(process.env.REWARDS_INTERVAL_MS || 60 * 60 * 1000);
const MIN_HOLDER_TOKENS = Number(process.env.REWARDS_MIN_TOKENS || 1);
const FEE_RESERVE_LAMPORTS = Number(process.env.REWARDS_FEE_RESERVE_LAMPORTS || 0.02 * LAMPORTS_PER_SOL);
const MIN_PAYOUT_LAMPORTS = Number(process.env.REWARDS_MIN_PAYOUT_LAMPORTS || 5000);

class RewardsTimer {
    constructor(options) {
        this.connection = options.connection;
        this.tokenMint = options.tokenMint;
        this.rewardsWallet = options.rewardsWallet;
        this.rewardsKeypair = options.rewardsKeypair || null;
        this.onUpdate = options.onUpdate || (() => {});

        this.state = this.loadState();
        this.poolSol = 0;
        this.distributing = false;
        this.tickTimer = null;
        this.checkTimer = null;
    }

    loadState() {
        try {
            fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
            if (fs.existsSync(STATE_PATH)) {
                const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
                if (parsed?.timerEndsAt) return parsed;
            }
        } catch (error) {
            console.warn('Rewards state load failed, starting fresh:', error.message);
        }
        return this.createInitialState();
    }

    createInitialState() {
        return {
            timerEndsAt: Date.now() + ONE_HOUR_MS,
            cycleId: 1,
            lastDistributionAt: null,
            lastDistributionStatus: 'idle',
            lastDistributionMessage: null,
            lastDistributionSummary: null,
        };
    }

    saveState() {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2));
    }

    getSnapshot() {
        const remainingMs = Math.max(0, this.state.timerEndsAt - Date.now());
        return {
            timerEndsAt: this.state.timerEndsAt,
            remainingMs,
            remainingSeconds: Math.ceil(remainingMs / 1000),
            cycleId: this.state.cycleId,
            rewardsWallet: this.rewardsWallet,
            poolSol: this.poolSol,
            poolLamports: Math.floor(this.poolSol * LAMPORTS_PER_SOL),
            canDistribute: Boolean(this.rewardsKeypair),
            lastDistributionAt: this.state.lastDistributionAt,
            lastDistributionStatus: this.state.lastDistributionStatus,
            lastDistributionMessage: this.state.lastDistributionMessage,
            lastDistributionSummary: this.state.lastDistributionSummary,
        };
    }

    start() {
        this.refreshPoolBalance().catch(() => {});
        this.tickTimer = setInterval(() => {
            this.onUpdate(this.getSnapshot());
        }, 1000);

        this.checkTimer = setInterval(() => {
            this.refreshPoolBalance().catch(() => {});
            this.checkTimerExpiry().catch((error) => {
                console.error('Rewards timer check failed:', error.message);
            });
        }, 10000);

        this.onUpdate(this.getSnapshot());
        this.checkTimerExpiry().catch(() => {});
    }

    stop() {
        if (this.tickTimer) clearInterval(this.tickTimer);
        if (this.checkTimer) clearInterval(this.checkTimer);
    }

    async refreshPoolBalance() {
        if (!this.rewardsWallet) return;
        const lamports = await this.connection.getBalance(new PublicKey(this.rewardsWallet), 'confirmed');
        this.poolSol = lamports / LAMPORTS_PER_SOL;
    }

    async checkTimerExpiry() {
        if (Date.now() < this.state.timerEndsAt || this.distributing) return;
        await this.runDistribution();
    }

    async fetchHolders() {
        if (!this.tokenMint) return [];

        const mint = new PublicKey(this.tokenMint);
        const accounts = await this.connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
            commitment: 'confirmed',
            filters: [
                { dataSize: 165 },
                { memcmp: { offset: 0, bytes: mint.toBase58() } },
            ],
        });

        const holders = new Map();
        for (const { account } of accounts) {
            const data = account.data;
            const owner = new PublicKey(data.slice(32, 64)).toBase58();
            const amount = Number(data.readBigUInt64LE(64));
            if (amount <= 0) continue;
            if (owner === this.rewardsWallet) continue;

            const uiAmount = amount / 1e6;
            if (uiAmount < MIN_HOLDER_TOKENS) continue;

            holders.set(owner, (holders.get(owner) || 0) + amount);
        }

        return [...holders.entries()].map(([owner, amount]) => ({ owner, amount }));
    }

    async runDistribution() {
        if (this.distributing) return;
        this.distributing = true;

        this.state.lastDistributionStatus = 'running';
        this.state.lastDistributionMessage = 'Distributing rewards to holders...';
        this.saveState();
        this.onUpdate(this.getSnapshot());

        try {
            if (!this.rewardsKeypair) {
                throw new Error('Auto-distribution unavailable');
            }
            if (!this.tokenMint) {
                throw new Error('Token not connected');
            }

            await this.refreshPoolBalance();
            const balanceLamports = await this.connection.getBalance(this.rewardsKeypair.publicKey, 'confirmed');
            const distributable = balanceLamports - FEE_RESERVE_LAMPORTS;
            if (distributable <= MIN_PAYOUT_LAMPORTS) {
                throw new Error(`Rewards wallet balance too low (${(balanceLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
            }

            const holders = await this.fetchHolders();
            if (holders.length === 0) {
                throw new Error('No eligible token holders found');
            }

            const totalTokens = holders.reduce((sum, h) => sum + h.amount, 0);
            const payouts = holders
                .map((h) => ({
                    owner: h.owner,
                    lamports: Math.floor(distributable * (h.amount / totalTokens)),
                }))
                .filter((p) => p.lamports >= MIN_PAYOUT_LAMPORTS)
                .sort((a, b) => b.lamports - a.lamports);

            if (payouts.length === 0) {
                throw new Error('No payouts met minimum threshold');
            }

            const signatures = [];
            const batchSize = 8;
            for (let i = 0; i < payouts.length; i += batchSize) {
                const batch = payouts.slice(i, i + batchSize);
                const tx = new Transaction();
                for (const payout of batch) {
                    tx.add(
                        SystemProgram.transfer({
                            fromPubkey: this.rewardsKeypair.publicKey,
                            toPubkey: new PublicKey(payout.owner),
                            lamports: payout.lamports,
                        })
                    );
                }
                const sig = await sendAndConfirmTransaction(this.connection, tx, [this.rewardsKeypair], {
                    commitment: 'confirmed',
                    skipPreflight: false,
                });
                signatures.push(sig);
            }

            const totalDistributed = payouts.reduce((sum, p) => sum + p.lamports, 0);
            this.state.lastDistributionAt = Date.now();
            this.state.lastDistributionStatus = 'complete';
            this.state.lastDistributionMessage = `Distributed ${(totalDistributed / LAMPORTS_PER_SOL).toFixed(4)} SOL to ${payouts.length} holders`;
            this.state.lastDistributionSummary = {
                holderCount: payouts.length,
                totalSol: totalDistributed / LAMPORTS_PER_SOL,
                signatures,
                topRecipients: payouts.slice(0, 5).map((p) => ({
                    owner: p.owner,
                    sol: p.lamports / LAMPORTS_PER_SOL,
                })),
            };
            this.state.cycleId += 1;
            this.state.timerEndsAt = Date.now() + ONE_HOUR_MS;
            this.saveState();
            console.log(`🎁 ${this.state.lastDistributionMessage}`);
        } catch (error) {
            this.state.lastDistributionStatus = 'failed';
            this.state.lastDistributionMessage = error.message;
            this.state.timerEndsAt = Date.now() + ONE_HOUR_MS;
            this.state.cycleId += 1;
            this.saveState();
            console.error('🎁 Rewards distribution failed:', error.message);
        } finally {
            this.distributing = false;
            await this.refreshPoolBalance();
            this.onUpdate(this.getSnapshot());
        }
    }
}

function loadRewardsKeypair(rewardsWallet, privateKeyEnv) {
    if (!privateKeyEnv) return null;
    try {
        const trimmed = privateKeyEnv.trim();
        let secretKey;
        if (trimmed.startsWith('[')) {
            secretKey = Uint8Array.from(JSON.parse(trimmed));
        } else {
            secretKey = bs58.decode(trimmed);
        }
        const keypair = Keypair.fromSecretKey(secretKey);
        if (rewardsWallet && keypair.publicKey.toBase58() !== rewardsWallet) {
            console.warn('⚠️ REWARDS_PRIVATE_KEY does not match REWARDS_WALLET public key');
        }
        return keypair;
    } catch (error) {
        console.error('Invalid REWARDS_PRIVATE_KEY:', error.message);
        return null;
    }
}

function createRewardsTimer(options) {
    return new RewardsTimer(options);
}

module.exports = { RewardsTimer, createRewardsTimer, loadRewardsKeypair };
