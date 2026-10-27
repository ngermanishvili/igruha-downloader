const fs = require('fs');

// --- Bencode decoder ---
function decode(buf, pos = { i: 0 }) {
    const c = buf[pos.i];
    if (c === 0x64) { // 'd' dict
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
    } else if (c === 0x6c) { // 'l' list
        pos.i++;
        const arr = [];
        while (buf[pos.i] !== 0x65) arr.push(decode(buf, pos));
        pos.i++;
        return arr;
    } else if (c === 0x69) { // 'i' integer
        pos.i++;
        const end = buf.indexOf(0x65, pos.i);
        const num = parseInt(buf.slice(pos.i, end).toString(), 10);
        pos.i = end + 1;
        return num;
    } else { // string (as Buffer)
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
    if (Buffer.isBuffer(val)) {
        return Buffer.concat([Buffer.from(val.length + ':'), val]);
    }
    if (typeof val === 'string') {
        const b = Buffer.from(val, 'utf-8');
        return Buffer.concat([Buffer.from(b.length + ':'), b]);
    }
    if (typeof val === 'number') {
        return Buffer.from('i' + val + 'e');
    }
    if (Array.isArray(val)) {
        return Buffer.concat([Buffer.from('l'), ...val.map(encode), Buffer.from('e')]);
    }
    if (typeof val === 'object') {
        const keys = val._keys || Object.keys(val).filter(k => k !== '_keys').sort();
        const parts = [Buffer.from('d')];
        for (const k of keys) {
            if (k === '_keys') continue;
            parts.push(encode(k));
            parts.push(encode(val[k]));
        }
        parts.push(Buffer.from('e'));
        return Buffer.concat(parts);
    }
}

// --- Main ---
const inputPath = '/Users/gerwki/Desktop/test-igruha/original.torrent';
const outputPath = '/Users/gerwki/Desktop/test-igruha/modified.torrent';

const buf = fs.readFileSync(inputPath);
const torrent = decode(buf);

// Show original metadata
console.log('=== ORIGINAL METADATA ===');
console.log('comment:', torrent.comment?.toString('utf-8'));
console.log('created by:', torrent['created by']?.toString('utf-8'));
console.log('publisher:', torrent.publisher?.toString('utf-8'));
console.log('publisher-url:', torrent['publisher-url']?.toString('utf-8'));
console.log('name:', torrent.info?.name?.toString('utf-8'));

// Modify metadata - include filename, strip all igruha/rutracker references
const rawName = torrent.info?.name?.toString('utf-8') || 'unknown';
const cleanName = rawName.replace(/\.[^.]+$/, '').replace(/[._-]/g, ' ').trim();
torrent.comment = `${cleanName} - MaxGames.cc`;
torrent['created by'] = `${cleanName} - MaxGames.cc`;

// Remove publisher fields
delete torrent.publisher;
delete torrent['publisher-url'];
torrent._keys = torrent._keys.filter(k => k !== 'publisher' && k !== 'publisher-url');

// Write modified torrent
const output = encode(torrent);
fs.writeFileSync(outputPath, output);

// Verify
const verify = decode(fs.readFileSync(outputPath));
console.log('\n=== MODIFIED METADATA ===');
console.log('comment:', verify.comment?.toString('utf-8'));
console.log('created by:', verify['created by']?.toString('utf-8'));
console.log('publisher:', verify.publisher?.toString('utf-8') || '(removed)');
console.log('publisher-url:', verify['publisher-url']?.toString('utf-8') || '(removed)');
console.log('name:', verify.info?.name?.toString('utf-8'));
console.log('\nSaved to:', outputPath);
