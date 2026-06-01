/*
 * printctl — Visualiseur read-only du serveur d'impression Windows.
 * Interroge le service Print Spooler via RPC (rpcclient, paquet samba-common-bin).
 * Aucune écriture sur le serveur. Aucune dépendance à SYSVOL / EannaAD.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

// Cache model strings per IP for the lifetime of the plugin process.
// Printer web UIs are slow (1-3s each), so re-querying 23 every page load is
// painful; the model basically never changes anyway.
const modelCache = {};

module.exports.printctl = function (parent) {
    const obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.exports = [];

    function loadCfg() {
        const p = path.join(__dirname, 'printer-config.json');
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
        catch (e) { return null; }
    }

    function sendJson(res, code, payload) {
        res.status(code || 200).set('Content-Type', 'application/json').send(JSON.stringify(payload));
    }

    // Run rpcclient against the print server. We pass credentials via -U DOMAIN/user%pass.
    // Output is parsed line-by-line; rpcclient is the same vintage as Samba 3 so the
    // format is extremely stable. Timeout caps a stuck spooler from hanging the UI.
    function rpc(cmd, cb) {
        const cfg = loadCfg();
        if (!cfg || !cfg.host || !cfg.user || !cfg.password) return cb(new Error('printer-config.json manquant ou incomplet'));
        const user = (cfg.domain ? cfg.domain + '/' : '') + cfg.user + '%' + cfg.password;
        const args = ['-U', user, '//' + cfg.host, '-c', cmd];
        execFile('rpcclient', args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                // rpcclient frequently prints the actual cause in stderr; expose more of it
                // than just the first line so we can debug DOS/permission errors quickly.
                const msg = (stderr || '').trim() || (err.message || '').trim() || 'rpcclient failed';
                return cb(new Error(msg.split('\n').slice(0, 3).join(' | ')));
            }
            cb(null, stdout);
        });
    }

    // Parse `enumprinters 2` output. rpcclient emits one printer per blank-line block,
    // with `key:[value]` lines. We grab the fields we care about.
    function parseEnumprinters(stdout) {
        const blocks = stdout.split(/\n\s*\n/);
        const printers = [];
        const fields = ['printername', 'sharename', 'portname', 'drivername', 'comment', 'location', 'status', 'cjobs', 'servername', 'printprocessor', 'datatype'];
        blocks.forEach((blk) => {
            const lines = blk.split('\n');
            const obj = {};
            let hasAny = false;
            lines.forEach((line) => {
                const m = line.match(/^\s*([a-z_]+):\[(.*)\]\s*$/i);
                if (!m) return;
                const k = m[1].toLowerCase();
                if (fields.indexOf(k) !== -1) {
                    obj[k] = m[2];
                    hasAny = true;
                }
            });
            if (hasAny && obj.printername) {
                obj.cjobs = parseInt(obj.cjobs, 10) || 0;
                printers.push(obj);
            }
        });
        // Drop the built-in Windows virtual printers — they're noise for our use case.
        const VIRTUAL = /(^|\\)(Microsoft (Print to PDF|XPS Document Writer)|Fax|OneNote)( |$)/i;
        const real = printers.filter((p) => !VIRTUAL.test(p.printername || '') && !VIRTUAL.test(p.sharename || ''));
        real.sort((a, b) => (a.printername || '').localeCompare(b.printername || '', 'fr', { numeric: true }));
        return real;
    }

    // Try a handful of patterns. Order matters: we return the first non-empty hit.
    // Strings get trimmed and de-genericised (e.g. drop "Status" / "Welcome" / "EWS").
    function extractModel(html) {
        if (!html) return '';
        const tryPick = (re) => {
            const m = html.match(re);
            return m ? m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim() : '';
        };
        const candidates = [
            tryPick(/<meta[^>]+name="ProductName"[^>]+content="([^"]+)"/i),
            tryPick(/id=["']ProductModel["'][^>]*>\s*([^<]+)</i),
            tryPick(/<title>([^<]+)<\/title>/i),
            tryPick(/Model\s*:?\s*<[^>]+>\s*([^<]+)</i),
        ];
        for (const c of candidates) {
            if (!c) continue;
            // Strip the most common boilerplate suffixes/prefixes on the title.
            let s = c.replace(/^(HP\s+(Embedded\s+)?Web\s+Server\s*[-|]?\s*)/i, '')
                     .replace(/\s*[-|]\s*(EWS|Status|Welcome|Home|Web Server|Embedded Web Server).*$/i, '')
                     .replace(/^Welcome\s+to\s+/i, '')
                     .trim();
            if (s && s.length > 2 && s.length < 120) return s;
        }
        return '';
    }

    obj.server_startup = function () {};

    obj.handleAdminReq = function (req, res, user) {
        const action = (req.query && req.query.action) || '';

        if (action === 'ping') {
            // Smoke test: list printers and report the count. Cheapest non-trivial RPC call.
            const cfg = loadCfg();
            if (!cfg) return sendJson(res, 200, { ok: false, error: 'printer-config.json manquant' });
            return rpc('enumprinters 2', (err, stdout) => {
                if (err) return sendJson(res, 200, { ok: false, host: cfg.host, error: err.message });
                const printers = parseEnumprinters(stdout);
                sendJson(res, 200, { ok: true, host: cfg.host, count: printers.length });
            });
        }

        if (action === 'list') {
            return rpc('enumprinters 2', (err, stdout) => {
                if (err) return sendJson(res, 500, { error: err.message });
                sendJson(res, 200, { printers: parseEnumprinters(stdout) });
            });
        }

        if (action === 'jobs' || action === 'purge') {
            // rpcclient's enumjobs is broken with modern Windows print servers
            // (DOS 0x8001011b on every call), so we shell out to a small Python helper
            // that queries (or deletes) Win32_PrintJob via WMI through impacket instead.
            const cfg = loadCfg();
            if (!cfg) return sendJson(res, 500, { error: 'printer-config.json manquant' });
            const raw = String(req.query.printer || '').trim();
            const printer = raw.replace(/^\\+[^\\]+\\+/, '').replace(/^\\+/, '');
            if (!printer || /["\r\n`$;|&<>]/.test(printer)) return sendJson(res, 400, { error: 'nom imprimante invalide' });
            const mode = action === 'purge' ? 'purge' : 'list';
            const script = path.join(__dirname, 'wmi_print_jobs.py');
            execFile('python3', [script, mode, cfg.host, cfg.user, cfg.password, cfg.domain || '', printer],
                { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
                    if (err && !stdout) {
                        return sendJson(res, 500, { error: (stderr || err.message || 'wmi failed').split('\n')[0] });
                    }
                    try {
                        const obj = JSON.parse(stdout.trim().split('\n').pop());
                        sendJson(res, 200, obj);
                    } catch (e) {
                        sendJson(res, 500, { error: 'invalid WMI output: ' + stdout.slice(0, 200) });
                    }
                });
            return;
        }

        if (action === 'getModel') {
            // Best-effort scrape of the printer's embedded web server. HP, Brother,
            // Lexmark and most others put the model in <title>; some HP firmwares
            // expose a ProductModel field in the body. We give up after 3s — these
            // pages are not standardised and we shouldn't block the UI.
            const ip = String(req.query.ip || '').trim();
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return sendJson(res, 400, { error: 'IP invalide' });
            if (modelCache[ip]) return sendJson(res, 200, { ip: ip, model: modelCache[ip], cached: true });

            // Guard: every error/end path can fire, but the response must be sent
            // exactly once or Node throws ERR_HTTP_HEADERS_SENT and the worker dies.
            let answered = false;
            const sendModel = (model) => {
                if (answered) return;
                answered = true;
                if (model) modelCache[ip] = model;
                try { sendJson(res, 200, { ip: ip, model: model || '' }); } catch (e) {}
            };

            const r = http.get({ host: ip, port: 80, path: '/', timeout: 3000, headers: { 'User-Agent': 'printctl/1.0' } }, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    response.resume();
                    return sendModel('');  // don't follow redirects
                }
                let body = '';
                let size = 0;
                response.on('data', (chunk) => {
                    size += chunk.length;
                    if (size < 200 * 1024) body += chunk.toString('utf8');
                });
                response.on('end', () => sendModel(extractModel(body)));
                response.on('error', () => sendModel(''));
            });
            r.on('timeout', () => { r.destroy(); sendModel(''); });
            r.on('error', () => sendModel(''));
            // Hard ceiling: belt-and-braces in case the socket goes silent without
            // emitting 'timeout' (DNS resolver hangs, half-open TCP, etc.).
            setTimeout(() => { try { r.destroy(); } catch (e) {} sendModel(''); }, 4000);
            return;
        }

        if (action === 'pingPrinter') {
            // Linux `ping -c1 -W1 <ip>` returns rc=0 if alive. Accept only dotted-quad
            // input — ports like "WSD-…uuid" are not pingable and the UI passes "" for them.
            const ip = String(req.query.ip || '').trim();
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return sendJson(res, 400, { error: 'IP invalide' });
            return execFile('ping', ['-c', '1', '-W', '1', ip], (err) => {
                sendJson(res, 200, { ip: ip, alive: !err });
            });
        }

        // Default (no `action`): render the plugin's handlebars view.
        res.render(path.join(__dirname, 'views/printctl'), { user: user });
    };

    return obj;
};
