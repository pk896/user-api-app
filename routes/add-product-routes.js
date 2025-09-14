/** routes/add-product-routes.js */
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Product = require("../models/Product");

// ------------------------------
// Multer storage configuration
// ------------------------------
const UPLOAD_FOLDER = path.join(__dirname, "..", "public", "images", "products-images");

// Ensure folder exists
if (!fs.existsSync(UPLOAD_FOLDER)) {
  fs.mkdirSync(UPLOAD_FOLDER, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_FOLDER);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// ------------------------------
// GET Add Product Form Page
// ------------------------------
router.get("/add", (req, res) => {
  const theme = req.session.theme || "light";
  res.render("add-product", {
    layout: "layout",
    title: "Add Product",
    active: "products",
    user: req.session.user,
    themeCss: theme === "dark" ? "/css/dark.css" : "/css/light.css",
    success_msg: req.flash("success_msg"),
    error_msg: req.flash("error_msg"),
  });
});

// ------------------------------
// GET All Products Page
// ------------------------------
router.get("/", async (req, res) => {
  try {
    const products = await Product.find({});
    const theme = req.session.theme || "light";
    res.render("products", {
      layout: "layout",
      title: "Products",
      active: "products",
      user: req.session.user,
      themeCss: theme === "dark" ? "/css/dark.css" : "/css/light.css",
      products,
      success_msg: req.flash("success_msg"),
      error_msg: req.flash("error_msg"),
    });
  } catch (err) {
    console.error("❌ Error fetching products:", err);
    req.flash("error_msg", "❌ Failed to fetch products.");
    res.redirect("/");
  }
});

// ------------------------------
// POST Add Product
// ------------------------------
router.post("/add", upload.single("imageFile"), async (req, res) => {
  try {
    const productData = { ...req.body };

    // Validate file upload
    if (!req.file) {
      req.flash("error_msg", "❌ Please upload a product image!");
      return res.redirect("/products/add");
    }

    // Store image path relative to public folder
    productData.image = `/images/products-images/${req.file.filename}`;

    const product = new Product(productData);
    await product.save();

    console.log("✅ Product added:", product.id);
    req.flash("success_msg", "✅ Product added successfully!");
    res.redirect("/products");
  } catch (err) {
    console.error("❌ Error adding product:", err);
    req.flash("error_msg", "❌ Failed to add product. Please try again.");
    res.redirect("/products/add");
  }
});

// ------------------------------
// POST Delete Product by ID
// ------------------------------
router.post("/delete/:id", async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product) {
      req.flash("error_msg", "❌ Product not found.");
      return res.redirect("/products");
    }

    // Delete image file if exists
    if (product.image) {
      const imagePath = path.join(__dirname, "..", "public", product.image);
      fs.unlink(imagePath, (err) => {
        if (err) console.warn("⚠️ Could not delete image file:", err.message);
        else console.log("🗑️ Deleted image:", imagePath);
      });
    }

    // Delete product from MongoDB
    await Product.deleteOne({ id: req.params.id });
    req.flash("success_msg", "🗑️ Product deleted successfully!");
    res.redirect("/products");
  } catch (err) {
    console.error("❌ Error deleting product:", err);
    req.flash("error_msg", "❌ Failed to delete product.");
    res.redirect("/products");
  }
});

