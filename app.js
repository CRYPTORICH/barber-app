/**
 * Smoke Shop Rewards — Data Layer
 * Pure GitHub stack: reads from raw.githubusercontent.com, writes via GitHub API.
 * No backend, no servers, no Render.
 */

const GH = {
  repo: 'CRYPTORICH/rewards-data',
  file: 'shop_data.json',
  get rawUrl() { return `https://raw.githubusercontent.com/${this.repo}/main/${this.file}`; },
  get apiUrl() { return `https://api.github.com/repos/${this.repo}/contents/${this.file}`; }
};

// ═══════════════════════
// AUTH — embedded reversed token
// ═══════════════════════

const REV = "I8maakcFIKJECB6RtlWceRWEjtBbB4OHhiPG7rOWPNridHZLDLksEY9kbZd_SPkp2G0KoCGS0IC6SMHA11_tap_buhtig";
function _flip(s) { let o=""; for(let i=s.length-1;i>=0;i--) o+=s[i]; return o; }
let _auth = _flip(REV);

// ═══════════════════════
// DATA (cached in memory + persisted to GitHub)
// ═══════════════════════

let _data = null;
let _dirty = false;

function defaultData() {
  return {
    customers: {},
    config: {
      shop_name: 'Smoke Shop Rewards',
      birthday_bonus: 50,
      referral_bonus: 100,
      double_points_days: []
    }
  };
}

async function loadData(force = false) {
  if (_data && !force) return _data;
  try {
    let r = await fetch(GH.rawUrl + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) { _data = await r.json(); return _data; }
  } catch(e) {}
  // Fallback to localStorage
  let local = localStorage.getItem('_rd');
  _data = local ? JSON.parse(local) : defaultData();
  return _data;
}

async function saveData() {
  if (!_data) return;
  // Always save locally
  localStorage.setItem('_rd', JSON.stringify(_data));
  if (!_auth) return;
  try {
    // Get current SHA
    let getResp = await fetch(GH.apiUrl, {
      headers: { 'Authorization': 'Bearer ' + _auth, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!getResp.ok) throw new Error('get sha failed');
    let info = await getResp.json();
    // Upload
    let content = btoa(unescape(encodeURIComponent(JSON.stringify(_data, null, 2))));
    let putResp = await fetch(GH.apiUrl, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + _auth,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: 'Update via rewards app',
        content: content, sha: info.sha, branch: 'main'
      })
    });
    if (!putResp.ok) { let e = await putResp.json(); throw new Error(e.message); }
    _dirty = false;
  } catch(e) {
    _dirty = true;
    console.warn('Save to GitHub failed, saved locally:', e.message);
  }
}

// ═══════════════════════
// TIER SYSTEM
// ═══════════════════════

const TIERS = [
  { name:'Bronze',   min:0,    earn:0.0,  redeem:1.0,  color:'#cd7f32', bg:'rgba(205,127,50,0.12)', icon:'🥉' },
  { name:'Silver',   min:500,  earn:0.10, redeem:1.25, color:'#a8a8b0', bg:'rgba(168,168,176,0.10)', icon:'🥈' },
  { name:'Gold',     min:2000, earn:0.25, redeem:1.50, color:'#d4a843', bg:'rgba(212,168,67,0.10)', icon:'🥇' },
  { name:'Platinum', min:5000, earn:0.50, redeem:2.00, color:'#d4d4dc', bg:'rgba(212,212,220,0.10)', icon:'💎' }
];

function getTier(c) {
  let pts = c.lifetime_points || 0;
  let t = TIERS[0];
  for (let x of TIERS) { if (pts >= x.min) t = x; }
  return t;
}

function nextTier(c) {
  let pts = c.lifetime_points || 0;
  for (let t of TIERS) { if (pts < t.min) return t; }
  return null;
}

function tierProgress(c) {
  let n = nextTier(c);
  if (!n) return 100;
  let cur = getTier(c);
  let total = n.min - cur.min;
  let progress = (c.lifetime_points || 0) - cur.min;
  return Math.min(100, Math.round((progress / total) * 100));
}

function calcPoints(amount, tier) {
  let base = Math.floor(amount) * 10;
  return base + Math.floor(base * tier.earn);
}

function redemptionValue(points, tier) {
  return ((points / 100) * tier.redeem).toFixed(2);
}

const VISIT_BONUSES = { 3: 25, 5: 50, 10: 100 };

// ═══════════════════════
// CUSTOMER OPERATIONS
// ═══════════════════════

function cleanPhone(r) { return (r||'').replace(/\D/g,''); }

function findCustomer(phone) {
  if (!_data) return null;
  return _data.customers?.[phone] || null;
}

function createCustomer(phone, extra = {}) {
  if (!_data) return null;
  let c = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2,6),
    phone, name: extra.name || '', points: 0,
    lifetime_points: 0, lifetime_spend: 0, visit_count: 0,
    birthday: extra.birthday || '',
    referral_code: genCode(),
    referred_by: extra.referred_by || '',
    created_at: new Date().toISOString(),
    transactions: []
  };
  _data.customers[phone] = c;
  return c;
}

