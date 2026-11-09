// Servidor do Z-Brasil v2 — sem dependências (só precisa do Node.js)
// Uso:  node server.js    (deixe na mesma pasta do z-brasil-base.html)
//
// O que ele faz:
//  - cada estado do Brasil é uma "base" (sala); jogadores do mesmo estado aparecem juntos
//  - notícias (logs) online da base
//  - chat da base e chat do Brasil
//  - efeitos em grupo (médico cura todos, barricadeiro reforça, coletor traz suprimentos)
//
// Comunicação: SSE (servidor -> jogo) + POST (jogo -> servidor). Funciona em hospedagens comuns.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const GAME_FILE = path.join(__dirname, 'z-brasil-base.html');

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
const JOBS = ['coletador', 'barricada', 'guarda', 'medico'];
const BAD = [
    'pau','pinto','bunda','vagina','penis','buceta','caralho',
    'droga','maconha','cocaina','crack','lança','arma','fuzil',
    'pistola','oitão','assassinar','matar','biqueira','trafico'
];

const clients = new Map();   // id -> { id, name, uf, shirt, job, res, lastChat, lastAct }
const rooms = {};            // uf -> { log: [] }
const baseChat = {};         // uf -> []
const globalChat = [];
const lastLeft = {};         // id -> timestamp (para não repetir "bem-vindo" em reconexão)

// ---------- utilidades ----------
function clean(s, max) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function esc(w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function maskBad(text) {
    let t = text;
    BAD.forEach((w) => {
        const re = new RegExp('(^|[^a-zà-ú])(' + esc(w) + ')(?=$|[^a-zà-ú])', 'gi');
        t = t.replace(re, (m, pre, word) => pre + '*'.repeat(word.length));
    });
    return t;
}
function nameHasBad(n) {
    const l = n.toLowerCase();
    return BAD.some((w) => l.includes(w));
}
function room(uf) {
    if (!rooms[uf]) rooms[uf] = { log: [] };
    if (!baseChat[uf]) baseChat[uf] = [];
    return rooms[uf];
}
function send(res, event, data) {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { /* conexão caiu */ }
}
function playersOf(uf) {
    const a = [];
    clients.forEach((c) => { if (c.uf === uf) a.push({ id: c.id, name: c.name, shirt: c.shirt, job: c.job }); });
    return a;
}
function counts() {
    const o = {};
    clients.forEach((c) => { o[c.uf] = (o[c.uf] || 0) + 1; });
    return o;
}
function toRoom(uf, event, data) {
    clients.forEach((c) => { if (c.uf === uf) send(c.res, event, data); });
}
function toAll(event, data) {
    clients.forEach((c) => send(c.res, event, data));
}
let countsTimer = null;
function scheduleCounts() {
    if (countsTimer) return;
    countsTimer = setTimeout(() => { countsTimer = null; toAll('counts', counts()); }, 500);
}
function addLog(uf, text) {
    const r = room(uf);
    const entry = { t: Date.now(), text: text };
    r.log.push(entry);
    if (r.log.length > 40) r.log.shift();
    toRoom(uf, 'log', entry);
}
function pickShirt(uf, id, want) {
    const used = [];
    clients.forEach((c) => { if (c.uf === uf && c.id !== id) used.push(c.shirt); });
    let h = ((parseInt(want, 10) || 0) % 360 + 360) % 360;
    for (let i = 0; i < 24; i++) {
        const ok = used.every((u) => { let d = Math.abs(u - h); d = Math.min(d, 360 - d); return d >= 18; });
        if (ok) return h;
        h = (h + 23) % 360;
    }
    return ((parseInt(want, 10) || 0) % 360 + 360) % 360;
}
function jobText(job, name) {
    switch (job) {
        case 'guarda': return '🛡️ ' + name + ' está de guarda pra proteger a base dos zumbis!';
        case 'coletador': return '🌾 ' + name + ' está catando alimentos e sucatas!';
        case 'barricada': return '🔨 ' + name + ' montou barricadas!';
        case 'medico': return '🩺 ' + name + ' regenerou o HP de todos!';
    }
    return null;
}

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

function readBody(req, cb) {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 4096) req.destroy(); });
    req.on('end', () => { try { cb(JSON.parse(b || '{}')); } catch (e) { cb(null); } });
}
function reply(res, code, txt) {
    res.writeHead(code, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS));
    res.end(txt || '');
}

