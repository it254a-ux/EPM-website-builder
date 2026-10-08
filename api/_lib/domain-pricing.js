// What an operator pays for a domain.
//   profit  = the bigger of  (profit % of the domain's cost)  and  (the minimum profit)
//   price   = (cost + profit) / (1 - buffer %), rounded UP to the next cent
// The buffer covers the payment fee and small exchange-rate moves, so after those you keep cost + profit.
// All money is worked out in whole cents (no decimals) so rounding never drifts.
//
// Settings (Vercel environment variables), all optional:
//   DOMAIN_PROFIT_PERCENT  default 12   (0 to 100)
//   DOMAIN_MIN_PROFIT_USD  default 2    (0 to 100)
//   DOMAIN_BUFFER_PERCENT  default 4    (0 to 30)
//   KES_PER_USD            no default: how many Kenya shillings one US dollar is today. Needed to show prices in KES.
//   KES_ROUND_TO           optional, default 10: shilling prices are rounded UP to a multiple of this.

const env = k => String(process.env[k] || '').trim();

function num(key, fallback, lo, hi) {
    const raw = env(key);
    if (raw === '') return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
}

function settings() {
    return {
        profitPercent: num('DOMAIN_PROFIT_PERCENT', 12, 0, 100),
        minProfitUsd: num('DOMAIN_MIN_PROFIT_USD', 2, 0, 100),
        bufferPercent: num('DOMAIN_BUFFER_PERCENT', 4, 0, 30),
        kesPerUsd: num('KES_PER_USD', 0, 0, 100000),
        kesRoundTo: Math.max(1, Math.round(num('KES_ROUND_TO', 10, 1, 1000))),
    };
}

const toCents = usd => Math.round(Number(usd) * 100);
const ceilDiv = (a, b) => { const q = a + b - 1; return (q - (q % b)) / b; };

// costUsd: what Vercel charges you (a number such as 0.99).
// Returns whole cents: { costCents, profitCents, priceCents } or null when the cost is not a usable number.
function priceFor(costUsd, s = settings()) {
    const cost = Number(costUsd);
    if (!Number.isFinite(cost) || cost <= 0) return null;
    const costCents = toCents(cost);
    const pctBp = Math.round(s.profitPercent * 100);                 // basis points: 12% = 1200
    const bufBp = Math.round(s.bufferPercent * 100);
    const profitCents = Math.max(Math.round(costCents * pctBp / 10000), toCents(s.minProfitUsd));
    const priceCents = ceilDiv((costCents + profitCents) * 10000, 10000 - bufBp);
    return { costCents, profitCents, priceCents };
}

// Shillings for a price in cents, rounded UP to the next multiple of kesRoundTo. Returns null when no rate is set.
function toKes(priceCents, s = settings()) {
    if (!(s.kesPerUsd > 0)) return null;
    // Work in thousandths of a shilling so the rate's decimals do not cause a wrong round-up.
    const milli = Math.round(priceCents * Math.round(s.kesPerUsd * 1000) / 100);
    return ceilDiv(milli, s.kesRoundTo * 1000) * s.kesRoundTo;
}

const formatUsd = cents => '$' + (cents / 100).toFixed(2);

module.exports = { settings, priceFor, toKes, formatUsd, toCents };
