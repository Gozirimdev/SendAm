const { verifyToken } = require('../services/adminAuth.service');
const { sendError } = require('../utils/response');

// Gate for every admin API route. Reads a Bearer token from the Authorization
// header and rejects the request unless it is a valid, unexpired admin token.
const requireAdmin = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  const payload = verifyToken(token);
  if (!payload) {
    return sendError(res, 'Unauthorized', 401);
  }

  req.admin = payload;
  next();
};

module.exports = requireAdmin;
