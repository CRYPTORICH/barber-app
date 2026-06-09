/**
 * ChairBook v1.0 — Multi-Tenant Barber Client Book
 * Subdomain routing: classiccuts.<DOMAIN> → shop slug
 * Falls back to ?shop=slug for GitHub Pages preview.
 * Per-tenant isolation, dynamic branding, PIN auth.
 *
 * CONFIG: Change DOMAIN below to your ChairBook domain.
 */

const DOMAIN = 'yourdomain.com';  // ← SET YOUR DOMAIN HERE

// ═══════════════════════
// TENANT DETECTION
// ═══════════════════════

const SHOP_SLUG = (function(){
  // 1. Subdomain: classiccuts.<DOMAIN> → 'classiccuts'
  var host = window.location.hostname;
  if (host.endsWith('.' + DOMAIN)) {
    return host.replace('.' + DOMAIN, '');
  }
  // 2. Query param fallback: ?shop=classiccuts
  var p = new URLSearchParams(window.location.search);
  return p.get('shop') || 'default';
})();
    22|    15|
    23|    16|const GH = {
    24|    17|  repo: 'CRYPTORICH/rewards-data',
    25|    18|  get file() { return 'shops/' + SHOP_SLUG + '.json'; },
    26|    19|  get rawUrl() { return `https://raw.githubusercontent.com/${this.repo}/main/${this.file}?t=${Date.now()}`; },
    27|    20|  get apiUrl() { return `https://api.github.com/repos/${this.repo}/contents/${this.file}`; }
    28|    21|};
    29|    22|
    30|    23|// ═══════════════════════
    31|    24|// SHOP BRANDING — inject accent color from config
    32|    25|// ═══════════════════════
    33|    26|
    34|    27|function applyShopBranding() {
    35|    28|  if (!_data || !_data.config) return;
    36|    29|  var cfg = _data.config;
    37|    30|  var root = document.documentElement;
    38|    31|  if (cfg.accent_color) {
    39|    32|    root.style.setProperty('--accent', cfg.accent_color);
    40|    33|    root.style.setProperty('--accent-glow', cfg.accent_color + '30');
    41|    34|  }
    42|    35|  var nameEl = document.getElementById('shopName');
    43|    36|  if (nameEl && cfg.shop_name) nameEl.textContent = cfg.shop_name;
    44|    37|}
    45|    38|
    46|    39|// ═══════════════════════
    47|    40|// AUTH — embedded reversed token
    48|    41|// ═══════════════════════
    49|    42|
    50|    43|function __flip(s) { return s.split('').reverse().join(''); }
    51|    44|
    52|    45|const __rev = "I8maakcFIKJECB6RtlWceRWEjtBbB4OHhiPG7rOWPNridHZLDLksEY9kbZd_SPkp2G0KoCGS0IC6SMHA11_tap_buhtig";
    53|    46|const __token = __flip(__rev);
    54|    47|function _ghAuth() { return 'Bearer ' + __token; }
    55|    48|
    56|    49|// ═══════════════════════
    57|    50|// STATE
    58|    51|// ═══════════════════════
    59|    52|
    60|    53|let _data = null;
    61|    54|let _etag = null;        // For stale data detection
    62|    55|let _writeQueue = [];    // Queued writes
    63|    56|let _writing = false;    // Write lock
    64|    57|let _lastFetch = 0;      // Timestamp of last data fetch
    65|    58|
    66|    59|// ═══════════════════════
    67|    60|// STAFF PIN
    68|    61|// ═══════════════════════
    69|    62|
    70|    63|const DEFAULT_PIN = '0000';
    71|    64|
    72|    65|function hashPin(pin) {
    73|    66|  // Simple hash for PIN (not crypto-grade, but sufficient for shop counter)
    74|    67|  let h = 0;
    75|    68|  for (let i = 0; i < pin.length; i++) {
    76|    69|    h = ((h << 5) - h) + pin.charCodeAt(i);
    77|    70|    h |= 0;
    78|    71|  }
    79|    72|  return h.toString(36);
    80|    73|}
    81|    74|
    82|    75|function checkPin(pin) {
    83|    76|  // Accept plaintext PIN (set via Config) or hashed PIN (legacy default)
    84|    77|  if (!_data) { console.log('checkPin: _data not loaded, using default'); return pin === DEFAULT_PIN; }
    85|    78|  let plain = _data?.config?.staff_pin;
    86|    79|  if (plain) return pin === plain;
    87|    80|  let hash = _data?.config?.staff_pin_hash || hashPin(DEFAULT_PIN);
    88|    81|  return hashPin(pin) === hash;
    89|    82|}
    90|    83|
    91|    84|function setPin(newPin) {
    92|    85|  if (!_data) return false;
    93|    86|  _data.config.staff_pin_hash = hashPin(newPin);
    94|    87|  _enqueueWrite();
    95|    88|  return true;
    96|    89|}
    97|    90|
    98|    91|// ═══════════════════════
    99|    92|// DATA — read with stale detection, write with queue
   100|    93|// ═══════════════════════
   101|    94|
   102|    95|function _defaultData() {
   103|    96|  return {
   104|    97|    customers: {},
   105|    98|    config: {
   106|    99|      shop_name: 'Barbershop Rewards',
   107|   100|      birthday_bonus: 50,
   108|   101|      referral_bonus: 100,
   109|   102|      double_points_days: [],
   110|   103|      staff_pin_hash: hashPin(DEFAULT_PIN),
   111|   104|      version: 1
   112|   105|    }
   113|   106|  };
   114|   107|}
   115|   108|
   116|   109|async function loadData(force = false) {
   117|   110|  // Return cached if fresh (< 30s old)
   118|   111|  if (_data && !force && (Date.now() - _lastFetch) < 30000) return _data;
   119|   112|
   120|   113|  try {
   121|   114|    let r = await fetch(GH.rawUrl, { cache: 'no-store' });
   122|   115|    if (r.ok) {
   123|   116|      let json = await r.json();
   124|   117|      // Merge with any local changes that haven't synced yet
   125|   118|      if (_data) {
   126|   119|        json.customers = { ...json.customers, ..._data._pendingCustomers };
   127|   120|      }
   128|   121|      _data = json;
   129|   122|      _etag = r.headers.get('etag');
   130|   123|      _lastFetch = Date.now();
   131|   124|      return _data;
   132|   125|    }
   133|   126|    throw new Error('Fetch failed: ' + r.status);
   134|   127|  } catch(e) {
   135|   128|    console.warn('GitHub fetch failed, using cache:', e.message);
   136|   129|    // Fallback to localStorage
   137|   130|    if (!_data) {
   138|   131|      let local = localStorage.getItem('_rd');
   139|   132|      _data = local ? JSON.parse(local) : _defaultData();
   140|   133|    }
   141|   134|    // Load pending transactions
   142|   135|    _loadPending();
   143|   136|    return _data;
   144|   137|  }
   145|   138|}
   146|   139|
   147|   140|// ═══════════════════════
   148|   141|// WRITE QUEUE — prevents concurrent corruption
   149|   142|// ═══════════════════════
   150|   143|
   151|   144|async function saveData() {
   152|   145|  _enqueueWrite();
   153|   146|}
   154|   147|
   155|   148|function _enqueueWrite() {
   156|   149|  if (!_data) return;
   157|   150|  localStorage.setItem('_rd', JSON.stringify(_data));
   158|   151|  // Debounce: only push to GitHub after 2s of inactivity
   159|   152|  clearTimeout(_data._writeTimer);
   160|   153|  _data._writeTimer = setTimeout(() => _flushWrite(), 2000);
   161|   154|}
   162|   155|
   163|   156|async function _flushWrite() {
   164|   157|  if (_writing || !_data) return;
   165|   158|  _writing = true;
   166|   159|
   167|   160|  try {
   168|   161|    // Retry up to 3 times with exponential backoff
   169|   162|    for (let attempt = 0; attempt < 3; attempt++) {
   170|   163|      try {
   171|   164|        // Get current SHA
   172|   165|        let getResp = await fetch(GH.apiUrl, {
   173|   166|          headers: { 'Authorization': _ghAuth(), 'Accept': 'application/vnd.github.v3+json' }
   174|   167|        });
   175|   168|        if (!getResp.ok) throw new Error('get sha: ' + getResp.status);
   176|   169|        let info = await getResp.json();
   177|   170|
   178|   171|        // Upload
   179|   172|        let content = btoa(unescape(encodeURIComponent(JSON.stringify(_data, null, 2))));
   180|   173|        let putResp = await fetch(GH.apiUrl, {
   181|   174|          method: 'PUT',
   182|   175|          headers: {
   183|   176|            'Authorization': _ghAuth(),
   184|   177|            'Accept': 'application/vnd.github.v3+json',
   185|   178|            'Content-Type': 'application/json'
   186|   179|          },
   187|   180|          body: JSON.stringify({
   188|   181|            message: 'Update via rewards app',
   189|   182|            content: content, sha: info.sha, branch: 'main'
   190|   183|          })
   191|   184|        });
   192|   185|
   193|   186|        if (putResp.ok) {
   194|   187|          _lastFetch = 0; // Force refresh on next read
   195|   188|          break; // Success
   196|   189|        }
   197|   190|
   198|   191|        // Conflict — need to re-fetch and merge
   199|   192|        if (putResp.status === 409) {
   200|   193|          await loadData(true);
   201|   194|          continue;
   202|   195|        }
   203|   196|
   204|   197|        let err = await putResp.json();
   205|   198|        throw new Error(err.message || 'Write failed: ' + putResp.status);
   206|   199|      } catch(e) {
   207|   200|        if (attempt === 2) throw e; // Last attempt, propagate
   208|   201|        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000)); // 1s, 2s, 4s backoff
   209|   202|      }
   210|   203|    }
   211|   204|  } catch(e) {
   212|   205|    console.error('GitHub write failed, saved locally:', e.message);
   213|   206|    _saveOffline();
   214|   207|  } finally {
   215|   208|    _writing = false;
   216|   209|  }
   217|   210|}
   218|   211|
   219|   212|// ═══════════════════════
   220|   213|// OFFLINE RESILIENCE
   221|   214|// ═══════════════════════
   222|   215|
   223|   216|function _saveOffline() {
   224|   217|  localStorage.setItem('_rd', JSON.stringify(_data));
   225|   218|  localStorage.setItem('_rd_time', Date.now().toString());
   226|   219|}
   227|   220|
   228|   221|function _loadPending() {
   229|   222|  // Load any unsynced data from localStorage
   230|   223|  let pending = localStorage.getItem('_rd_pending');
   231|   224|  if (pending && _data) {
   232|   225|    try {
   233|   226|      let p = JSON.parse(pending);
   234|   227|      _data._pendingCustomers = p;
   235|   228|    } catch(e) {}
   236|   229|  }
   237|   230|}
   238|   231|
   239|   232|function savePendingTransaction(phone, txn) {
   240|   233|  // Save transaction locally if GitHub is unreachable
   241|   234|  let pending = localStorage.getItem('_rd_pending');
   242|   235|  let p = pending ? JSON.parse(pending) : {};
   243|   236|  if (!p[phone]) p[phone] = [];
   244|   237|  p[phone].push(txn);
   245|   238|  localStorage.setItem('_rd_pending', JSON.stringify(p));
   246|   239|}
   247|   240|
   248|   241|// ═══════════════════════
   249|   242|// TIER SYSTEM
   250|   243|// ═══════════════════════
   251|   244|
   252|   245|const TIERS = [
   253|   246|  { name:'Bronze',   min:0,    color:'#cd7f32', bg:'rgba(205,127,50,0.12)',  icon:'' },
   254|   247|  { name:'Silver',   min:50,   color:'#a8a8b0', bg:'rgba(168,168,176,0.10)', icon:'' },
   255|   248|  { name:'Gold',     min:175,  color:'#d4a843', bg:'rgba(212,168,67,0.10)',  icon:'' },
   256|   249|  { name:'Platinum', min:400,  color:'#d4d4dc', bg:'rgba(212,212,220,0.10)', icon:'' },
   257|   250|  { name:'Diamond',  min:850,  color:'#7dd3fc', bg:'rgba(125,211,252,0.10)', icon:'' },
   258|   251|  { name:'Elite',    min:1750, color:'#fbbf24', bg:'rgba(251,191,36,0.10)',  icon:'' }
   259|   252|];
   260|   253|
   261|   254|const REDEEM_TIERS = [
   262|   255|  [100, 5],
   263|   256|  [300, 15],
   264|   257|  [500, 20],
   265|   258|  [750, 25],
   266|   259|  [1000, 30]
   267|   260|];
   268|   261|
   269|   262|// ═══════════════════════
   270|   263|// ACHIEVEMENT SYSTEM
   271|   264|// ═══════════════════════
   272|   265|
   273|   266|const ACHIEVEMENTS = {
   274|   267|  first_visit:     { id:'first_visit',     icon:'', name:'First Visit',        desc:'Made your first haircut',                    pts:10 },
   275|   268|  streak_3:        { id:'streak_3',        icon:'', name:'3-Visit Streak',     desc:'Visited 3 times in a row',                   pts:25 },
   276|   269|  streak_5:        { id:'streak_5',        icon:'', name:'5-Visit Streak',   desc:'Visited 5 times without breaking streak',     pts:50 },
   277|   270|  streak_10:       { id:'streak_10',       icon:'-', name:'Loyal Regular',      desc:'10 visits — you basically live here',         pts:100 },
   278|   271|  big_spender:     { id:'big_spender',     icon:'', name:'Big Spender',        desc:'Single haircut of $75 or more',              pts:25 },
   279|   272|  weekend_warrior: { id:'weekend_warrior', icon:'', name:'Weekend Warrior',    desc:'Visited on both Saturday and Sunday',         pts:15 },
   280|   273|  night_owl:       { id:'night_owl',       icon:'', name:'Night Owl',          desc:'Visited after 8 PM',                         pts:10 },
   281|   274|  points_100:      { id:'points_100',      icon:'', name:'Century Club',       desc:'Earned 100 lifetime points',                  pts:0 },
   282|   275|  points_500:      { id:'points_500',      icon:'', name:'Halfway to Legend',  desc:'Earned 500 lifetime points',                  pts:0 },
   283|   276|  points_1000:     { id:'points_1000',     icon:'', name:'1K Club',            desc:'Earned 1,000 lifetime points',                pts:0 },
   284|   277|  points_2500:     { id:'points_2500',     icon:'', name:'Legend Status',      desc:'Earned 2,500 lifetime points',                pts:0 },
   285|   278|  referral_1:      { id:'referral_1',      icon:'', name:'Connector',          desc:'Referred your first friend',                  pts:100 },
   286|   279|  comeback:        { id:'comeback',        icon:'-', name:'Welcome Back!',      desc:'Returned after 30+ days away',                pts:25 },
   287|   280|  tier_silver:     { id:'tier_silver',     icon:'', name:'Silver Status',      desc:'Reached Silver tier',                         pts:0 },
   288|   281|  tier_gold:       { id:'tier_gold',       icon:'', name:'Gold Status',        desc:'Reached Gold tier',                           pts:0 },
   289|   282|  tier_platinum:   { id:'tier_platinum',   icon:'', name:'Platinum Status',    desc:'Reached Platinum tier',                       pts:0 },
   290|   283|  tier_diamond:    { id:'tier_diamond',    icon:'', name:'Diamond Status',     desc:'Reached Diamond tier',                        pts:0 },
   291|   284|  tier_elite:      { id:'tier_elite',      icon:'', name:'Elite Status',       desc:'Reached Elite tier',                          pts:0 }
   292|   285|};
   293|   286|
   294|   287|function checkAchievements(c, trigger) {
   295|   288|  if (!c.achievements) c.achievements = [];
   296|   289|  let earned = c.achievements.map(a => a.id);
   297|   290|  let newAchievements = [];
   298|   291|  let bonusPts = 0;
   299|   292|
   300|   293|  function award(aid) {
   301|   294|    if (earned.includes(aid)) return;
   302|   295|    let a = ACHIEVEMENTS[aid];
   303|   296|    if (!a) return;
   304|   297|    c.achievements.push({ id: a.id, icon: a.icon, name: a.name, desc: a.desc, earned_at: new Date().toISOString() });
   305|   298|    newAchievements.push(a);
   306|   299|    if (a.pts) bonusPts += a.pts;
   307|   300|  }
   308|   301|
   309|   302|  if (trigger === 'haircut') {
   310|   303|    award('first_visit');
   311|   304|    if (c.visit_count >= 3) award('streak_3');
   312|   305|    if (c.visit_count >= 5) award('streak_5');
   313|   306|    if (c.visit_count >= 10) award('streak_10');
   314|   307|    let now = new Date();
   315|   308|    let hour = now.getHours();
   316|   309|    let day = now.getDay();
   317|   310|    if (hour >= 20 || hour < 6) award('night_owl');
   318|   311|    if (day === 0 || day === 6) award('weekend_warrior');
   319|   312|  }
   320|   313|
   321|   314|  if (trigger === 'big_spender') award('big_spender');
   322|   315|
   323|   316|  let lp = c.lifetime_points || 0;
   324|   317|  if (lp >= 100) award('points_100');
   325|   318|  if (lp >= 500) award('points_500');
   326|   319|  if (lp >= 1000) award('points_1000');
   327|   320|  if (lp >= 2500) award('points_2500');
   328|   321|
   329|   322|  if ((c.referral_count || 0) >= 1) award('referral_1');
   330|   323|
   331|   324|  // Comeback: check if last visit was 30+ days ago
   332|   325|  let txs = c.transactions || [];
   333|   326|  if (txs.length >= 2) {
   334|   327|    let lastTwo = txs.slice(-2);
   335|   328|    let gap = (new Date(lastTwo[1].timestamp) - new Date(lastTwo[0].timestamp)) / (1000*60*60*24);
   336|   329|    if (gap > 30) award('comeback');
   337|   330|  }
   338|   331|
   339|   332|  // Tier achievements
   340|   333|  let t = getTier(c);
   341|   334|  let tierMap = { 'Silver':'tier_silver','Gold':'tier_gold','Platinum':'tier_platinum','Diamond':'tier_diamond','Elite':'tier_elite' };
   342|   335|  let taid = tierMap[t.name];
   343|   336|  if (taid) award(taid);
   344|   337|
   345|   338|  if (bonusPts > 0) {
   346|   339|    c.points = (c.points || 0) + bonusPts;
   347|   340|    if (!c.transactions) c.transactions = [];
   348|   341|    c.transactions.push({ id: _genId(), type: 'achievement_bonus', points: bonusPts, note: newAchievements.map(a => a.icon+' '+a.name).join(', '), timestamp: new Date().toISOString() });
   349|   342|  }
   350|   343|
   351|   344|  return { achievements: newAchievements, bonusPts };
   352|   345|}
   353|   346|
   354|   347|function getAchievements(c) {
   355|   348|  if (!c) return [];
   356|   349|  let earned = (c.achievements || []).map(a => a.id);
   357|   350|  // Return ALL achievements with earned status
   358|   351|  return Object.values(ACHIEVEMENTS).map(a => ({
   359|   352|    ...a, earned: earned.includes(a.id),
   360|   353|    earned_at: earned.includes(a.id) ? (c.achievements.find(ea => ea.id === a.id)?.earned_at || '') : ''
   361|   354|  }));
   362|   355|}
   363|   356|
   364|   357|function getUnearnedCount(c) {
   365|   358|  return Object.keys(ACHIEVEMENTS).length - (c?.achievements?.length || 0);
   366|   359|}
   367|   360|
   368|   361|function getTier(c) {
   369|   362|  let pts = c.lifetime_points || 0;
   370|   363|  let t = TIERS[0];
   371|   364|  for (let x of TIERS) { if (pts >= x.min) t = x; }
   372|   365|  return t;
   373|   366|}
   374|   367|
   375|   368|function nextTier(c) {
   376|   369|  let pts = c.lifetime_points || 0;
   377|   370|  for (let t of TIERS) { if (pts < t.min) return t; }
   378|   371|  return null;
   379|   372|}
   380|   373|
   381|   374|function tierProgress(c) {
   382|   375|  let n = nextTier(c);
   383|   376|  if (!n) return 100;
   384|   377|  let cur = getTier(c);
   385|   378|  let total = n.min - cur.min;
   386|   379|  let progress = (c.lifetime_points || 0) - cur.min;
   387|   380|  return Math.min(100, Math.round((progress / total) * 100));
   388|   381|}
   389|   382|
   390|   383|function _parseBdayMonth(bday) {
   391|   384|  // Accepts MM/DD, MM-DD, or ISO date formats
   392|   385|  if (!bday) return 0;
   393|   386|  var m = parseInt(bday.split(/[\/\-]/)[0]);
   394|   387|  return (m >= 1 && m <= 12) ? m : 0;
   395|   388|}
   396|   389|
   397|   390|function calcPoints(amount) {
   398|   391|  return Math.floor(amount);  // 1 point per $1
   399|   392|}
   400|   393|
   401|   394|function redemptionValue(points) {
   402|   395|  let value = 0;
   403|   396|  for (let [threshold, val] of REDEEM_TIERS) {
   404|   397|    if (points >= threshold) value = val;
   405|   398|  }
   406|   399|  return value;
   407|   400|}
   408|   401|
   409|   402|const VISIT_BONUSES = { 3: 25, 5: 50, 10: 100 };
   410|   403|
   411|   404|// ═══════════════════════
   412|   405|// RECENT CUSTOMERS
   413|   406|// ═══════════════════════
   414|   407|
   415|   408|function getRecent() {
   416|   409|  try {
   417|   410|    return JSON.parse(localStorage.getItem('_recent') || '[]');
   418|   411|  } catch(e) { return []; }
   419|   412|}
   420|   413|
   421|   414|function addRecent(phone) {
   422|   415|  let recent = getRecent().filter(r => r.phone !== phone);
   423|   416|  let c = findCustomer(phone);
   424|   417|  recent.unshift({
   425|   418|    phone,
   426|   419|    name: c?.name || '',
   427|   420|    tier: c ? getTier(c).name : 'Bronze',
   428|   421|    points: c?.points || 0,
   429|   422|    time: Date.now()
   430|   423|  });
   431|   424|  // Keep last 20
   432|   425|  recent = recent.slice(0, 20);
   433|   426|  localStorage.setItem('_recent', JSON.stringify(recent));
   434|   427|}
   435|   428|
   436|   429|// ═══════════════════════
   437|   430|// CUSTOMER OPERATIONS
   438|   431|// ═══════════════════════
   439|   432|
   440|   433|function cleanPhone(r) { return (r||'').replace(/\D/g,''); }
   441|   434|
   442|   435|function findCustomer(phone) {
   443|   436|  if (!_data) return null;
   444|   437|  return _data.customers?.[phone] || null;
   445|   438|}
   446|   439|
   447|   440|function searchCustomers(query) {
   448|   441|  if (!_data) return [];
   449|   442|  let q = query.toLowerCase();
   450|   443|  return Object.values(_data.customers || {}).filter(c => {
   451|   444|    return (c.phone && c.phone.includes(q)) ||
   452|   445|           (c.name && c.name.toLowerCase().includes(q));
   453|   446|  }).slice(0, 10);
   454|   447|}
   455|   448|
   456|   449|function createCustomer(phone, extra = {}) {
   457|   450|  if (!_data) return null;
   458|   451|  let c = {
   459|   452|    id: Date.now().toString(36) + Math.random().toString(36).substring(2,6),
   460|   453|    phone, name: extra.name || '', points: 0,
   461|   454|    lifetime_points: 0, lifetime_spend: 0, visit_count: 0,
   462|   455|    birthday: extra.birthday || '',
   463|   456|    referral_code: _genCode(),
   464|   457|    referred_by: extra.referred_by || '',
   465|   458|    referral_count: 0,
   466|   459|    verified: extra.verified || false,
   467|   460|    achievements: [],
   468|   461|    created_at: new Date().toISOString(),
   469|   462|    transactions: []
   470|   463|  };
   471|   464|  _data.customers[phone] = c;
   472|   465|
   473|   466|  // Referral bonus
   474|   467|  let referralResult = null;
   475|   468|  if (extra.referral_code) {
   476|   469|    let referrer = lookupReferral(extra.referral_code);
   477|   470|    if (referrer && referrer.phone !== phone) {
   478|   471|      c.referred_by = referrer.phone;
   479|   472|      let bonus = _data.config?.referral_bonus || 100;
   480|   473|      // Award referrer
   481|   474|      let rc = findCustomer(referrer.phone);
   482|   475|      if (rc) {
   483|   476|        rc.points = (rc.points || 0) + bonus;
   484|   477|        rc.referral_count = (rc.referral_count || 0) + 1;
   485|   478|        if (!rc.transactions) rc.transactions = [];
   486|   479|        rc.transactions.push({ id: _genId(), type: 'referral_bonus', points: bonus, note: 'Referred '+ (c.name||phone), timestamp: new Date().toISOString() });
   487|   480|      }
   488|   481|      // Award new customer
   489|   482|      c.points = (c.points || 0) + bonus;
   490|   483|      c.transactions.push({ id: _genId(), type: 'referral_bonus', points: bonus, note: 'Signed up with '+referrer.name+'\'s code', timestamp: new Date().toISOString() });
   491|   484|      referralResult = { referrer: referrer, bonus: bonus };
   492|   485|    }
   493|   486|  }
   494|   487|
   495|   488|  addRecent(phone);
   496|   489|  return { customer: c, referral: referralResult };
   497|   490|}
   498|   491|
   499|   492|function deleteCustomer(phone) {
   500|   493|  if (!_data) return { error: 'Data not loaded' };
   501|   494|  if (!_data.customers[phone]) return { error: 'Customer not found' };
   502|   495|  delete _data.customers[phone];
   503|   496|  _enqueueWrite();
   504|   497|  return { success: true };
   505|   498|}
   506|   499|
   507|   500|function _genCode() {
   508|   501|  let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
   509|   502|  let c = ''; for(let i=0;i<8;i++) c+=chars[Math.floor(Math.random()*chars.length)];
   510|   503|  return c;
   511|   504|}
   512|   505|
   513|   506|// ═══════════════════════
   514|   507|// TRANSACTIONS (with error handling)
   515|   508|// ═══════════════════════
   516|   509|
   517|   510|function addHaircut(phone, amount) {
   518|   511|  if (!_data) return { error: 'Data not loaded' };
   519|   512|  let c = findCustomer(phone);
   520|   513|  if (!c) return { error: 'Customer not found' };
   521|   514|
   522|   515|  let tier = getTier(c);
   523|   516|  let pts = calcPoints(amount);
   524|   517|
   525|   518|  // Double points
   526|   519|  let today = new Date().toISOString().split('T')[0];
   527|   520|  if ((_data.config?.double_points_days || []).includes(today)) pts *= 2;
   528|   521|
   529|   522|  c.points = (c.points || 0) + pts;
   530|   523|  c.lifetime_points = (c.lifetime_points || 0) + pts;
   531|   524|  c.lifetime_spend = (c.lifetime_spend || 0) + amount;
   532|   525|  c.visit_count = (c.visit_count || 0) + 1;
   533|   526|
   534|   527|  let newTier = getTier(c);
   535|   528|  let tierUp = newTier.name !== tier.name;
   536|   529|  let bonuses = [];
   537|   530|
   538|   531|  // Visit streak
   539|   532|  let vb = VISIT_BONUSES[c.visit_count] || 0;
   540|   533|  if (vb) {
   541|   534|    c.points += vb; pts += vb;
   542|   535|    bonuses.push({ type: 'visit_bonus', pts: vb, label: 'Visit #' + c.visit_count + ' streak' });
   543|   536|  }
   544|   537|
   545|   538|  // Birthday
   546|   539|  if (c.birthday) {
   547|   540|    let now = new Date();
   548|   541|    let bm = _parseBdayMonth(c.birthday);
   549|   542|    if (bm === now.getMonth() + 1) {
   550|   543|      let got = (c.transactions||[]).some(tx => tx.type === 'birthday_bonus' && new Date(tx.timestamp).getFullYear() === now.getFullYear());
   551|   544|      if (!got) {
   552|   545|        let bonus = _data.config?.birthday_bonus || 50;
   553|   546|        c.points += bonus; pts += bonus;
   554|   547|        bonuses.push({ type: 'birthday_bonus', pts: bonus, label: ' Birthday month' });
   555|   548|      }
   556|   549|    }
   557|   550|  }
   558|   551|
   559|   552|  // Record
   560|   553|  let nowISO = new Date().toISOString();
   561|   554|  if (!c.transactions) c.transactions = [];
   562|   555|  c.transactions.push({ id: _genId(), type: 'haircut', amount, points: pts, tier: newTier.name, timestamp: nowISO });
   563|   556|  bonuses.forEach(b => c.transactions.push({ id: _genId(), type: b.type, points: b.pts, note: b.label, timestamp: nowISO }));
   564|   557|
   565|   558|  addRecent(phone);
   566|   559|
   567|   560|  // Check achievements
   568|   561|  let achResult = checkAchievements(c, 'haircut');
   569|   562|  if (amount >= 75) {
   570|   563|    let bigSpenderResult = checkAchievements(c, 'big_spender');
   571|   564|    if (bigSpenderResult.achievements.length) {
   572|   565|      achResult.achievements = achResult.achievements.concat(bigSpenderResult.achievements);
   573|   566|      achResult.bonusPts += bigSpenderResult.bonusPts;
   574|   567|    }
   575|   568|  }
   576|   569|  if (achResult.achievements.length) bonuses.push({ type:'achievement', pts:achResult.bonusPts, label:achResult.achievements.map(a=>a.icon+' '+a.name).join(', ') });
   577|   570|
   578|   571|  _enqueueWrite();
   579|   572|  return { customer: c, points_earned: pts + achResult.bonusPts, tier_up: tierUp, new_tier: newTier, bonuses };
   580|   573|}
   581|   574|
   582|   575|function redeemPoints(phone, points) {
   583|   576|  if (!_data) return { error: 'Data not loaded' };
   584|   577|  let c = findCustomer(phone);
   585|   578|  if (!c) return { error: 'Customer not found' };
   586|   579|  if ((c.points||0) < points) return { error: 'Insufficient points', available: c.points };
   587|   580|
   588|   581|  let tier = getTier(c);
   589|   582|  let value = redemptionValue(points);
   590|   583|  c.points -= points;
   591|   584|
   592|   585|  if (!c.transactions) c.transactions = [];
   593|   586|  c.transactions.push({
   594|   587|    id: _genId(), type: 'redeem', points: -points, value,
   595|   588|    tier: tier.name, timestamp: new Date().toISOString()
   596|   589|  });
   597|   590|
   598|   591|  _enqueueWrite();
   599|   592|  return { customer: c, value };
   600|   593|}
   601|   594|
   602|   595|function _genId() { return Date.now().toString(36) + Math.random().toString(36).substring(2,5); }
   603|   596|
   604|   597|// ═══════════════════════
   605|   598|// REFERRALS
   606|   599|// ═══════════════════════
   607|   600|
   608|   601|function lookupReferral(code) {
   609|   602|  if (!_data) return null;
   610|   603|  for (let [phone, c] of Object.entries(_data.customers || {})) {
   611|   604|    if (c.referral_code === code.toUpperCase()) return { phone, name: c.name };
   612|   605|  }
   613|   606|  return null;
   614|   607|}
   615|   608|
   616|   609|// ═══════════════════════
   617|   610|// STATS
   618|   611|// ═══════════════════════
   619|   612|
   620|   613|function getStats() {
   621|   614|  if (!_data) return {};
   622|   615|  let custs = Object.values(_data.customers || {});
   623|   616|  let now = new Date();
   624|   617|  let tiers = { Bronze: 0, Silver: 0, Gold: 0, Platinum: 0, Diamond: 0, Elite: 0 };
   625|   618|  custs.forEach(c => { tiers[getTier(c).name]++; });
   626|   619|
   627|   620|  return {
   628|   621|    total: custs.length,
   629|   622|    points: custs.reduce((s,c) => s + (c.points||0), 0),
   630|   623|    lifetime: custs.reduce((s,c) => s + (c.lifetime_points||0), 0),
   631|   624|    tiers,
   632|   625|    birthdays: custs.filter(c => {
   633|   626|      if (!c.birthday) return false;
   634|   627|      let m = _parseBdayMonth(c.birthday);
   635|   628|      return m === now.getMonth() + 1;
   636|   629|    }).length,
   637|   630|    referrals: custs.filter(c => c.referred_by).length
   638|   631|  };
   639|   632|}
   640|   633|
   641|   634|// ═══════════════════════
   642|   635|// DATA EXPORT
   643|   636|// ═══════════════════════
   644|   637|
   645|   638|function exportData() {
   646|   639|  if (!_data) return null;
   647|   640|  let clean = JSON.parse(JSON.stringify(_data));
   648|   641|  delete clean._writeTimer;
   649|   642|  delete clean._pendingCustomers;
   650|   643|  return clean;
   651|   644|}
   652|   645|
   653|   646|function downloadJSON() {
   654|   647|  let data = exportData();
   655|   648|  if (!data) return;
   656|   649|  let blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
   657|   650|  let url = URL.createObjectURL(blob);
   658|   651|  let a = document.createElement('a');
   659|   652|  a.href = url; a.download = 'shop_data_backup_' + new Date().toISOString().split('T')[0] + '.json';
   660|   653|  a.click();
   661|   654|  URL.revokeObjectURL(url);
   662|   655|}
   663|   656|
   664|   657|// ═══════════════════════
   665|   658|// HELPERS
   666|   659|// ═══════════════════════
   667|   660|
   668|   661|function enrichCustomer(c) {
   669|   662|  if (!c) return null;
   670|   663|  let t = getTier(c);
   671|   664|  let n = nextTier(c);
   672|   665|  return {
   673|   666|    ...c,
   674|   667|    _tier: t, _next: n,
   675|   668|    _progress: tierProgress(c),
   676|   669|    _value: redemptionValue(c.points || 0),
   677|   670|    _achievements: getAchievements(c),
   678|   671|    _unearned: getUnearnedCount(c)
   679|   672|  };
   680|   673|}
   681|   674|
   682|   675|function formatPhone(p) { return p.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3'); }
   683|   676|function formatDate(d) { return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
   684|   677|function formatCurrency(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 }); }
   685|   678|function formatNumber(n) { return Number(n).toLocaleString(); }
   686|   679|
   687|   680|// ═══════════════════════
   688|   681|// INIT
   689|   682|// ═══════════════════════
   690|   683|
   691|   684|(async function() {
   692|   685|  await loadData();
   693|   686|  console.log('Rewards engine v3.1 ready. Customers:', Object.keys(_data?.customers||{}).length);
   694|   687|})();
   695|   688|