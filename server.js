import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import session from 'express-session';
import { db } from './db.js';

const app = express();
const PORT = process.env.PORT || 10000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'kaze_super_secret_key_999',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, maxAge: 1000 * 60 * 60 * 24 }
}));

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN; const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); } 
  catch (err) { console.error('Telegram error:', err.message); }
}

function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (['paid', 'finished', 'completed'].includes(s)) return 'paid';
  if (s === 'confirming') return 'confirming';
  if (s === 'waiting') return 'pending';
  if (['rejected', 'expired', 'refunded', 'failed', 'cancelled'].includes(s)) return 'failed';
  return s || 'pending';
}

function getOrderAndProduct(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
  return product ? { order, product } : null;
}

async function createNowPaymentsCheckout({ orderId, productId, priceUsd }) {
  if (!process.env.NOWPAYMENTS_API_KEY) throw new ApiError(500, 'NOWPAYMENTS_API_KEY is not set');
  const headers = { 'x-api-key': process.env.NOWPAYMENTS_API_KEY.trim(), 'Content-Type': 'application/json' };
  const body = { price_amount: Number(priceUsd), price_currency: 'usd', order_id: orderId, order_description: `Product: ${productId}`, success_url: `${BASE_URL}/order/${orderId}`, cancel_url: BASE_URL };
  const res = await fetch('https://api.nowpayments.io/v1/invoice', { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(502, data.message || 'NOWPayments error');
  if (!data.invoice_url) throw new ApiError(502, 'Missing invoice_url');
  return { checkout_url: data.invoice_url, payment_id: data.id, payment_status: 'pending' };
}

async function createOrderCore({ productId }) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) throw new ApiError(404, 'Product not found');
  const orderId = crypto.randomUUID();
  let checkout;
  try { checkout = await createNowPaymentsCheckout({ orderId, productId: product.id, priceUsd: product.price_usd }); } 
  catch (err) { await sendTelegram(`⚠️ Payment failed for ${product.id}: ${err.message}`); throw err; }
  const status = normalizeStatus(checkout.payment_status || 'pending');
  db.prepare(`INSERT INTO orders (id, product_id, status, price_usd, checkout_url, nowpayments_payment_id) VALUES (?, ?, ?, ?, ?, ?)`).run(orderId, product.id, status, product.price_usd, checkout.checkout_url, checkout.payment_id);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  await sendTelegram(`🛒 <b>New Order</b>\nID: <code>${order.id}</code>\nProduct: <code>${product.id}</code>\nPrice: $${product.price_usd}`);
  return { order, product, checkout };
}

// Navigation & Footer
const navHTML = `<nav class="main-nav"><a href="/" class="logo">Kaze <span class="kanji">風</span></a><div class="nav-links"><a href="#shop">SHOP</a><a href="#contact">CONTACT</a><a href="#policy">POLICY</a></div></nav>`;
const footerHTML = `<footer class="main-footer"><p class="tagline">Kaze <span class="dash">—</span> cinematic digital art,</p><p class="copyright">© 2026 KAZE Studio.</p></footer>`;

const svgEmail = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`;
const svgTelegram = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`;
const svgPinterest = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z"/></svg>`;

