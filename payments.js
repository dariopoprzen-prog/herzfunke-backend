// ===== HERZFUNKE – STRIPE BEZAHLSYSTEM =====
// npm install stripe

const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_51TGmqxAoFQG1HeY0jehA71wuD7bE77nrlL49XHExhdr9Z4OZthEVFQLEd5BmPlVuoNaYaJTS1yVF3JSTeFUMn3TL00YwbTD4Zi');

// ============================================================
// 🔧 PRODUKTE & PREISE – hier anpassen
// ============================================================
const PRODUCTS = {

  // === ABOS (monatlich) ===
  premium_monthly: {
    type: 'subscription',
    name: 'Premium Monatlich',
    description: 'Unbegrenzte Likes, sehen wer dich geliked hat, Premium-Badge',
    amount: 999,        // in Cents = 9,99 €
    currency: 'eur',
    interval: 'month',
    features: ['Unbegrenzte Likes', 'Sehen wer dich mag', 'Premium Badge', 'Kein Werbung'],
    stripePriceId: process.env.STRIPE_PRICE_PREMIUM_MONTHLY || null, // nach Stripe-Setup eintragen
  },

  premium_yearly: {
    type: 'subscription',
    name: 'Premium Jährlich',
    description: 'Alle Premium-Vorteile – 2 Monate gratis!',
    amount: 7999,       // 79,99 € / Jahr
    currency: 'eur',
    interval: 'year',
    features: ['Alles aus Premium', '2 Monate gratis', 'Prioritäts-Support'],
    stripePriceId: process.env.STRIPE_PRICE_PREMIUM_YEARLY || null,
  },

  // === EINMALIGE KÄUFE (Coins/Credits) ===
  coins_100: {
    type: 'one_time',
    name: '100 Herzfunken',
    description: 'Für Superlike, Boosts und Geschenke',
    amount: 299,        // 2,99 €
    currency: 'eur',
    coins: 100,
  },

  coins_500: {
    type: 'one_time',
    name: '500 Herzfunken',
    description: 'Bestes Preis-Leistungs-Verhältnis',
    amount: 999,        // 9,99 €
    coins: 500,
    badge: 'Beliebt',
  },

  coins_1200: {
    type: 'one_time',
    name: '1200 Herzfunken',
    description: 'Großes Paket für echte Romantikerr',
    amount: 1999,       // 19,99 €
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
      const stripeProduct = await stripe.products.create({ name: product.name });
      const price = await stripe.prices.create({
        product: stripeProduct.id,
        unit_amount: product.amount,
        currency: product.currency,
        recurring: { interval: product.interval },
      });
      priceId = price.id;
    }

    return await stripe.checkout.sessions.create({
      ...baseParams,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
    });

  } else {
    // Einmalkauf
    return await stripe.checkout.sessions.create({
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
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET nicht gesetzt');
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

/**
 * Gibt Details einer abgeschlossenen Checkout Session zurück.
 */
async function getSession(sessionId) {
  return await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription', 'payment_intent'],
  });
}

/**
 * Kündigt ein Abo (am Ende der Laufzeit).
 */
async function cancelSubscription(subscriptionId) {
  return await stripe.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true,
  });
}

/**
 * Gibt alle aktiven Abos eines Kunden zurück.
 */
async function getCustomerSubscriptions(customerId) {
  const subs = await stripe.subscriptions.list({
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
};
