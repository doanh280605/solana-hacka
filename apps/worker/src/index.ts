import { createWorker } from './app.js';
import { createChainGateway } from './chain.js';
import { loadConfiguration } from './config.js';

async function main(): Promise<void> {
  const { config, settings, host, port } = loadConfiguration();
  const { app } = await createWorker({ chain: createChainGateway(config), settings });
  const stop = async (): Promise<void> => {
    try { await app.close(); }
    catch (error) { app.log.error(error); process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  await app.listen({ host, port });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Worker failed to start');
  process.exitCode = 1;
});
