const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const {
    OnlinePumpSdk,
    bondingCurvePda,
    canonicalPumpPoolPda,
} = require('@nirholas/pump-sdk');

class PumpMarketMonitor {
    constructor(options) {
        this.mintAddress = options.mintAddress;
        this.rpcUrl = options.rpcUrl || 'https://api.mainnet-beta.solana.com';
        this.wsUrl = options.wsUrl || 'wss://api.mainnet-beta.solana.com';
        this.onUpdate = options.onUpdate || (() => {});
        this.onStatus = options.onStatus || (() => {});

        // Rate limits (ms) — tune via env
        this.minRefreshMs = Number(options.minRefreshMs || process.env.MC_MIN_REFRESH_MS || 900);
        this.graduationCheckMs = Number(options.graduationCheckMs || 60000);
        this.supplyCacheMs = Number(options.supplyCacheMs || 60000);
        this.heartbeatMs = Number(options.heartbeatMs || 4000);

        this.connection = new Connection(this.rpcUrl, {
            wsEndpoint: this.wsUrl,
            commitment: 'confirmed',
            disableRetryOnRateLimit: true,
        });
        this.sdk = new OnlinePumpSdk(this.connection);
        this.mint = new PublicKey(this.mintAddress);

        this.solPriceUsd = 150;
        this.lastMarketCapUsd = null;
        this.lastMarketCapSol = null;
        this.isGraduated = false;
        this.mode = null;
        this.poolCache = null;

        this.lastRefreshAt = 0;
        this.lastGraduationCheckAt = 0;
        this.backoffUntil = 0;
        this.backoffMs = 0;
        this.pendingRefresh = false;
        this.refreshTimer = null;
        this.refreshInFlight = false;
        this.queuedAfterFlight = false;

        this.subscriptions = [];
        this.started = false;
    }

    async start() {
        if (this.started || !this.mintAddress) return;
        this.started = true;

        await this.refreshSolPrice();
        setInterval(() => this.refreshSolPrice(), 30000);
        setInterval(() => this.heartbeat(), this.heartbeatMs);

        await this.refreshMarketCap(true);
        await this.setupSubscriptions();

        this.onStatus({
            mode: this.mode,
            isGraduated: this.isGraduated,
            mint: this.mintAddress,
        });
    }

    stop() {
        this.subscriptions.forEach((id) => {
            try {
                this.connection.removeAccountChangeListener(id);
            } catch {}
        });
        this.subscriptions = [];
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.started = false;
    }

    heartbeat() {
        if (Date.now() - this.lastRefreshAt >= this.heartbeatMs) {
            this.scheduleRefresh('heartbeat');
        }
    }

    async refreshSolPrice() {
        try {
            const { data } = await axios.get(
                'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
                { timeout: 10000 }
            );
            const price = data?.solana?.usd;
            if (Number.isFinite(price) && price > 0) {
                this.solPriceUsd = price;
            }
        } catch {
            // keep previous SOL price
        }
    }

    scheduleRefresh(reason = 'event') {
        this.pendingRefresh = true;
        if (this.refreshTimer) return;

        const now = Date.now();
        const waitForBackoff = Math.max(0, this.backoffUntil - now);
        const waitForMinInterval = Math.max(0, this.minRefreshMs - (now - this.lastRefreshAt));
        const delay = Math.max(waitForBackoff, waitForMinInterval, 100);

        this.refreshTimer = setTimeout(async () => {
            this.refreshTimer = null;
            if (!this.pendingRefresh) return;
            this.pendingRefresh = false;
            await this.refreshMarketCap(false);
        }, delay);
    }

    isRateLimitError(error) {
        const msg = String(error?.message || error || '').toLowerCase();
        return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
    }

    noteRateLimit() {
        this.backoffMs = Math.min(this.backoffMs ? this.backoffMs * 2 : 2000, 15000);
        this.backoffUntil = Date.now() + this.backoffMs;
        console.warn(`⏳ RPC rate limited — backing off ${this.backoffMs}ms`);
    }

    noteSuccess() {
        this.backoffMs = 0;
        this.backoffUntil = 0;
    }

