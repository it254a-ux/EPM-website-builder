// Checks whether a domain already points at the platform (Vercel). Resolver is injectable for tests.
const dns = require('dns').promises;

const A_PREFIXES = ['76.76.21.', '216.198.79.', '66.33.60.'];

async function checkDomain(domain, resolver = dns) {
    const out = { domain, pointing: false, cname: [], a: [] };
    try { out.cname = await resolver.resolveCname(domain); } catch (e) { /* no CNAME */ }
    try { out.a = await resolver.resolve4(domain); } catch (e) { /* no A */ }
    const cnameOk = out.cname.some(c => /vercel-dns/i.test(c));
    const aOk = out.a.some(ip => A_PREFIXES.some(p => ip.startsWith(p)));
    out.pointing = cnameOk || aOk;
    return out;
}

module.exports = { checkDomain };
