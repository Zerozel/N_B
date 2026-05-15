// config/supabase.js
// dotenv is already loaded by server.js before this module is required
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    '❌ FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
    '  → Use the service_role key (starts with eyJ...), NOT the anon/publishable key.\n' +
    '  → Find it in: Supabase Dashboard → Settings → API → service_role'
  );
}

// auth.persistSession = false: This is a server-side bot, not a browser.
// No user sessions needed — we always operate as the service role.
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

module.exports = supabase;
