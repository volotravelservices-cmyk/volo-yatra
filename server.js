require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const initDB = require('./db/init');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/auth', require('./routes/auth'));
app.use('/api', require('./routes/api'));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function start() {
  await initDB();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Volo Yatra running on port ${PORT}`);
    console.log(`👤 Login: admin@voloyatra.in / Admin@123`);
  });
}
start();