// ---------- servidor ----------
const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const url = u.pathname;

    if (req.method === 'OPTIONS') { reply(res, 204); return; }

    // Canal em tempo real
    if (url === '/events') {
        const id = u.searchParams.get('id') || '';
        const uf = (u.searchParams.get('uf') || '').toUpperCase();
        let name = clean(u.searchParams.get('name'), 15);
        if (!/^[a-f0-9]{8,32}$/i.test(id) || UFS.indexOf(uf) < 0) { reply(res, 400, 'dados invalidos'); return; }
        if (name.length < 2 || nameHasBad(name)) name = 'Sobrevivente';

        const prev = clients.get(id);
        if (prev) { try { prev.res.end(); } catch (e) { /* ignora */ } clients.delete(id); }

        req.socket.setTimeout(0);
        res.writeHead(200, Object.assign({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }, CORS));
        res.write('retry: 3000\n\n');

        const shirt = pickShirt(uf, id, u.searchParams.get('shirt'));
        const c = { id: id, name: name, uf: uf, shirt: shirt, job: '', res: res, lastChat: 0, lastAct: 0 };
        clients.set(id, c);
        const r = room(uf);

        send(res, 'init', {
            you: { shirt: shirt, name: name },
            players: playersOf(uf),
            log: r.log,
            chat: baseChat[uf],
            gchat: globalChat,
            counts: counts()
        });

        const fresh = !lastLeft[id] || Date.now() - lastLeft[id] > 60000;
        if (fresh) addLog(uf, '👋 Seja bem-vindo à base, ' + name + '!');
        toRoom(uf, 'players', playersOf(uf));
        scheduleCounts();

        req.on('close', () => {
            if (clients.get(id) === c) {
                clients.delete(id);
                lastLeft[id] = Date.now();
                toRoom(uf, 'players', playersOf(uf));
                scheduleCounts();
            }
        });
        return;
    }

    // Ações do jogador
    if (url === '/act' && req.method === 'POST') {
        readBody(req, (b) => {
            const c = b && clients.get(String(b.id));
            if (!c) { reply(res, 400, 'sem conexao'); return; }
            const now = Date.now();
            if (b.type === 'sync' || b.type === 'job') {
                const job = JOBS.indexOf(b.job) >= 0 ? b.job : '';
                const changed = job !== c.job;
                c.job = job;
                if (b.type === 'job' && changed && job) {
                    if (now - c.lastAct > 3000) { addLog(c.uf, jobText(job, c.name)); c.lastAct = now; }
                }
                toRoom(c.uf, 'players', playersOf(c.uf));
            } else if (b.type === 'action') {
                if (now - c.lastAct < 20000) { reply(res, 429, 'calma'); return; }
                c.lastAct = now;
                const t = jobText(c.job, c.name);
                if (t) addLog(c.uf, t);
                const fx = { coletador: 'supply', barricada: 'barricade', medico: 'heal' }[c.job];
                if (fx) toRoom(c.uf, 'fx', { type: fx, by: c.id });
            } else if (b.type === 'raid_ok') {
                addLog(c.uf, '🛡️ As barricadas de ' + c.name + ' seguraram a horda!');
            } else if (b.type === 'raid_fail') {
                addLog(c.uf, '🚨 A horda invadiu a base de ' + c.name + '!');
            }
            reply(res, 200, 'ok');
        });
        return;
    }

    // Chat
    if (url === '/chat' && req.method === 'POST') {
        readBody(req, (b) => {
            const c = b && clients.get(String(b.id));
            if (!c) { reply(res, 400, 'sem conexao'); return; }
            const now = Date.now();
            if (now - c.lastChat < 1000) { reply(res, 429, 'calma'); return; }
            const text = maskBad(clean(b.text, 140));
            if (!text) { reply(res, 400, 'vazio'); return; }
            c.lastChat = now;
            const m = { id: c.id, n: c.name, uf: c.uf, h: c.shirt, t: now, text: text };
            if (b.ch === 'brasil') {
                globalChat.push(m); if (globalChat.length > 60) globalChat.shift();
                toAll('chat', { ch: 'brasil', m: m });
            } else {
                room(c.uf);
                baseChat[c.uf].push(m); if (baseChat[c.uf].length > 40) baseChat[c.uf].shift();
                toRoom(c.uf, 'chat', { ch: 'base', m: m });
            }
            reply(res, 200, 'ok');
        });
        return;
    }

    // Batida de coração (mantém hospedagens grátis acordadas)
    if (url === '/ping') { reply(res, 200, 'ok'); return; }

    // O jogo
    if (url === '/' || url === '/index.html') {
        fs.readFile(GAME_FILE, (err, data) => {
            if (err) { reply(res, 500, 'Nao achei z-brasil-base.html na mesma pasta do server.js'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }

    reply(res, 404, '404');
});

// Mantém conexões vivas
setInterval(() => { clients.forEach((c) => { try { c.res.write(': ping\n\n'); } catch (e) { /* ignora */ } }); }, 25000);

// Avisos por horário de Brasília (UTC-3): 18:00 fogueira, 21:00 zumbis
let lastKey = '';
setInterval(() => {
    const d = new Date(Date.now() - 3 * 3600 * 1000);
    const h = d.getUTCHours(), m = d.getUTCMinutes();
    const key = d.toISOString().slice(0, 10) + '-' + h;
    if (m === 0 && (h === 18 || h === 21) && key !== lastKey) {
        lastKey = key;
        const text = h === 18
            ? '🔥 18:00 — A fogueira foi acesa e os grilos começaram a cantar.'
            : '🧟 21:00 — Quatro zumbis apareceram ao redor da base!';
        const active = {};
        clients.forEach((c) => { active[c.uf] = true; });
        Object.keys(active).forEach((uf) => addLog(uf, text));
    }
}, 20000);

server.listen(PORT, '0.0.0.0', () => {
    console.log('Z-Brasil rodando!');
    console.log('  Neste computador:  http://localhost:' + PORT);
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach((name) => {
        nets[name].forEach((n) => {
            if (n.family === 'IPv4' && !n.internal) console.log('  Na mesma rede:     http://' + n.address + ':' + PORT);
        });
    });
});
