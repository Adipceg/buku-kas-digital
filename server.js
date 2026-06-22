const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');

const app = express();
// Menggunakan port dinamis dari Railway, jika tidak ada baru pakai 3000
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Konfigurasi Session / Sesi Login
app.use(session({
    secret: 'kunci_rahasia_buku_kas_rezz',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Sesi aktif selama 1 hari
}));

// ================= CONNECTION POOL (SUDAH FIXED ANTI-CRASH) =================
const db = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',      
    password: process.env.DB_PASSWORD || '',      
    database: process.env.DB_NAME || 'uang-kas-digital',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

console.log('Mantap! Connection Pool Database sudah disiapkan.');

// Middleware untuk proteksi halaman/API kas (Harus Login)
const checkAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Silakan login terlebih dahulu!' });
    }
    next();
};

// ================= API AUTENTIKASI =================

// 1. REGISTER: Daftar Akun Baru (Pakai Gmail + Password Baru)
app.post('/api/auth/register', async (req, res) => {
    const { email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = 'INSERT INTO users (email, password) VALUES (?, ?)';
        db.query(sql, [email, hashedPassword], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Gmail ini sudah terdaftar!' });
                return res.status(500).json({ error: err.message });
            }
            res.status(201).json({ message: 'Akun berhasil dibuat! Silakan login.' });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. LOGIN: Masuk ke Akun
app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    const sql = 'SELECT * FROM users WHERE email = ?';
    db.query(sql, [email], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(400).json({ error: 'Gmail tidak ditemukan!' });

        const user = results[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Password kamu salah!' });

        // Simpan info user di session laptop
        req.session.userId = user.id;
        req.session.userEmail = user.email;
        res.json({ message: 'Login sukses!', email: user.email });
    });
});

// 3. LOGOUT: Keluar Akun
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ message: 'Berhasil logout.' });
    });
});

// 4. CHECK USER: Cek siapa yang sedang login
app.get('/api/auth/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ loggedIn: false });
    res.json({ loggedIn: true, email: req.session.userEmail });
});

// ================= API CRUD BUKU KAS (DIPROTEKSI PER-USER) =================

app.get('/api/kas', checkAuth, (req, res) => {
    const sql = 'SELECT id, DATE_FORMAT(tanggal, "%Y-%m-%d") AS tanggal, kategori, keterangan, tipe, jumlah FROM kas_transaksi WHERE user_id = ? ORDER BY id DESC';
    db.query(sql, [req.session.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/kas', checkAuth, (req, res) => {
    const { tanggal, kategori, keterangan, tipe, jumlah } = req.body;
    const sql = 'INSERT INTO kas_transaksi (user_id, tanggal, kategori, keterangan, tipe, jumlah) VALUES (?, ?, ?, ?, ?, ?)';
    db.query(sql, [req.session.userId, tanggal, kategori, keterangan, tipe, jumlah], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ message: 'Transaksi berhasil disimpan!' });
    });
});

app.put('/api/kas/:id', checkAuth, (req, res) => {
    const { id } = req.params;
    const { tanggal, kategori, keterangan, tipe, jumlah } = req.body;
    const sql = 'UPDATE kas_transaksi SET tanggal = ?, kategori = ?, keterangan = ?, tipe = ?, jumlah = ? WHERE id = ? AND user_id = ?';
    db.query(sql, [tanggal, kategori, keterangan, tipe, jumlah, id, req.session.userId], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Transaksi diperbarui!' });
    });
});

app.delete('/api/kas/:id', checkAuth, (req, res) => {
    const { id } = req.params;
    const sql = 'DELETE FROM kas_transaksi WHERE id = ? AND user_id = ?';
    db.query(sql, [id, req.session.userId], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Transaksi dihapus!' });
    });
});

// ================= API EKSPOR DATA KAS KE EXCEL / XLS =================

app.get('/api/ekspor-csv', checkAuth, (req, res) => {
    const sql = 'SELECT DATE_FORMAT(tanggal, "%Y-%m-%d") AS tanggal, kategori, keterangan, tipe, jumlah FROM kas_transaksi WHERE user_id = ? ORDER BY tanggal DESC';
    
    db.query(sql, [req.session.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });

        let htmlContent = `
        <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
        <head><meta charset="utf-8"></head>
        <body>
            <table border="1">
                <tr style="background-color: #1e3a8a; color: #ffffff; font-weight: bold;">
                    <th>Tanggal</th>
                    <th>Akun/Kategori</th>
                    <th>Keterangan</th>
                    <th>Tipe</th>
                    <th>Jumlah Nominal (Rp)</th>
                </tr>`;

        results.forEach((row) => {
            htmlContent += `
                <tr>
                    <td>${row.tanggal}</td>
                    <td>${row.kategori}</td>
                    <td>${row.keterangan}</td>
                    <td>${row.tipe}</td>
                    <td>${row.jumlah}</td>
                </tr>`;
        });

        htmlContent += `
            </table>
        </body>
        </html>`;

        res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=Laporan_Buku_Kas_Digital.xls');
        
        res.status(200).send(Buffer.from(htmlContent, 'utf-8'));
    });
});

// ================= PERBAIKAN PENTING: MENAMBAHKAN HOST '0.0.0.0' AGAR MENERIMA KONEKSI RAILWAY =================
app.listen(PORT, '0.0.0.0', () => console.log(`Server aktif di port: ${PORT}`));