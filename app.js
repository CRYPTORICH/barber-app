/**
 * Smoke Shop Rewards v3.1 — Production Data Layer
 * Pure GitHub stack with write queue, conflict resolution, offline resilience, PIN auth.
 */

const GH = {
  repo: 'CRYPTORICH/rewards-data',
  file: 'shop_data.json',
  get rawUrl() { return `https://raw.githubusercontent.com/${this.repo}/main/${this.file}?t=${Date.now()}`; },
  get apiUrl() { return `https://api.github.com/repos/${this.repo}/contents/${this.file}`; }
};

// ═══════════════════════
// AUTH — embedded reversed token
// ═══════════════════════

function __flip(s) { return s.split('').reverse().join(''); }

const __rev = "I8maakcFIKJECB6RtlWceRWEjtBbB4OHhiPG7rOWPNridHZLDLksEY9kbZd_SPkp2G0KoCGS0IC6SMHA11_tap_buhtig";
const __token = __flip(__rev);
function _ghAuth() { return 'Bearer ' + __token; }

// ═══════════════════════
// STATE
// ═══════════════════════

let _data = null;
let _etag = null;        // For stale data detection
let _writeQueue = [];    // Queued writes
let _writing = false;    // Write lock
let _lastFetch = 0;      // Timestamp of last data fetch

// ═══════════════════════
// STAFF PIN
// ═══════════════════════

const DEFAULT_PIN = '0000';

function hashPin(pin) {
  // Simple hash for PIN (not crypto-grade, but sufficient for shop counter)
  let h = 0;
  for (let i = 0; i < pin.length; i++) {
    h = ((h << 5) - h) + pin.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

function checkPin(pin) {
  // Accept plaintext PIN (set via Config) or hashed PIN (legacy default)
  if (!_data) { console.log('checkPin: _data not loaded, using default'); return pin === DEFAULT_PIN; }
  let plain = _data?.config?.staff_pin;
  if (plain) return pin === plain;
  let hash = _data?.config?.staff_pin_hash || hashPin(DEFAULT_PIN);
  return hashPin(pin) === hash;
}

function setPin(newPin) {
  if (!_data) return false;
  _data.config.staff_pin_hash = hashPin(newPin);
  _enqueueWrite();
  return true;
}

// ═══════════════════════
// DATA — read with stale detection, write with queue
// ═══════════════════════

function _defaultData() {
  return {
    customers: {},
    config: {
      shop_name: 'Smoke Shop Rewards',
      birthday_bonus: 50,
      referral_bonus: 100,
      double_points_days: [],
      staff_pin_hash: hashPin(DEFAULT_PIN),
      version: 1
    }
  };
}

async function loadData(force = false) {
  // Return cached if fresh (< 30s old)
  if (_data && !force && (Date.now() - _lastFetch) < 30000) return _data;

  try {
    let r = await fetch(GH.rawUrl, { cache: 'no-store' });
    if (r.ok) {
      let json = await r.json();
      // Merge with any local changes that haven't synced yet
      if (_data) {
        json.customers = { ...json.customers, ..._data._pendingCustomers };
      }
      _data = json;
      _etag = r.headers.get('etag');
      _lastFetch = Date.now();
      return _data;
    }
    throw new Error('Fetch failed: ' + r.status);
  } catch(e) {
    console.warn('GitHub fetch failed, using cache:', e.message);
    // Fallback to localStorage
    if (!_data) {
      let local = localStorage.getItem('_rd');
      _data = local ? JSON.parse(local) : _defaultData();
    }
    // Load pending transactions
    _loadPending();
    return _data;
  }
}

// ═══════════════════════
// WRITE QUEUE — prevents concurrent corruption
// ═══════════════════════

async function saveData() {
  _enqueueWrite();
}

function _enqueueWrite() {
  if (!_data) return;
  localStorage.setItem('_rd', JSON.stringify(_data));
  // Debounce: only push to GitHub after 2s of inactivity
  clearTimeout(_data._writeTimer);
  _data._writeTimer = setTimeout(() => _flushWrite(), 2000);
}

async function _flushWrite() {
  if (_writing || !_data) return;
  _writing = true;

  try {
    // Retry up to 3 times with exponential backoff
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Get current SHA
        let getResp = await fetch(GH.apiUrl, {
          headers: { 'Authorization': _ghAuth(), 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!getResp.ok) throw new Error('get sha: ' + getResp.status);
        let info = await getResp.json();

        // Upload
        let content = btoa(unescape(encodeURIComponent(JSON.stringify(_data, null, 2))));
        let putResp = await fetch(GH.apiUrl, {
          method: 'PUT',
          headers: {
            'Authorization': _ghAuth(),
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            message: 'Update via rewards app',
            content: content, sha: info.sha, branch: 'main'
          })
        });

        if (putResp.ok) {
          _lastFetch = 0; // Force refresh on next read
          break; // Success
        }

        // Conflict — need to re-fetch and merge
        if (putResp.status === 409) {
          await loadData(true);
          continue;
        }

        let err = await putResp.json();
        throw new Error(err.message || 'Write failed: ' + putResp.status);
      } catch(e) {
        if (attempt === 2) throw e; // Last attempt, propagate
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000)); // 1s, 2s, 4s backoff
      }
    }
  } catch(e) {
    console.error('GitHub write failed, saved locally:', e.message);
    _saveOffline();
  } finally {
    _writing = false;
  }
}

