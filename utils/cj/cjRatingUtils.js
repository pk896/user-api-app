// utils/cj/cjRatingUtils.js
'use strict';

const CjProduct = require('../../models/CjProduct');
const CjRating = require('../../models/CjRating');

/**
 * Recalculate one CJ product's published rating aggregates.
 *
 * Only CjRating records with status "published" are included.
 * Internal Product and Rating collections are never accessed.
 */
async function recalcCjProductRating(cjProductObjectId) {
  if (!cjProductObjectId) {
    return {
      avgRating: 0,
      ratingsCount: 0,
    };
  }

  const [aggregate] = await CjRating.aggregate([
    {
      $match: {
        cjProduct: cjProductObjectId,
        status: 'published',
      },
    },
    {
      $group: {
        _id: '$cjProduct',
        avgRating: {
          $avg: '$stars',
        },
        ratingsCount: {
          $sum: 1,
        },
      },
    },
  ]);

  const avgRating = aggregate
    ? Number(
        Number(
          aggregate.avgRating || 0,
        ).toFixed(2),
      )
    : 0;

  const ratingsCount = aggregate
    ? Math.max(
        0,
        Number(
          aggregate.ratingsCount || 0,
        ),
      )
    : 0;

  await CjProduct.updateOne(
    {
      _id: cjProductObjectId,
    },
    {
      $set: {
        avgRating,
        ratingsCount,
      },
    },
  );

  return {
    avgRating,
    ratingsCount,
  };
}

module.exports = {
  recalcCjProductRating,
};
