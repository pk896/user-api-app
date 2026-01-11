// routes/debugDanger.js
'use strict';

const express = require('express');
const router = express.Router();

let requireAdmin = null;
try {
  requireAdmin = require('../middleware/requireAdmin');
} catch {
  // Fallback (ONLY if your requireAdmin file is missing)
  requireAdmin = (req, res, next) => {
    if (req.session?.admin) return next();
    return res.status(401).send('Unauthorized (admin only).');
  };
}

let Order = null;
try {
  Order = require('../models/Order');
} catch {
  Order = null;
}

let Product = null;
try {
  Product = require('../models/Product');
} catch {
  Product = null;
}

function safeInt(v, def) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

function isProd() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

/* -------------------------------------------------------
   SAFETY: disable all _danger endpoints in production
-------------------------------------------------------- */
router.use((req, res, next) => {
  if (isProd()) return res.status(404).send('Not found');
  next();
});

/* -------------------------------------------------------
   Ping
-------------------------------------------------------- */
// GET /_danger/ping
router.get('/ping', requireAdmin, (req, res) => {
  res.json({ ok: true, route: '/_danger', now: new Date().toISOString() });
});

/* -------------------------------------------------------
   PRODUCTS (JSON)
-------------------------------------------------------- */
// GET /_danger/products?limit=200
router.get('/products', requireAdmin, async (req, res) => {
  try {
    if (!Product) return res.status(500).json({ ok: false, message: 'Product model not available.' });

    const limit = Math.min(500, Math.max(1, safeInt(req.query.limit, 200)));

    const items = await Product.find({})
      .select('_id customId name price stock avgRating ratingsCount createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error('debug products list error', err);
    return res.status(500).json({ ok: false, message: err?.message || 'Failed to load products' });
  }
});

/* -------------------------------------------------------
   PRODUCTS (BROWSER UI) ✅ FAST DELETE HERE
-------------------------------------------------------- */
// GET /_danger/products/ui?limit=200
router.get('/products/ui', requireAdmin, async (req, res) => {
  try {
    if (!Product) return res.status(500).send('Product model not available.');

    const limit = Math.min(500, Math.max(1, safeInt(req.query.limit, 200)));

    const items = await Product.find({})
      .select('_id customId name price stock avgRating ratingsCount createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const rows = items
      .map((p) => {
        const name = String(p.name || '');
        const customId = String(p.customId || '');
        const id = String(p._id || '');
        const price = p.price ?? '';
        const stock = p.stock ?? '';
        const avg = p.avgRating ?? '';
        const cnt = p.ratingsCount ?? '';
        return `
          <tr>
            <td><code>${id}</code></td>
            <td><code>${customId}</code></td>
            <td>${escapeHtml(name)}</td>
            <td>${escapeHtml(String(price))}</td>
            <td>${escapeHtml(String(stock))}</td>
            <td>${escapeHtml(String(avg))}</td>
            <td>${escapeHtml(String(cnt))}</td>
            <td>
              <form method="POST" action="/_danger/products/${id}/delete" style="margin:0">
                <button type="submit" class="btn-del">Delete</button>
              </form>
            </td>
          </tr>
        `;
      })
      .join('\n');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Danger Products</title>
        <style>
          body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:20px;background:#0b1220;color:#e2e8f0}
          a{color:#60a5fa}
          .top{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
          .pill{padding:6px 10px;border:1px solid rgba(255,255,255,.15);border-radius:999px;background:rgba(255,255,255,.06)}
          table{width:100%;border-collapse:collapse;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.10);border-radius:12px;overflow:hidden}
          th,td{padding:10px;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:top}
          th{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;background:rgba(255,255,255,.04)}
          code{font-size:12px;color:#a78bfa}
          .btn-del{background:#ef4444;color:#fff;border:none;border-radius:10px;padding:8px 10px;font-weight:800;cursor:pointer}
          .btn-del:hover{filter:brightness(1.05)}
          .hint{color:#94a3b8;font-size:13px}
          @media (max-width: 900px){
            table{display:block;overflow:auto}
            th,td{white-space:nowrap}
          }
        </style>
      </head>
      <body>
        <div class="top">
          <div class="pill">/_danger/products/ui</div>
          <div class="pill">count: ${items.length}</div>
          <a href="/_danger/products?limit=${limit}">View JSON</a>
        </div>
        <p class="hint">⚠️ Clicking Delete removes the product immediately from MongoDB.</p>

        <table>
          <thead>
            <tr>
              <th>_id</th>
              <th>customId</th>
              <th>name</th>
              <th>price</th>
              <th>stock</th>
              <th>avgRating</th>
              <th>ratingsCount</th>
              <th>action</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="8">No products found.</td></tr>'}
          </tbody>
        </table>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('products ui error', err);
    return res.status(500).send(err?.message || 'Failed to load products UI.');
  }
});

// POST /_danger/products/:id/delete  (browser delete)
router.post('/products/:id/delete', requireAdmin, async (req, res) => {
  try {
    if (!Product) return res.status(500).send('Product model not available.');

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).send('Missing id.');

    let deleted = null;

    // try Mongo _id delete
    try {
      deleted = await Product.findByIdAndDelete(id).lean();
    } catch {
      deleted = null;
    }

    // fallback: allow deleting by customId if someone pastes it
    if (!deleted) {
      deleted = await Product.findOneAndDelete({ customId: id }).lean();
    }

    // redirect back to UI either way
    return res.redirect('/_danger/products/ui?limit=200');
  } catch (err) {
    console.error('delete product error', err);
    return res.status(500).send(err?.message || 'Failed to delete product.');
  }
});

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/* -------------------------------------------------------
   ORDERS (your existing endpoints)
-------------------------------------------------------- */

// GET /_danger/orders/stats
router.get('/orders/stats', requireAdmin, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const count = await Order.countDocuments({});
    const latest = await Order.find({}, { _id: 1, orderId: 1, status: 1, paymentStatus: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const newest = latest?.[0]?.createdAt ? new Date(latest[0].createdAt).toISOString() : null;

    res.json({ ok: true, count, newest, latest });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'Failed to load stats.' });
  }
});

// GET /_danger/orders
router.get('/orders', requireAdmin, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const page = Math.max(1, safeInt(req.query.page, 1));
    const limit = Math.min(200, Math.max(1, safeInt(req.query.limit, 20)));
    const skip = (page - 1) * limit;

    const sortStr = String(req.query.sort || '-createdAt');
    const sort = sortStr.startsWith('-') ? { [sortStr.slice(1)]: -1 } : { [sortStr]: 1 };

    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const paymentStatus = String(req.query.paymentStatus || '').trim();

    const filter = {};
    if (q) {
      filter.$or = [
        { orderId: { $regex: q, $options: 'i' } },
        { status: { $regex: q, $options: 'i' } },
        { paymentStatus: { $regex: q, $options: 'i' } },
      ];
    }
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

    const projection = {
      orderId: 1,
      status: 1,
      paymentStatus: 1,
      amount: 1,
      refundedTotal: 1,
      refundedAt: 1,
      refundsCount: 1,
      createdAt: 1,
      updatedAt: 1,
      paypal: 1,
      capture0: 1,
      refunds: 1,
      itemsCount: 1,
      items: 1,
    };

    const [count, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter, projection).sort(sort).skip(skip).limit(limit).lean(),
    ]);

    res.json({ ok: true, page, limit, count, pages: Math.ceil(count / limit), orders });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'Failed to list orders.' });
  }
});

