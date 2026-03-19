// models/HeroSlide.js
'use strict';

const mongoose = require('mongoose');

const heroSlideSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 180,
    },
    subtitle: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },
    description: {
      type: String,
      trim: true,
      maxlength: 300,
      default: '',
    },
    image: {
      type: String,
      required: true,
      trim: true,
    },
    buttonText: {
      type: String,
      trim: true,
      maxlength: 40,
      default: 'Shop Now',
    },
    buttonUrl: {
      type: String,
      trim: true,
      default: '/store/shop',
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.models.HeroSlide || mongoose.model('HeroSlide', heroSlideSchema);