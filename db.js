import Database from 'better-sqlite3';

export const db = new Database('shop.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_usd REAL NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  secret_content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  status TEXT NOT NULL DEFAULT 'pending',
  price_usd REAL NOT NULL,
  pay_currency TEXT,
  pay_amount REAL,
  pay_address TEXT,
  checkout_url TEXT,
  nowpayments_payment_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
`);

// Fix for existing databases: Add columns if they don't exist
try { db.exec(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]';`); } catch (e) {}
try { db.exec(`ALTER TABLE products ADD COLUMN description TEXT DEFAULT '';`); } catch (e) {}
