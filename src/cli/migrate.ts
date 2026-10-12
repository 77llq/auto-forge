import { connectDatabase, migrate } from '../db.js';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = connectDatabase(url);
try { await migrate(pool); console.log('Database migration 001 verified.'); }
finally { await pool.end(); }