// MAIN STORE PAGE
app.get('/', (_req, res) => {
  const allProducts = db.prepare('SELECT id, name, price_usd, images FROM products ORDER BY created_at DESC').all();
  
  let productsHTML = '';
  if (allProducts.length === 0) {
    productsHTML = '<div class="empty-state">No products yet. Check back soon.</div>';
  } else {
    productsHTML = '<div class="products-grid">';
    allProducts.forEach((p, index) => {
      let images = [];
      try { images = JSON.parse(p.images || '[]'); } catch (e) { images = p.images ? p.images.split(',').map(s => s.trim()).filter(Boolean) : []; }
      if (images.length === 0 && p.images) images = [p.images];
      
      const imagesJSON = escapeHtml(JSON.stringify(images));
      const firstImage = images.length > 0 ? images[0] : '';
      
      productsHTML += `
        <div class="product-card" data-product-id="${escapeHtml(p.id)}">
          <div class="carousel-container">
            <div class="carousel-images">
              ${images.map((img, i) => `<img src="${escapeHtml(img)}" class="carousel-img ${i === 0 ? 'active' : ''}" onerror="this.style.display='none'">`).join('')}
              ${images.length === 0 ? '<div class="no-image">No Image</div>' : ''}
            </div>
            ${images.length > 1 ? `
              <button class="carousel-btn prev-btn" onclick="changeSlide('${escapeHtml(p.id)}', -1)">‹</button>
              <button class="carousel-btn next-btn" onclick="changeSlide('${escapeHtml(p.id)}', 1)">›</button>
              <div class="carousel-dots">
                ${images.map((_, i) => `<span class="dot ${i === 0 ? 'active' : ''}" onclick="goToSlide('${escapeHtml(p.id)}', ${i})"></span>`).join('')}
              </div>
            ` : ''}
          </div>
          <div class="product-info">
            <div class="product-meta">
              <span class="product-badge">DIGITAL · PDF</span>
              <span class="product-price">$${escapeHtml(p.price_usd)}</span>
            </div>
            <h3 class="product-name">${escapeHtml(p.name)}</h3>
            <form method="POST" action="/buy" class="buy-form">
              <input type="hidden" name="product_id" value="${escapeHtml(p.id)}">
              <button type="submit" class="buy-btn">Purchase</button>
            </form>
          </div>
        </div>
      `;
    });
    productsHTML += '</div>';
  }

  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>KAZE Studio</title><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;1,400&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet"><style>
    html { scroll-behavior: smooth; } * { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: 'Inter', sans-serif; background: #000; color: #e5e5e5; }
    
    /* Navigation with transparent glow bar */
    .main-nav { display: flex; justify-content: space-between; align-items: center; padding: 20px 40px; background: rgba(0,0,0,0.8); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 100; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .logo { font-family: 'Playfair Display', serif; font-size: 1.8em; font-style: italic; color: #7c6ff7; text-decoration: none; } .logo .kanji { font-style: normal; font-size: 0.7em; margin-left: 4px; }
    .nav-links { display: flex; gap: 40px; } .nav-links a { color: #888; text-decoration: none; font-size: 0.85em; letter-spacing: 2px; transition: all 0.3s; position: relative; padding: 8px 16px; border-radius: 20px; } .nav-links a:hover { color: #fff; background: rgba(124,111,247,0.15); }
    
    section { max-width: 1200px; margin: 0 auto; padding: 100px 40px; }
    .badge { display: inline-block; border: 1px solid #333; border-radius: 30px; padding: 10px 28px; font-size: 0.8em; letter-spacing: 3px; color: #7c6ff7; margin-bottom: 40px; }
    .section-title { font-family: 'Playfair Display', serif; font-size: 3.5em; font-weight: 400; color: #fff; margin-bottom: 20px; text-align: center; } .title-divider { width: 60px; height: 1px; background: #333; margin: 0 auto 60px; }
    
    #home { text-align: center; padding: 120px 40px 100px; background: radial-gradient(circle at top, #0a0a1a 0%, #000000 100%); max-width: 100%; }
    .hero-title { font-family: 'Playfair Display', serif; font-size: 5em; font-weight: 400; color: #fff; margin-bottom: 30px; line-height: 1.1; max-width: 900px; margin: 0 auto 30px; }
    .hero-title .highlight { color: #7c6ff7; font-style: italic; } .hero-title .italic { font-style: italic; }
    .hero-subtitle { color: #888; font-size: 1.2em; max-width: 700px; margin: 0 auto 50px; line-height: 1.6; }
    .hero-buttons { display: flex; justify-content: center; gap: 20px; margin-bottom: 60px; }
    .btn-primary { background: #7c6ff7; color: white; text-decoration: none; padding: 16px 32px; border-radius: 50px; font-weight: 500; transition: all 0.3s; } .btn-primary:hover { background: #6b5ce6; transform: translateY(-2px); }
    .btn-outline { background: transparent; color: white; text-decoration: none; padding: 16px 32px; border-radius: 50px; font-weight: 500; border: 1px solid #333; } .btn-outline:hover { border-color: #fff; }
    .trust-badge { color: #666; font-size: 0.95em; display: flex; align-items: center; justify-content: center; gap: 10px; } .trust-stars { color: #7c6ff7; letter-spacing: 2px; }
    
    /* Products Grid - New Design */
    .products-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 30px; }
    .product-card { background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 16px; overflow: hidden; transition: all 0.3s; }
    .product-card:hover { border-color: #2a2a2a; transform: translateY(-4px); box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    
    /* Carousel */
    .carousel-container { position: relative; width: 100%; height: 420px; overflow: hidden; background: #111; }
    .carousel-images { width: 100%; height: 100%; position: relative; }
    .carousel-img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.5s ease; }
    .carousel-img.active { opacity: 1; }
    .no-image { display: flex; align-items: center; justify-content: center; height: 100%; color: #555; font-size: 1.2em; }
    .carousel-btn { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.6); color: #fff; border: none; width: 40px; height: 40px; border-radius: 50%; font-size: 1.5em; cursor: pointer; transition: all 0.3s; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
    .carousel-btn:hover { background: rgba(124,111,247,0.8); }
    .prev-btn { left: 15px; } .next-btn { right: 15px; }
    .carousel-dots { position: absolute; bottom: 15px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,0.3); cursor: pointer; transition: all 0.3s; }
    .dot.active { background: #7c6ff7; width: 24px; border-radius: 4px; }
    
    /* Product Info */
    .product-info { padding: 24px; }
    .product-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .product-badge { background: rgba(124,111,247,0.15); color: #7c6ff7; padding: 6px 14px; border-radius: 20px; font-size: 0.75em; letter-spacing: 1px; font-weight: 500; }
    .product-price { color: #fff; font-size: 1.1em; font-weight: 600; }
    .product-name { font-family: 'Playfair Display', serif; font-size: 1.6em; color: #fff; margin-bottom: 20px; font-weight: 400; }
    .buy-btn { width: 100%; background: #7c6ff7; color: white; border: none; padding: 14px; border-radius: 8px; font-weight: 500; cursor: pointer; transition: all 0.3s; font-size: 0.95em; } .buy-btn:hover { background: #6b5ce6; }
    .empty-state { text-align: center; padding: 80px 20px; color: #555; grid-column: 1 / -1; }
    
    #contact { text-align: center; } .contact-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 24px; max-width: 900px; margin: 0 auto; }
    .contact-card { background: #0a0a0a; border: 1px solid #1a1a1a; border-radius: 12px; padding: 50px 30px; text-align: center; text-decoration: none; color: #e5e5e5; transition: all 0.3s; } .contact-card:hover { border-color: #2a2a2a; transform: translateY(-3px); }
    .contact-icon { width: 48px; height: 48px; margin: 0 auto 20px; } .contact-label { font-family: 'Playfair Display', serif; font-size: 1.4em; margin-bottom: 10px; color: #fff; } .contact-value { color: #666; font-size: 0.95em; }
    .icon-email { color: #f87171; } .icon-telegram { color: #38bdf8; } .icon-pinterest { color: #e91e63; }
    .policy-content { max-width: 800px; margin: 0 auto; } .policy-section { margin-bottom: 50px; } .policy-section h2 { font-family: 'Playfair Display', serif; font-size: 1.8em; color: #fff; margin-bottom: 20px; } .policy-section p { color: #888; line-height: 1.8; }
    .main-footer { text-align: center; padding: 60px 20px 40px; border-top: 1px solid #1a1a1a; } .tagline { font-family: 'Playfair Display', serif; font-style: italic; font-size: 1.3em; color: #7c6ff7; margin-bottom: 20px; } .copyright { color: #555; font-size: 0.9em; }
    code { background: #1a1a1a; padding: 2px 8px; border-radius: 4px; color: #7c6ff7; }
    @media (max-width: 768px) { .main-nav { padding: 16px 20px; flex-direction: column; gap: 16px; } .hero-title { font-size: 3em; } .products-grid { grid-template-columns: 1fr; } .carousel-container { height: 300px; } }
  </style></head><body>${navHTML}
  <section id="home"><h1 class="hero-title">Where <span class="highlight">wind</span> becomes <span class="italic">cinematic art.</span></h1><p class="hero-subtitle">Printable calendars, posters and wall art inspired by JDM culture, anime, and the quiet cinema of Japan at night.</p><div class="hero-buttons"><a href="#shop" class="btn-primary">Enter the store ›</a><a href="#contact" class="btn-outline">Contact us</a></div><div class="trust-badge"><span class="trust-stars">★★★★★</span> Trusted by collectors in 40+ countries</div></section>
  <section id="shop"><div style="text-align:center;"><div class="badge">COLLECTION</div></div><h2 class="section-title">Shop</h2><div class="title-divider"></div>${productsHTML}</section>
  <section id="contact"><div style="text-align:center;"><div class="badge">REACH US</div></div><h2 class="section-title">A quiet channel, always open.</h2><p style="color:#888; margin-bottom:60px; max-width:600px; margin:0 auto;">Questions about a piece, a custom commission, or a wholesale order? We reply within 24h.</p><div class="contact-grid"><a href="mailto:kaze.2.7.7.9.3@gmail.com" class="contact-card"><div class="contact-icon icon-email">${svgEmail}</div><div class="contact-label">Email</div><div class="contact-value">kaze.2.7.7.9.3@gmail.com</div></a><a href="https://t.me/277_RYNA" target="_blank" class="contact-card"><div class="contact-icon icon-telegram">${svgTelegram}</div><div class="contact-label">Telegram</div><div class="contact-value">@277_RYNA</div></a><a href="https://pinterest.com/KAZE277" target="_blank" class="contact-card"><div class="contact-icon icon-pinterest">${svgPinterest}</div><div class="contact-label">Pinterest</div><div class="contact-value">@KAZE277</div></a></div></section>
  <section id="policy"><div style="text-align:center;"><div class="badge">FINE PRINT</div></div><h2 class="section-title">Return & Refund Policy</h2><div class="title-divider"></div><div class="policy-content"><div class="policy-section"><h2>Digital products</h2><p>All digital downloads are final. Because files are delivered instantly and cannot be "returned", we do not offer refunds on digital purchases. If your file is corrupted or the download link fails, contact us within 7 days and we'll re-issue it.</p></div><div class="policy-section"><h2>Custom commissions</h2><p>Custom work is non-refundable once the creative process has begun. We provide previews and revisions throughout the process to ensure your satisfaction before final delivery.</p></div></div></section>${footerHTML}
  <script>
    const carousels = {};
    document.querySelectorAll('.product-card').forEach(card => {
      const id = card.dataset.productId;
      const images = card.querySelectorAll('.carousel-img');
      const dots = card.querySelectorAll('.dot');
      carousels[id] = { images: Array.from(images), dots: Array.from(dots), current: 0 };
    });
    function changeSlide(productId, direction) {
      const c = carousels[productId]; if (!c) return;
      c.images[c.current].classList.remove('active');
      c.dots[c.current].classList.remove('active');
      c.current = (c.current + direction + c.images.length) % c.images.length;
      c.images[c.current].classList.add('active');
      c.dots[c.current].classList.add('active');
    }
    function goToSlide(productId, index) {
      const c = carousels[productId]; if (!c) return;
      c.images[c.current].classList.remove('active');
      c.dots[c.current].classList.remove('active');
      c.current = index;
      c.images[c.current].classList.add('active');
      c.dots[c.current].classList.add('active');
    }
  </script>
  </body></html>`);
});

app.post('/buy', async (req, res) => {
  try { const result = await createOrderCore({ productId: req.body.product_id }); res.redirect(303, `/order/${result.order.id}`); } 
  catch (err) { res.status(err.status || 500).send(`<h1>Error</h1><pre>${escapeHtml(err.message)}</pre><a href="/">Back</a>`); }
});

app.get('/order/:id', (req, res) => {
  const data = getOrderAndProduct(req.params.id);
  if (!data) return res.status(404).send('<h1>Order not found</h1><a href="/">Back</a>');
  const { order, product } = data;
  const isPaid = order.status === 'paid';
  let productBox;
  if (isPaid) {
    const downloadBtn = product.secret_content.startsWith('http') ? `<a href="${escapeHtml(product.secret_content)}" target="_blank" class="pay-btn" style="background:#4ade80;color:#000;margin-top:15px;display:inline-block;">Download PDF / Access File</a>` : '';
    productBox = `<div class="unlocked-box"><h2>✅ Product Unlocked</h2><p><strong>Name:</strong> ${escapeHtml(product.name)}</p>${downloadBtn}<h3 style="margin-top:20px;">Access Link:</h3><pre>${escapeHtml(product.secret_content)}</pre></div>`;
  } else {
    const portalButton = order.checkout_url ? `<a href="${escapeHtml(order.checkout_url)}" target="_blank" class="pay-btn">Proceed to Payment</a>` : `<p>Payment pending...</p>`;
    productBox = `<div class="locked-box"><h2>🔒 Payment Required</h2><p><strong>Price:</strong> <span class="price-tag">$${escapeHtml(order.price_usd)}</span></p>${portalButton}<p class="help-text">Need help? <a href="https://t.me/277_RYNA">Contact us</a></p></div>`;
  }
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Order Details</title><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400&family=Inter:wght@400;600&display=swap" rel="stylesheet"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',sans-serif;background:#000;color:#e5e5e5;min-height:100vh}.container{max-width:700px;margin:0 auto;padding:80px 40px}.card{background:#0a0a0a;border:1px solid #1a1a1a;border-radius:16px;padding:50px}h1{font-family:'Playfair Display',serif;font-size:2.5em;margin-bottom:30px;color:#fff}.info-row{margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid #1a1a1a}.info-label{color:#666;font-size:0.85em;margin-bottom:6px}.info-value{font-size:1.1em;color:#fff}code{background:#1a1a1a;padding:3px 10px;border-radius:4px;color:#7c6ff7}.unlocked-box{background:#064e3b;border:1px solid #4ade80;border-radius:12px;padding:30px;margin-top:30px}.unlocked-box h2{color:#4ade80;margin-bottom:16px}.locked-box{background:#1a1a2e;border:1px solid #2a2a3e;border-radius:12px;padding:30px;margin-top:30px}.locked-box h2{color:#fbbf24;margin-bottom:16px}.price-tag{color:#4ade80;font-size:1.4em;font-weight:600}.pay-btn{display:inline-block;background:#7c6ff7;color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:500;margin-top:16px}.help-text{margin-top:24px;color:#888}.help-text a{color:#7c6ff7;text-decoration:none}pre{background:#020617;padding:20px;border-radius:8px;white-space:pre-wrap;margin-top:16px}a{color:#7c6ff7;text-decoration:none}</style></head><body><div class="container"><div class="card"><h1>Order Details</h1><div class="info-row"><div class="info-label">ORDER ID</div><div class="info-value"><code>${escapeHtml(order.id)}</code></div></div><div class="info-row"><div class="info-label">STATUS</div><div class="info-value" style="color:${order.status === 'paid' ? '#4ade80' : '#fbbf24'};font-weight:600;">${escapeHtml(order.status.toUpperCase())}</div></div><div class="info-row"><div class="info-label">PRICE</div><div class="info-value">$${escapeHtml(order.price_usd)}</div></div>${productBox}<p style="margin-top:32px;"><a href="/">← Back to Shop</a></p></div></div><script>const orderId=${JSON.stringify(order.id)};async function checkStatus(){try{const res=await fetch('/api/orders/'+encodeURIComponent(orderId));const data=await res.json();if(!data.locked)window.location.reload();}catch(e){}}setInterval(checkStatus,5000);</script></body></html>`);
});

app.get('/api/products', (_req, res) => { res.json(db.prepare('SELECT id, price_usd FROM products ORDER BY created_at DESC').all()); });
app.get('/api/orders/:id', (req, res) => { const data = getOrderAndProduct(req.params.id); if (!data) return res.status(404).json({ error: 'Not found' }); res.json({ locked: data.order.status !== 'paid', order: data.order, product: data.order.status === 'paid' ? data.product : { id: data.product.id } }); });
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.post('/webhook/nowpayments', async (req, res) => {
  try {
    const secret = process.env.NOWPAYMENTS_IPN_SECRET;
    if (secret) { const sig = req.header('x-nowpayments-signature') || ''; const hmac = crypto.createHmac('sha512', secret).update(req.rawBody || '').digest('hex'); if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac))) return res.status(401).send('Invalid signature'); }
    const payload = req.body || {}; let order = null;
    if (payload.order_id) order = db.prepare('SELECT * FROM orders WHERE id = ?').get(String(payload.order_id));
    if (!order && payload.payment_id) order = db.prepare('SELECT * FROM orders WHERE nowpayments_payment_id = ?').get(String(payload.payment_id));
    if (!order) return res.status(200).send('ignored');
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
    const previousStatus = order.status; const newStatus = normalizeStatus(payload.payment_status || payload.status || order.status);
    db.prepare(`UPDATE orders SET status = ?, nowpayments_payment_id = COALESCE(?, nowpayments_payment_id), pay_amount = COALESCE(?, pay_amount), paid_at = CASE WHEN ? = 'paid' AND paid_at IS NULL THEN datetime('now') ELSE paid_at END WHERE id = ?`).run(newStatus, payload.payment_id ?? null, payload.pay_amount ?? null, newStatus, order.id);
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    if (previousStatus !== newStatus && ['paid', 'partial', 'failed', 'confirming'].includes(newStatus)) { const emoji = newStatus === 'paid' ? '✅' : newStatus === 'partial' ? '⚠️' : newStatus === 'confirming' ? '🕒' : '❌'; await sendTelegram(`${emoji} <b>Payment ${escapeHtml(newStatus.toUpperCase())}</b>\nOrder ID: <code>${escapeHtml(updated.id)}</code>\nProduct ID: <code>${escapeHtml(product.id)}</code>`); }
    res.status(200).send('ok');
  } catch (err) { console.error('Webhook error:', err); res.status(200).send('ok'); }
});

// ADMIN PANEL
const requireLogin = (req, res, next) => { if (req.session && req.session.isAdmin === true) return next(); res.redirect('/admin/login'); };

app.get('/admin/login', (req, res) => { res.send(`<!doctype html><html><head><title>Admin Login</title><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400&family=Inter:wght@400;500&display=swap" rel="stylesheet"><style>body{font-family:'Inter',sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#000;color:#e5e7eb;margin:0}.login-box{background:#0a0a0a;padding:50px;border-radius:12px;border:1px solid #1a1a1a;width:380px;text-align:center}input{width:100%;padding:14px;margin:20px 0;border-radius:8px;border:1px solid #2a2a2a;background:#000;color:#e5e7eb;box-sizing:border-box;font-size:1em}button{width:100%;padding:16px;border-radius:8px;border:none;background:#7c6ff7;color:white;font-weight:500;cursor:pointer;font-size:1em}button:hover{background:#6b5ce6}.error{color:#f87171;font-size:14px;margin-bottom:16px}h2{font-family:'Playfair Display',serif;font-weight:400;font-size:1.8em;color:#fff}</style></head><body><div class="login-box"><h2>Admin Login</h2><form method="POST" action="/admin/login"><input type="password" name="password" placeholder="Enter Password" required autofocus><button type="submit">Login</button></form></div></body></html>`); });

app.post('/admin/login', (req, res) => {
  const enteredPassword = req.body.password;
  const realPassword = process.env.ADMIN_PASSWORD || 'test123'; 
  console.log('Login attempt - Entered:', enteredPassword, 'Expected:', realPassword);
  if (enteredPassword === realPassword) { req.session.isAdmin = true; res.redirect('/admin'); } 
  else { res.send(`<!doctype html><html><head><title>Admin Login</title><style>body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#000;color:#fff;margin:0}.box{background:#111;padding:40px;border-radius:12px;width:350px;text-align:center}input{width:100%;padding:12px;margin:15px 0;border-radius:6px;border:1px solid #333;background:#000;color:#fff}button{width:100%;padding:14px;border-radius:6px;border:none;background:#7c6ff7;color:#fff;font-weight:bold;cursor:pointer}.error{color:#f87171;margin-bottom:15px}</style></head><body><div class="box"><h2>Admin Login</h2><div class="error">❌ Incorrect password</div><form method="POST" action="/admin/login"><input type="password" name="password" placeholder="Enter Password" required><button>Login</button></form></div></body></html>`); }
});

app.get('/admin', requireLogin, (req, res) => { res.send(`<!doctype html><html><head><title>Admin Dashboard</title><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400&family=Inter:wght@400;500&display=swap" rel="stylesheet"><style>body{font-family:'Inter',sans-serif;margin:0;background:#000;color:#e5e7eb}input,textarea{width:100%;padding:14px;margin:10px 0;box-sizing:border-box;border-radius:8px;border:1px solid #2a2a2a;background:#0a0a0a;color:#e5e7eb;font-family:'Inter',sans-serif}button{background:#7c6ff7;border:none;padding:16px 32px;border-radius:8px;color:white;font-weight:500;cursor:pointer;margin-top:20px}button:hover{background:#6b5ce6}.logout{display:inline-block;background:#dc2626;padding:12px 24px;margin-top:40px;text-decoration:none;color:white;border-radius:8px}a{color:#7c6ff7;text-decoration:none;display:block;margin-top:24px}h1{font-family:'Playfair Display',serif;font-weight:400;font-size:2.2em;color:#fff;margin-bottom:10px}label{display:block;margin-top:24px;color:#aaa;font-size:0.9em}.helper{color:#666;font-size:0.8em;margin-top:-5px;margin-bottom:10px}.container{max-width:700px;margin:0 auto;padding:80px 40px}textarea{min-height:120px;font-family:monospace;font-size:0.9em}</style></head><body><div class="container"><h1>Add New Product</h1><form method="POST" action="/admin/add-product"><label>Product Name</label><input type="text" name="name" required placeholder="e.g., JDM 2026 Calendar"><label>Price (USD)</label><input type="number" step="0.01" name="price_usd" required placeholder="14.00"><label>Product Images (one URL per line)</label><textarea name="images" rows="8" placeholder="https://example.com/image1.jpg&#10;https://example.com/image2.jpg&#10;https://example.com/image3.jpg"></textarea><p class="helper">Add as many image URLs as you want (one per line). Customers can navigate between them using arrows.</p><label>PDF / Download Link</label><input type="url" name="secret_content" required placeholder="https://drive.google.com/..."><p class="helper">Customers get this link after payment</p><button type="submit">Publish Product</button></form><a href="/">← Back to Shop</a><a href="/admin/logout" class="logout">Logout</a></div></body></html>`); });

app.post('/admin/add-product', requireLogin, (req, res) => {
  const { name, price_usd, images, secret_content } = req.body;
  if (!name || !price_usd || !secret_content) return res.send('<h2 style="color:#f87171;">Error: Name, Price, and Download Link required.</h2> <a href="/admin">Go Back</a>');
  try { 
    const autoId = 'PROD-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    const imageList = (images || '').split('\n').map(s => s.trim()).filter(Boolean);
    const imagesJSON = JSON.stringify(imageList);
    db.prepare(`INSERT INTO products (id, name, description, price_usd, images, secret_content) VALUES (?, ?, ?, ?, ?, ?)`).run(autoId, name, '', Number(price_usd), imagesJSON, secret_content); 
    res.send(`<!doctype html><html><head><title>Success</title><style>body{font-family:Arial,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#000;color:#fff;margin:0}.box{background:#111;padding:50px;border-radius:12px;text-align:center}h2{color:#4ade80;margin-bottom:20px}a{color:#7c6ff7;margin:0 10px;text-decoration:none}</style></head><body><div class="box"><h2>✅ Product Published!</h2><p style="color:#888;margin-bottom:30px;">Your product is now live with ${imageList.length} image(s).</p><a href="/admin">Add Another</a><a href="/">View Shop</a></div></body></html>`); 
  } catch (err) { res.send(`<h2 style="color:#f87171;">Error:</h2> <p>${escapeHtml(err.message)}</p> <a href="/admin">Go Back</a>`); }
});

app.get('/admin/logout', (req, res) => { req.session.destroy(() => { res.redirect('/admin/login'); }); });

app.listen(PORT, () => { console.log(`Server running at ${BASE_URL}`); console.log(`Admin: ${BASE_URL}/admin/login`); });
