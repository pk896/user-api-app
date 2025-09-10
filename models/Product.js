// models/Product.js
const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true }, // keep custom id
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: String,
  image: {
    type: String,
    required: true, // ensure every product has an image
    validate: {
      validator: function(v) {
        // simple URL validation
        return /^https?:\/\/|^\/\S+/.test(v);
      },
      message: props => `${props.value} is not a valid image URL or path!`
    }
  },
  stock: { type: Number, default: 0 },
  category: String,
  color: String,
  size: String,
  quality: String,
  made: String,
  manufacturer: String,
  type: String,
});

module.exports = mongoose.model("Product", productSchema);















// models/Product.js
/*const mongoose = require("mongoose");

const productSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true }, // keep custom id
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: String,
  image: String,
  stock: { type: Number, default: 0 },
  category: String,
  color: String,
  size: String,
  quality: String,
  made: String,
  manufacturer: String,
  type: String,
});

module.exports = mongoose.model("Product", productSchema);
*/