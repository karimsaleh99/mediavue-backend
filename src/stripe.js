// src/stripe.js
// Stripe checkout + webhook routes. Uses Supabase service-role to flip
// profiles.is_premium when a checkout completes.

const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// All clients are lazy so the server boots even before env vars resolve
// (Railway sometimes runs the entry file before secrets are injected).
let stripe;
function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not set');
    }
    stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return stripe;
}

let supabase;
function getDb() {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return supabase;
}

const PRICES = {
  monthly: 'price_1TIetmCNh46FhHW7NnpwHfzE',
  annual: 'price_1TIeuNCNh46FhHW76z9lKZTY',
  student: 'price_1TIevCCNh46FhHW7V8LAtkno',
};

// Create checkout session
router.post('/create-checkout', async (req, res) => {
  try {
    const { plan, userId, userEmail } = req.body;

    if (!PRICES[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const session = await getStripe().checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: PRICES[plan], quantity: 1 }],
      customer_email: userEmail,
      metadata: { userId, plan },
      success_url: 'https://mediavue.fr?payment=success',
      cancel_url: 'https://mediavue.fr?payment=cancelled',
      locale: 'fr',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook — marks user as premium after payment
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = getStripe().webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { userId, plan } = session.metadata;

    try {
      await getDb()
        .from('profiles')
        .update({
          is_premium: true,
          premium_plan: plan,
          premium_since: new Date().toISOString(),
          stripe_customer_id: session.customer,
        })
        .eq('id', userId);

      console.log(`User ${userId} upgraded to ${plan}`);
    } catch (err) {
      console.error('Supabase update error:', err);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const customerId = subscription.customer;

    try {
      await getDb()
        .from('profiles')
        .update({ is_premium: false, premium_plan: null })
        .eq('stripe_customer_id', customerId);

      console.log(`Subscription cancelled for customer ${customerId}`);
    } catch (err) {
      console.error('Supabase update error:', err);
    }
  }

  res.json({ received: true });
});

module.exports = router;
