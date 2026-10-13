'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../printctl.js'), 'utf8');
const UI = fs.readFileSync(path.join(__dirname, '../views/printctl.handlebars'), 'utf8').split('<script>')[1].split('</script>')[0];
const IP = '192.0.2.13';
const OID = '.1.3.6.1.2.1.25.3.5.1.';
function snmp(state = '3', errors = '00', index = 1) {
    return `${OID}1.${index} = INTEGER: ${state}\n${OID}2.${index} = Hex-STRING: ${errors}\n`;
}
function inventory(status = '0x0', jobs = '0x1') {
    return `printername:[\\\\PRINT-TEST\\IMP-013]\nsharename:[IMP-013]\nportname:[IP_${IP}]\ndrivername:[Brother HL-L5100DN series]\nstatus:[${status}]\ncjobs:[${jobs}]\n`;
}
function backend(options = {}) {
    const calls = [], sockets = [], timers = [];
    const module = { exports: {} };
    const execFile = (command, args, config, cb) => {
        calls.push({ command, args, config });
        if (command === 'rpcclient') return cb(null, options.inventory || inventory());
        if (command === 'ping') return cb(options.pingOk ? null : Object.assign(new Error('no reply'), { code: 'ENOENT' }));
        if (command === 'snmpwalk') return cb(options.snmpError ? new Error('SNMP unavailable') : null, options.snmp || '');
        assert.fail('Unexpected command: ' + command);
    };
    const fakeNet = {
        isIP: require('node:net').isIP,
        connect: ({ host, port }) => {
            const socket = new EventEmitter();
            socket.host = host; socket.port = port;
            socket.write = () => assert.fail('Reachability must not send print data');
            socket.destroy = () => { socket.destroyed = true; };
            sockets.push(socket);
            queueMicrotask(() => {
                if (options.silentTcp) return;
                socket.emit(port === options.openPort ? 'connect' : 'error', new Error('refused'));
                socket.emit('close'); // Late events must not send a second response.
            });
            return socket;
        }
    };
    vm.runInNewContext(source, {
        module, __dirname: path.join(__dirname, '..'), Buffer, console,
        setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
        clearTimeout: timer => { timer.cleared = true; },
        require: name => name === 'child_process' ? { execFile } : name === 'net' ? fakeNet
            : name === 'fs' ? { readFileSync: () => JSON.stringify({ hosts: ['PRINT-TEST'], user: 'test-user', password: 'test-password' }) } : require(name)
    });
    const plugin = module.exports.printctl({ parent: {} });
    function request(action, query = {}) {
        return new Promise((resolve) => {
            let count = 0, status;
            const res = {
                status(code) { status = code; return this; }, set() { return this; },
                send(body) { assert.equal(++count, 1); resolve({ status, body: JSON.parse(body) }); }
            };
            plugin.handleAdminReq({ query: { action, ...query } }, res, {});
        });
    }
    return { request, calls, sockets, timers, options };
}
function frontend(responses = {}) {
    const elements = {};
    const calls = [];
    const sandbox = {
        document: {
            getElementById: id => elements[id] || (elements[id] = { value: '', style: {}, innerHTML: '' }),
            querySelectorAll: () => []
        },
        fetch: async url => {
            const query = new URL(url, 'http://test.invalid').searchParams;
            const action = query.get('action'); calls.push({ action, query });
            const result = responses[action];
            if (result instanceof Error) throw result;
            return { json: async () => typeof result === 'function' ? result(query) : result || {} };
        },
        setInterval() {}, clearInterval() {}, alert: () => assert.fail('unexpected alert'), confirm: () => false
    };
    let script = UI.replace(/  api\('ping'\)\.then[\s\S]*?  \/\/ Query every IP/, '  // Query every IP');
    script = script.replace('  load(true);\n  refreshTimer', '  refreshTimer');
    vm.runInNewContext(script, sandbox);
    return { sandbox, elements, calls };
}

test('Windows queue status is decoded from rpcclient hex, including jobs', async () => {
    const h = backend({ inventory: inventory('0x82', '0xa') });
    const p = (await h.request('list')).body.printers[0];
    assert.equal(p.cjobs, 10);
    assert.equal(p.queueStatus.offline, true);
    assert.deepEqual(p.queueStatus.states.map(s => s.label), ['Erreur', 'Hors connexion']);
});

