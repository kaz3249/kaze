import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import session from 'express-session';
import { db } from './db.js';

const app = express();

const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SUPPORT_TELEGRAM_URL = process.env.SUPPORT_TELEGRAM_URL || 'https://t.me/Kaze_277_bot';
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
    await sendTelegram(`️ <b>Payment creation failed</b>\nProduct ID: <code>${escapeHtml(product.id)}</code>\nError: ${escapeHtml(err.message)}`);
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

app.get('/', (_req, res) => {
  const products = db.prepare('SELECT id, name, price_usd FROM products ORDER BY created_at DESC, id').all();
  const productRows = products.map((p) => `
    <li>
      <div><strong>Product ID:</strong> <code>${escapeHtml(p.id)}</code></div>
      <div><strong>Name:</strong> ${escapeHtml(p.name)}</div>
      <div><strong>Price:</strong> $${escapeHtml(p.price_usd)}</div>
      <form method="POST" action="/buy" style="margin-top:12px;">
        <input type="hidden" name="product_id" value="${escapeHtml(p.id)}">
        <input type="hidden" name="pay_currency" value="${escapeHtml(DEFAULT_PAY_CURRENCY)}">
        <button type="submit" style="background:#f7931a;color:white;border:none;padding:10px 16px;border-radius:8px;cursor:pointer;font-weight:bold;">Pay with NOWPayments</button>
      </form>
    </li>
  `).join('');

  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Store</title>
  <style>body{font-family:Arial,sans-serif;margin:24px;background:#0f172a;color:#e5e7eb}li{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px;margin-bottom:16px;list-style:none}code{background:#020617;padding:2px 6px;border-radius:6px}</style>
  </head><body><h1>Products</h1><ul>${productRows}</ul></body></html>`);
});

app.post('/buy', async (req, res) => {
  try {
    const result = await createOrderCore({ productId: req.body.product_id, payCurrency: req.body.pay_currency || DEFAULT_PAY_CURRENCY });
    res.redirect(303, `/order/${result.order.id}`);
  } catch (err) {
    res.status(err.status || 500).send(`<h1>Error</h1><pre>${escapeHtml(err.message)}</pre><a href="/">Back</a>`);
  }
});

app.get('/order/:id', (req, res) => {
  const data = getOrderAndProduct(req.params.id);
  if (!data) return res.status(404).send('<h1>Order not found</h1><a href="/">Back</a>');

  const { order, product } = data;
  const isPaid = order.status === 'paid';
  let productBox;

  if (isPaid) {
    productBox = `<h2 style="color:#4ade80;">✅ Unlocked Product</h2><p><strong>Product ID:</strong> <code>${escapeHtml(product.id)}</code></p><p><strong>Name:</strong> ${escapeHtml(product.name)}</p><h3>Product Access</h3><pre style="background:#020617;padding:16px;border-radius:8px;">${escapeHtml(product.secret_content)}</pre>`;
  } else {
    const portalButton = order.checkout_url 
      ? `<a href="${escapeHtml(order.checkout_url)}" target="_blank" style="display:inline-block;background:#f7931a;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;margin-top:12px;">Open NOWPayments Portal to Pay</a>` 
      : `<p>Payment address: <code>${escapeHtml(order.pay_address || 'N/A')}</code></p>`;
    
    productBox = `<h2>🔒 Locked</h2><p><strong>Product ID:</strong> <code>${escapeHtml(product.id)}</code></p><p>This product is locked until full payment is confirmed.</p>${portalButton}<p style="margin-top:16px;">Need help? <a href="${escapeHtml(SUPPORT_TELEGRAM_URL)}" style="color:#38bdf8;">Contact on Telegram</a></p>`;
  }

  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Order ${escapeHtml(order.id)}</title>
  <style>body{font-family:Arial,sans-serif;margin:24px;background:#0f172a;color:#e5e7eb}.card{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:20px;max-width:700px}code,pre{background:#020617;padding:2px 6px;border-radius:6px;white-space:pre-wrap}.status{font-weight:bold}</style>
  </head><body><div class="card"><h1>Order Details</h1><p><strong>Order ID:</strong> <code>${escapeHtml(order.id)}</code></p><p><strong>Status:</strong> <span class="status">${escapeHtml(order.status)}</span></p><p><strong>Price:</strong> $${escapeHtml(order.price_usd)}</p>${productBox}<p style="margin-top:24px;"><a href="/" style="color:#38bdf8;">Back to products</a></p></div>
  <script>const orderId=${JSON.stringify(order.id)};async function checkStatus(){try{const res=await fetch('/api/orders/'+encodeURIComponent(orderId));const data=await res.json();if(!data.locked)window.location.reload();}catch(e){}}setInterval(checkStatus,5000);</script></body></html>`);
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

const requireLogin = (req, res, next) => {
  if (req.session.isAdmin) return next();
  res.redirect('/admin/login');
};

app.get('/admin/login', (req, res) => {
  res.send(`<!doctype html><html><head><title>Admin Login</title><style>body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#0f172a;color:#e5e7eb;margin:0}.login-box{background:#111827;padding:32px;border-radius:12px;border:1px solid #1f2937;width:300px;text-align:center}input{width:100%;padding:10px;margin:12px 0;border-radius:8px;border:1px solid #334155;background:#020617;color:#e5e7eb;box-sizing:border-box}button{width:100%;padding:10px;border-radius:8px;border:none;background:#2563eb;color:white;font-weight:bold;cursor:pointer}.error{color:#f87171;font-size:14px;margin-bottom:12px}</style></head><body><div class="login-box"><h2> Admin Login</h2><form method="POST" action="/admin/login"><input type="password" name="password" placeholder="Enter Admin Password" required autofocus><button type="submit">Login</button></form></div></body></html>`);
});

app.post('/admin/login', (req, res) => {
  if (req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.send(`<!doctype html><html><head><title>Admin Login</title><style>body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#0f172a;color:#e5e7eb;margin:0}.login-box{background:#111827;padding:32px;border-radius:12px;border:1px solid #1f2937;width:300px;text-align:center}input{width:100%;padding:10px;margin:12px 0;border-radius:8px;border:1px solid #334155;background:#020617;color:#e5e7eb;box-sizing:border-box}button{width:100%;padding:10px;border-radius:8px;border:none;background:#2563eb;color:white;font-weight:bold;cursor:pointer}.error{color:#f87171;font-size:14px;margin-bottom:12px}</style></head><body><div class="login-box"><h2> Admin Login</h2><div class="error">❌ Incorrect password.</div><form method="POST" action="/admin/login"><input type="password" name="password" placeholder="Enter Admin Password" required autofocus><button type="submit">Login</button></form></div></body></html>`);
  }
});

app.get('/admin', requireLogin, (req, res) => {
  res.send(`<!doctype html><html><head><title>Admin Dashboard</title><style>body{font-family:Arial,sans-serif;margin:24px;background:#0f172a;color:#e5e7eb}input,textarea,button{padding:10px;margin:8px 0;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #334155;background:#020617;color:#e5e7eb}button{background:#2563eb;border:none;cursor:pointer;font-weight:bold}button:hover{background:#1d4ed8}.logout{display:inline-block;width:auto;background:#dc2626;padding:8px 16px;margin-top:24px;text-decoration:none;color:white;border-radius:8px}</style></head><body><h1>🛠️ Add New Product</h1><form method="POST" action="/admin/add-product"><label><strong>Product ID:</strong></label><input type="text" name="id" required placeholder="Unique ID"><label><strong>Product Name:</strong></label><input type="text" name="name" required placeholder="Name of the product"><label><strong>Description:</strong></label><textarea name="description" rows="2" placeholder="Short description"></textarea><label><strong>Price (USD):</strong></label><input type="number" step="0.01" name="price_usd" required placeholder="10.00"><label><strong>Secret Content:</strong> (What they see after paying)</label><textarea name="secret_content" rows="5" required placeholder="Download link, license key, etc."></textarea><button type="submit">Add Product to Store</button></form><a href="/" style="color:#38bdf8; display:block; margin-top:16px;">← Back to Store</a><a href="/admin/logout" class="logout"> Logout</a></body></html>`);
});

app.post('/admin/add-product', requireLogin, (req, res) => {
  const { id, name, description, price_usd, secret_content } = req.body;
  if (!id || !name || !price_usd || !secret_content) {
    return res.send('<h2>Error: Missing required fields.</h2> <a href="/admin">Go Back</a>');
  }
  try {
    db.prepare(`INSERT INTO products (id, name, description, price_usd, secret_content) VALUES (?, ?, ?, ?, ?)`).run(id, name, description || '', Number(price_usd), secret_content);
    res.send(`<h2 style="color: #4ade80; font-family: Arial;">✅ Product "${escapeHtml(name)}" Added Successfully!</h2><a href="/admin" style="color:#38bdf8; font-family: Arial;">Add Another Product</a><br><br><a href="/" style="color:#38bdf8; font-family: Arial;">View Store</a>`);
  } catch (err) {
    res.send(`<h2 style="font-family: Arial;">Error adding product:</h2> <p>${escapeHtml(err.message)}</p> <a href="/admin" style="font-family: Arial;">Go Back</a>`);
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