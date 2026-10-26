const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const SOURCE_HOST = 'itorrents-igruha.org';

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);

    // Proxy download endpoint
    if (parsed.pathname === '/download') {
        const id = parsed.query.id;
        if (!id) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing id parameter');
            return;
        }

        // Use the direct download.php endpoint
        const sourceUrl = `https://${SOURCE_HOST}/engine/download.php?id=${encodeURIComponent(id)}`;

        const fetchTorrent = (fetchUrl, redirectCount = 0) => {
            if (redirectCount > 5) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Too many redirects');
                return;
            }

            https.get(fetchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Referer': `https://${SOURCE_HOST}/?do=download&id=${encodeURIComponent(id)}`,
                }
            }, (proxyRes) => {
                // Follow redirects
                if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                    fetchTorrent(proxyRes.headers.location, redirectCount + 1);
                    return;
                }

                if (proxyRes.statusCode !== 200) {
                    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/plain' });
                    res.end(`Source returned status ${proxyRes.statusCode}`);
                    return;
                }

                // Get filename from Content-Disposition header
                let filename = `download_${id}.torrent`;
                const disposition = proxyRes.headers['content-disposition'];
                if (disposition) {
                    // Try filename*=UTF-8'' first (RFC 5987)
                    const utf8Match = disposition.match(/filename\*=UTF-8''([^;\s]+)/i);
                    if (utf8Match) {
                        filename = decodeURIComponent(utf8Match[1]);
                    } else {
                        const basicMatch = disposition.match(/filename="?([^";]+)"?/i);
                        if (basicMatch) {
                            filename = basicMatch[1];
                        }
                    }
                }

                // Stream the torrent file to the client
                res.writeHead(200, {
                    'Content-Type': 'application/x-bittorrent',
                    'Content-Disposition': `attachment; filename="${filename}"`,
                });
                proxyRes.pipe(res);

            }).on('error', (err) => {
                console.error('Proxy error:', err.message);
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Failed to fetch from source');
            });
        };

        fetchTorrent(sourceUrl);
        return;
    }

    // Serve static files (index.html, etc.)
    let filePath = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
    filePath = path.join(__dirname, filePath);

    // Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath);
    const mimeTypes = {
        '.html': 'text/html',
        '.css': 'text/css',
        '.js': 'application/javascript',
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