// ------------------------------
// GET Single Product by ID (JSON API)
// ------------------------------
router.get("/:id", async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error("❌ Error fetching product:", err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

module.exports = router;





















/** routes/add-product-routes.js */
/*const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Product = require("../models/Product");

// ------------------------------
// Multer storage configuration
// ------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Default folder
    let folder = path.join(__dirname, "..", "public", "images", "fruits-images");

    // Ensure folders exist
    const clothesFolder = path.join(__dirname, "..", "public", "images", "clothes-images");
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    if (!fs.existsSync(clothesFolder)) fs.mkdirSync(clothesFolder, { recursive: true });

    // Use type to select folder (fall back to fruits)
    if (req.body.type && req.body.type.toLowerCase() === "clothes") {
      folder = clothesFolder;
    }

    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// ------------------------------
// GET Add Product Form Page
// ------------------------------
router.get("/add", (req, res) => {
  const theme = req.session.theme || "light";
  res.render("add-product", {
    layout: "layout",
    title: "Add Product",
    active: "products",
    user: req.session.user,
    themeCss: theme === "dark" ? "/css/dark.css" : "/css/light.css",
    success_msg: req.flash("success_msg"),
    error_msg: req.flash("error_msg"),
  });
});

// ------------------------------
// GET All Products Page
// ------------------------------
router.get("/", async (req, res) => {
  try {
    const products = await Product.find({});
    const theme = req.session.theme || "light";
    res.render("products", {
      layout: "layout",
      title: "Products",
      active: "products",
      user: req.session.user,
      themeCss: theme === "dark" ? "/css/dark.css" : "/css/light.css",
      products,
      success_msg: req.flash("success_msg"),
      error_msg: req.flash("error_msg"),
    });
  } catch (err) {
    console.error("❌ Error fetching products:", err);
    req.flash("error_msg", "❌ Failed to fetch products.");
    res.redirect("/");
  }
});

// ------------------------------
// POST Add Product
// ------------------------------
router.post("/add", upload.single("imageFile"), async (req, res) => {
  try {
    const productData = { ...req.body };

    // Validate file upload
    if (!req.file) {
      req.flash("error_msg", "❌ Please upload a product image!");
      return res.redirect("/products/add");
    }

    // Set image path relative to public folder
    const imageFolder =
      req.body.type && req.body.type.toLowerCase() === "clothes"
        ? "clothes-images"
        : "fruits-images";
    productData.image = `/images/${imageFolder}/${req.file.filename}`;

    const product = new Product(productData);
    await product.save();

    console.log("✅ Product added:", product.id);
    req.flash("success_msg", "✅ Product added successfully!");
    res.redirect("/products");
  } catch (err) {
    console.error("❌ Error adding product:", err);
    req.flash("error_msg", "❌ Failed to add product. Please try again.");
    res.redirect("/products/add");
  }
});

// ------------------------------
// POST Delete Product by ID
// ------------------------------
router.post("/delete/:id", async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product) {
      req.flash("error_msg", "❌ Product not found.");
      return res.redirect("/products");
    }

    // Delete image file if exists
    if (product.image) {
      const imagePath = path.join(__dirname, "..", "public", product.image);
      fs.unlink(imagePath, (err) => {
        if (err) console.warn("⚠️ Could not delete image file:", err.message);
        else console.log("🗑️ Deleted image:", imagePath);
      });
    }

    // Delete product from MongoDB
    await Product.deleteOne({ id: req.params.id });
    req.flash("success_msg", "🗑️ Product deleted successfully!");
    res.redirect("/products");
  } catch (err) {
    console.error("❌ Error deleting product:", err);
    req.flash("error_msg", "❌ Failed to delete product.");
    res.redirect("/products");
  }
});

// ------------------------------
// GET Single Product by ID (JSON API)
// ------------------------------
router.get("/:id", async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error("❌ Error fetching product:", err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

module.exports = router;*/

















/** routes/add-product-routes.js */
/*const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const Product = require("../models/Product");

// ------------------------------
// Multer storage configuration
// ------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let folder = "public/images/fruits-images"; // default
    if (req.body.type === "clothes") folder = "public/images/clothes-images";
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// ------------------------------
// GET Add Product Form Page
// ------------------------------
router.get("/add", (req, res) => {
  const theme = req.session.theme || "light";
  res.render("add-product", {
    layout: "layout",
    title: "Add Product",
    active: "products",
    user: req.session.user,
    themeCss: theme === "dark" ? "/css/dark.css" : "/css/light.css",
    success_msg: req.flash("success_msg"),
    error_msg: req.flash("error_msg"),
  });
});

// ------------------------------
// GET All Products Page
// ------------------------------
router.get("/", async (req, res) => {
  try {
    const products = await Product.find({});
    const theme = req.session.theme || "light";
    res.render("products", {
      layout: "layout",
      title: "Products",
      active: "products",
      user: req.session.user,
      themeCss: theme === "dark" ? "/css/dark.css" : "/css/light.css",
      products,
      success_msg: req.flash("success_msg"),
      error_msg: req.flash("error_msg"),
    });
  } catch (err) {
    console.error("❌ Error fetching products:", err);
    req.flash("error_msg", "❌ Failed to fetch products.");
    res.redirect("/"); // fallback to home
  }
});

// ------------------------------
// POST Add Product
// ------------------------------
router.post("/add", upload.single("imageFile"), async (req, res) => {
  try {
    const productData = req.body;

    // Set image path based on type
    if (req.file) {
      productData.image =
        req.body.type === "clothes"
          ? `/images/clothes-images/${req.file.filename}`
          : `/images/fruits-images/${req.file.filename}`;
    }

    const product = new Product(productData);
    await product.save();

    console.log("✅ Product added:", product.id);
    req.flash("success_msg", "✅ Product added successfully!");
    res.redirect("/products");
  } catch (err) {
    console.error("❌ Error adding product:", err);
    req.flash("error_msg", "❌ Failed to add product. Please try again.");
    res.redirect("/products/add");
  }
});

// ------------------------------
// POST Delete Product by ID
// ------------------------------
router.post("/delete/:id", async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product) {
      req.flash("error_msg", "❌ Product not found.");
      return res.redirect("/products");
    }

    // Delete image file if exists
    if (product.image) {
      const imagePath = path.join(__dirname, "..", "public", product.image);
      fs.unlink(imagePath, (err) => {
        if (err) console.warn("⚠️ Could not delete image file:", err.message);
        else console.log("🗑️ Deleted image:", imagePath);
      });
    }

    // Delete product from MongoDB
    await Product.deleteOne({ id: req.params.id });
    req.flash("success_msg", "🗑️ Product deleted successfully!");
    res.redirect("/products");
  } catch (err) {
    console.error("❌ Error deleting product:", err);
    req.flash("error_msg", "❌ Failed to delete product.");
    res.redirect("/products");
  }
});

// ------------------------------
// GET Single Product by ID (JSON API)
// ------------------------------
router.get("/:id", async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: "Product not found" });
    res.json(product);
  } catch (err) {
    console.error("❌ Error fetching product:", err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

module.exports = router;
*/

