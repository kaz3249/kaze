import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import session from 'express-session';
import { db } from './db.js';

const app = express();

const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SUPPORT_TELEGRAM_URL = 'https://t.me/277_RYNA';
const DEFAULT_PAY_CURRENCY = process.env.DEFAULT_PAY_CURRENCY || 'usdttrc20';
const PAYMENT_MODE = (process.env.PAYMENT_MODE || 'invoice').toLowerCase();

app.use(express.urlencoded({ extended: true }));

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    }
  })
);

app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Serve static CSS
app.use(express.static('public'));

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('Telegram is not configured.');
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    await res.json().catch(() => ({}));
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (['paid', 'finished', 'completed'].includes(s)) return 'paid';
  if (s === 'confirming') return 'confirming';
  if (s === 'waiting') return 'pending';
  if (s === 'partially_paid') return 'partial';
  if (['rejected', 'expired', 'refunded', 'failed', 'cancelled'].includes(s)) return 'failed';
  return s || 'pending';
}

function getOrderAndProduct(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
  if (!product) return null;
  return { order, product };
}

function publicOrderJson(order, product) {
  const isPaid = order.status === 'paid';
  return {
    locked: !isPaid,
    order_url: `${BASE_URL}/order/${order.id}`,
    support_url: SUPPORT_TELEGRAM_URL,
    order: {
      id: order.id,
      product_id: order.product_id,
      status: order.status,
      price_usd: order.price_usd,
      pay_currency: order.pay_currency,
      pay_amount: order.pay_amount,
      pay_address: order.pay_address,
      checkout_url: order.checkout_url,
      nowpayments_payment_id: order.nowpayments_payment_id,
      created_at: order.created_at,
      paid_at: order.paid_at
    },
    product: isPaid
      ? { id: product.id, name: product.name, description: product.description, secret_content: product.secret_content }
      : { id: product.id }
  };
}

