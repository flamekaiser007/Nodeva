import { verifySession } from './jwt.js';

// Attaches req.userId/req.userEmail from a Bearer token, or 401s. Every
// route that trusts "who is making this request" must use this rather than
// reading a user_id out of the request body -- a body field is whatever the
// caller claims, a verified token is who they actually authenticated as.
export function requireAuth(secret) {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      return res.status(401).json({ error: 'missing bearer token' });
    }
    try {
      const { userId, email } = verifySession(secret, token);
      req.userId = userId;
      req.userEmail = email;
      next();
    } catch {
      // Deliberately one generic message for expired, malformed, and
      // tampered tokens alike -- distinguishing them in the response gives
      // an attacker free signal about which forgery attempts are "close".
      res.status(401).json({ error: 'invalid or expired token' });
    }
  };
}
