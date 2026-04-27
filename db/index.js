const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on('connect', () => console.log('✅ PostgreSQL connected'));
pool.on('error', e => console.error('DB error:', e.message));
module.exports = { query: (t, p) => pool.query(t, p), pool };
