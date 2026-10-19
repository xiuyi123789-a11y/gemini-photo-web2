import 'dotenv/config';
import { openDatabase } from './database.js';
import { createApp } from './app.js';
const PORT = process.env.PORT || 3001;
const database = await openDatabase();
const app = createApp({ database });

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] 服务已启动，监听端口: ${PORT}`);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(async () => { await database?.pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 15000).unref();
  });
}
