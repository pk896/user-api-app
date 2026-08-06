// routes/tempDeleteCjOrders.js
'use strict';

const express = require('express');

const CjOrder = require('../models/CjOrder');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');

const router = express.Router();

/*
 * TEMPORARY DEVELOPMENT-ONLY ROUTE
 * ================================
 *
 * This route deletes all CJ test orders.
 *
 * It is intentionally isolated from the permanent CJ order routes.
 *
 * Delete this entire file immediately after the cleanup succeeds.
 */
router.post(
  '/temporary/delete-all-cj-orders',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      if (
        String(process.env.NODE_ENV || '')
          .trim()
          .toLowerCase() === 'production'
      ) {
        return res.status(403).json({
          ok: false,
          code: 'TEMPORARY_CJ_DELETE_DISABLED',
          message:
            'This temporary CJ deletion route is disabled in production.',
        });
      }

      const confirmation = String(
        req.body?.confirmation || '',
      )
        .trim()
        .toUpperCase();

      if (
        confirmation !==
        'DELETE ALL CJ TEST ORDERS'
      ) {
        return res.status(400).json({
          ok: false,
          code: 'TEMPORARY_CJ_DELETE_CONFIRMATION_REQUIRED',
          message:
            'The exact confirmation phrase is required.',
        });
      }

      const result = await CjOrder.deleteMany({
        department: 'CJ',
      });

      const deletedCount =
        Number(result?.deletedCount || 0);

      console.warn(
        '[temporary CJ cleanup] CJ orders deleted:',
        {
          deletedCount,
          adminId:
            req.admin?._id ||
            req.session?.admin?._id ||
            null,
        },
      );

      return res.status(200).json({
        ok: true,
        deletedCount,
        message:
          `${deletedCount} CJ order(s) deleted successfully.`,
      });
    } catch (error) {
      console.error(
        '[temporary CJ cleanup] Failed:',
        error?.stack || error,
      );

      return res.status(500).json({
        ok: false,
        code: 'TEMPORARY_CJ_DELETE_FAILED',
        message:
          'The temporary CJ order cleanup failed.',
      });
    }
  },
);

module.exports = router;

// open the browser developer console, and paste:
/**
 * fetch('/temporary/delete-all-cj-orders', {
  method: 'POST',
  credentials: 'same-origin',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    confirmation: 'DELETE ALL CJ TEST ORDERS',
  }),
})
  .then(async (response) => {
    const data = await response.json();

    console.log({
      httpStatus: response.status,
      ...data,
    });

    return data;
  })
  .catch((error) => {
    console.error(
      'CJ test-order deletion failed:',
      error,
    );
  });
 */

  // mount

   /*
    * Temporary development-only CJ test-order cleanup.
    *
    * Delete this import after the cleanup succeeds.
    */
   //const tempDeleteCjOrdersRoutes =
     //require('./routes/tempDeleteCjOrders'); 

  /*
   * Temporary development-only CJ test-order cleanup.
   *
   * Final endpoint:
   * POST /temporary/delete-all-cj-orders
   *
   * Delete this mount after the cleanup succeeds.
   * app.use(tempDeleteCjOrdersRoutes);*/