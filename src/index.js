// Mascotly server entry point.
import { config } from './config.js';
import { createStore } from './store-factory.js';
import { createServer } from './server.js';
import { getLlm } from './providers/llm.js';
import { resolveEmbeddingsSettings } from './config.js';

const BANNER = `
  ╔═══════════════════════════════════════════════════════════╗
  ║  __  __                                                   ║
  ║ |  \\/  | __ _ _ __ ___  _   _ _ __   __ _  ___ _ __       ║
  ║ | |\\/| |/ _\` | '_ \` _ \\| | | | '_ \\ / _\` |/ _ \\ '__|   ║
  ║ | |  | | (_| | | | | | | |_| | | | | (_| |  __/ |         ║
  ║ |_|  |_|\\__,_|_| |_| |_|\\__,_|_| |_|\\__,_|\\___|_|      ║
  ║                                                           ║
  ║   The open-source AI mascot that lives inside any app     ║
  ╚═══════════════════════════════════════════════════════════╝`;

async function main() {
  console.log(BANNER);

  const store = await createStore();
  if (typeof store.init === 'function') await store.init(); // KV cold-start preload
  const adminRecord = store.ensureAdminKey();

  const llm = getLlm({});
  const emb = resolveEmbeddingsSettings({});
  console.log(`  data dir : ${config.store === 'file' ? config.dataDir : `${config.store} (KV)`}`);
  console.log(`  brain    : ${llm.configured ? `${llm.provider} (${llm.model})` : 'none configured → offline fallback brain'}`);
  console.log(`  vectors  : ${emb.configured ? `${emb.provider} (${emb.model})` : 'local TF-IDF (hybrid BM25 + cosine)'}`);
  if (!llm.configured) {
    console.log('  tip      : set MASCOT_LLM_PROVIDER=openai-compatible + MASCOT_LLM_BASE_URL/MASCOT_LLM_API_KEY for a real brain');
  }

  const server = createServer(store);
  server.listen(config.port, config.host, () => {
    const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
    const base = `http://${host}:${config.port}`;
    console.log('');
    console.log(`  server   : ${base}`);
    console.log(`  dashboard: ${base}/dashboard/`);
    console.log(`  admin key: ${config.adminKey ? 'from MASCOT_ADMIN_KEY' : `stored in ${config.dataDir}/admin.json`}`);
    if (!config.adminKey) console.log(`             ${adminRecord.key}`);
    console.log('');
    console.log('  Ready. Press Ctrl+C to stop.');
    console.log('');
  });

  const shutdown = async (signal) => {
    console.log(`\n[${signal}] flushing data and shutting down…`);
    try {
      await store.flushAll();
    } catch (err) {
      console.error('flush failed:', err.message);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
