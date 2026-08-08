// scripts/migrateKasyoraHomeHeaderImageSingleton.js
'use strict';

require('dotenv').config();

const mongoose = require('mongoose');

const KasyoraHomeHeaderImage =
  require('../models/KasyoraHomeHeaderImage');

async function migrateKasyoraHomeHeaderImageSingleton() {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error(
        'MONGO_URI is not configured.',
      );
    }

    await mongoose.connect(
      process.env.MONGO_URI,
    );

    console.log(
      '✅ Connected to MongoDB.',
    );

    /*
     * First check whether the new singleton
     * configuration already exists.
     */
    const existingSingleton =
      await KasyoraHomeHeaderImage.findOne({
        singletonKey: 'main',
      });

    if (existingSingleton) {
      console.log(
        '✅ Kasyora Home Header Image singleton already exists.',
      );

      console.log(
        `   Record: ${existingSingleton._id}`,
      );

      return;
    }

    /*
     * Find the old pre-singleton Home Header Image.
     *
     * The previous flow displayed the most recently
     * updated configuration, so we preserve that same
     * record as the canonical singleton.
     */
    const legacyHeaderImage =
      await KasyoraHomeHeaderImage.findOne({
        $or: [
          {
            singletonKey: {
              $exists: false,
            },
          },
          {
            singletonKey: null,
          },
        ],
      })
        .sort({
          updatedAt: -1,
          createdAt: -1,
        });

    if (!legacyHeaderImage) {
      console.log(
        'ℹ️ No legacy Kasyora Home Header Image record was found.',
      );

      console.log(
        '   The admin can create the new singleton normally.',
      );

      return;
    }

    console.log(
      `ℹ️ Migrating legacy record: ${legacyHeaderImage._id}`,
    );

    /*
     * Give the existing record its permanent
     * singleton identity.
     *
     * Image URL, active state, timestamps and _id
     * remain attached to the same MongoDB record.
     */
    legacyHeaderImage.singletonKey = 'main';

    await legacyHeaderImage.save();

    console.log(
      '✅ Kasyora Home Header Image migration completed.',
    );

    console.log(
      `   Singleton record: ${legacyHeaderImage._id}`,
    );

    console.log(
      `   Image: ${legacyHeaderImage.image}`,
    );

    console.log(
      `   Active: ${legacyHeaderImage.active}`,
    );
  } catch (err) {
    console.error(
      '❌ Kasyora Home Header Image migration failed:',
      err,
    );

    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();

    console.log(
      '✅ MongoDB connection closed.',
    );
  }
}

migrateKasyoraHomeHeaderImageSingleton();