require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_MARKETCAP = Number(process.env.DEFAULT_MARKETCAP || 7000);
const MARKETCAP_SOURCE_URL = process.env.MARKETCAP_SOURCE_URL || null; // Optional custom endpoint returning { marketCap }
const TOKEN_MINT = process.env.TOKEN_MINT || null; // Solana token mint for DexScreener

// Helper: fetch market cap from DexScreener by token mint
async function fetchDexScreenerMarketCap(tokenMint) {
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(tokenMint)}`;
        const { data } = await axios.get(url, { timeout: 10000, headers: { 'Accept': 'application/json' } });
        const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
        if (pairs.length === 0) return null;

        // Pick the pair with highest liquidity USD, fallback to highest 24h volume
        const best = pairs
            .slice()
            .sort((a, b) => (Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))
                || (Number(b?.volume?.h24 || 0) - Number(a?.volume?.h24 || 0)))[0];

        const priceUsd = Number(best?.priceUsd || 0);
        const marketCapField = best?.marketCap ?? best?.fdv;
        const marketCap = marketCapField != null ? Number(marketCapField) : null;

        if (Number.isFinite(marketCap) && marketCap > 0) {
            return { marketCap, priceUsd, source: 'dexscreener' };
        }

        // If MC not provided, we cannot reliably compute without supply; return price for potential future use
        if (Number.isFinite(priceUsd) && priceUsd > 0) {
            return { marketCap: null, priceUsd, source: 'dexscreener' };
        }
        return null;
    } catch (e) {
        return null;
    }
}

// Helper: parse DexScreener response (when MARKETCAP_SOURCE_URL points to DexScreener)
function parseDexScreenerResponse(data) {
    try {
        const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
        if (pairs.length === 0) return null;
        const best = pairs
            .slice()
            .sort((a, b) => (Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))
                || (Number(b?.volume?.h24 || 0) - Number(a?.volume?.h24 || 0)))[0];
        const priceUsd = Number(best?.priceUsd || 0);
        const marketCapField = best?.marketCap ?? best?.fdv;
        const marketCap = marketCapField != null ? Number(marketCapField) : null;
        if (Number.isFinite(marketCap) && marketCap > 0) {
            return { marketCap, priceUsd };
        }
        return null;
    } catch {
        return null;
    }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint to get token market cap
app.get('/api/marketcap/:tokenAddress?', async (req, res) => {
    try {
        // Prefer DexScreener if TOKEN_MINT is configured
        if (TOKEN_MINT) {
            const ds = await fetchDexScreenerMarketCap(TOKEN_MINT);
            if (ds && ds.marketCap != null) {
                return res.json({ marketCap: ds.marketCap, price: ds.priceUsd, source: ds.source });
            }
        }
        // If a custom source URL is configured, prefer it
        if (MARKETCAP_SOURCE_URL && /^https?:\/\//i.test(MARKETCAP_SOURCE_URL)) {
            try {
                const { data } = await axios.get(MARKETCAP_SOURCE_URL, { timeout: 10000, headers: { 'Accept': 'application/json' } });
                // If it's DexScreener response shape, parse pairs
                const dsParsed = parseDexScreenerResponse(data);
                if (dsParsed && dsParsed.marketCap != null) {
                    return res.json({ marketCap: dsParsed.marketCap, price: dsParsed.priceUsd, source: 'dexscreener:url' });
                }
                // Otherwise expect { marketCap }
                if (data && typeof data.marketCap === 'number') {
                    return res.json({ marketCap: data.marketCap, source: 'custom' });
                }
            } catch {}
        }
        // No valid source provided or parse failed
        return res.status(503).json({ error: 'Market cap source unavailable. Configure TOKEN_MINT or MARKETCAP_SOURCE_URL.' });
    } catch (error) {
        console.error('Error fetching market cap:', error);
        return res.status(503).json({ error: 'Failed to fetch market cap data' });
    }
});

// Create WebSocket server for real-time updates
const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

const wss = new WebSocket.Server({ server });

// Broadcast market cap updates to all connected clients
let lastKnownMarketCap = DEFAULT_MARKETCAP; // Initial value only; no BTC/simulation fallback

setInterval(async () => {
    try {
        let marketCap = null;
        // Prefer DexScreener if TOKEN_MINT is configured
        if (TOKEN_MINT) {
            const ds = await fetchDexScreenerMarketCap(TOKEN_MINT);
            if (ds && ds.marketCap != null) {
                marketCap = ds.marketCap;
            }
        }
        if (!marketCap && MARKETCAP_SOURCE_URL && /^https?:\/\//i.test(MARKETCAP_SOURCE_URL)) {
            try {
                const { data } = await axios.get(MARKETCAP_SOURCE_URL, { timeout: 10000, headers: { 'Accept': 'application/json' } });
                const dsParsed = parseDexScreenerResponse(data);
                if (dsParsed && dsParsed.marketCap != null) {
                    marketCap = dsParsed.marketCap;
                } else if (data && typeof data.marketCap === 'number') {
                    marketCap = data.marketCap;
                }
            } catch {}
        }
        if (marketCap != null) {
            lastKnownMarketCap = marketCap; // Update last known value on success
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'marketcap', data: marketCap }));
                }
            });
        }
    } catch (error) {
        console.error('Error broadcasting market cap:', error);
        // No simulation or BTC fallback; keep lastKnownMarketCap unchanged
    }
}, 10000); // Update every 10 seconds

wss.on('connection', (ws) => {
    console.log('Client connected');
    // Send the latest known market cap immediately upon connection
    try {
        ws.send(JSON.stringify({ type: 'marketcap', data: lastKnownMarketCap }));
    } catch {}
    ws.on('close', () => {
        console.log('Client disconnected');
    });
}); 