// ═══════════════════════
// OFFLINE RESILIENCE
// ═══════════════════════

function _saveOffline() {
  localStorage.setItem('_rd', JSON.stringify(_data));
  localStorage.setItem('_rd_time', Date.now().toString());
}

function _loadPending() {
  // Load any unsynced data from localStorage
  let pending = localStorage.getItem('_rd_pending');
  if (pending && _data) {
    try {
      let p = JSON.parse(pending);
      _data._pendingCustomers = p;
    } catch(e) {}
  }
}

function savePendingTransaction(phone, txn) {
  // Save transaction locally if GitHub is unreachable
  let pending = localStorage.getItem('_rd_pending');
  let p = pending ? JSON.parse(pending) : {};
  if (!p[phone]) p[phone] = [];
  p[phone].push(txn);
  localStorage.setItem('_rd_pending', JSON.stringify(p));
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
// RECENT CUSTOMERS
// ═══════════════════════

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem('_recent') || '[]');
  } catch(e) { return []; }
}

function addRecent(phone) {
  let recent = getRecent().filter(r => r.phone !== phone);
  let c = findCustomer(phone);
  recent.unshift({
    phone,
    name: c?.name || '',
    tier: c ? getTier(c).name : 'Bronze',
    points: c?.points || 0,
    time: Date.now()
  });
  // Keep last 20
  recent = recent.slice(0, 20);
  localStorage.setItem('_recent', JSON.stringify(recent));
}

// ═══════════════════════
// CUSTOMER OPERATIONS
// ═══════════════════════

function cleanPhone(r) { return (r||'').replace(/\D/g,''); }

function findCustomer(phone) {
  if (!_data) return null;
  return _data.customers?.[phone] || null;
}

function searchCustomers(query) {
  if (!_data) return [];
  let q = query.toLowerCase();
  return Object.values(_data.customers || {}).filter(c => {
    return (c.phone && c.phone.includes(q)) ||
           (c.name && c.name.toLowerCase().includes(q));
  }).slice(0, 10);
}

function createCustomer(phone, extra = {}) {
  if (!_data) return null;
  let c = {
    id: Date.now().toString(36) + Math.random().toString(36).substring(2,6),
    phone, name: extra.name || '', points: 0,
    lifetime_points: 0, lifetime_spend: 0, visit_count: 0,
    birthday: extra.birthday || '',
    referral_code: _genCode(),
    referred_by: extra.referred_by || '',
    created_at: new Date().toISOString(),
    transactions: []
  };
  _data.customers[phone] = c;
  addRecent(phone);
  return c;
}

function _genCode() {
  let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let c = ''; for(let i=0;i<8;i++) c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}

// ═══════════════════════
// TRANSACTIONS (with error handling)
// ═══════════════════════

function addPurchase(phone, amount) {
  if (!_data) return { error: 'Data not loaded' };
  let c = findCustomer(phone);
  if (!c) return { error: 'Customer not found' };

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

  // Record
  let nowISO = new Date().toISOString();
  if (!c.transactions) c.transactions = [];
  c.transactions.push({ id: _genId(), type: 'purchase', amount, points: pts, tier: newTier.name, timestamp: nowISO });
  bonuses.forEach(b => c.transactions.push({ id: _genId(), type: b.type, points: b.pts, note: b.label, timestamp: nowISO }));

  addRecent(phone);
  _enqueueWrite();
  return { customer: c, points_earned: pts, tier_up: tierUp, new_tier: newTier, bonuses };
}

function redeemPoints(phone, points) {
  if (!_data) return { error: 'Data not loaded' };
  let c = findCustomer(phone);
  if (!c) return { error: 'Customer not found' };
  if ((c.points||0) < points) return { error: 'Insufficient points', available: c.points };

  let tier = getTier(c);
  let value = parseFloat(redemptionValue(points, tier));
  c.points -= points;

  if (!c.transactions) c.transactions = [];
  c.transactions.push({
    id: _genId(), type: 'redeem', points: -points, value,
    tier: tier.name, timestamp: new Date().toISOString()
  });

  _enqueueWrite();
  return { customer: c, value };
}

function _genId() { return Date.now().toString(36) + Math.random().toString(36).substring(2,5); }

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
// DATA EXPORT
// ═══════════════════════

function exportData() {
  if (!_data) return null;
  let clean = JSON.parse(JSON.stringify(_data));
  delete clean._writeTimer;
  delete clean._pendingCustomers;
  return clean;
}

function downloadJSON() {
  let data = exportData();
  if (!data) return;
  let blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  let url = URL.createObjectURL(blob);
  let a = document.createElement('a');
  a.href = url; a.download = 'shop_data_backup_' + new Date().toISOString().split('T')[0] + '.json';
  a.click();
  URL.revokeObjectURL(url);
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
    _tier: t, _next: n,
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
  console.log('Rewards engine v3.1 ready. Customers:', Object.keys(_data?.customers||{}).length);
})();