async function createNowPaymentsCheckout({ orderId, productId, priceUsd, payCurrency }) {
  if (!process.env.NOWPAYMENTS_API_KEY) {
    throw new ApiError(500, 'NOWPAYMENTS_API_KEY is not set');
  }

  const headers = {
    'x-api-key': process.env.NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
  };

  const description = `Product ID: ${productId} | Order ID: ${orderId}`;

  if (PAYMENT_MODE === 'invoice') {
    const body = {
      price_amount: Number(priceUsd),
      price_currency: 'usd',
      order_id: orderId,
      order_description: description,
      success_url: `${BASE_URL}/order/${orderId}`,
      cancel_url: `${BASE_URL}/`
    };
    if (process.env.IPN_CALLBACK_URL) body.ipn_callback_url = process.env.IPN_CALLBACK_URL;

    const res = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(502, data.message || `NOWPayments error: ${res.status}`);
    if (!data.invoice_url) throw new ApiError(502, 'Missing invoice_url');

    return {
      mode: 'invoice', checkout_url: data.invoice_url, payment_id: data.id || data.invoice_id || null,
      pay_address: null, pay_amount: data.pay_amount ?? null, pay_currency: data.pay_currency ?? null, payment_status: 'pending'
    };
  }

  const body = {
    price_amount: Number(priceUsd), price_currency: 'usd', order_id: orderId, order_description: description
  };
  if (process.env.IPN_CALLBACK_URL) body.ipn_callback_url = process.env.IPN_CALLBACK_URL;
  if (payCurrency) body.pay_currency = payCurrency;

  const res = await fetch('https://api.nowpayments.io/v1/payment', {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(502, data.message || `NOWPayments error: ${res.status}`);

  return {
    mode: 'payment', checkout_url: data.invoice_url || null, payment_id: data.payment_id || data.id || null,
    pay_address: data.pay_address || null, pay_amount: data.pay_amount ?? null, pay_currency: data.pay_currency || null, payment_status: data.payment_status || 'pending'
  };
}

async function createOrderCore({ productId, payCurrency }) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new ApiError(404, 'Product not found');

  const orderId = crypto.randomUUID();
  let checkout;

  try {
    checkout = await createNowPaymentsCheckout({ orderId, productId: product.id, priceUsd: product.price_usd, payCurrency });
  } catch (err) {
    await sendTelegram(`⚠️ <b>Payment creation failed</b>\nProduct ID: <code>${escapeHtml(product.id)}</code>\nError: ${escapeHtml(err.message)}`);
    throw err;
  }

  const status = normalizeStatus(checkout.payment_status || 'pending');

  db.prepare(`
    INSERT INTO orders (id, product_id, status, price_usd, pay_currency, pay_amount, pay_address, nowpayments_payment_id, checkout_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(orderId, product.id, status, product.price_usd, checkout.pay_currency ?? null, checkout.pay_amount ?? null, checkout.pay_address ?? null, checkout.payment_id ?? null, checkout.checkout_url ?? null);

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  
  await sendTelegram(
    `🛒 <b>New Order</b>\nOrder ID: <code>${escapeHtml(order.id)}</code>\nProduct ID: <code>${escapeHtml(product.id)}</code>\nPrice: $${escapeHtml(product.price_usd)}\nStatus: ${escapeHtml(order.status)}\nCustomer URL: ${escapeHtml(`${BASE_URL}/order/${order.id}`)}`
  );

  return { order, product, checkout };
}

// Navigation HTML
const navHTML = `
  <nav class="main-nav">
    <a href="/" class="logo">Kaze <span class="kanji">風</span></a>
    <div class="nav-links">
      <a href="/">SHOP</a>
      <a href="/contact">CONTACT</a>
      <a href="/policy">POLICY</a>
    </div>
  </nav>
`;

const footerHTML = `
  <footer class="main-footer">
    <p class="tagline">Kaze <span class="dash">—</span> cinematic digital art,</p>
    <p class="copyright">© 2026 KAZE Studio.</p>
  </footer>
`;

// ==========================================
// SHOP PAGE (COLLECTION)
// ==========================================
app.get('/', (_req, res) => {
  const products = db.prepare('SELECT id, name, price_usd FROM products ORDER BY created_at DESC, id').all();
  const productRows = products.map((p) => `
    <div class="product-card">
      <div class="product-header">
        <div class="product-id">Product ID: <code>${escapeHtml(p.id)}</code></div>
        <div class="product-price">$${escapeHtml(p.price_usd)}</div>
      </div>
      <div class="product-name">${escapeHtml(p.name)}</div>
      ${p.description ? `<div class="product-desc">${escapeHtml(p.description)}</div>` : ''}
      <form method="POST" action="/buy" class="buy-form">
        <input type="hidden" name="product_id" value="${escapeHtml(p.id)}">
        <input type="hidden" name="pay_currency" value="${escapeHtml(DEFAULT_PAY_CURRENCY)}">
        <button type="submit" class="buy-btn">Purchase</button>
      </form>
    </div>
  `).join('');

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KAZE — Shop</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Inter', sans-serif; 
      background: #000; 
      color: #e5e5e5;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    
    /* Navigation */
    .main-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 40px;
      border-bottom: 1px solid #1a1a1a;
      background: #000;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo {
      font-family: 'Playfair Display', serif;
      font-size: 1.8em;
      font-style: italic;
      color: #7c6ff7;
      text-decoration: none;
      font-weight: 400;
    }
    .logo .kanji {
      font-style: normal;
      font-size: 0.7em;
      margin-left: 4px;
    }
    .nav-links {
      display: flex;
      gap: 40px;
    }
    .nav-links a {
      color: #888;
      text-decoration: none;
      font-size: 0.85em;
      letter-spacing: 2px;
      font-weight: 400;
      transition: color 0.3s ease;
    }
    .nav-links a:hover {
      color: #fff;
    }
    
    /* Main Content */
    .main-content {
      flex: 1;
      max-width: 1000px;
      margin: 0 auto;
      padding: 80px 40px;
      width: 100%;
    }
    
    /* Badge */
    .badge {
      display: inline-block;
      border: 1px solid #333;
      border-radius: 30px;
      padding: 10px 28px;
      font-size: 0.8em;
      letter-spacing: 3px;
      color: #7c6ff7;
      margin-bottom: 40px;
      font-weight: 400;
    }
    
    /* Page Title */
    .page-title {
      font-family: 'Playfair Display', serif;
      font-size: 3.5em;
      font-weight: 400;
      color: #fff;
      margin-bottom: 20px;
      letter-spacing: 1px;
    }
    
    .title-divider {
      width: 60px;
      height: 1px;
      background: #333;
      margin-bottom: 60px;
    }
    
    /* Products Grid */
    .products-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 24px;
      margin-bottom: 40px;
    }
    
    .product-card {
      background: #0a0a0a;
      border: 1px solid #1a1a1a;
      border-radius: 12px;
      padding: 30px;
      transition: all 0.3s ease;
    }
    .product-card:hover {
      border-color: #2a2a2a;
      transform: translateY(-2px);
    }
    
    .product-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    
    .product-id {
      color: #666;
      font-size: 0.8em;
      letter-spacing: 1px;
    }
    
    .product-price {
      color: #4ade80;
      font-size: 1.1em;
      font-weight: 600;
    }
    
    .product-name {
      font-family: 'Playfair Display', serif;
      font-size: 1.4em;
      color: #fff;
      margin-bottom: 10px;
      font-weight: 400;
    }
    
    .product-desc {
      color: #888;
      font-size: 0.9em;
      margin-bottom: 20px;
      line-height: 1.5;
    }
    
    .buy-form {
      margin: 0;
    }
    
    .buy-btn {
      width: 100%;
      background: #7c6ff7;
      color: white;
      border: none;
      padding: 14px;
      border-radius: 8px;
      font-weight: 500;
      font-size: 0.9em;
      letter-spacing: 1px;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    .buy-btn:hover {
      background: #6b5ce6;
      transform: translateY(-1px);
    }
    
    .empty-state {
      text-align: center;
      padding: 80px 20px;
      color: #555;
      font-size: 1.1em;
    }
    
    /* Footer */
    .main-footer {
      text-align: center;
      padding: 60px 20px 40px;
      border-top: 1px solid #1a1a1a;
      margin-top: auto;
    }
    .tagline {
      font-family: 'Playfair Display', serif;
      font-style: italic;
      font-size: 1.3em;
      color: #7c6ff7;
      margin-bottom: 20px;
      font-weight: 400;
    }
    .tagline .dash {
      color: #555;
      margin: 0 8px;
    }
    .copyright {
      color: #555;
      font-size: 0.9em;
    }
    
    code {
      background: #1a1a1a;
      padding: 2px 8px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      color: #7c6ff7;
      font-size: 0.9em;
    }
    
    @media (max-width: 768px) {
      .main-nav {
        padding: 16px 20px;
        flex-direction: column;
        gap: 16px;
      }
      .nav-links {
        gap: 24px;
      }
      .main-content {
        padding: 40px 20px;
      }
      .page-title {
        font-size: 2.2em;
      }
      .products-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  ${navHTML}
  
  <div class="main-content">
    <div style="text-align:center;">
      <div class="badge">COLLECTION</div>
    </div>
    <h1 class="page-title" style="text-align:center;">The KAZE Catalog</h1>
    <div class="title-divider" style="margin:0 auto 60px;"></div>
    
    <div class="products-grid">
      ${productRows || '<div class="empty-state">No products yet. Check back soon.</div>'}
    </div>
  </div>

  ${footerHTML}
</body>
</html>`);
});

