const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const DATA_DIR = path.join(__dirname, 'data');
const ORIG_DIR = path.join(__dirname, 'torrents', 'originals');
const MG_DIR = path.join(__dirname, 'torrents', 'mg');
const PROXY_FILE = path.join(DATA_DIR, 'details', 'proxies.fr.txt');
const SOURCE_HOST = 'itorrents-igruha.org';
const CONCURRENCY = 10;
const DELAY = 100;

// --- Load proxies ---
function loadProxies() {
    const lines = fs.readFileSync(PROXY_FILE, 'utf-8').trim().split('\n');
    return lines.map(line => {
        const [ip, port, user, pass] = line.trim().split(':');
        return { host: ip, port: parseInt(port), user, pass };
    }).filter(p => p.host && p.port);
}

// --- Bencode decoder ---
function decode(buf, pos = { i: 0 }) {
    const c = buf[pos.i];
    if (c === 0x64) {
        pos.i++;
        const obj = {};
        const keys = [];
        while (buf[pos.i] !== 0x65) {
            const key = decode(buf, pos).toString('utf-8');
            keys.push(key);
            obj[key] = decode(buf, pos);
        }
        pos.i++;
        obj._keys = keys;
        return obj;
    } else if (c === 0x6c) {
        pos.i++;
        const arr = [];
        while (buf[pos.i] !== 0x65) arr.push(decode(buf, pos));
        pos.i++;
        return arr;
    } else if (c === 0x69) {
        pos.i++;
        const end = buf.indexOf(0x65, pos.i);
        const num = parseInt(buf.slice(pos.i, end).toString(), 10);
        pos.i = end + 1;
        return num;
    } else {
        const colon = buf.indexOf(0x3a, pos.i);
        const len = parseInt(buf.slice(pos.i, colon).toString(), 10);
        pos.i = colon + 1;
        const str = buf.slice(pos.i, pos.i + len);
        pos.i += len;
        return str;
    }
}

// --- Bencode encoder ---
function encode(val) {
    if (Buffer.isBuffer(val)) return Buffer.concat([Buffer.from(val.length + ':'), val]);
    if (typeof val === 'string') { const b = Buffer.from(val, 'utf-8'); return Buffer.concat([Buffer.from(b.length + ':'), b]); }
    if (typeof val === 'number') return Buffer.from('i' + val + 'e');
    if (Array.isArray(val)) return Buffer.concat([Buffer.from('l'), ...val.map(encode), Buffer.from('e')]);
    if (typeof val === 'object') {
        const keys = val._keys || Object.keys(val).filter(k => k !== '_keys').sort();
        const parts = [Buffer.from('d')];
        for (const k of keys) { if (k === '_keys') continue; parts.push(encode(k)); parts.push(encode(val[k])); }
        parts.push(Buffer.from('e'));
        return Buffer.concat(parts);
    }
}

// --- Fetch through proxy ---
function fetchViaProxy(targetUrl, proxy) {
    return new Promise((resolve, reject) => {
        const target = new URL(targetUrl);
        const auth = Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');

        const connectReq = http.request({
            host: proxy.host,
            port: proxy.port,
            method: 'CONNECT',
            path: `${target.hostname}:443`,
            headers: { 'Proxy-Authorization': `Basic ${auth}` },
            timeout: 15000,
        });

        connectReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                return reject(new Error(`CONNECT ${res.statusCode}`));
            }

            const req = https.request({
                hostname: target.hostname,
                path: target.pathname + target.search,
                method: 'GET',
                socket: socket,
                agent: false,
                headers: {
                    'Host': target.hostname,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': `https://${SOURCE_HOST}/`,
                },
                timeout: 15000,
            }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
                res.on('error', reject);
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
        });

        connectReq.on('error', reject);
        connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('connect timeout')); });
        connectReq.end();
    });
}

