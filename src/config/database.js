const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: process.env.NODE_ENV === 'production' } : false
});

async function query(text, params) {
    const res = await pool.query(text, params);
    return res;
}

async function transaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function testConnection() {
    try {
        await pool.query('SELECT NOW()');
        return true;
    } catch (error) {
        console.error('Database connection failed:', error);
        throw error;
    }
}

module.exports = {
    supabase,
    pool,
    query,
    transaction,
    testConnection
};
