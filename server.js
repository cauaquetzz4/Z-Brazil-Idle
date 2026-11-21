// Servidor do Z-Brasil: Aldeia — sem dependências (só precisa do Node.js)
// Uso:  node server.js    (deixe na mesma pasta do z-brasil-aldeia.html)
//
// O que ele faz:
//  - guarda uma "foto" da aldeia de cada jogador (para os outros poderem atacar)
//  - acha um oponente para quem quer atacar (jogador online, off-line também vale, como no Clash of Clans)
//  - recebe o resultado do ataque, confere os números, tira o saque da vítima e dá escudo a ela
//  - avisa a vítima do que aconteceu (ela recebe na próxima vez que o jogo dela falar com o servidor)
//
// Variáveis opcionais:  PORT=3000   DATA_FILE=perfis.json
// Os recursos de cada jogador ficam no aparelho dele; o servidor só confere e limita o saque.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const GAME_FILE = path.join(__dirname, 'z-brasil-aldeia.html');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'perfis.json');

const RES = ['food', 'water', 'scrap'];
const BAD = [
    'pau','pinto','bunda','vagina','penis','buceta','caralho',
    'droga','maconha','cocaina','crack','lança','arma','fuzil',
    'pistola','oitão','assassinar','matar','biqueira','trafico'
];

let profiles = {};   // id -> perfil
let dirty = false;
try {
    profiles = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log('Perfis carregados: ' + Object.keys(profiles).length);
} catch (e) { /* primeira vez */ }

function saveProfiles() {
    if (!dirty) return;
    dirty = false;
    fs.writeFile(DATA_FILE, JSON.stringify(profiles), () => {});
}
setInterval(saveProfiles, 30000);
process.on('SIGTERM', () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(profiles)); } catch (e) { /* ignora */ } process.exit(0); });

// ---------- utilidades ----------
function num(v, max) { v = Math.floor(Number(v)); if (!isFinite(v) || v < 0) return 0; return Math.min(v, max); }
function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max); }
function nameOk(n) { const l = n.toLowerCase(); return n.length >= 2 && !BAD.some((w) => l.includes(w)); }
function idOk(id) { return /^[a-f0-9]{8,32}$/i.test(String(id || '')); }
function cleanBase(arr) {
    if (!Array.isArray(arr) || arr.length > 260) return null;
    const out = [];
    for (const e of arr) {
        if (!Array.isArray(e) || e.length < 4) return null;
        const t = num(e[0], 20), l = num(e[1], 5), x = num(e[2], 29), y = num(e[3], 29);
        if (t > 7 || l < 1) return null;
        out.push([t, l, x, y]);
    }
    return out;
}
function cleanRes(r) { const o = {}; RES.forEach((k) => { o[k] = num(r && r[k], 99999); }); return o; }
function cleanTroops(t) { return { zombie: num(t && t.zombie, 200), spitter: num(t && t.spitter, 200), tank: num(t && t.tank, 200) }; }

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};
function readBody(req, cb) {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 40000) req.destroy(); });
    req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch (e) { cb(null); } });
}
function json(res, code, obj) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS));
    res.end(JSON.stringify(obj));
}
function text(res, code, t) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS));
    res.end(t || '');
}

