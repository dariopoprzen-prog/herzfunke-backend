// ===== PAYMENT ROUTES =====
// Diese Routen in deiner server.js einbinden:
// const paymentRoutes = require('./payment-routes');
// app.use('/api/payments', paymentRoutes(db, auth));

const express = require('express');
const {
  PRODUCTS,
  createCheckoutSession,
  constructWebhookEvent,
  getSession,
  cancelSubscription,
} = require('./payments');

module.exports = function(db, authMiddleware) {
  const router = express.Router();

  const dbGet = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,r) => e ? rej(e) : res(r)));
  const dbRun = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e ? rej(e) : res(this); }));

  // Tabellen für Zahlungen
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      stripe_session_id TEXT,
      stripe_subscription_id TEXT,
      stripe_customer_id TEXT,
      status TEXT DEFAULT 'pending',
      amount INTEGER,
      currency TEXT DEFAULT 'eur',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME
    )`);

    db.run(`ALTER TABLE users ADD COLUMN is_premium INTEGER DEFAULT 0`, [], () => {});
    db.run(`ALTER TABLE users ADD COLUMN premium_tier TEXT`, [], () => {});
    db.run(`ALTER TABLE users ADD COLUMN coins INTEGER DEFAULT 0`, [], () => {});
    db.run(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`, [], () => {});
    db.run(`ALTER TABLE users ADD COLUMN subscription_id TEXT`, [], () => {});
  });

  // --- Alle Produkte abrufen ---
  router.get('/products', (req, res) => {
    const list = Object.entries(PRODUCTS).map(([id, p]) => ({
      id,
      name: p.name,
      description: p.description,
      amount: p.amount,
      currency: p.currency,
      type: p.type,
      interval: p.interval || null,
      coins: p.coins || null,
      features: p.features || null,
      badge: p.badge || null,
    }));
    res.json(list);
  });

  // --- Checkout Session erstellen ---
  router.post('/checkout', authMiddleware, async (req, res) => {
    try {
      const { productId } = req.body;
      const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
      if (!user) return res.status(404).json({ message: 'Nutzer nicht gefunden' });

      const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

      const session = await createCheckoutSession({
        productId,
        userId: user.id,
        userEmail: user.email,
        successUrl: `${baseUrl}/payment-success.html`,
        cancelUrl: `${baseUrl}/payment-cancel.html`,
      });

      // Kauf als "pending" speichern
      await dbRun(
        `INSERT INTO purchases (user_id, product_id, stripe_session_id, status, amount, currency)
         VALUES (?,?,?,?,?,?)`,
        [user.id, productId, session.id, 'pending',
         PRODUCTS[productId].amount, PRODUCTS[productId].currency]
      );

      res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
      console.error('Checkout Fehler:', err);
      res.status(500).json({ message: err.message });
    }
  });

  // --- Zahlung bestätigen (nach Redirect) ---
  router.get('/verify/:sessionId', authMiddleware, async (req, res) => {
    try {
      const session = await getSession(req.params.sessionId);
      if (session.payment_status !== 'paid' && session.status !== 'complete') {
        return res.status(400).json({ message: 'Zahlung nicht abgeschlossen' });
      }

      const { userId, productId } = session.metadata;
      if (parseInt(userId) !== req.user.id) {
        return res.status(403).json({ message: 'Nicht berechtigt' });
      }

      const product = PRODUCTS[productId];
      const customerId = session.customer;

      // Kauf als abgeschlossen markieren
      await dbRun(
        `UPDATE purchases SET status='completed', stripe_customer_id=?, stripe_subscription_id=?
         WHERE stripe_session_id=?`,
        [customerId, session.subscription?.id || null, session.id]
      );

      // User-Daten aktualisieren
      if (product.type === 'subscription') {
        // Premium aktivieren (läuft 30/365 Tage)
        const days = product.interval === 'year' ? 365 : 30;
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
        const coinsGrant = Number(product.coins || 0);
        await dbRun(
          `UPDATE users SET is_premium=1, premium_tier=?, stripe_customer_id=?, subscription_id=? WHERE id=?`,
          [product.premiumTier || null, customerId, session.subscription?.id || null, userId]
        );
        if (coinsGrant > 0) {
          await dbRun('UPDATE users SET coins = coins + ? WHERE id=?', [coinsGrant, userId]);
        }
        await dbRun(
          `UPDATE purchases SET expires_at=? WHERE stripe_session_id=?`,
          [expiresAt, session.id]
        );
      } else {
        // Coins gutschreiben
        await dbRun(
          `UPDATE users SET coins = coins + ?, stripe_customer_id=? WHERE id=?`,
          [product.coins, customerId, userId]
        );
      }

      const user = await dbGet('SELECT id, name, is_premium, premium_tier, coins FROM users WHERE id=?', [userId]);
      res.json({ success: true, user, productId });

    } catch (err) {
      console.error('Verify Fehler:', err);
      res.status(500).json({ message: err.message });
    }
  });

  // --- Abo kündigen ---
  router.post('/cancel-subscription', authMiddleware, async (req, res) => {
    try {
      const user = await dbGet('SELECT * FROM users WHERE id=?', [req.user.id]);
      if (!user?.subscription_id) return res.status(400).json({ message: 'Kein aktives Abo' });
      await cancelSubscription(user.subscription_id);
      res.json({ message: 'Abo wird am Ende der Laufzeit gekündigt.' });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  });

  // --- Meine Käufe ---
  router.get('/my-purchases', authMiddleware, async (req, res) => {
    const purchases = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM purchases WHERE user_id=? ORDER BY created_at DESC', [req.user.id],
        (err, rows) => err ? reject(err) : resolve(rows));
    });
    res.json(purchases);
  });

  // --- Stripe Webhook (OHNE Auth – Stripe ruft direkt auf) ---
  // WICHTIG: express.raw() muss VOR express.json() für diese Route kommen!
  // In server.js hinzufügen:
  // app.use('/api/payments/webhook', express.raw({type: 'application/json'}));
  router.post('/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = constructWebhookEvent(req.body, sig);
      } catch (err) {
        console.error('Webhook Fehler:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      try {
        switch (event.type) {

          case 'checkout.session.completed': {
            const session = event.data.object;
            console.log(`✅ Zahlung abgeschlossen: ${session.id}`);
            // Bereits in /verify behandelt – hier optional nochmal absichern
            break;
          }

          case 'invoice.payment_succeeded': {
            // Abo-Verlängerung
            const invoice = event.data.object;
            const customerId = invoice.customer;
            await dbRun('UPDATE users SET is_premium=1 WHERE stripe_customer_id=?', [customerId]);
            // Coins bei Verlängerung gutschreiben (nach Tier)
            const u = await dbGet('SELECT id, premium_tier FROM users WHERE stripe_customer_id=?', [customerId]);
            const tier = (u?.premium_tier || '').toLowerCase();
            const grant = tier === 'big' ? 50 : tier === 'small' ? 10 : 0;
            if (u?.id && grant > 0) {
              await dbRun('UPDATE users SET coins = coins + ? WHERE id=?', [grant, u.id]);
            }
            console.log(`🔄 Abo verlängert für Customer: ${customerId}`);
            break;
          }

          case 'invoice.payment_failed': {
            const invoice = event.data.object;
            console.warn(`❌ Zahlung fehlgeschlagen: ${invoice.customer}`);
            // Optional: User benachrichtigen
            break;
          }

          case 'customer.subscription.deleted': {
            // Abo abgelaufen oder gekündigt
            const sub = event.data.object;
            await dbRun(
              'UPDATE users SET is_premium=0, subscription_id=NULL WHERE stripe_customer_id=?',
              [sub.customer]
            );
            console.log(`🚫 Abo beendet für Customer: ${sub.customer}`);
            break;
          }
        }

        res.json({ received: true });
      } catch (err) {
        console.error('Webhook Verarbeitung Fehler:', err);
        res.status(500).json({ error: err.message });
      }
    }
  );

  return router;
};
