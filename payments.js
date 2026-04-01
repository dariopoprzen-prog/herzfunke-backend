// ===== HERZFUNKE – STRIPE BEZAHLSYSTEM =====
// npm install stripe
//
// Zum Testen: Stripe Dashboard → Entwickler → API-Schlüssel → Geheimschlüssel beginnt mit sk_test_…
// Test-Karte: 4242 4242 4242 4242, beliebiges zukünftiges Ablaufdatum, CVC 123

const Stripe = require('stripe');

const STRIPE_SECRET_KEY = (process.env.STRIPE_SECRET_KEY || '').trim();
const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

function requireStripe() {
  if (!stripe) {
    throw new Error(
      'Stripe ist nicht konfiguriert. Setze STRIPE_SECRET_KEY (lokal: sk_test_… aus dem Stripe-Dashboard) und starte den Server neu.'
    );
  }
  return stripe;
}

// ============================================================
// 🔧 PRODUKTE & PREISE – hier anpassen
// ============================================================
const PRODUCTS = {

  // === ABOS ===
  premium_small: {
    type: 'subscription',
    name: 'Premium (Klein)',
    description: 'Unbegrenzt swipen & liken',
    amount: 1999,        // 19,99 €
    currency: 'eur',
    interval: 'month',
    features: ['Unbegrenzt swipen', 'Unbegrenzt liken', '10 Herzfunken inklusive'],
    premiumTier: 'small',
    coins: 10,
    stripePriceId: process.env.STRIPE_PRICE_PREMIUM_SMALL || null, // optional
  },

  premium_big: {
    type: 'subscription',
    name: 'Premium (Groß)',
    description: 'Unbegrenzt swipen & liken',
    amount: 9999,       // 99,99 € / Jahr
    currency: 'eur',
    interval: 'year',
    features: ['Unbegrenzt swipen', 'Unbegrenzt liken', '50 Herzfunken inklusive'],
    premiumTier: 'big',
    coins: 50,
    stripePriceId: process.env.STRIPE_PRICE_PREMIUM_BIG || null,
  },

  // === EINMALIGE KÄUFE (Coins/Credits) ===
  coins_100: {
    type: 'one_time',
    name: '100 Herzfunken',
    description: 'Für Superlike, Boosts und Geschenke',
    amount: 1700,       // 17,00 €  (10 Funken = 1 Nachricht = 1,70 €)
    currency: 'eur',
    coins: 100,
  },

  coins_500: {
    type: 'one_time',
    name: '500 Herzfunken',
    description: 'Bestes Preis-Leistungs-Verhältnis',
    amount: 8500,       // 85,00 €
    currency: 'eur',
    coins: 500,
    badge: 'Beliebt',
  },

  coins_1200: {
    type: 'one_time',
    name: '1200 Herzfunken',
    description: 'Großes Paket für echte Romantikerr',
    amount: 20400,      // 204,00 €
    currency: 'eur',
    coins: 1200,
    badge: 'Bestes Angebot',
  },
};
// ============================================================

/**
 * Erstellt eine Stripe Checkout Session für Abos oder Einmalkäufe.
 * Der Nutzer wird zu Stripe weitergeleitet und kehrt nach Zahlung zurück.
 */
async function createCheckoutSession({ productId, userId, userEmail, successUrl, cancelUrl }) {
  const s = requireStripe();
  const product = PRODUCTS[productId];
  if (!product) throw new Error(`Unbekanntes Produkt: ${productId}`);

  const baseParams = {
    customer_email: userEmail,
    metadata: { userId: String(userId), productId },
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    payment_method_types: ['card', 'paypal', 'sepa_debit'],
    locale: 'de',
  };

  if (product.type === 'subscription') {
    // Abo: Stripe Price ID wird benötigt
    // Falls keine Price ID → dynamisch erstellen (für Tests)
    let priceId = product.stripePriceId;
    if (!priceId) {
      const stripeProduct = await s.products.create({ name: product.name });
      const price = await s.prices.create({
        product: stripeProduct.id,
        unit_amount: product.amount,
        currency: product.currency,
        recurring: { interval: product.interval },
      });
      priceId = price.id;
    }

    return await s.checkout.sessions.create({
      ...baseParams,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
    });

  } else {
    // Einmalkauf
    return await s.checkout.sessions.create({
      ...baseParams,
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: product.currency,
          unit_amount: product.amount,
          product_data: { name: product.name, description: product.description },
        },
      }],
    });
  }
}

/**
 * Verifiziert Stripe Webhook und gibt das Event zurück.
 * Wichtig: rawBody muss ungeparst übergeben werden!
 */
function constructWebhookEvent(rawBody, signature) {
  const s = requireStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET nicht gesetzt');
  return s.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/**
 * Gibt Details einer abgeschlossenen Checkout Session zurück.
 */
async function getSession(sessionId) {
  const s = requireStripe();
  return await s.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'payment_intent'],
  });
}

/**
 * Kündigt ein Abo (am Ende der Laufzeit).
 */
async function cancelSubscription(subscriptionId) {
  const s = requireStripe();
  return await s.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

/**
 * Gibt alle aktiven Abos eines Kunden zurück.
 */
async function getCustomerSubscriptions(customerId) {
  const s = requireStripe();
  const subs = await s.subscriptions.list({
    customer: customerId,
    status: 'active',
  });
  return subs.data;
}

module.exports = {
  PRODUCTS,
  createCheckoutSession,
  constructWebhookEvent,
  getSession,
  cancelSubscription,
  getCustomerSubscriptions,
  stripe,
  isStripeConfigured: () => !!stripe,
};
