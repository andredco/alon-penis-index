require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const WebSocket = require('ws');
const { Connection } = require('@solana/web3.js');
const { PumpMarketMonitor } = require('./marketMonitor');
const { createRewardsTimer, loadRewardsKeypair } = require('./rewardsTimer');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN_MINT = process.env.TOKEN_MINT || null;
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://solana-rpc.publicnode.com';
const SOLANA_RPC_WS = process.env.SOLANA_RPC_WS || 'wss://solana-rpc.publicnode.com';
const REWARDS_WALLET = process.env.REWARDS_WALLET || 'J7DErCUYfvs8FFm9psWLqWa1TsbneMCZpa1AXmeBiXMi';

const connection = new Connection(SOLANA_RPC_URL, {
    wsEndpoint: SOLANA_RPC_WS,
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/token', (req, res) => {
    if (TOKEN_MINT) {
        res.json({ token: TOKEN_MINT });
    } else {
        res.status(404).json({ error: 'TOKEN_MINT not configured in .env' });
    }
});

app.get('/api/marketcap/:tokenAddress?', (req, res) => {
    const snapshot = marketMonitor?.getSnapshot();
    if (snapshot?.marketCap != null) {
        return res.json({ ...snapshot, status: 'live' });
    }
    if (lastKnownMarketCap != null) {
        return res.json({ ...lastPayload, marketCap: lastKnownMarketCap, status: 'live' });
    }
    return res.json({ status: 'connecting', marketCap: null, realtime: false });
});

app.get('/api/rewards', (req, res) => {
    if (!rewardsTimer) {
        return res.status(503).json({ error: 'Rewards timer not configured' });
    }
    res.json(rewardsTimer.getSnapshot());
});

app.get('/api/status', (req, res) => {
    res.json({
        token: TOKEN_MINT,
        monitor: marketMonitor?.getSnapshot() || null,
        rewards: rewardsTimer?.getSnapshot() || null,
        rpc: SOLANA_RPC_URL,
    });
});

const server = app.listen(PORT, () => {
    console.log(`Server running: http://localhost:${PORT}`);
});

const wss = new WebSocket.Server({ server });

let lastKnownMarketCap = null;
let lastPayload = {
    status: 'connecting',
    marketCap: null,
    source: null,
    realtime: false,
    isGraduated: false,
};
let lastRewardsPayload = null;

function broadcast(json) {
    const message = JSON.stringify(json);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastMarketCap(payload) {
    lastKnownMarketCap = payload.marketCap;
    lastPayload = { ...payload, status: 'live' };
    broadcast({
        type: 'marketcap',
        status: 'live',
        data: payload.marketCap,
        marketCapSol: payload.marketCapSol,
        source: payload.source,
        isGraduated: payload.isGraduated,
        realtime: payload.realtime,
        solPriceUsd: payload.solPriceUsd,
    });
}

function broadcastRewards(snapshot) {
    lastRewardsPayload = snapshot;
    broadcast({ type: 'rewards', data: snapshot });
}

wss.on('connection', (ws) => {
    console.log('Client connected');
    try {
        ws.send(JSON.stringify({
            type: 'marketcap',
            status: lastPayload.status || (lastKnownMarketCap != null ? 'live' : 'connecting'),
            data: lastKnownMarketCap,
            ...lastPayload,
        }));
        if (lastRewardsPayload) {
            ws.send(JSON.stringify({ type: 'rewards', data: lastRewardsPayload }));
        }
    } catch {}
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

let marketMonitor = null;
let rewardsTimer = null;

if (TOKEN_MINT) {
    marketMonitor = new PumpMarketMonitor({
        mintAddress: TOKEN_MINT,
        rpcUrl: SOLANA_RPC_URL,
        wsUrl: SOLANA_RPC_WS,
        onUpdate: (payload) => {
            console.log(
                `⚡ MC $${payload.marketCap.toFixed(0)} (${payload.marketCapSol.toFixed(2)} SOL) [${payload.source}]`
            );
            broadcastMarketCap(payload);
        },
        onStatus: (status) => {
            console.log(`🔁 Monitor mode: ${status.mode} | graduated=${status.isGraduated}`);
        },
    });

    marketMonitor.start().catch((error) => {
        console.error('Failed to start market monitor:', error.message);
    });
} else {
    console.warn('TOKEN_MINT not set — configure .env for live on-chain tracking');
}

const rewardsKeypair = loadRewardsKeypair(REWARDS_WALLET, process.env.REWARDS_PRIVATE_KEY);
if (!rewardsKeypair) {
    console.warn('REWARDS_PRIVATE_KEY not set — timer will run but auto-distribution is disabled');
}

rewardsTimer = createRewardsTimer({
    connection,
    tokenMint: TOKEN_MINT,
    rewardsWallet: REWARDS_WALLET,
    rewardsKeypair,
    onUpdate: broadcastRewards,
});
rewardsTimer.start();
console.log(`🎁 Holder rewards timer started — wallet ${REWARDS_WALLET}`);
