// routes/contact.js
const express = require("express");
const router = express.Router();
const ContactMessage = require("../models/ContactMessage");
const requireBusiness = require("../middleware/requireBusiness");

// --- SSE Broker (very small, per-thread) ---
const sseClients = new Map(); // Map<threadId, Set<res>>

function sseAddClient(threadId, res) {
  if (!sseClients.has(threadId)) sseClients.set(threadId, new Set());
  sseClients.get(threadId).add(res);
}

function sseRemoveClient(threadId, res) {
  const set = sseClients.get(threadId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) sseClients.delete(threadId);
}

function sseNotify(threadId, eventName, dataObj) {
  const set = sseClients.get(String(threadId));
  if (!set || !set.size) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch (_) { /* ignore broken pipe */ }
  }
}

/* ===========================================================
 * 📩 GET: Contact Page (for logged-in businesses)
 * =========================================================== */
router.get("/", requireBusiness, (req, res) => {
  const theme = req.session.theme || "light";
  const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

  res.render("contact", {
    title: "Contact Support",
    nonce: res.locals.nonce,
    themeCss,
    business: req.session.business,
  });
});

// GET /contact/thread/:id/stream — live updates for a specific thread
router.get("/thread/:id/stream", async (req, res) => {
  // 🔒 Protect with requireAdmin (and/or requireBusiness) as needed:
  // If you want both sides, you can allow either to pass:
  // - For now, keep it simple: allow admin only. If you want both, add a small guard.
  // (Example hybrid guard)
  const isAdmin = !!req.session.admin;
  const isBusiness = !!req.session.business;
  if (!isAdmin && !isBusiness) {
    return res.status(401).end();
  }

  // Optional: ensure viewer has access to this thread (e.g., business owns it, or admin)
  if (isBusiness) {
    const msg = await ContactMessage.findById(req.params.id).select("business").lean();
    if (!msg || String(msg.business) !== String(req.session.business._id)) {
      return res.status(403).end();
    }
  }

  // SSE headers
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  res.flushHeaders?.();

  // Initial hello (optional)
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);

  // Keepalive every 20s (some proxies close idle connections)
  const keep = setInterval(() => {
    try { res.write(`event: keepalive\ndata: ${Date.now()}\n\n`); } catch (e) {}
  }, 20000);

  const threadId = String(req.params.id);
  sseAddClient(threadId, res);

  req.on("close", () => {
    clearInterval(keep);
    sseRemoveClient(threadId, res);
  });
});

// Admin global stream (receives every thread's newMessage)
let adminClients = new Set();

router.get("/admin/stream", (req, res) => {
  if (!req.session.admin) return res.status(401).end();

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  res.flushHeaders?.();
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);

  const keep = setInterval(() => {
    try { res.write(`event: keepalive\ndata: ${Date.now()}\n\n`); } catch (e) {}
  }, 20000);

  adminClients.add(res);
  req.on("close", () => {
    clearInterval(keep);
    adminClients.delete(res);
  });
});