    async refreshMarketCap(forceBroadcast = false) {
        if (this.refreshInFlight) {
            this.queuedAfterFlight = true;
            return;
        }

        if (!forceBroadcast && Date.now() < this.backoffUntil) {
            this.pendingRefresh = true;
            this.scheduleRefresh('backoff');
            return;
        }

        this.refreshInFlight = true;
        try {
            await this.checkGraduationIfNeeded(forceBroadcast);

            let marketCapSol = null;
            let source = null;

            if (!this.isGraduated) {
                const summary = await this.sdk.fetchBondingCurveSummary(this.mint);
                marketCapSol = Number(summary.marketCap.toString()) / 1e9;
                source = 'bonding-curve';
            } else {
                marketCapSol = await this.fetchAmmMarketCapSol();
                source = 'amm';
            }

            if (!Number.isFinite(marketCapSol) || marketCapSol <= 0) return;

            this.noteSuccess();
            this.lastRefreshAt = Date.now();

            const marketCapUsd = marketCapSol * this.solPriceUsd;
            const changed = this.lastMarketCapUsd == null
                || Math.abs(marketCapUsd - this.lastMarketCapUsd) > 0.01;

            this.lastMarketCapSol = marketCapSol;
            this.lastMarketCapUsd = marketCapUsd;

            if (changed || forceBroadcast) {
                this.onUpdate({
                    marketCap: marketCapUsd,
                    marketCapSol,
                    solPriceUsd: this.solPriceUsd,
                    source,
                    isGraduated: this.isGraduated,
                    realtime: true,
                });
            }

            const desiredMode = this.isGraduated ? 'amm' : 'bonding-curve';
            if (this.mode !== desiredMode) {
                this.mode = desiredMode;
                await this.setupSubscriptions();
                this.onStatus({
                    mode: this.mode,
                    isGraduated: this.isGraduated,
                    mint: this.mintAddress,
                });
            }
        } catch (error) {
            if (this.isRateLimitError(error)) {
                this.noteRateLimit();
                this.pendingRefresh = true;
                this.scheduleRefresh('rate-limit');
            } else {
                console.error('Market cap refresh failed:', error.message);
            }
        } finally {
            this.refreshInFlight = false;
            if (this.queuedAfterFlight) {
                this.queuedAfterFlight = false;
                this.scheduleRefresh('queued');
            }
        }
    }

    async checkGraduationIfNeeded(force = false) {
        const now = Date.now();
        if (!force && now - this.lastGraduationCheckAt < this.graduationCheckMs && this.mode != null) {
            return;
        }
        this.lastGraduationCheckAt = now;
        this.isGraduated = await this.sdk.isGraduated(this.mint);
        if (this.isGraduated) {
            await this.ensurePoolCache();
        }
    }

    async ensurePoolCache() {
        if (this.poolCache) return this.poolCache;
        const pool = await this.sdk.fetchPool(this.mint);
        this.poolCache = {
            pool,
            baseAccount: pool.poolBaseTokenAccount,
            quoteAccount: pool.poolQuoteTokenAccount,
            poolAddress: canonicalPumpPoolPda(this.mint),
            supplyUi: null,
            supplyFetchedAt: 0,
        };
        return this.poolCache;
    }

    async getSupplyUi() {
        await this.ensurePoolCache();
        const now = Date.now();
        if (this.poolCache.supplyUi && now - this.poolCache.supplyFetchedAt < this.supplyCacheMs) {
            return this.poolCache.supplyUi;
        }
        const supplyInfo = await this.connection.getTokenSupply(this.mint);
        const supplyUi = Number(supplyInfo.value.amount) / 10 ** supplyInfo.value.decimals;
        this.poolCache.supplyUi = supplyUi;
        this.poolCache.supplyFetchedAt = now;
        return supplyUi;
    }

    async fetchAmmMarketCapSol() {
        await this.ensurePoolCache();
        const { baseAccount, quoteAccount } = this.poolCache;

        const [baseBal, quoteBal] = await Promise.all([
            this.connection.getTokenAccountBalance(baseAccount, 'confirmed'),
            this.connection.getTokenAccountBalance(quoteAccount, 'confirmed'),
        ]);

        const baseUi = Number(baseBal.value.uiAmount);
        const quoteUi = Number(quoteBal.value.uiAmount);
        if (!baseUi || !quoteUi) return null;

        const supplyUi = await this.getSupplyUi();
        if (!supplyUi) return null;

        const priceSol = quoteUi / baseUi;
        return priceSol * supplyUi;
    }

    async setupSubscriptions() {
        this.subscriptions.forEach((id) => {
            try {
                this.connection.removeAccountChangeListener(id);
            } catch {}
        });
        this.subscriptions = [];

        if (this.isGraduated) {
            await this.subscribeAmm();
        } else {
            this.subscribeBondingCurve();
        }
    }

    subscribeBondingCurve() {
        const curveAddress = bondingCurvePda(this.mint);
        console.log(`📡 Watching bonding curve (rate-limited): ${curveAddress.toBase58()}`);

        const subId = this.connection.onAccountChange(
            curveAddress,
            () => this.scheduleRefresh('curve'),
            'confirmed'
        );
        this.subscriptions.push(subId);
        this.mode = 'bonding-curve';
    }

    async subscribeAmm() {
        await this.ensurePoolCache();
        const { quoteAccount, poolAddress } = this.poolCache;

        console.log(`📡 Watching AMM quote vault (rate-limited): ${quoteAccount.toBase58()}`);

        // One subscription is enough — quote vault changes on every swap
        const subId = this.connection.onAccountChange(
            quoteAccount,
            () => this.scheduleRefresh('amm'),
            'confirmed'
        );
        this.subscriptions.push(subId);
        this.mode = 'amm';
    }

    getSnapshot() {
        return {
            marketCap: this.lastMarketCapUsd,
            marketCapSol: this.lastMarketCapSol,
            solPriceUsd: this.solPriceUsd,
            isGraduated: this.isGraduated,
            mode: this.mode,
            source: this.mode === 'amm' ? 'amm' : 'bonding-curve',
            realtime: true,
        };
    }
}

module.exports = { PumpMarketMonitor };
