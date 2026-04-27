const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { SECRET } = require('./middleware');

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const r = await db.query('SELECT * FROM users WHERE email=$1 AND is_active=true', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = r.rows[0];
    if (!await bcrypt.compare(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid email or password' });
    await db.query('UPDATE users SET last_login=NOW() WHERE id=$1', [user.id]);
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, maxAge: 7*24*60*60*1000, sameSite: 'lax' });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', (req, res) => { res.clearCookie('token'); res.json({ success: true }); });

router.get('/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.json({ user: null });
  try { res.json({ user: jwt.verify(token, SECRET) }); }
  catch { res.json({ user: null }); }
});

router.post('/change-password', async (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = jwt.verify(token, SECRET);
    const { currentPassword, newPassword } = req.body;
    const r = await db.query('SELECT * FROM users WHERE id=$1', [user.id]);
    if (!await bcrypt.compare(currentPassword, r.rows[0].password_hash))
      return res.status(400).json({ error: 'Current password incorrect' });
    await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 10), user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