// ---------- servidor ----------
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    if (req.method === 'OPTIONS') { text(res, 204); return; }

    // O jogador manda a foto da aldeia e recebe o que aconteceu com ela
    if (url === '/api/sync' && req.method === 'POST') {
        readBody(req, (b) => {
            if (!b || !idOk(b.id)) { json(res, 400, { ok: false }); return; }
            const now = Date.now();
            let p = profiles[b.id];
            const fresh = !p;
            if (!p) p = profiles[b.id] = { id: b.id, shield: now + 12 * 3600 * 1000, pendT: 0, pendLoss: { food: 0, water: 0, scrap: 0 }, logs: [], base: [], lastAtk: 0 };
            let name = clean(b.name, 15);
            if (!nameOk(name)) name = 'Sobrevivente';
            p.name = name;
            p.seen = now;
            p.trophies = num(b.trophies, 99999);
            p.res = cleanRes(b.res);
            p.troops = cleanTroops(b.troops);
            p.lvl = Math.max(1, Math.min(4, num(b.lvl, 4)));
            if (b.base) { const cb = cleanBase(b.base); if (cb) p.base = cb; }
            const out = { ok: true, fresh: fresh, shield: p.shield, loss: p.pendLoss, tdelta: p.pendT, logs: p.logs };
            p.trophies = Math.max(0, p.trophies + p.pendT);
            p.pendLoss = { food: 0, water: 0, scrap: 0 }; p.pendT = 0; p.logs = [];
            dirty = true;
            json(res, 200, out);
        });
        return;
    }

    // Procurar um oponente
    if (url === '/api/search' && req.method === 'POST') {
        readBody(req, (b) => {
            const me = b && profiles[b.id];
            if (!me) { json(res, 400, { found: false }); return; }
            const now = Date.now();
            const pool = Object.keys(profiles).map((k) => profiles[k]).filter((p) =>
                p.id !== me.id && p.base && p.base.length > 0 && p.shield < now && now - p.seen < 7 * 86400 * 1000 && (!b.skip || b.skip.indexOf(p.id) < 0));
            if (!pool.length) { json(res, 200, { found: false }); return; }
            pool.sort((x, y) => Math.abs(x.trophies - me.trophies) - Math.abs(y.trophies - me.trophies));
            const p = pool[Math.floor(Math.random() * Math.min(5, pool.length))];
            json(res, 200, { found: true, p: { id: p.id, name: p.name, trophies: p.trophies, lvl: p.lvl, base: p.base, troops: p.troops, res: p.res } });
        });
        return;
    }

    // Resultado de um ataque
    if (url === '/api/result' && req.method === 'POST') {
        readBody(req, (b) => {
            const a = b && profiles[b.id], d = b && profiles[b.defId];
            if (!a || !d || a.id === d.id) { json(res, 400, { ok: false }); return; }
            const now = Date.now();
            if (now - a.lastAtk < 15000) { json(res, 429, { ok: false, msg: 'Calma.' }); return; }
            a.lastAtk = now;
            const stars = num(b.stars, 3), destr = num(b.destruction, 100);
            // o saque é no máximo 25% do que a vítima tinha, proporcional à destruição
            const loot = {};
            RES.forEach((k) => {
                const allowed = Math.floor(d.res[k] * 0.25 * destr / 100) + 1;
                loot[k] = Math.min(num(b.loot && b.loot[k], 99999), allowed, d.res[k]);
                d.res[k] -= loot[k];
                d.pendLoss[k] += loot[k];
            });
            const aT = stars > 0 ? 10 + stars * 8 : -8;
            const dT = -stars * 6;
            d.pendT += dT;
            a.trophies = Math.max(0, a.trophies + aT);
            a.shield = 0; // atacar quebra o seu escudo
            if (destr >= 40) d.shield = now + 30 * 60 * 1000; // a vítima ganha 30 min de escudo
            d.logs.push({ t: now, by: a.name, stars: stars, destr: destr, loot: loot });
            if (d.logs.length > 20) d.logs.shift();
            dirty = true;
            json(res, 200, { ok: true, loot: loot, tdelta: aT });
        });
        return;
    }

    if (url === '/ping') { text(res, 200, 'ok'); return; }

    if (url === '/' || url === '/index.html') {
        fs.readFile(GAME_FILE, (err, data) => {
            if (err) { text(res, 500, 'Nao achei z-brasil-aldeia.html na mesma pasta do server.js'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }
    text(res, 404, '404');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('Z-Brasil: Aldeia rodando!');
    console.log('  Neste computador:  http://localhost:' + PORT);
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach((name) => {
        nets[name].forEach((n) => {
            if (n.family === 'IPv4' && !n.internal) console.log('  Na mesma rede:     http://' + n.address + ':' + PORT);
        });
    });
});
