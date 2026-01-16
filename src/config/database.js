const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
    const res = await pool.query(text, params);
    return res;
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
    testConnection
};
