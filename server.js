const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Rate limiting for free tier
const freeLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 5,
  message: { error: 'Daily limit reached. Upgrade to Pro for unlimited generations.' }
});

// Auth middleware
const requireAuth = async (req, res, next) => {
  const token = req.cookies?.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  req.user = user;
  next();
};

// Serve static files
app.use(express.static(path.join(__dirname)));

// API: Auth - Sign Up
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
  });
  
  if (error) return res.status(400).json({ error: error.message });
  
  // Create user profile
  await supabase.from('profiles').insert([
    { 
      id: data.user.id, 
      email, 
      tier: 'free',
      generations_today: 0,
      total_generations: 0
    }
  ]);
  
  res.json({ 
    message: 'Check your email to confirm signup',
    user: data.user 
  });
});

// API: Auth - Sign In
app.post('/api/auth/signin', async (req, res) => {
  const { email, password } = req.body;
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  
  if (error) return res.status(401).json({ error: error.message });
  
  res.cookie('auth_token', data.session.access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
  
  res.json({ user: data.user });
});

// API: Auth - Sign Out
app.post('/api/auth/signout', async (req, res) => {
  res.clearCookie('auth_token');
  res.json({ message: 'Signed out' });
});

// API: Get Current User
app.get('/api/auth/user', requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();
  
  res.json({ user: req.user, profile });
});

// API: Create Checkout Session (Pro - $9/mo)
app.post('/api/create-checkout-session', requireAuth, async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    customer_email: req.user.email,
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'CringeForge Pro',
            description: 'Unlimited generations, all platforms, advanced templates',
          },
          unit_amount: 900, // $9.00
          recurring: { interval: 'month' },
        },
        quantity: 1,
      },
    ],
    mode: 'subscription',
    success_url: `${req.headers.origin}/dashboard?success=true`,
    cancel_url: `${req.headers.origin}/pricing?canceled=true`,
  });
  
  res.json({ url: session.url });
});

// API: Webhook for Stripe events
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // Update user tier to pro
    await supabase
      .from('profiles')
      .update({ tier: 'pro', stripe_customer_id: session.customer })
      .eq('email', session.customer_email);
  }
  
  res.json({received: true});
});

// API: Generate Post (with tier checking)
app.post('/api/generate', requireAuth, async (req, res) => {
  const { platform, type } = req.body;
  
  // Get user profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();
  
  // Check tier limits
  if (profile.tier === 'free') {
    if (profile.generations_today >= 5) {
      return res.status(429).json({ 
        error: 'Daily limit reached',
        upgrade_url: '/pricing'
      });
    }
    
    // Increment counter
    await supabase
      .from('profiles')
      .update({ 
        generations_today: profile.generations_today + 1,
        total_generations: profile.total_generations + 1
      })
      .eq('id', req.user.id);
  }
  
  // Generate content (your existing templates)
  const content = generateContent(platform, type);
  
  // Log generation
  await supabase.from('generations').insert([
    { user_id: req.user.id, platform, type, content }
  ]);
  
  res.json({ content, tier: profile.tier });
});

// API: Contact for Agency
app.post('/api/contact-agency', async (req, res) => {
  const { name, email, company, message } = req.body;
  
  // Store in database
  await supabase.from('agency_leads').insert([
    { name, email, company, message, status: 'new' }
  ]);
  
  res.json({ message: 'Thanks! We\'ll be in touch within 24 hours.' });
});

// Content generator function
function generateContent(platform, type) {
  const templates = {
    linkedin: {
      hustle: "I was today years old when I realized that success isn't about the destination—it's about synergizing your core competencies while leveraging paradigm shifts. 💪\\n\\nThis morning I woke up at 4 AM, meditated for 3 hours, and fired someone before breakfast. That's what CEOs do.\\n\\nAgree? 👇",
      positivity: "Just got laid off. Couldn't be more grateful! 🙏\\n\\nSometimes the universe removes you from toxic situations (employment) to put you where you need to be (unemployed).\\n\\nTrust the journey! ✨",
      vague: "3 things I wish I knew before starting my career:\\n\\n1. Trust the process\\n2. Network strategically\\n3. Never give up\\n\\nDrop a 🔥 if you agree!",
      humblebrag: "Humbled to announce I just closed a $50M Series B. I say 'humbled' but honestly I've never been more confident.\\n\\nP.S. - Still driving my 2009 Honda though. Stay grounded. 🚗"
    },
    x: {
      hustle: "Hot take: Working 80 hours a week is actually GOOD for your mental health. Builds character. Separates the wolves from the sheep.\\n\\nAgree or argue below. I'll wait. 👇",
      positivity: "My startup just failed. I'm not sad, I'm EXCITED!\\n\\nFailure is just success in progress. Now I can leverage my learnings to pivot into something even more disruptive!\\n\\nWho's with me? 🔥",
      vague: "The secret to success? It's not what you think. It's not about skills. It's not about connections.\\n\\nIt's about something much deeper. Something I can't explain in a post.\\n\\nDM me 'SUCCESS' to learn more.",
      humblebrag: "Someone asked me: 'How did you become a millionaire before 30?'\\n\\nI laughed. It wasn't easy. It took waking up at 4 AM every day for 10 years.\\n\\nBut if I can do it, anyone with my specific advantages can too! 💪"
    },
    instagram: {
      hustle: "✨ boss babe ✨\\n\\nwaking up at 5am to grind before the grind\\ncoffee in one hand, ambition in the other\\n\\n#girlboss #hustle #entrepreneur #manifesting",
      positivity: "🌸 positive vibes only 🌸\\n\\ndon't let negative energy enter your space\\nif they don't support your dreams, they don't deserve your presence\\n\\n#blessed #grateful #positivevibes #energy",
      vague: "📸 late night thoughts...\\n\\nsometimes you have to let go of what's weighing you down\\neven if it feels heavy\\nespecially if it feels heavy\\n\\n#deep #thoughts #reflection #growth",
      humblebrag: "living my best life ✨\\n\\njust closed another deal from my beachfront office (aka my phone at starbucks but manifesting the beachfront) 💅\\n\\n#blessed #livingmybestlife #manifesting #success"
    },
    facebook: {
      hustle: "COPY AND SHARE IF YOU AGREE!!!\\n\\nI don't work 9-5\\nI work 5-9\\nAM TO AM!!!\\n\\nWHO ELSE IS GRINDING WITH ME???",
      positivity: "SHARE THIS TO BLESS SOMEONE TODAY 🙏\\n\\nGOD has a plan for you\\neven when you can't see it\\nespecially when you can't see it\\n\\nAMEN IF YOU BELIEVE!!!",
      vague: "some people will never understand...\\n\\nand that's okay\\nbecause you're not doing it for them\\nyou're doing it for you\\n\\n*share if you agree*",
      humblebrag: "feeling blessed today 🙏\\n\\njust got back from vacation (3rd one this year lol)\\nhard work pays off!!\\n\\nwho else is living their dreams???"
    }
  };
  
  return templates[platform]?.[type] || "Select a platform and type to generate cringe...";
}

// Serve index.html for all routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CringeForge server running on port ${PORT}`);
});
