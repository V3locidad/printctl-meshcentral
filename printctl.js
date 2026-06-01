/*
 * printctl — Visualiseur read-only du serveur d'impression Windows.
 * Interroge le service Print Spooler via RPC (rpcclient, paquet samba-common-bin).
 * Aucune écriture sur le serveur. Aucune dépendance à SYSVOL / EannaAD.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
            if (err) return cb(new Error((stderr || err.message).split('\n')[0]));
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
        printers.sort((a, b) => (a.printername || '').localeCompare(b.printername || '', 'fr', { numeric: true }));
        return printers;
    }

    // Parse `enumjobs <printer>` output. Same block layout as enumprinters.
    function parseEnumjobs(stdout) {
        const blocks = stdout.split(/\n\s*\n/);
        const jobs = [];
        const fields = ['jobid', 'printername', 'username', 'document', 'datatype', 'status', 'priority', 'size', 'submitted', 'totalpages', 'pagesprinted'];
        blocks.forEach((blk) => {
            const lines = blk.split('\n');
            const obj = {};
            let hasAny = false;
            lines.forEach((line) => {
                const m = line.match(/^\s*([a-z_]+):\[(.*)\]\s*$/i);
                if (!m) return;
                const k = m[1].toLowerCase();
                if (fields.indexOf(k) !== -1) { obj[k] = m[2]; hasAny = true; }
            });
            if (hasAny && obj.jobid) jobs.push(obj);
        });
        return jobs;
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

        if (action === 'jobs') {
            const p = String(req.query.printer || '').trim();
            // Allow only printable ASCII for the printer name; rpcclient -c is shell-quoted
            // by execFile so injection isn't possible, but we still reject garbage.
            if (!p || /["\r\n`$\\]/.test(p)) return sendJson(res, 400, { error: 'printer invalide' });
            return rpc('enumjobs "' + p + '"', (err, stdout) => {
                if (err) return sendJson(res, 500, { error: err.message });
                sendJson(res, 200, { printer: p, jobs: parseEnumjobs(stdout) });
            });
        }

        // Default (no `action`): render the plugin's handlebars view.
        res.render(path.join(__dirname, 'views/printctl'), { user: user });
    };

    return obj;
};
