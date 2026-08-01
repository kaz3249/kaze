import 'dotenv/config';
import { db } from './db.js';

const fakeProducts = [
  {
    id: 'FAKE-1001',
    name: 'Fake Product 1',
    description: 'Test product 1.',
    price_usd: 1,
    secret_content: 'UNLOCKED: This is the private content for FAKE-1001.'
  },
  {
    id: 'FAKE-1002',
    name: 'Fake Product 2',
    description: 'Test product 2.',
    price_usd: 5,
    secret_content: 'UNLOCKED: This is the private content for FAKE-1002.'
  }
];

const insert = db.prepare(`
  INSERT OR REPLACE INTO products (id, name, description, price_usd, secret_content)
  VALUES (@id, @name, @description, @price_usd, @secret_content)
`);

const seed = db.transaction((products) => {
  for (const product of products) {
    insert.run(product);
  }
});

seed(fakeProducts);
console.log('Seeded fake products.');