test('Windows ready, paused and unknown values stay distinct', async () => {
    for (const [value, label] of [['0x0', 'Prête'], ['1', 'Suspendue'], ['0x1000000', 'Veille'], ['0x80000000', 'Autre état (0x80000000)']]) {
        const p = (await backend({ inventory: inventory(value) }).request('list')).body.printers[0];
        assert.equal(p.queueStatus.states[0].label, label);
    }
    for (const value of ['', 'unknown', '-1', '0x100000000']) {
        const p = (await backend({ inventory: inventory(value) }).request('list')).body.printers[0];
        assert.equal(p.queueStatus.known, false);
    }
});

test('a filtered/missing ping falls back to TCP without sending print data', async () => {
    const h = backend({ openPort: 9100 });
    const r = await h.request('pingPrinter', { ip: IP });
    assert.equal(r.body.alive, true);
    assert.equal(r.body.via, 'tcp:9100');
    assert.equal(h.calls[0].config.timeout, 3500);
    assert.ok(h.sockets.every(s => s.destroyed));
});

test('a successful ping does not need TCP probes', async () => {
    const h = backend({ pingOk: true });
    assert.equal((await h.request('pingPrinter', { ip: IP })).body.via, 'icmp');
    assert.equal(h.sockets.length, 0);
});

test('no response or closed ports mean unknown reachability, never offline', async () => {
    const h = backend();
    assert.equal((await h.request('pingPrinter', { ip: IP })).body.alive, null);
    const silent = backend({ silentTcp: true });
    const pending = silent.request('pingPrinter', { ip: IP });
    silent.timers.forEach(t => t.fn());
    assert.equal((await pending).body.alive, null);
    assert.ok(silent.sockets.every(s => s.destroyed));
});

test('invalid IPs start no network probes or SNMP commands', async () => {
    const h = backend();
    for (const action of ['pingPrinter', 'getStatus']) {
        for (const ip of ['999.0.0.1', '192.0.2.13;bad', '', 'not-an-ip']) {
            assert.equal((await h.request(action, { ip })).status, 400);
        }
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.sockets.length, 0);
});

test('SNMP status accepts a non-1 device index and uses numeric/hex output', async () => {
    const h = backend({ snmp: snmp('3', '00', 7) });
    const r = (await h.request('getStatus', { ip: IP })).body;
    assert.equal(r.available, true); assert.equal(r.state, 'prête');
    assert.equal(r.errorsKnown, true); assert.deepEqual(r.errors, []);
    assert.equal(h.calls[0].command, 'snmpwalk');
    assert.equal(h.calls[0].args[h.calls[0].args.indexOf('-O') + 1], 'nex');
    assert.equal(h.calls[0].args[h.calls[0].args.indexOf('-m') + 1], '');
});

test('real SNMP jam/offline bits and second-byte alerts remain visible', async () => {
    const h = backend({ snmp: snmp('3', '06 80') });
    const r = (await h.request('getStatus', { ip: IP })).body;
    assert.deepEqual(r.errors, ['bourrage', 'hors ligne', 'autre alerte imprimante']);
});

test('SNMP exceptions and malformed text never become error bits or OK', async () => {
    for (const invalid of ['No Such Instance currently exists at this OID', 'No Such Object available on this agent at this OID', 'Timeout: No Response', 'STRING: "06"', 'Hex-STRING: 0G', 'Hex-STRING: deadbeef']) {
        const h = backend({ snmp: `${OID}1.1 = ${invalid}\n${OID}2.1 = ${invalid}\n` });
        const r = (await h.request('getStatus', { ip: IP })).body;
        assert.equal(r.available, false, invalid);
        assert.equal(r.errorsKnown, false); assert.deepEqual(r.errors, []);
    }
});

test('missing bitmap is incomplete and different SNMP devices are never merged', async () => {
    let h = backend({ snmp: `${OID}1.1 = INTEGER: 3\n${OID}2.1 = No Such Instance currently exists at this OID` });
    let r = (await h.request('getStatus', { ip: IP })).body;
    assert.equal(r.available, true); assert.equal(r.errorsKnown, false);
    h = backend({ snmp: `${OID}1.1 = INTEGER: 3\n${OID}2.2 = Hex-STRING: 06` });
    r = (await h.request('getStatus', { ip: IP })).body;
    assert.equal(r.available, false); assert.deepEqual(r.errors, []);
});

test('failed SNMP commands discard partial output and cannot poison the cache', async () => {
    const h = backend({ snmpError: true, snmp: snmp('3', '06') });
    assert.equal((await h.request('getStatus', { ip: IP })).body.available, false);
    h.options.snmpError = false; h.options.snmp = snmp();
    assert.equal((await h.request('getStatus', { ip: IP })).body.state, 'prête');
    assert.equal(h.calls.length, 2);
    await h.request('getStatus', { ip: IP });
    assert.equal(h.calls.length, 2);
    h.options.snmp = snmp('4', '00');
    assert.equal((await h.request('getStatus', { ip: IP, force: '1' })).body.state, 'imprime');
    assert.equal(h.calls.length, 3);
});

