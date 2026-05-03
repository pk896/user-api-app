// routes/debugDanger.js
'use strict';

const express = require('express');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const { logAdminAction } = require('../utils/logAdminAction');

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

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function productSnapshot(product) {
  if (!product) return null;

  return {
    productId: String(product._id || ''),
    customId: product.customId || '',
    name: product.name || '',
    price: product.price ?? null,
    stock: product.stock ?? null,
    avgRating: product.avgRating ?? null,
    ratingsCount: product.ratingsCount ?? null,
    createdAt: product.createdAt || null,
    updatedAt: product.updatedAt || null,
  };
}

// SAFETY: disable all _danger endpoints in production
router.use((req, res, next) => {
  if (isProd()) return res.status(404).send('Not found');
  return next();
});

// SAFETY: only super_admin can access _danger routes outside production
router.use(requireAdmin, requireAdminRole(['super_admin']));

// GET /_danger/ping
router.get('/ping', (req, res) => {
  res.json({
    ok: true,
    route: '/_danger',
    access: 'super_admin_only',
    productionDisabled: true,
    now: new Date().toISOString(),
  });
});

// GET /_danger/products?limit=200
router.get('/products', async (req, res) => {
  try {
    if (!Product) {
      return res.status(500).json({
        ok: false,
        message: 'Product model not available.',
      });
    }

    const limit = Math.min(500, Math.max(1, safeInt(req.query.limit, 200)));

    const items = await Product.find({})
      .select('_id customId name price stock avgRating ratingsCount createdAt updatedAt')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      ok: true,
      count: items.length,
      items,
    });
  } catch (err) {
    console.error('debug products list error', err);
    return res.status(500).json({
      ok: false,
      message: err?.message || 'Failed to load products',
    });
  }
});