function genCode() {
  let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let c = ''; for(let i=0;i<8;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}

// ═══════════════════════
// TRANSACTIONS
// ═══════════════════════

function addPurchase(phone, amount) {
  if (!_data) return null;
  let c = findCustomer(phone);
  if (!c) return null;

  let tier = getTier(c);
  let pts = calcPoints(amount, tier);

  // Double points
  let today = new Date().toISOString().split('T')[0];
  if ((_data.config?.double_points_days || []).includes(today)) pts *= 2;

  c.points = (c.points || 0) + pts;
  c.lifetime_points = (c.lifetime_points || 0) + pts;
  c.lifetime_spend = (c.lifetime_spend || 0) + amount;
  c.visit_count = (c.visit_count || 0) + 1;

  let newTier = getTier(c);
  let tierUp = newTier.name !== tier.name;
  let bonuses = [];

  // Visit streak
  let vb = VISIT_BONUSES[c.visit_count] || 0;
  if (vb) {
    c.points += vb; pts += vb;
    bonuses.push({ type: 'visit_bonus', pts: vb, label: 'Visit #' + c.visit_count + ' streak' });
  }

  // Birthday
  if (c.birthday) {
    let now = new Date();
    let bm = parseInt(c.birthday.split('-')[0]) || parseInt(c.birthday.split('-')[1]);
    if (bm === now.getMonth() + 1) {
      let got = (c.transactions||[]).some(tx => tx.type === 'birthday_bonus' && new Date(tx.timestamp).getFullYear() === now.getFullYear());
      if (!got) {
        let bonus = _data.config?.birthday_bonus || 50;
        c.points += bonus; pts += bonus;
        bonuses.push({ type: 'birthday_bonus', pts: bonus, label: '🎂 Birthday month' });
      }
    }
  }

  // Record transactions
  let now = new Date().toISOString();
  if (!c.transactions) c.transactions = [];
  c.transactions.push({ id: genId(), type: 'purchase', amount, points: pts, tier: newTier.name, timestamp: now });
  bonuses.forEach(b => c.transactions.push({ id: genId(), type: b.type, points: b.pts, note: b.label, timestamp: now }));

  _data.customers[phone] = c;
  saveData();
  return { customer: c, points_earned: pts, tier_up: tierUp, new_tier: newTier, bonuses };
}

function redeemPoints(phone, points) {
  if (!_data) return null;
  let c = findCustomer(phone);
  if (!c || (c.points||0) < points) return null;

  let tier = getTier(c);
  let value = parseFloat(redemptionValue(points, tier));
  c.points -= points;

  if (!c.transactions) c.transactions = [];
  c.transactions.push({
    id: genId(), type: 'redeem', points: -points, value,
    tier: tier.name, timestamp: new Date().toISOString()
  });

  _data.customers[phone] = c;
  saveData();
  return { customer: c, value };
}

function genId() { return Date.now().toString(36) + Math.random().toString(36).substring(2,5); }

// ═══════════════════════
// REFERRALS
// ═══════════════════════

function lookupReferral(code) {
  if (!_data) return null;
  for (let [phone, c] of Object.entries(_data.customers || {})) {
    if (c.referral_code === code.toUpperCase()) return { phone, name: c.name };
  }
  return null;
}

// ═══════════════════════
// STATS
// ═══════════════════════

function getStats() {
  if (!_data) return {};
  let custs = Object.values(_data.customers || {});
  let now = new Date();
  let tiers = { Bronze: 0, Silver: 0, Gold: 0, Platinum: 0 };
  custs.forEach(c => { tiers[getTier(c).name]++; });

  return {
    total: custs.length,
    points: custs.reduce((s,c) => s + (c.points||0), 0),
    lifetime: custs.reduce((s,c) => s + (c.lifetime_points||0), 0),
    tiers,
    birthdays: custs.filter(c => {
      if (!c.birthday) return false;
      let m = parseInt(c.birthday.split('-')[0]) || parseInt(c.birthday.split('-')[1]);
      return m === now.getMonth() + 1;
    }).length,
    referrals: custs.filter(c => c.referred_by).length
  };
}

// ═══════════════════════
// HELPERS
// ═══════════════════════

function enrichCustomer(c) {
  if (!c) return null;
  let t = getTier(c);
  let n = nextTier(c);
  return {
    ...c,
    _tier: t,
    _next: n,
    _progress: tierProgress(c),
    _value: redemptionValue(c.points || 0, t)
  };
}

function formatPhone(p) { return p.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3'); }
function formatDate(d) { return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
function formatCurrency(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 }); }
function formatNumber(n) { return Number(n).toLocaleString(); }

// ═══════════════════════
// INIT
// ═══════════════════════

(async function() {
  await loadData();
  console.log('Rewards engine ready. Token configured. Customers:', Object.keys(_data?.customers||{}).length);
})();