// helper to notify all admins (list page)
function sseNotifyAdmins(eventName, dataObj) {
  if (!adminClients.size) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`;
  for (const res of adminClients) {
    try { res.write(payload); } catch (_) {}
  }
}

/* ===========================================================
 * 📤 POST: Submit New Message (Business only)
 * =========================================================== */
router.post("/", requireBusiness, async (req, res) => {
  try {
    const { name, email, message } = req.body;
    const business = req.session.business;

    if (!message || !message.trim()) {
      req.flash("error", "⚠️ Please write your message before sending.");
      return res.redirect("/contact");
    }

    await ContactMessage.create({
      business: business._id,
      name: business.name || name,
      email: business.email || email,
      thread: [
        {
          sender: "business",
          message: message.trim(),
          timestamp: new Date(),
        },
      ],
      readByAdmin: false,
      readByBusiness: true,
    });

    req.flash("success", "✅ Message sent successfully to admin.");
    res.redirect("/contact");
  } catch (err) {
    console.error("❌ Error saving contact message:", err);
    req.flash("error", "❌ Could not send your message. Try again later.");
    res.redirect("/contact");
  }
});

/* ===========================================================
 * 🧾 GET: Business Message Center (Only Own Messages)
 * =========================================================== */
router.get("/all", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

    // ✅ Filter messages only belonging to the logged-in business
    const search = req.query.search?.trim() || "";
    const page = parseInt(req.query.page) || 1;
    const limit = 6;
    const skip = (page - 1) * limit;

    const filter = { business: business._id };

    // Optional search by message text
    if (search) {
      filter["thread.message"] = new RegExp(search, "i");
    }

    const totalMessages = await ContactMessage.countDocuments(filter);
    const totalPages = Math.ceil(totalMessages / limit);

    const messages = await ContactMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    console.log(`💬 Loaded ${messages.length} messages for ${business.name}`);

    res.render("business-messages", {
      title: "My Messages",
      nonce: res.locals.nonce,
      themeCss,
      business,
      messages,
      currentPage: page,
      totalPages,
      search,
      success: req.flash("success"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error("❌ Failed to load business messages:", err);
    req.flash("error", "❌ Could not load your messages.");
    res.redirect("/contact");
  }
});

/* ===========================================================
 * 💬 POST: Business Reply (Own Message Only)
 * =========================================================== */
router.post("/reply/:id", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    const { reply } = req.body;

    if (!reply || !reply.trim()) {
      req.flash("error", "⚠️ Reply cannot be empty.");
      return res.redirect("/contact/all");
    }

    // ✅ Ensure the message belongs to this business
    const message = await ContactMessage.findOne({
      _id: req.params.id,
      business: business._id,
    });

    if (!message) {
      req.flash("error", "⛔ Message not found or access denied.");
      return res.redirect("/contact/all");
    }

    message.thread.push({
      sender: "business",
      message: reply.trim(),
      timestamp: new Date(),
    });

    message.readByAdmin = false;
    message.readByBusiness = true;

    await message.save();

    req.flash("success", "✅ Reply sent successfully!");
    res.redirect("/contact/all");
  } catch (err) {
    console.error("❌ Error replying to message:", err);
    req.flash("error", "❌ Could not send your reply.");
    res.redirect("/contact/all");
  }
});

/* ===========================================================
 * 📬 PATCH: Mark a Message as Read
 * =========================================================== */
router.patch("/mark-read/:id", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;

    const message = await ContactMessage.findOne({
      _id: req.params.id,
      business: business._id,
    }).lean();

    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found." });
    }

    message.readByBusiness = true;
    await message.save();

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error marking message as read:", err);
    res.status(500).json({ success: false });
  }
});

// ✅ GET: unread message count
router.get("/unread-count", requireBusiness, async (req, res) => {
  try {
    const businessId = req.session.business?._id;
    if (!businessId) {
      return res.status(401).json({ success: false, message: "Not logged in" });
    }

    const unreadCount = await ContactMessage.countDocuments({
      business: businessId,
      read: false,
    });

    res.json({ success: true, unreadCount });
  } catch (err) {
    console.error("❌ Error fetching unread count:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ===========================================================
 * 🗑️ DELETE: Business Deletes Only Their Messages
 * =========================================================== */
router.post("/delete/:id", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;

    const message = await ContactMessage.findOneAndDelete({
      _id: req.params.id,
      business: business._id,
    });

    if (!message) {
      req.flash("error", "⛔ Message not found or unauthorized.");
      return res.redirect("/contact/all");
    }

    req.flash("success", "🗑️ Message deleted successfully.");
    res.redirect("/contact/all");
  } catch (err) {
    console.error("❌ Error deleting message:", err);
    req.flash("error", "❌ Could not delete message.");
    res.redirect("/contact/all");
  }
});

/* ===========================================================
 * 💬 GET: Logged-in Business's Message Thread (AJAX API)
 * =========================================================== */
router.get("/api/messages/mine", requireBusiness, async (req, res) => {
  try {
    const businessId = req.session.business?._id;
    if (!businessId) {
      return res.status(401).json({ success: false, message: "Not logged in" });
    }

    // Find the most recent message thread for this business
    const message = await ContactMessage.findOne({ business: businessId })
      .sort({ createdAt: -1 })
      .lean();

    if (!message) {
      return res.json({ success: true, thread: [] });
    }

    res.json({
      success: true,
      _id: message._id,
      thread: message.thread,
    });
  } catch (err) {
    console.error("❌ Error fetching messages:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


module.exports = router;
