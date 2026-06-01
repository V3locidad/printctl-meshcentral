/*
 * printctl — Visualiseur read-only des imprimantes déployées par GPO.
 * Lit Imprimantes_Par_OU.json (produit par EannaAD, déposé dans SYSVOL).
 * Aucune écriture : l'édition reste dans EannaAD.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

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

    function readPrinterJson() {
        const cfg = loadCfg();
        if (!cfg || !cfg.jsonPath) throw new Error('printer-config.json manquant ou jsonPath non défini');
        const raw = fs.readFileSync(cfg.jsonPath, 'utf8');
        return JSON.parse(raw);
    }

    // Translate the raw JSON into a tidy structure for the UI.
    // The JSON mixes top-level scalars (ServeurImpression, IPServeurImpression) with
    // per-room objects keyed by room name; we tease them apart here.
    function parsePrinters(json) {
        const out = { server: null, ip: null, salles: [] };
        Object.keys(json).forEach((k) => {
            const v = json[k];
            if (k === 'ServeurImpression') { out.server = v; return; }
            if (k === 'IPServeurImpression') { out.ip = v; return; }
            if (v && typeof v === 'object') {
                out.salles.push({
                    name: k,
                    eleves: Array.isArray(v.eleves) ? v.eleves : [],
                    personnels: Array.isArray(v.personnels) ? v.personnels : []
                });
            }
        });
        out.salles.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
        return out;
    }

    obj.server_startup = function () {};

    obj.handleAdminReq = function (req, res /*, user */) {
        const action = (req.query && req.query.action) || '';

        if (action === 'ping') {
            // Smoke test: confirm we can read the JSON and report basic stats.
            try {
                const cfg = loadCfg();
                if (!cfg) return sendJson(res, 200, { ok: false, error: 'printer-config.json manquant' });
                const parsed = parsePrinters(readPrinterJson());
                const totalPrinters = parsed.salles.reduce((n, s) => n + s.eleves.length + s.personnels.length, 0);
                return sendJson(res, 200, { ok: true, jsonPath: cfg.jsonPath, server: parsed.server, ip: parsed.ip, salles: parsed.salles.length, printers: totalPrinters });
            } catch (e) {
                return sendJson(res, 200, { ok: false, error: e.message });
            }
        }

        if (action === 'list') {
            try {
                return sendJson(res, 200, parsePrinters(readPrinterJson()));
            } catch (e) {
                return sendJson(res, 500, { error: e.message });
            }
        }

        if (action === 'pingPrinter') {
            // Linux `ping -c 1 -W 1 <ip>` returns rc=0 if alive. We only accept dotted-quad
            // input to keep the shell exec safe — IPs come straight from the JSON.
            const ip = String(req.query.ip || '').trim();
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return sendJson(res, 400, { error: 'IP invalide' });
            return exec('ping -c 1 -W 1 ' + ip, (err) => {
                sendJson(res, 200, { ip, alive: !err });
            });
        }

        return sendJson(res, 404, { error: 'unknown action' });
    };

    return obj;
};