app.post('/buy', async (req, res) => {
  try {
    const result = await createOrderCore({ productId: req.body.product_id, payCurrency: req.body.pay_currency || DEFAULT_PAY_CURRENCY });
    res.redirect(303, `/order/${result.order.id}`);
  } catch (err) {
    res.status(err.status || 500).send(`<h1>Error</h1><pre>${escapeHtml(err.message)}</pre><a href="/">Back</a>`);
  }
});

// ==========================================
// CONTACT PAGE (REACH US)
// ==========================================
app.get('/contact', (_req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KAZE — Contact</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Inter', sans-serif; 
      background: #000; 
      color: #e5e5e5;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .main-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 40px;
      border-bottom: 1px solid #1a1a1a;
      background: #000;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo {
      font-family: 'Playfair Display', serif;
      font-size: 1.8em;
      font-style: italic;
      color: #7c6ff7;
      text-decoration: none;
      font-weight: 400;
    }
    .logo .kanji { font-style: normal; font-size: 0.7em; margin-left: 4px; }
    .nav-links { display: flex; gap: 40px; }
    .nav-links a {
      color: #888;
      text-decoration: none;
      font-size: 0.85em;
      letter-spacing: 2px;
      font-weight: 400;
      transition: color 0.3s ease;
    }
    .nav-links a:hover { color: #fff; }
    
    .main-content {
      flex: 1;
      max-width: 1000px;
      margin: 0 auto;
      padding: 80px 40px;
      width: 100%;
    }
    
    .badge {
      display: inline-block;
      border: 1px solid #333;
      border-radius: 30px;
      padding: 10px 28px;
      font-size: 0.8em;
      letter-spacing: 3px;
      color: #7c6ff7;
      margin-bottom: 40px;
    }
    
    .page-title {
      font-family: 'Playfair Display', serif;
      font-size: 3.5em;
      font-weight: 400;
      color: #fff;
      margin-bottom: 20px;
      letter-spacing: 1px;
    }
    
    .page-subtitle {
      color: #888;
      font-size: 1.05em;
      margin-bottom: 60px;
      max-width: 600px;
    }
    
    .contact-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 24px;
      max-width: 900px;
    }
    
    .contact-card {
      background: #0a0a0a;
      border: 1px solid #1a1a1a;
      border-radius: 12px;
      padding: 50px 30px;
      text-align: center;
      text-decoration: none;
      color: #e5e5e5;
      transition: all 0.3s ease;
    }
    .contact-card:hover {
      border-color: #2a2a2a;
      transform: translateY(-3px);
    }
    
    .contact-icon {
      font-size: 3em;
      margin-bottom: 20px;
    }
    
    .contact-label {
      font-family: 'Playfair Display', serif;
      font-size: 1.4em;
      margin-bottom: 10px;
      color: #fff;
      font-weight: 400;
    }
    
    .contact-value {
      color: #666;
      font-size: 0.95em;
    }
    
    .icon-email { color: #f87171; }
    .icon-telegram { color: #38bdf8; }
    .icon-pinterest { color: #e91e63; }
    
    .main-footer {
      text-align: center;
      padding: 60px 20px 40px;
      border-top: 1px solid #1a1a1a;
      margin-top: auto;
    }
    .tagline {
      font-family: 'Playfair Display', serif;
      font-style: italic;
      font-size: 1.3em;
      color: #7c6ff7;
      margin-bottom: 20px;
      font-weight: 400;
    }
    .tagline .dash { color: #555; margin: 0 8px; }
    .copyright { color: #555; font-size: 0.9em; }
    
    @media (max-width: 768px) {
      .main-nav { padding: 16px 20px; flex-direction: column; gap: 16px; }
      .nav-links { gap: 24px; }
      .main-content { padding: 40px 20px; }
      .page-title { font-size: 2.2em; }
      .contact-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  ${navHTML}
  
  <div class="main-content">
    <div style="text-align:center;">
      <div class="badge">REACH US</div>
    </div>
    <h1 class="page-title" style="text-align:center;">A quiet channel, always open.</h1>
    <p class="page-subtitle" style="text-align:center;margin:0 auto 60px;">Questions about a piece, a custom commission, or a wholesale order? We reply within 24h.</p>
    
    <div class="contact-grid">
      <a href="mailto:kaze.2.7.7.9.3@gmail.com" class="contact-card">
        <div class="contact-icon icon-email">✉️</div>
        <div class="contact-label">Email</div>
        <div class="contact-value">kaze.2.7.7.9.3@gmail.com</div>
      </a>
      
      <a href="https://t.me/277_RYNA" target="_blank" class="contact-card">
        <div class="contact-icon icon-telegram">✈️</div>
        <div class="contact-label">Telegram</div>
        <div class="contact-value">@277_RYNA</div>
      </a>
      
      <a href="https://pinterest.com/KAZE277" target="_blank" class="contact-card">
        <div class="contact-icon icon-pinterest">📌</div>
        <div class="contact-label">Pinterest</div>
        <div class="contact-value">@KAZE277</div>
      </a>
    </div>
  </div>

  ${footerHTML}
</body>
</html>`);
});

// ==========================================
// POLICY PAGE (FINE PRINT)
// ==========================================
app.get('/policy', (_req, res) => {
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KAZE — Policy</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Inter', sans-serif; 
      background: #000; 
      color: #e5e5e5;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .main-nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 40px;
      border-bottom: 1px solid #1a1a1a;
      background: #000;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo {
      font-family: 'Playfair Display', serif;
      font-size: 1.8em;
      font-style: italic;
      color: #7c6ff7;
      text-decoration: none;
      font-weight: 400;
    }
    .logo .kanji { font-style: normal; font-size: 0.7em; margin-left: 4px; }
    .nav-links { display: flex; gap: 40px; }
    .nav-links a {
      color: #888;
      text-decoration: none;
      font-size: 0.85em;
      letter-spacing: 2px;
      font-weight: 400;
      transition: color 0.3s ease;
    }
    .nav-links a:hover { color: #fff; }
    
    .main-content {
      flex: 1;
      max-width: 800px;
      margin: 0 auto;
      padding: 80px 40px;
      width: 100%;
    }
    
    .badge {
      display: inline-block;
      border: 1px solid #333;
      border-radius: 30px;
      padding: 10px 28px;
      font-size: 0.8em;
      letter-spacing: 3px;
      color: #7c6ff7;
      margin-bottom: 40px;
    }
    
    .page-title {
      font-family: 'Playfair Display', serif;
      font-size: 3.5em;
      font-weight: 400;
      color: #fff;
      margin-bottom: 20px;
      letter-spacing: 1px;
    }
    
    .title-divider {
      width: 60px;
      height: 1px;
      background: #333;
      margin-bottom: 60px;
    }
    
    .policy-section {
      margin-bottom: 50px;
    }
    
    .policy-section h2 {
      font-family: 'Playfair Display', serif;
      font-size: 1.8em;
      color: #fff;
      margin-bottom: 20px;
      font-weight: 400;
    }
    
    .policy-section p {
      color: #888;
      font-size: 1em;
      line-height: 1.8;
      margin-bottom: 16px;
    }
    
    .main-footer {
      text-align: center;
      padding: 60px 20px 40px;
      border-top: 1px solid #1a1a1a;
      margin-top: auto;
    }
    .tagline {
      font-family: 'Playfair Display', serif;
      font-style: italic;
      font-size: 1.3em;
      color: #7c6ff7;
      margin-bottom: 20px;
      font-weight: 400;
    }
    .tagline .dash { color: #555; margin: 0 8px; }
    .copyright { color: #555; font-size: 0.9em; }
    
    @media (max-width: 768px) {
      .main-nav { padding: 16px 20px; flex-direction: column; gap: 16px; }
      .nav-links { gap: 24px; }
      .main-content { padding: 40px 20px; }
      .page-title { font-size: 2.2em; }
    }
  </style>
</head>
<body>
  ${navHTML}
  
  <div class="main-content">
    <div style="text-align:center;">
      <div class="badge">FINE PRINT</div>
    </div>
    <h1 class="page-title" style="text-align:center;">Return & Refund Policy</h1>
    <div class="title-divider" style="margin:0 auto 60px;"></div>
    
    <div class="policy-section">
      <h2>Digital products</h2>
      <p>All digital downloads are final. Because files are delivered instantly and cannot be "returned", we do not offer refunds on digital purchases. If your file is corrupted or the download link fails, contact us within 7 days and we'll re-issue it.</p>
    </div>
    
    <div class="policy-section">
      <h2>Custom commissions</h2>
      <p>Custom work is non-refundable once the creative process has begun. We provide previews and revisions throughout the process to ensure your satisfaction before final delivery.</p>
    </div>
    
    <div class="policy-section">
      <h2>Contact</h2>
      <p>For any questions regarding this policy, please reach out to us at <a href="https://t.me/277_RYNA" style="color:#7c6ff7;text-decoration:none;">@277_RYNA</a> on Telegram or via email at <a href="mailto:kaze.2.7.7.9.3@gmail.com" style="color:#7c6ff7;text-decoration:none;">kaze.2.7.7.9.3@gmail.com</a>.</p>
    </div>
  </div>

  ${footerHTML}
</body>
</html>`);
});

// ==========================================
// ORDER PAGE
// ==========================================
app.get('/order/:id', (req, res) => {
  const data = getOrderAndProduct(req.params.id);
  if (!data) return res.status(404).send('<h1>Order not found</h1><a href="/">Back</a>');

  const { order, product } = data;
  const isPaid = order.status === 'paid';
  let productBox;

  if (isPaid) {
    productBox = `<div class="unlocked-box"><h2>✅ Product Unlocked</h2><p><strong>Product ID:</strong> <code>${escapeHtml(product.id)}</code></p><p><strong>Name:</strong> ${escapeHtml(product.name)}</p><h3>Your Access:</h3><pre>${escapeHtml(product.secret_content)}</pre></div>`;
  } else {
    const portalButton = order.checkout_url 
      ? `<a href="${escapeHtml(order.checkout_url)}" target="_blank" class="pay-btn">Proceed to Payment</a>` 
      : `<p class="pay-address"><strong>Payment Address:</strong><br><code>${escapeHtml(order.pay_address || 'N/A')}</code></p>`;
    
    productBox = `<div class="locked-box"><h2>🔒 Payment Required</h2><p>This product is locked until payment is confirmed.</p><p><strong>Product ID:</strong> <code>${escapeHtml(product.id)}</code></p><p><strong>Price:</strong> <span class="price-tag">$${escapeHtml(order.price_usd)}</span></p>${portalButton}<p class="help-text">Need help? <a href="https://t.me/277_RYNA">Contact us on Telegram</a></p></div>`;
  }

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Order Details</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
      font-family: 'Inter', sans-serif; 
      background: #000; 
      color: #e5e5e5;
      line-height: 1.6;
      min-height: 100vh;
    }
    .container {
      max-width: 700px;
      margin: 0 auto;
      padding: 80px 40px;
    }
    .card {
      background: #0a0a0a;
      border: 1px solid #1a1a1a;
      border-radius: 16px;
      padding: 50px;
    }
    h1 {
      font-family: 'Playfair Display', serif;
      font-size: 2.5em;
      font-weight: 400;
      margin-bottom: 30px;
      color: #fff;
    }
    .info-row {
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid #1a1a1a;
    }
    .info-label {
      color: #666;
      font-size: 0.85em;
      letter-spacing: 1px;
      margin-bottom: 6px;
    }
    .info-value {
      font-size: 1.1em;
      color: #fff;
    }
    code {
      background: #1a1a1a;
      padding: 3px 10px;
      border-radius: 4px;
      font-family: 'Courier New', monospace;
      color: #7c6ff7;
    }
    .unlocked-box {
      background: #064e3b;
      border: 1px solid #4ade80;
      border-radius: 12px;
      padding: 30px;
      margin-top: 30px;
    }
    .unlocked-box h2 { color: #4ade80; margin-bottom: 16px; font-family: 'Playfair Display', serif; font-weight: 400; }
    .locked-box {
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      border-radius: 12px;
      padding: 30px;
      margin-top: 30px;
    }
    .locked-box h2 { color: #fbbf24; margin-bottom: 16px; font-family: 'Playfair Display', serif; font-weight: 400; }
    .price-tag { color: #4ade80; font-size: 1.4em; font-weight: 600; }
    .pay-btn {
      display: inline-block;
      background: #7c6ff7;
      color: white;
      text-decoration: none;
      padding: 14px 32px;
      border-radius: 8px;
      font-weight: 500;
      margin-top: 16px;
      transition: all 0.3s ease;
    }
    .pay-btn:hover { background: #6b5ce6; }
    .pay-address { background: #1a1a1a; padding: 16px; border-radius: 8px; margin-top: 16px; }
    .help-text { margin-top: 24px; color: #888; font-size: 0.95em; }
    .help-text a { color: #7c6ff7; text-decoration: none; }
    pre {
      background: #020617;
      padding: 20px;
      border-radius: 8px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
      margin-top: 16px;
    }
    a { color: #7c6ff7; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <h1>Order Details</h1>
      <div class="info-row">
        <div class="info-label">ORDER ID</div>
        <div class="info-value"><code>${escapeHtml(order.id)}</code></div>
      </div>
      <div class="info-row">
        <div class="info-label">STATUS</div>
        <div class="info-value" style="color:${order.status === 'paid' ? '#4ade80' : '#fbbf24'};font-weight:600;">${escapeHtml(order.status.toUpperCase())}</div>
      </div>
      <div class="info-row">
        <div class="info-label">PRICE</div>
        <div class="info-value">$${escapeHtml(order.price_usd)}</div>
      </div>
      ${productBox}
      <p style="margin-top:32px;"><a href="/">← Back to Shop</a></p>
    </div>
  </div>
  <script>
    const orderId = ${JSON.stringify(order.id)};
    async function checkStatus() {
      try {
        const res = await fetch('/api/orders/' + encodeURIComponent(orderId));
        const data = await res.json();
        if (!data.locked) window.location.reload();
      } catch (e) {}
    }
    setInterval(checkStatus, 5000);
  </script>
</body>
</html>`);
});

app.get('/api/products', (_req, res) => {
  res.json(db.prepare('SELECT id, price_usd FROM products ORDER BY created_at DESC, id').all());
});

app.post('/api/orders', async (req, res) => {
  try {
    const { product_id, pay_currency } = req.body || {};
    if (!product_id) throw new ApiError(400, 'product_id is required');
    const result = await createOrderCore({ productId: product_id, payCurrency: pay_currency || DEFAULT_PAY_CURRENCY });
    res.json(publicOrderJson(result.order, result.product));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/orders/:id', (req, res) => {
  const data = getOrderAndProduct(req.params.id);
  if (!data) return res.status(404).json({ error: 'Order not found' });
  res.json(publicOrderJson(data.order, data.product));
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/webhook/nowpayments', async (req, res) => {
  try {
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (secret) {
      const signature = req.header('x-nowpayments-signature') || '';
      const hmac = crypto.createHmac('sha512', secret).update(req.rawBody || '').digest('hex');
      const a = Buffer.from(signature);
      const b = Buffer.from(hmac);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).send('Invalid signature');
      }
    }

    const payload = req.body || {};
    let order = null;
    if (payload.order_id) order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(payload.order_id));
    if (!order && payload.payment_id) order = db.prepare('SELECT * FROM orders WHERE nowpayments_payment_id = ?').get(String(payload.payment_id));
    if (!order) return res.status(200).send('ignored');

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const previousStatus = order.status;
    const newStatus = normalizeStatus(payload.payment_status || payload.status || order.status);

    db.prepare(`
      UPDATE orders SET status = ?, nowpayments_payment_id = COALESCE(?, nowpayments_payment_id),
      pay_amount = COALESCE(?, pay_amount), pay_address = COALESCE(?, pay_address), pay_currency = COALESCE(?, pay_currency),
      paid_at = CASE WHEN ? = 'paid' AND paid_at IS NULL THEN datetime('now') ELSE paid_at END WHERE id = ?
    `).run(newStatus, payload.payment_id ?? null, payload.pay_amount ?? null, payload.pay_address ?? null, payload.pay_currency ?? null, newStatus, order.id);

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);

    if (previousStatus !== newStatus && ['paid', 'partial', 'failed', 'confirming'].includes(newStatus)) {
      const emoji = newStatus === 'paid' ? '✅' : newStatus === 'partial' ? '⚠️' : newStatus === 'confirming' ? '' : '❌';
      await sendTelegram(
        `${emoji} <b>Payment ${escapeHtml(newStatus.toUpperCase())}</b>\nOrder ID: <code>${escapeHtml(updated.id)}</code>\nProduct ID: <code>${escapeHtml(product.id)}</code>\nPaid Amount: ${escapeHtml(payload.actually_paid ?? payload.pay_amount ?? 'N/A')}`
      );
    }
    res.status(200).send('ok');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).send('ok');
  }
});

// ==========================================
// ADMIN PANEL
// ==========================================
const requireLogin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
};

app.get('/admin/login', (req, res) => {
  res.send(`<!doctype html><html><head><title>Admin Login</title><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet"><style>body{font-family:'Inter',sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#000;color:#e5e7eb;margin:0}.login-box{background:#0a0a0a;padding:50px;border-radius:12px;border:1px solid #1a1a1a;width:380px;text-align:center}input{width:100%;padding:14px;margin:20px 0;border-radius:8px;border:1px solid #2a2a2a;background:#000;color:#e5e7eb;box-sizing:border-box;font-size:1em}button{width:100%;padding:16px;border-radius:8px;border:none;background:#7c6ff7;color:white;font-weight:500;cursor:pointer;font-size:1em;letter-spacing:1px;transition:all 0.3s ease}button:hover{background:#6b5ce6}.error{color:#f87171;font-size:14px;margin-bottom:16px}h2{font-family:'Playfair Display',serif;font-weight:400;font-size:1.8em;color:#fff;letter-spacing:1px}</style></head><body><div class="login-box"><h2>Admin Login</h2><form method="POST" action="/admin/login"><input type="password" name="password" placeholder="Enter Password" required autofocus><button type="submit">Login</button></form></div></body></html>`);
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.send(`<!doctype html><html><head><title>Admin Login</title><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet"><style>body{font-family:'Inter',sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#000;color:#e5e7eb;margin:0}.login-box{background:#0a0a0a;padding:50px;border-radius:12px;border:1px solid #1a1a1a;width:380px;text-align:center}input{width:100%;padding:14px;margin:20px 0;border-radius:8px;border:1px solid #2a2a2a;background:#000;color:#e5e7eb;box-sizing:border-box;font-size:1em}button{width:100%;padding:16px;border-radius:8px;border:none;background:#7c6ff7;color:white;font-weight:500;cursor:pointer;font-size:1em;letter-spacing:1px}.error{color:#f87171;font-size:14px;margin-bottom:16px}h2{font-family:'Playfair Display',serif;font-weight:400;font-size:1.8em;color:#fff;letter-spacing:1px}</style></head><body><div class="login-box"><h2>Admin Login</h2><div class="error">Incorrect password</div><form method="POST" action="/admin/login"><input type="password" name="password" placeholder="Enter Password" required autofocus><button type="submit">Login</button></form></div></body></html>`);
  }
});

app.get('/admin', requireLogin, (req, res) => {
  res.send(`<!doctype html><html><head><title>Admin Dashboard</title><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet"><style>body{font-family:'Inter',sans-serif;margin:0;background:#000;color:#e5e7eb}input,textarea{width:100%;padding:14px;margin:10px 0;box-sizing:border-box;border-radius:8px;border:1px solid #2a2a2a;background:#000;color:#e5e7eb;font-size:1em}button{background:#7c6ff7;border:none;padding:16px 32px;border-radius:8px;color:white;font-weight:500;cursor:pointer;font-size:1em;margin-top:20px;letter-spacing:1px;transition:all 0.3s ease}button:hover{background:#6b5ce6}.logout{display:inline-block;background:#dc2626;padding:12px 24px;margin-top:40px;text-decoration:none;color:white;border-radius:8px;transition:all 0.3s ease}.logout:hover{background:#b91c1c}a{color:#7c6ff7;text-decoration:none;display:block;margin-top:24px}h1{font-family:'Playfair Display',serif;font-weight:400;font-size:2.2em;color:#fff;letter-spacing:1px;margin-bottom:30px}label{display:block;margin-top:24px;color:#888;font-size:0.9em;letter-spacing:1px}.container{max-width:700px;margin:0 auto;padding:80px 40px}</style></head><body><div class="container"><h1>Add New Product</h1><form method="POST" action="/admin/add-product"><label>Product ID</label><input type="text" name="id" required placeholder="e.g., PROD-001"><label>Product Name</label><input type="text" name="name" required placeholder="Product name"><label>Description</label><textarea name="description" rows="3" placeholder="Short description"></textarea><label>Price (USD)</label><input type="number" step="0.01" name="price_usd" required placeholder="10.00"><label>Secret Content (What customers see after payment)</label><textarea name="secret_content" rows="6" required placeholder="Download link, license key, etc."></textarea><button type="submit">Add Product</button></form><a href="/">← Back to Shop</a><a href="/admin/logout" class="logout">Logout</a></div></body></html>`);
});

app.post('/admin/add-product', requireLogin, (req, res) => {
  const { id, name, description, price_usd, secret_content } = req.body;
  if (!id || !name || !price_usd || !secret_content) {
    return res.send('<h2>Error: Missing required fields.</h2> <a href="/admin">Go Back</a>');
  }
  try {
    db.prepare(`INSERT INTO products (id, name, description, price_usd, secret_content) VALUES (?, ?, ?, ?, ?)`).run(id, name, description || '', Number(price_usd), secret_content);
    res.send(`<h2 style="color: #4ade80; font-family: 'Playfair Display', serif;">✅ Product "${escapeHtml(name)}" Added Successfully!</h2><a href="/admin" style="color:#7c6ff7; font-family: 'Inter', sans-serif;">Add Another Product</a><br><br><a href="/" style="color:#7c6ff7; font-family: 'Inter', sans-serif;">View Shop</a>`);
  } catch (err) {
    res.send(`<h2 style="font-family: 'Playfair Display', serif;">Error adding product:</h2> <p>${escapeHtml(err.message)}</p> <a href="/admin" style="font-family: 'Inter', sans-serif;">Go Back</a>`);
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy((err) => {
    res.redirect('/admin/login');
  });
});

app.listen(PORT, () => {
  console.log(`Server running at ${BASE_URL}`);
  console.log(`Admin panel: ${BASE_URL}/admin/login`);
});
