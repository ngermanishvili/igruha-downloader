const fs = require('fs');
const https = require('https');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const BASE = 'https://itorrents-igruha.org';

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

    // Title
    const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (titleMatch) {
        result.title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    } else {
        const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/i);
        result.title = ogTitle ? ogTitle[1].trim() : null;
    }

    // Hero image
    const heroMatch = html.match(/property="og:image"\s+content="([^"]+)"/i) ||
                      html.match(/class="[^"]*poster[^"]*"[^>]*src="([^"]+)"/i);
    result.hero = heroMatch ? heroMatch[1] : null;

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
            result.description = descChunk
                .replace(/<br\s*\/?>/g, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
                .replace(/\n{3,}/g, '\n\n').trim();
        }
    }

    result.sourceUrl = sourceUrl;

    // Info fields from <span> blocks
    const relMatch = html.match(/Release date:\s*([^<]+)/i);
    result.releaseDateRaw = relMatch ? relMatch[1].trim() : null;

    const updMatch = html.match(/<time[^>]*class="updated"[^>]*datetime="([^"]+)"[^>]*>\s*([^<]+)/);
    result.updatedAt = updMatch ? updMatch[2].trim() : null;

    const genreMatch = html.match(/Genre:\s*([^<]+)/i);
    result.genre = genreMatch ? genreMatch[1].trim() : null;

    const devMatch = html.match(/Developer:\s*([^<]+)/i);
    result.developer = devMatch ? devMatch[1].trim() : null;

    const pubMatch = html.match(/Publisher:\s*([^<]+)/i);
    result.publisher = pubMatch ? pubMatch[1].trim() : null;

    const typeMatch = html.match(/Release type:\s*([^<]+)/i);
    result.publicationType = typeMatch ? typeMatch[1].trim() : null;

    const langMatch = html.match(/Interface language:\s*<b>([^<]+)/i) ||
                      html.match(/Interface language:\s*([^<]+)/i);
    result.interfaceLanguage = langMatch ? langMatch[1].replace(/&amp;/g, '&').trim() : null;

    const voiceMatch = html.match(/Voice-over:\s*<b>([^<]+)/i) ||
                       html.match(/Voice-over:\s*([^<]+)/i);
    result.voiceOver = voiceMatch ? voiceMatch[1].replace(/&amp;/g, '&').trim() : null;

    const crackMatch = html.match(/Crack:\s*<b>([^<]+)/i) ||
                       html.match(/Crack:\s*([^<]+)/i);
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

    // Tags (Steam tags from tgv block)
    result.tags = [];
    let tm;
    const tgvIdx = html.indexOf('class="tgv-l"');
    if (tgvIdx > -1) {
        const tgvChunk = html.slice(tgvIdx, html.indexOf('</div>', tgvIdx + 500));
        const tgvTagRegex = /href="\/en\/(?:metki\/)?([^"\/]+)\/?"\s*[^>]*>(?:<i>[^<]*<\/i>)?([^<]+)<\/a>/g;
        while ((tm = tgvTagRegex.exec(tgvChunk))) {
            const slug = tm[1].replace(/\//g, '');
            const label = tm[2].trim();
            if (label && slug) {
                result.tags.push({ slug, label });
            }
        }
    }
    // Fallback: old format
    if (result.tags.length === 0) {
        const tagRegex = /href="\/en\/tags\/([^"]+)"[^>]*>([^<]+)<\/a>/g;
        while ((tm = tagRegex.exec(html))) {
            result.tags.push({ slug: tm[1].replace(/\//g, ''), label: tm[2].trim() });
        }
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

    // Screenshots (highslide gallery)
    result.screenshots = [];
    const ssBlock = html.match(/Screenshots:<\/div>([\s\S]*?)<\/div><\/div>/);
    if (ssBlock) {
        const ssRegex = /href="([^"]+)"\s+rel="highslide"/g;
        while ((tm = ssRegex.exec(ssBlock[1]))) {
            const url = tm[1].startsWith('http') ? tm[1] : BASE + tm[1];
            result.screenshots.push(url);
        }
    }

    // Repack features
    result.repackFeatures = [];
    const repackIdx = html.indexOf('Repack features:');
    if (repackIdx > -1) {
        const extrasIdx2 = html.indexOf('Extras:', repackIdx);
        const endIdx = extrasIdx2 > -1 ? extrasIdx2 : repackIdx + 2000;
        const repackChunk = html.slice(repackIdx, endIdx);
        const features = repackChunk.match(/- ([^<]+)/g);
        if (features) {
            result.repackFeatures = features.map(f => f.replace(/^- /, '').trim());
        }
    }

    // DLC / Extras
    result.dlc = [];
    const extrasIdx = html.indexOf('Extras:');
    if (extrasIdx > -1) {
        const extrasChunk = html.slice(extrasIdx, extrasIdx + 1000);
        const spoilerMatch = extrasChunk.match(/spoiler_text-->(.+?)<!--spoiler_text_end/s);
        if (spoilerMatch) {
            const dlcItems = spoilerMatch[1].split(/<br\s*\/?>/).map(s =>
                s.replace(/<[^>]+>/g, '').replace(/^-\s*/, '').trim()
            ).filter(Boolean);
            result.dlc = dlcItems;
        }
    }

    // Starting the game
    result.startingTheGame = null;
    const startIdx = html.indexOf('Starting the game:');
    if (startIdx > -1) {
        const startChunk = html.slice(startIdx, startIdx + 3000);
        const spoilerMatch = startChunk.match(/spoiler_text-->(.+?)<!--spoiler_text_end/s);
        if (spoilerMatch) {
            const raw = spoilerMatch[1];
            const lines = raw
                .replace(/<br\s*\/?>/g, '\n')
                .replace(/<b>/g, '').replace(/<\/b>/g, '')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
                .replace(/В«/g, '"').replace(/В»/g, '"')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean);

            const warning = lines.find(l => /^Attention|^Warning|^Note/i.test(l)) || null;
            const steps = lines
                .filter(l => /^\d+\./.test(l))
                .map(l => l.replace(/^\d+\.\s*/, '').trim());

            result.startingTheGame = { warning, steps };
        }
    }

    // How to start playing (alternative block)
    if (!result.startingTheGame) {
        const howtoIdx = html.indexOf('How to start playing');
        if (howtoIdx > -1) {
            const howtoChunk = html.slice(howtoIdx, howtoIdx + 2000);
            const textMatch = howtoChunk.match(/howto-text[^>]*>([^<]+)/);
            if (textMatch) {
                result.startingTheGame = {
                    warning: textMatch[1].trim(),
                    steps: []
                };
            }
        }
    }

    // Download size
    const sizeMatch = html.match(/Download size[:\s]*<[^>]*>([^<]+)/i) ||
                      html.match(/Size[:\s]*([0-9.,]+\s*(?:GB|MB|TB))/i);
    result.downloadSize = sizeMatch ? sizeMatch[1].trim() : null;

    // Version
    const verMatch = html.match(/Game version[:\s]*([^<\n]+)/i);
    result.version = verMatch ? verMatch[1].trim() : null;

    // Download links
    result.links = [];
    const torrentRegex = /do=download&(?:amp;)?id=(\d+)[^>]*>([^<]*)</g;
    const seenIds = new Set();
    while ((tm = torrentRegex.exec(html))) {
        const dlId = tm[1];
        if (seenIds.has(dlId)) continue;
        seenIds.add(dlId);
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

function parseInput(input) {
    input = input.trim();

    // Full URL: https://itorrents-igruha.org/en/15151-phantom-blade-zero.html
    const urlMatch = input.match(/itorrents-igruha\.org\/(?:en\/)?(\d+)-([^.]+)\.html/);
    if (urlMatch) {
        return { id: urlMatch[1], slug: `${urlMatch[1]}-${urlMatch[2]}` };
    }

    // Just ID: 15151
    if (/^\d+$/.test(input)) {
        return { id: input, slug: null };
    }

    // ID-slug: 15151-phantom-blade-zero
    const slugMatch = input.match(/^(\d+)-(.+)/);
    if (slugMatch) {
        return { id: slugMatch[1], slug: input };
    }

    console.error('Invalid input. Use a URL, ID, or ID-slug. Examples:');
    console.error('  node scrape-single.js 15151');
    console.error('  node scrape-single.js 15151-phantom-blade-zero');
    console.error('  node scrape-single.js https://itorrents-igruha.org/en/15151-phantom-blade-zero.html');
    process.exit(1);
}

async function main() {
    const input = process.argv[2];
    if (!input) {
        console.error('Usage: node scrape-single.js <url|id|id-slug>');
        console.error('Examples:');
        console.error('  node scrape-single.js 15151');
        console.error('  node scrape-single.js 15151-phantom-blade-zero');
        console.error('  node scrape-single.js https://itorrents-igruha.org/en/15151-phantom-blade-zero.html');
        process.exit(1);
    }

    const { id, slug } = parseInput(input);
    let pageSlug = slug;

    // If we only have an ID, fetch the Russian page first to find the slug
    if (!pageSlug) {
        console.log(`Looking up slug for ID ${id}...`);
        const { status, body } = await fetch(`${BASE}/${id}-.html`);
        if (status === 200) {
            const canonical = body.match(/link rel="canonical" href="[^"]*\/(\d+-[^"]+)\.html"/);
            if (canonical) pageSlug = canonical[1];
        }
        if (!pageSlug) {
            // Try finding from og:url or redirect
            const ogMatch = body && body.match(/property="og:url"\s+content="[^"]*\/(?:en\/)?(\d+-[^"]+)\.html"/);
            if (ogMatch) pageSlug = ogMatch[1];
        }
        if (!pageSlug) {
            console.error(`Could not resolve slug for ID ${id}. Provide the full URL or slug.`);
            process.exit(1);
        }
    }

    const enUrl = `${BASE}/en/${pageSlug}.html`;
    console.log(`Fetching: ${enUrl}`);

    const { status, body } = await fetch(enUrl);
    if (status !== 200) {
        console.error(`Failed to fetch (HTTP ${status}): ${enUrl}`);
        process.exit(1);
    }

    const detail = parseDetail(body, enUrl);
    const result = { [id]: detail };

    const outFile = path.join(DATA_DIR, `${pageSlug}.json`);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`Saved: ${outFile}`);
    console.log(`Title: ${detail.title}`);
    console.log(`Tags: ${detail.tags.map(t => t.label).join(', ')}`);
    console.log(`Links: ${detail.links.length}`);
    if (detail.startingTheGame) console.log(`Starting: ${detail.startingTheGame.steps.length} steps`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
