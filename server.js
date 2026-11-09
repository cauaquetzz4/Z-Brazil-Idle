// Servidor do Z-Brasil — sem dependências (só precisa do Node.js instalado)
// Como usar:  node server.js
// Deixe este arquivo na MESMA pasta do z-brasil-base.html

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const GAME_FILE = path.join(__dirname, 'z-brasil-base.html');

// Cada jogador com o jogo aberto = uma conexão aberta em /events
const clients = new Set();

function broadcast() {
    const msg = 'data: ' + clients.size + '\n\n';
    clients.forEach((res) => res.write(msg));
}

const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // Canal em tempo real: manda o número de jogadores online
    if (url === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*'
        });
        res.write('retry: 3000\n\n');
        clients.add(res);
        broadcast();
        req.on('close', () => {
            clients.delete(res);
            broadcast();
        });
        return;
    }

    // Batida de coração: os jogos online chamam isto de tempos em tempos,
    // assim hospedagens grátis não "dormem" enquanto tem gente jogando
    if (url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end('ok');
        return;
    }

    // O próprio jogo
    if (url === '/' || url === '/index.html') {
        fs.readFile(GAME_FILE, (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Não achei z-brasil-base.html na mesma pasta do server.js');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
});

// Mantém as conexões vivas (alguns roteadores derrubam conexões paradas)
setInterval(() => {
    clients.forEach((res) => res.write(': ping\n\n'));
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
    console.log('Z-Brasil rodando!');
    console.log('  Neste computador:  http://localhost:' + PORT);
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach((name) => {
        nets[name].forEach((n) => {
            if (n.family === 'IPv4' && !n.internal) {
                console.log('  Na mesma rede:     http://' + n.address + ':' + PORT);
            }
        });
    });
});
