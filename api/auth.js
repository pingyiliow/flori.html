// auth.js — no longer used for main flow
// Kept for compatibility. Main connection is now via /api/connect
export default function handler(req, res) {
  res.redirect(302, '/');
}
