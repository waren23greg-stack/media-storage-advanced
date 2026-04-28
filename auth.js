const jwt = require('jsonwebtoken');
const db = require('./warenvault');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'warenvault-secret-key-2024';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '7d';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, uuid: user.uuid, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.getUserById(decoded.id);

    if (!user) {
      return res.status(401).json({ error: 'User no longer exists.' });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

module.exports = { generateToken, hashToken, authenticate, adminOnly };
