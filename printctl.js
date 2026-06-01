/*
 * printctl — Visualiseur read-only du serveur d'impression Windows.
 * Interroge le service Print Spooler via RPC (rpcclient, paquet samba-common-bin).
 * Aucune écriture sur le serveur. Aucune dépendance à SYSVOL / EannaAD.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
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

    // snmpget -O qv emits one quoted value per line. hrDeviceDescr is usually
    // a clean "HP LaserJet M203dn"; sysDescr is the noisy multi-field string
    // ("HP ETHERNET MULTI-ENV,SN:…,PID:HP LaserJet M203dn"). For the latter we
    // try to extract just the model from the PID:/MDL: tag.
    function parseSnmpModel(stdout) {
        const lines = stdout.split('\n').map((l) => l.replace(/^"|"$/g, '').trim()).filter(Boolean);
        for (const line of lines) {
            if (/^no such/i.test(line) || /timeout/i.test(line)) continue;
            const tagged = line.match(/(?:PID|MDL):\s*([^,;]+)/i);
            if (tagged) return tagged[1].trim();
            if (line.length < 80 && !line.includes(',')) return line;
        }
        return (lines[0] || '').slice(0, 80);
    }

    function trySnmp(ip, cb) {
        const community = (loadCfg() || {}).snmpCommunity || 'public';
        const args = ['-v', '2c', '-c', community, '-O', 'qv', '-t', '1', '-r', '1', ip,
                      '1.3.6.1.2.1.25.3.2.1.3.1', '1.3.6.1.2.1.1.1.0'];
        execFile('snmpget', args, { timeout: 4000, maxBuffer: 64 * 1024 }, (_err, stdout) => {
            cb(parseSnmpModel(stdout || ''));
        });
    }

    // PJL: send the printer-language standard "INFO ID" query on port 9100.
    // Response looks like: @PJL INFO ID\r\n"HP LaserJet M203dn"\r\n<FF>
    function tryPjl(ip, cb) {
        let done = false;
        let buf = '';
        const finish = (val) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) {}
            cb(val || '');
        };
        const sock = net.connect({ host: ip, port: 9100, timeout: 2500 });
        sock.on('connect', () => {
            // PJL Universal Exit Language wrapper around the INFO ID command.
            sock.write('\x1b%-12345X@PJL INFO ID\r\n\x1b%-12345X');
        });
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            // Most printers reply within a frame; if we have the quoted line we're done.
            const m = buf.match(/"([^"\r\n]{2,80})"/);
            if (m) finish(m[1].trim());
            else if (buf.length > 4096) finish('');
        });
        sock.on('end', () => finish((buf.match(/"([^"\r\n]+)"/) || [])[1] || ''));
        sock.on('timeout', () => finish(''));
        sock.on('error', () => finish(''));
        setTimeout(() => finish(''), 3500);
    }

    // HTTP fallback: scrape <title> / ProductModel meta. Same single-fire guard
    // pattern as PJL to avoid double-response crashes on socket races.
    function tryHttp(ip, cb) {
        let done = false;
        const finish = (val) => { if (done) return; done = true; cb(val || ''); };
        const r = http.get({ host: ip, port: 80, path: '/', timeout: 2500, headers: { 'User-Agent': 'printctl/1.0' } }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return finish(''); }
            let body = '';
            response.on('data', (c) => { if (body.length < 128 * 1024) body += c.toString('utf8'); });
            response.on('end', () => finish(extractHtmlModel(body)));
            response.on('error', () => finish(''));
        });
        r.on('timeout', () => { try { r.destroy(); } catch (e) {} finish(''); });
        r.on('error', () => finish(''));
        setTimeout(() => { try { r.destroy(); } catch (e) {} finish(''); }, 3500);
    }

    function extractHtmlModel(html) {
        if (!html) return '';
        const pick = (re) => { const m = html.match(re); return m ? m[1].replace(/<[^>]+>/g, '').trim() : ''; };
        const cands = [
            pick(/<meta[^>]+name=["']ProductName["'][^>]+content=["']([^"']+)/i),
            pick(/id=["']ProductModel["'][^>]*>\s*([^<]+)</i),
            pick(/<title>([^<]+)<\/title>/i),
        ];
        for (const c of cands) {
            if (!c) continue;
            const s = c.replace(/^(HP\s+(Embedded\s+)?Web\s+Server\s*[-|]?\s*)/i, '')
                       .replace(/\s*[-|]\s*(EWS|Status|Welcome|Home|Web Server|Embedded Web Server).*$/i, '')
                       .replace(/^Welcome\s+to\s+/i, '').trim();
            if (s.length > 2 && s.length < 120) return s;
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
            const ip = String(req.query.ip || '').trim();
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return sendJson(res, 400, { error: 'IP invalide' });
            if (modelCache[ip]) return sendJson(res, 200, { ip: ip, model: modelCache[ip], cached: true, via: 'cache' });

            // Belt-and-braces: every send must go through this, exactly once.
            let answered = false;
            const finish = (model, via) => {
                if (answered) return;
                answered = true;
                if (model) modelCache[ip] = model;
                try { sendJson(res, 200, { ip: ip, model: model || '', via: via }); } catch (e) {}
            };

            // 1) SNMP (snmpget). Fastest, but disabled on some printers.
            trySnmp(ip, (model) => {
                if (model) return finish(model, 'snmp');
                // 2) PJL on port 9100. The print port itself — almost always open.
                tryPjl(ip, (model2) => {
                    if (model2) return finish(model2, 'pjl');
                    // 3) HTTP scrape on port 80. Last resort.
                    tryHttp(ip, (model3) => finish(model3, model3 ? 'http' : 'none'));
                });
            });
            // Hard ceiling so even a buggy fallback can't hang the response.
            setTimeout(() => finish('', 'timeout'), 9000);
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
