const fs = require('fs');
const https = require('https');
const path = require('path');

const SCRATCH = path.dirname(__filename || process.argv[1]);
const DATA_DIR = '/Users/gerwki/Desktop/test-igruha/data';
const BASE = 'https://itorrents-igruha.org';
const DELAY = 500;

const games = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'new-games-list.json'), 'utf-8'));

function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,*/*',
            }
        }, (res) => {
            if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
                return fetch(res.headers.location).then(resolve).catch(reject);
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function parseDetail(html, sourceUrl) {
    const result = {};

    // Description
    const exIdx = html.indexOf('exampleone');
    if (exIdx > -1) {
        const chunk = html.slice(exIdx, exIdx + 10000);
        const descStart = chunk.indexOf('</b>');
        if (descStart > -1) {
            let descChunk = chunk.slice(descStart + 4);
            const endMarkers = ['<hr', '<div class="is-centered">', '<div class="howto'];
            let endIdx = descChunk.length;
            for (const marker of endMarkers) {
                const i = descChunk.indexOf(marker);
                if (i > -1 && i < endIdx) endIdx = i;
            }
            descChunk = descChunk.slice(0, endIdx);
            result.description = descChunk.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
        }
    }

    result.sourceUrl = sourceUrl;

    // Release date
    const relMatch = html.match(/Release date[:\s]*<[^>]*>([^<]+)/i) || html.match(/Release:\s*<[^>]*>([^<]+)/i);
    result.releaseDateRaw = relMatch ? relMatch[1].trim() : null;

    // Updated
    const updMatch = html.match(/<time[^>]*class="updated"[^>]*datetime="([^"]+)"[^>]*>\s*([^<]+)/);
    result.updatedAt = updMatch ? updMatch[2].trim() : null;

    // Interface language
    const langMatch = html.match(/Interface language[^<]*<\/[^>]+>\s*([^<]+)/i) ||
                      html.match(/Interface[:\s]*<[^>]*>([^<]+)/i);
    result.interfaceLanguage = langMatch ? langMatch[1].replace(/&amp;/g, '&').trim() : null;

    // Voice
    const voiceMatch = html.match(/Voice[:\s]*<\/[^>]+>\s*([^<]+)/i);
    result.voiceOver = voiceMatch ? voiceMatch[1].trim() : null;

    // Crack
    const crackMatch = html.match(/Crack[:\s]*<\/[^>]+>\s*([^<]+)/i) ||
                       html.match(/crack[^>]*>([^<]+)/i);
    result.crack = crackMatch ? crackMatch[1].replace(/&amp;/g, '&').trim() : null;

    // Steam reviews
    const steamMatch = html.match(/steam[^>]*>([^<]*(?:Positive|Negative|Mixed)[^<]*)<[\s\S]*?\((\d+%[^)]*)\)/i);
    result.steamReviews = steamMatch ? `${steamMatch[1].trim()} (${steamMatch[2]})` : null;

    // Changes
    const changesMatch = html.match(/Changes:<\/b>\s*<span[^>]*>([^<]+)/i);
    result.changes = changesMatch ? changesMatch[1].trim() : null;

    // System requirements
    result.sysreq = {};
    const sysIdx = html.indexOf('System requirements:');
    if (sysIdx > -1) {
        const sysChunk = html.slice(sysIdx, sysIdx + 1000);
        const osMatch = sysChunk.match(/OS:\s*([^<]+)/i);
        const cpuMatch = sysChunk.match(/Processor:\s*([^<]+)/i);
        const ramMatch = sysChunk.match(/Memory:\s*([^<]+)/i);
        const gpuMatch = sysChunk.match(/Graphics:\s*([^<]+)/i);
        const storageMatch = sysChunk.match(/Storage:\s*([^<]+)/i);
        if (osMatch) result.sysreq.os = osMatch[1].trim();
        if (cpuMatch) result.sysreq.processor = cpuMatch[1].trim();
        if (ramMatch) result.sysreq.memory = ramMatch[1].trim();
        if (gpuMatch) result.sysreq.graphics = gpuMatch[1].trim();
        if (storageMatch) result.sysreq.storage = storageMatch[1].trim();
    }

    // Tags
    result.tags = [];
    const tagRegex = /href="\/en\/tags\/([^"]+)"[^>]*>([^<]+)<\/a>/g;
    let tm;
    while ((tm = tagRegex.exec(html))) {
        result.tags.push({ slug: tm[1].replace(/\//g, ''), label: tm[2].trim() });
    }

    // Categories
    result.categories = [];
    const catRegex = /href="\/en\/([^"]+)\/"[^>]*class="chip[^"]*"[^>]*>[^<]*<\/svg>([^<]+)<\/a>/g;
    while ((tm = catRegex.exec(html))) {
        const label = tm[2].trim();
        if (label && !['Igruha repacks', 'Premium', 'Login'].includes(label)) {
            result.categories.push(label);
        }
    }

    // Download links
    result.links = [];
    // Torrent links
    const torrentRegex = /do=download&(?:amp;)?id=(\d+)[^>]*>([^<]*)</g;
    const seenIds = new Set();
    while ((tm = torrentRegex.exec(html))) {
        const dlId = tm[1];
        if (seenIds.has(dlId)) continue;
        seenIds.add(dlId);
        const label = tm[2].trim();

        // Find downloads count near this link
        const nearbyChunk = html.slice(tm.index, tm.index + 500);
        const dlCount = nearbyChunk.match(/Downloads:\s*([\d,]+)/i);

        result.links.push({
            n: result.links.length + 1,
            label: `Download torrent${dlCount ? ' Downloads: ' + dlCount[1].replace(/,/g, '') : ''}`,
            kind: 'torrent',
            href: `/en/?do=download&id=${dlId}`,
            downloads: dlCount ? parseInt(dlCount[1].replace(/,/g, ''), 10) : null
        });
    }

    // Direct links
    if (html.includes('#vipfast-modal')) {
        result.links.push({
            n: result.links.length + 1,
            label: 'Download directly',
            kind: 'direct',
            href: '#vipfast-modal',
            downloads: null
        });
    }

    return result;
}

async function main() {
    const catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf-8'));
    const catalogMap = new Map(catalog.map(g => [g.id, g]));

    let newCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    const newDetails = {};

    for (let i = 0; i < games.length; i++) {
        const game = games[i];
        const url = BASE + game.path;

        process.stdout.write(`[${i+1}/${games.length}] ${game.title}... `);

        try {
            const { status, body } = await fetch(url);
            if (status !== 200) {
                console.log(`SKIP (${status})`);
                failedCount++;
                continue;
            }

            const detail = parseDetail(body, url);

            // Only keep if has torrent links
            if (detail.links.filter(l => l.kind === 'torrent').length === 0) {
                console.log('SKIP (no torrent)');
                continue;
            }

            newDetails[game.id] = detail;

            // Update or add to catalog
            if (!catalogMap.has(game.id)) {
                const entry = {
                    id: game.id,
                    slug: game.path.split('/').pop().replace('.html', ''),
                    title: game.title,
                    cover: game.cover,
                    genres: detail.categories || [],
                    platforms: ['PC'],
                    tags: detail.tags.map(t => t.label),
                    year: detail.releaseDateRaw ? detail.releaseDateRaw.match(/\d{4}/)?.[0] || null : null,
                    date: detail.releaseDateRaw,
                    developer: null,
                    publisher: null,
                    rating: null,
                    ratingCount: 0,
                    views: 0,
                    downloads: detail.links[0]?.downloads || null,
                    igdbCover: null,
                    adult: false,
                    linkCount: detail.links.length,
                    capturedAt: new Date().toISOString()
                };
                catalog.push(entry);
                catalogMap.set(game.id, entry);
                newCount++;
                console.log('NEW');
            } else {
                // Update existing
                const existing = catalogMap.get(game.id);
                existing.linkCount = detail.links.length;
                if (detail.links[0]?.downloads) existing.downloads = detail.links[0].downloads;
                existing.capturedAt = new Date().toISOString();
                updatedCount++;
                console.log('UPDATED');
            }
        } catch (err) {
            console.log('ERROR:', err.message);
            failedCount++;
        }

        // Rate limiting
        if (i < games.length - 1) await new Promise(r => setTimeout(r, DELAY));
    }

    // Save catalog
    fs.writeFileSync(path.join(DATA_DIR, 'catalog.json'), JSON.stringify(catalog, null, 2));

    // Add new details to detail files
    // Find the right detail file to add to (use the last one or create logic)
    const detailsDir = path.join(DATA_DIR, 'details');
    const detailFiles = fs.readdirSync(detailsDir).sort((a, b) => parseInt(a) - parseInt(b));

    // Load existing details to check which games already exist
    const existingIds = new Set();
    for (const f of detailFiles) {
        const data = JSON.parse(fs.readFileSync(path.join(detailsDir, f), 'utf-8'));
        for (const id of Object.keys(data)) existingIds.add(id);
    }

    // Add new game details to existing files or update
    for (const [id, detail] of Object.entries(newDetails)) {
        if (existingIds.has(id)) {
            // Update in existing file
            for (const f of detailFiles) {
                const filePath = path.join(detailsDir, f);
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (data[id]) {
                    data[id] = detail;
                    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
                    break;
                }
            }
        } else {
            // Add to the last detail file
            const lastFile = detailFiles[detailFiles.length - 1];
            const filePath = path.join(detailsDir, lastFile);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            data[id] = detail;
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        }
    }

    console.log('\n=== DONE ===');
    console.log('New games added:', newCount);
    console.log('Updated games:', updatedCount);
    console.log('Failed:', failedCount);
    console.log('Total catalog:', catalog.length);
}

main().catch(console.error);
