// utils/sanitize.js
function stripHtml(input = "") { return String(input).replace(/<[^>]*>/g, ""); }
function clampStars(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(1, Math.min(5, Math.round(x)));
}
module.exports = { stripHtml, clampStars };