// GET /_danger/orders/debug-shape
router.get('/orders/debug-shape', requireAdmin, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const limit = Math.min(200, Math.max(1, safeInt(req.query.limit, 10)));

    const sortStr = String(req.query.sort || '-createdAt');
    const sort = sortStr.startsWith('-') ? { [sortStr.slice(1)]: -1 } : { [sortStr]: 1 };

    const full = String(req.query.full || '').trim() === '1';

    const projection = full
      ? undefined
      : {
          orderId: 1,
          status: 1,
          paymentStatus: 1,
          createdAt: 1,
          updatedAt: 1,
          amount: 1,
          refundedTotal: 1,
          refundedAt: 1,
          paypal: 1,
          capture0: 1,
          refundsCount: 1,
          refunds: 1,
          itemsCount: 1,
          items: 1,
        };

    const [count, orders] = await Promise.all([
      Order.countDocuments({}),
      Order.find({}, projection).sort(sort).limit(limit).lean(),
    ]);

    const sampleKeys = orders && orders.length ? Object.keys(orders[0]) : [];

    res.json({ ok: true, count, sampleKeys, orders });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'Failed to load debug shape.' });
  }
});

// GET /_danger/orders/:id
router.get('/orders/:id', requireAdmin, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, message: 'Missing id.' });

    let doc = null;
    try {
      doc = await Order.findById(id).lean();
    } catch {
      doc = null;
    }

    if (!doc) doc = await Order.findOne({ orderId: id }).lean();
    if (!doc) return res.status(404).json({ ok: false, message: 'Order not found.' });

    res.json({ ok: true, order: doc });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'Failed to load order.' });
  }
});

module.exports = router;