function rebrandTorrent(buf) {
    try {
        const torrent = decode(buf);
        const rawName = torrent.info?.name?.toString('utf-8') || 'unknown';
        const cleanName = rawName.replace(/\.[^.]+$/, '').replace(/[._-]/g, ' ').trim();
        torrent.comment = `${cleanName} - MaxGames.cc`;
        torrent['created by'] = `${cleanName} - MaxGames.cc`;
        delete torrent.publisher;
        delete torrent['publisher-url'];
        if (torrent._keys) torrent._keys = torrent._keys.filter(k => k !== 'publisher' && k !== 'publisher-url');
        return encode(torrent);
    } catch { return null; }
}

function sanitizeFilename(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

async function processOne(gameTitle, dlId, proxy) {
    const url = `https://${SOURCE_HOST}/engine/download.php?id=${dlId}`;
    const safeName = sanitizeFilename(gameTitle);

    try {
        const { status, buf } = await fetchViaProxy(url, proxy);
        if (status !== 200) return { dlId, status: 'http-' + status };
        if (buf.length < 50 || buf.slice(0, 1).toString() !== 'd') return { dlId, status: 'not-torrent' };

        fs.writeFileSync(path.join(ORIG_DIR, `${safeName} [${dlId}].torrent`), buf);

        const rebranded = rebrandTorrent(buf);
        if (!rebranded) return { dlId, status: 'parse-error' };

        fs.writeFileSync(path.join(MG_DIR, `${safeName} [mg${dlId}].torrent`), rebranded);
        return { dlId, status: 'ok' };
    } catch (e) {
        return { dlId, status: 'error', msg: e.message };
    }
}

async function main() {
    const proxies = loadProxies();
    console.log(`Loaded ${proxies.length} proxies`);

    const detailsDir = path.join(DATA_DIR, 'details');
    const jobs = [];
    const seenDlIds = new Set();

    const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf-8'));
    const titleMap = new Map(catalog.map(g => [g.id, g.title]));

    for (const f of fs.readdirSync(detailsDir)) {
        if (!f.endsWith('.json')) continue;
        const data = JSON.parse(fs.readFileSync(path.join(detailsDir, f), 'utf-8'));
        for (const [gameId, entry] of Object.entries(data)) {
            if (!entry.links) continue;
            for (const link of entry.links) {
                if (link.kind !== 'torrent') continue;
                const idMatch = link.href.match(/id=(\d+)/);
                if (!idMatch) continue;
                const dlId = idMatch[1];
                if (seenDlIds.has(dlId)) continue;
                seenDlIds.add(dlId);
                jobs.push({ title: titleMap.get(gameId) || `game_${gameId}`, dlId, gameId });
            }
        }
    }

    console.log(`Total torrent links: ${jobs.length}`);
    console.log(`Concurrency: ${CONCURRENCY} | Proxies: ${proxies.length}`);
    console.log(`Originals -> ${ORIG_DIR}`);
    console.log(`Rebranded -> ${MG_DIR}\n`);

    let ok = 0, fail = 0;
    let proxyIdx = 0;
    const startTime = Date.now();

    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        const batch = jobs.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((j, batchIdx) => {
            const proxy = proxies[(proxyIdx + batchIdx) % proxies.length];
            return processOne(j.title, j.dlId, proxy);
        }));
        proxyIdx = (proxyIdx + CONCURRENCY) % proxies.length;

        for (const res of results) {
            if (res.status === 'ok') ok++;
            else {
                fail++;
                if (fail <= 20) console.log(`  FAIL id=${res.dlId}: ${res.status} ${res.msg || ''}`);
            }
        }

        const done = Math.min(i + CONCURRENCY, jobs.length);
        if (done % 100 < CONCURRENCY || done >= jobs.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            const rate = done / (elapsed || 1);
            const eta = ((jobs.length - done) / rate).toFixed(0);
            console.log(`[${done}/${jobs.length}] ok:${ok} fail:${fail} | ${elapsed}s elapsed ~${eta}s left`);
        }

        if (i + CONCURRENCY < jobs.length) await new Promise(r => setTimeout(r, DELAY));
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== DONE in ${totalTime}s ===`);
    console.log(`OK: ${ok} | Failed: ${fail}`);
}

main().catch(console.error);
