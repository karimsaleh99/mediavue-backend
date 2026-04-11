// Add this to your Railway backend
// File: src/stripe.js

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');

let stripe;
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PRICES = {
  monthly: 'price_1TIetmCNh46FhHW7NnpwHfzE',
  annual: 'price_1TIeuNCNh46FhHW76z9lKZTY',
  student: 'price_1TIevCCNh46FhHW7V8LAtkno',
};

// Create checkout session
router.post('/create-checkout', async (req, res) => {if (!stripe) stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  try {
    const { plan, userId, userEmail } = req.body;

    if (!PRICES[plan]) {
      return res.status(400).json({ error: 'Invalid plan' });
    }

    const session = await stripe.checkout.sessions.create({
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
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {if (!stripe) stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
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
      await supabase
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
      await supabase
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
