import { createApp } from './app.js';
import { createD1Driver } from './driver-d1.js';
import { createSqlStore } from './store-sql.js';
import { configFromEnv } from './config.js';

export default {
  async fetch(request, env) {
    if (!env.DB) {
      return new Response(JSON.stringify({ error: 'db_missing', message: 'D1 尚未绑定' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    const store = createSqlStore(createD1Driver(env.DB));
    const config = configFromEnv(env);
    const app = createApp({ store, config });
    return app.fetch(request);
  },
};
