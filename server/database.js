import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const createStore = (pool) => ({
  pool,
  async init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        entries JSONB NOT NULL DEFAULT '[]', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS error_notebook (
        id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        issue TEXT NOT NULL, solution TEXT NOT NULL, tags JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  },
  async createUser(username, passwordHash) {
    const { rows } = await pool.query('INSERT INTO users(id, username, password_hash) VALUES($1,$2,$3) RETURNING id, username', [randomUUID(), username, passwordHash]);
    return rows[0];
  },
  async findUser(username) {
    return (await pool.query('SELECT * FROM users WHERE username=$1', [username])).rows[0];
  },
  async addSession(hash, userId, expires) {
    await pool.query('DELETE FROM sessions WHERE expires_at <= NOW()');
    await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hash,userId,expires]);
  },
  async getSession(hash) {
    return (await pool.query('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at > NOW()', [hash])).rows[0];
  },
  async removeSession(hash) { await pool.query('DELETE FROM sessions WHERE token_hash=$1', [hash]); },
  async getKnowledge(userId) {
    return (await pool.query('SELECT entries FROM knowledge_bases WHERE user_id=$1', [userId])).rows[0]?.entries || [];
  },
  async saveKnowledge(userId, entries) {
    await pool.query(`INSERT INTO knowledge_bases(user_id,entries) VALUES($1,$2::jsonb)
      ON CONFLICT(user_id) DO UPDATE SET entries=EXCLUDED.entries, updated_at=NOW()`, [userId, JSON.stringify(entries)]);
  },
  async addError(userId, { issue, solution, tags = [] }) {
    const { rows } = await pool.query(`INSERT INTO error_notebook(id,user_id,issue,solution,tags)
      VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,issue,solution,tags,created_at AS timestamp`, [randomUUID(),userId,issue,solution,JSON.stringify(tags)]);
    return rows[0];
  },
  async getErrors(userId) {
    return (await pool.query('SELECT id,issue,solution,tags,created_at AS timestamp FROM error_notebook WHERE user_id=$1 ORDER BY created_at DESC', [userId])).rows;
  }
});

export async function openDatabase() {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    if (process.env.NODE_ENV === 'production') throw new Error('Production requires PostgreSQL configuration');
    console.warn('[Storage] Development legacy file mode; production requires PostgreSQL.');
    return null;
  }
  const pool = new pg.Pool({ ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}), max: 10, connectionTimeoutMillis: 10000 });
  pool.on('error', () => console.error('[Database] Idle connection failed'));
  const store = createStore(pool);
  await store.init();
  return store;
}
