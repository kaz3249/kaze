import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

export const db = {
  prepare: (sql) => ({
    get: async (...params) => {
      const res = await pool.query(sql, params);
      return res.rows[0];
    },
    all: async (...params) => {
      const res = await pool.query(sql, params);
      return res.rows;
    },
    run: async (...params) => {
      await pool.query(sql, params);
    }
  }),
  exec: async (sql) => {
    await pool.query(sql);
  }
};

export async function initDB() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_usd REAL NOT NULL,
      images TEXT NOT NULL DEFAULT '[]',
      secret_content TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      price_usd REAL NOT NULL,
      pay_currency TEXT,
      pay_amount REAL,
      pay_address TEXT,
      checkout_url TEXT,
      nowpayments_payment_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      paid_at TIMESTAMP
    );
  `);
  console.log('✅ Database connected to Neon!');
}
