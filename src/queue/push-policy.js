// When a question may be pushed to a remote platform: after its push delay, and not while someone
// is typing in that session's terminal (they are at the keyboard).
export function presenceHoldUntil(db, cfg, q, now = Date.now()) {
  const presence = (cfg.localPresenceSec || 0) * 1000;
  if (!presence) return null;
  const s = db.getSession(q.session_id);
  if (s?.last_input_at && now - s.last_input_at < presence) return s.last_input_at + presence;
  return null;
}