test('IMP-013 ready in Windows remains ready when direct access is unconfirmed', async () => {
    const printer = (await backend().request('list')).body.printers[0];
    const h = frontend();
    h.sandbox.data = { printers: [printer] };
    h.sandbox.pingState[IP] = null;
    h.sandbox.statusState[IP] = { available: false };
    h.sandbox.render();
    const html = h.elements.tbody.innerHTML;
    assert.match(html, /Windows : Prête/);
    assert.match(html, /Accès direct non confirmé/);
    assert.match(html, /Brother HL-L5100DN series/);
    assert.match(html, /Pilote Windows/);
    assert.doesNotMatch(html, /hors ligne|Hors connexion|bourrage|>OK</);
});

test('a reachable printer never hides Windows offline or valid SNMP errors', async () => {
    const printer = (await backend({ inventory: inventory('0x80') }).request('list')).body.printers[0];
    const h = frontend(); h.sandbox.pingState[IP] = true;
    h.sandbox.statusState[IP] = { available: true, errorsKnown: true, stateCode: 3, errors: ['bourrage', 'hors ligne'] };
    const html = h.sandbox.statusHtml(printer);
    assert.match(html, /Windows : Hors connexion/);
    assert.match(html, /SNMP : bourrage/); assert.match(html, /SNMP : hors ligne/);
    assert.match(html, /Joignable depuis MeshCentral/);
});

test('unknown or incomplete statuses never render as OK, and labels are escaped', () => {
    const h = frontend();
    h.sandbox.pingState[IP] = null;
    h.sandbox.statusState[IP] = { available: true, stateCode: 3, errorsKnown: false, errors: [] };
    const p = { ip: IP, queueStatus: { known: false } };
    assert.match(h.sandbox.statusHtml(p), /État Windows inconnu.*État SNMP incomplet/);
    assert.doesNotMatch(h.sandbox.statusHtml(p), /chip ok/);
    h.sandbox.statusState[IP].errors = ['<img src=x>'];
    assert.match(h.sandbox.statusHtml(p), /&lt;img src=x&gt;/);
});

test('SNMP and model queries run despite ping failure and retry missing models', async () => {
    const h = frontend({ pingPrinter: { alive: null }, getStatus: { available: true, stateCode: 3, errorsKnown: true, state: 'prête', errors: [] }, getModel: { model: '' } });
    h.sandbox.data = { printers: [{ ip: IP }] };
    await h.sandbox.pingAll();
    await Promise.all([h.sandbox.modelsAll(), h.sandbox.statusAll(true)]);
    assert.ok(h.calls.some(c => c.action === 'getModel'));
    assert.ok(h.calls.some(c => c.action === 'getStatus' && c.query.get('force') === '1'));
    await h.sandbox.modelsAll();
    assert.equal(h.calls.filter(c => c.action === 'getModel').length, 2);
    assert.match(h.sandbox.statusHtml({ ip: IP }), /Joignable depuis MeshCentral/);
});

test('refresh picks up new Windows status and clears old probe errors/successes', async () => {
    const ready = (await backend().request('list')).body.printers[0];
    const offline = (await backend({ inventory: inventory('0x80') }).request('list')).body.printers[0];
    let printer = ready;
    const h = frontend({ list: () => ({ printers: [printer] }), pingPrinter: new Error('endpoint error'), getStatus: new Error('endpoint error'), getModel: { model: 'Brother' }, jobCounts: { counts: {} } });
    h.sandbox.pingState[IP] = true;
    h.sandbox.statusState[IP] = { available: true, errors: ['bourrage'] };
    await h.sandbox.load(true);
    assert.match(h.elements.tbody.innerHTML, /Windows : Prête/);
    assert.doesNotMatch(h.elements.tbody.innerHTML, /SNMP : bourrage|Joignable depuis MeshCentral/);
    printer = offline;
    await h.sandbox.load(false);
    assert.match(h.elements.tbody.innerHTML, /Windows : Hors connexion/);
    assert.equal(h.elements.refreshBtn.disabled, false);
});

test('overlapping refreshes do not start competing status requests', async () => {
    let release;
    const h = frontend({ list: () => new Promise(resolve => { release = resolve; }) });
    const first = h.sandbox.load(true);
    await new Promise(resolve => setImmediate(resolve));
    await h.sandbox.load(true);
    assert.equal(h.calls.filter(c => c.action === 'list').length, 1);
    release({ printers: [] });
    await first;
    assert.equal(h.elements.refreshBtn.disabled, false);
});