// GET /_danger/products/ui?limit=200
router.get('/products/ui', async (req, res) => {
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
            <td><code>${escapeHtml(id)}</code></td>
            <td><code>${escapeHtml(customId)}</code></td>
            <td>${escapeHtml(name)}</td>
            <td>${escapeHtml(String(price))}</td>
            <td>${escapeHtml(String(stock))}</td>
            <td>${escapeHtml(String(avg))}</td>
            <td>${escapeHtml(String(cnt))}</td>
            <td class="text-end">
              <form
                method="POST"
                action="/_danger/products/${escapeHtml(id)}/delete"
                class="m-0"
                onsubmit="return confirm('This will permanently delete this product from MongoDB. Continue?');"
              >
                <button type="submit" class="btn btn-sm btn-danger">
                  Delete
                </button>
              </form>
            </td>
          </tr>
        `;
      })
      .join('\n');

    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    return res.send(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Danger Products</title>
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css"
          rel="stylesheet"
        >
      </head>
      <body class="bg-light">
        <main class="container py-4">
          <div class="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-4">
            <div>
              <h1 class="h3 text-primary mb-1">Danger Products</h1>
              <p class="text-muted mb-0">
                Super admin only. Disabled in production.
              </p>
            </div>

            <div class="d-flex flex-wrap gap-2">
              <span class="badge bg-primary">/_danger/products/ui</span>
              <span class="badge bg-success">Count: ${items.length}</span>
              <a href="/_danger/products?limit=${limit}" class="btn btn-outline-primary btn-sm">
                View JSON
              </a>
            </div>
          </div>

          <div class="alert alert-danger">
            Clicking Delete removes the product immediately from MongoDB.
          </div>

          <div class="card shadow-sm border-0">
            <div class="card-body p-0">
              <div class="table-responsive">
                <table class="table table-hover align-middle mb-0">
                  <thead class="table-light">
                    <tr>
                      <th>_id</th>
                      <th>customId</th>
                      <th>Name</th>
                      <th>Price</th>
                      <th>Stock</th>
                      <th>Avg Rating</th>
                      <th>Ratings Count</th>
                      <th class="text-end">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${
                      rows ||
                      '<tr><td colspan="8" class="text-center text-muted py-4">No products found.</td></tr>'
                    }
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </main>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('products ui error', err);
    return res.status(500).send(err?.message || 'Failed to load products UI.');
  }
});

// POST /_danger/products/:id/delete
router.post('/products/:id/delete', async (req, res) => {
  try {
    if (!Product) return res.status(500).send('Product model not available.');

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).send('Missing id.');

    let product = null;

    try {
      product = await Product.findById(id).lean();
    } catch {
      product = null;
    }

    if (!product) {
      product = await Product.findOne({ customId: id }).lean();
    }

    if (!product) {
      await logAdminAction(req, {
        action: 'danger.product.delete',
        entityType: 'product',
        entityId: id,
        status: 'failure',
        meta: {
          section: 'debug_danger',
          reason: 'product_not_found',
          identifier: id,
        },
      });

      return res.redirect('/_danger/products/ui?limit=200');
    }

    const before = productSnapshot(product);

    await Product.deleteOne({ _id: product._id });

    await logAdminAction(req, {
      action: 'danger.product.delete',
      entityType: 'product',
      entityId: String(product._id),
      status: 'success',
      before,
      meta: {
        section: 'debug_danger',
        customId: product.customId || '',
        name: product.name || '',
      },
    });

    return res.redirect('/_danger/products/ui?limit=200');
  } catch (err) {
    console.error('delete product error', err);

    await logAdminAction(req, {
      action: 'danger.product.delete',
      entityType: 'product',
      entityId: String(req.params.id || ''),
      status: 'failure',
      meta: {
        section: 'debug_danger',
        error: String(err?.message || err || '').slice(0, 500),
      },
    });

    return res.status(500).send(err?.message || 'Failed to delete product.');
  }
});

// GET /_danger/orders/stats
router.get('/orders/stats', async (req, res) => {
  try {
    if (!Order) {
      return res.status(500).json({
        ok: false,
        message: 'Order model not available.',
      });
    }

    const count = await Order.countDocuments({});
    const latest = await Order.find(
      {},
      { _id: 1, orderId: 1, status: 1, paymentStatus: 1, createdAt: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const newest = latest?.[0]?.createdAt ? new Date(latest[0].createdAt).toISOString() : null;

    return res.json({
      ok: true,
      count,
      newest,
      latest,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || 'Failed to load stats.',
    });
  }
});

// GET /_danger/orders
router.get('/orders', async (req, res) => {
  try {
    if (!Order) {
      return res.status(500).json({
        ok: false,
        message: 'Order model not available.',
      });
    }

    const page = Math.max(1, safeInt(req.query.page, 1));
    const limit = Math.min(200, Math.max(1, safeInt(req.query.limit, 20)));
    const skip = (page - 1) * limit;

    const sortStr = String(req.query.sort || '-createdAt');
    const sort = sortStr.startsWith('-') ? { [sortStr.slice(1)]: -1 } : { [sortStr]: 1 };

    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const paymentStatus = String(req.query.paymentStatus || '').trim();
    const full = String(req.query.full || '').trim() === '1';

    const filter = {};

    if (q) {
      filter.$or = [
        { orderId: { $regex: q, $options: 'i' } },
        { status: { $regex: q, $options: 'i' } },
        { paymentStatus: { $regex: q, $options: 'i' } },
        { 'payer.email': { $regex: q, $options: 'i' } },
        { 'payer.payerId': { $regex: q, $options: 'i' } },
        { 'shipping.email': { $regex: q, $options: 'i' } },
        { 'shipping.phone': { $regex: q, $options: 'i' } },
        { 'paypal.captureId': { $regex: q, $options: 'i' } },
        { 'paypal.orderId': { $regex: q, $options: 'i' } },
      ];
    }

    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

    const projection = full
      ? undefined
      : {
          orderId: 1,
          status: 1,
          paymentStatus: 1,
          amount: 1,
          refundedTotal: 1,
          refundedAt: 1,
          createdAt: 1,
          updatedAt: 1,
          paypal: 1,
          payer: 1,
          shipping: 1,
          refunds: 1,
          items: 1,
          userId: 1,
          businessBuyer: 1,
        };

    const [count, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter, projection).sort(sort).skip(skip).limit(limit).lean(),
    ]);

    return res.json({
      ok: true,
      page,
      limit,
      count,
      pages: Math.ceil(count / limit),
      full,
      orders,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || 'Failed to list orders.',
    });
  }
});

// GET /_danger/orders/debug-shape
router.get('/orders/debug-shape', async (req, res) => {
  try {
    if (!Order) {
      return res.status(500).json({
        ok: false,
        message: 'Order model not available.',
      });
    }

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

    return res.json({
      ok: true,
      count,
      sampleKeys,
      orders,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || 'Failed to load debug shape.',
    });
  }
});

// GET /_danger/orders/:id
router.get('/orders/:id', async (req, res) => {
  try {
    if (!Order) {
      return res.status(500).json({
        ok: false,
        message: 'Order model not available.',
      });
    }

    const id = String(req.params.id || '').trim();
    if (!id) {
      return res.status(400).json({
        ok: false,
        message: 'Missing id.',
      });
    }

    let doc = null;

    try {
      doc = await Order.findById(id).lean();
    } catch {
      doc = null;
    }

    if (!doc) doc = await Order.findOne({ orderId: id }).lean();

    if (!doc) {
      return res.status(404).json({
        ok: false,
        message: 'Order not found.',
      });
    }

    return res.json({
      ok: true,
      order: doc,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: err?.message || 'Failed to load order.',
    });
  }
});

module.exports = router;