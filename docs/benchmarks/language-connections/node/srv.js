const net = require('net');
const base = +process.argv[2], n = +process.argv[3];
let samples = 0;
for (let i = 0; i < n; i++) {
  net.createServer({ noDelay: true }, (sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try { const m = JSON.parse(line); samples += m.samples.length; } catch (e) {}
        sock.write('A\n');
      }
    });
    sock.on('error', () => {});
  }).listen({ port: base + i, host: '127.0.0.1', backlog: 4096 });
}
