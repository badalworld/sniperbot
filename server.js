'use strict';
/* MEXC AI Fusion — entry point.
 * Run:  node server.js   →  open http://localhost:8080 in Chrome.
 * Zero external dependencies: pure Node.js (>=16). */
const { Scanner } = require('./server/scanner');
const { Engine } = require('./server/engine');
const { WebServer } = require('./server/http');
const { logger, publicIP, localIPs, sleep } = require('./server/util');

(async function main() {
  console.log('');
  console.log('  ⚡ MEXC AI FUSION — AI Futures Trading Bot & Dashboard');
  console.log('     Development by BadalWorld  •  Contact: t.me/anonymousvai');
  console.log('');

  const port = parseInt(process.env.PORT || '8080', 10);
  const scanner = new Scanner();
  const engine = new Engine(scanner);
  engine.settings.port = port;
  engine.ip.port = port;
  engine.onEvent = (ev) => { /* forwarded to dashboards via snapshot feed */ };

  logger.info('Booting MEXC AI Fusion…');
  scanner.init().catch((e) => logger.error('scanner init: ' + e.message));

  const web = new WebServer(engine, port);
  web.start();

  // ping loop (dashboard green <100ms, red >=100ms)
  (function pingLoop() {
    scanner.client.ping().catch(() => { scanner.client.pingMs = null; });
    setTimeout(pingLoop, 5000);
  })();

  // public IP discovery
  (async function ipLoop() {
    try {
      const pub = await publicIP();
      engine.ip.public = pub;
      engine.ip.lan = localIPs();
      if (pub) logger.info('Public IP: ' + pub + ' | LAN: ' + (engine.ip.lan.join(', ') || 'n/a'));
      else logger.warn('Public IP not reachable yet (offline?) — will retry');
    } catch (e) { logger.warn('ip: ' + e.message); }
    setTimeout(ipLoop, 10 * 60 * 1000);
  })();

  process.on('SIGINT', async () => {
    logger.info('Shutting down (Ctrl+C). Open bot positions stay open on MEXC — their exchange-side stop-loss remains active.');
    web.stop(); scanner.stop();
    require('./server/store').flushAll();
    process.exit(0);
  });
  process.on('uncaughtException', (e) => logger.error('uncaught: ' + e.stack ? e.message : e.message));
  process.on('unhandledRejection', (e) => logger.error('unhandled rejection: ' + (e && e.message ? e.message : e)));
})();
