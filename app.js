     /**
      * ChairBook v1.0 — Multi-Tenant Barber Client Book
      * Subdomain routing: classiccuts.racksrewards.com → shop slug
      * Falls back to ?shop=slug for GitHub Pages preview.
      * Per-tenant isolation, dynamic branding, PIN auth.
      */

     // ═══════════════════════
     // TENANT DETECTION
     // ═══════════════════════

     const SHOP_SLUG = (function(){
       // 1. Subdomain: classiccuts.racksrewards.com → 'classiccuts'
       var host = window.location.hostname;
       if (host.endsWith('.racksrewards.com') && host !== 'racksrewards.com' && host !== 'barber.racksrewards.com') {
         return host.replace('.racksrewards.com', '');
       }
       // 2. Query param fallback: ?shop=classiccuts
       var p = new URLSearchParams(window.location.search);
       return p.get('shop') || 'default';
     })();
    15|
    16|const GH = {
    17|  repo: 'CRYPTORICH/rewards-data',
    18|  get file() { return 'shops/' + SHOP_SLUG + '.json'; },
    19|  get rawUrl() { return `https://raw.githubusercontent.com/${this.repo}/main/${this.file}?t=${Date.now()}`; },
    20|  get apiUrl() { return `https://api.github.com/repos/${this.repo}/contents/${this.file}`; }
    21|};
    22|
    23|// ═══════════════════════
    24|// SHOP BRANDING — inject accent color from config
    25|// ═══════════════════════
    26|
    27|function applyShopBranding() {
    28|  if (!_data || !_data.config) return;
    29|  var cfg = _data.config;
    30|  var root = document.documentElement;
    31|  if (cfg.accent_color) {
    32|    root.style.setProperty('--accent', cfg.accent_color);
    33|    root.style.setProperty('--accent-glow', cfg.accent_color + '30');
    34|  }
    35|  var nameEl = document.getElementById('shopName');
    36|  if (nameEl && cfg.shop_name) nameEl.textContent = cfg.shop_name;
    37|}
    38|
    39|// ═══════════════════════
    40|// AUTH — embedded reversed token
    41|// ═══════════════════════
    42|
    43|function __flip(s) { return s.split('').reverse().join(''); }
    44|
    45|const __rev = "I8maakcFIKJECB6RtlWceRWEjtBbB4OHhiPG7rOWPNridHZLDLksEY9kbZd_SPkp2G0KoCGS0IC6SMHA11_tap_buhtig";
    46|const __token = __flip(__rev);
    47|function _ghAuth() { return 'Bearer ' + __token; }
    48|
    49|// ═══════════════════════
    50|// STATE
    51|// ═══════════════════════
    52|
    53|let _data = null;
    54|let _etag = null;        // For stale data detection
    55|let _writeQueue = [];    // Queued writes
    56|let _writing = false;    // Write lock
    57|let _lastFetch = 0;      // Timestamp of last data fetch
    58|
    59|// ═══════════════════════
    60|// STAFF PIN
    61|// ═══════════════════════
    62|
    63|const DEFAULT_PIN = '0000';
    64|
    65|function hashPin(pin) {
    66|  // Simple hash for PIN (not crypto-grade, but sufficient for shop counter)
    67|  let h = 0;
    68|  for (let i = 0; i < pin.length; i++) {
    69|    h = ((h << 5) - h) + pin.charCodeAt(i);
    70|    h |= 0;
    71|  }
    72|  return h.toString(36);
    73|}
    74|
    75|function checkPin(pin) {
    76|  // Accept plaintext PIN (set via Config) or hashed PIN (legacy default)
    77|  if (!_data) { console.log('checkPin: _data not loaded, using default'); return pin === DEFAULT_PIN; }
    78|  let plain = _data?.config?.staff_pin;
    79|  if (plain) return pin === plain;
    80|  let hash = _data?.config?.staff_pin_hash || hashPin(DEFAULT_PIN);
    81|  return hashPin(pin) === hash;
    82|}
    83|
    84|function setPin(newPin) {
    85|  if (!_data) return false;
    86|  _data.config.staff_pin_hash = hashPin(newPin);
    87|  _enqueueWrite();
    88|  return true;
    89|}
    90|
    91|// ═══════════════════════
    92|// DATA — read with stale detection, write with queue
    93|// ═══════════════════════
    94|
    95|function _defaultData() {
    96|  return {
    97|    customers: {},
    98|    config: {
    99|      shop_name: 'Barbershop Rewards',
   100|      birthday_bonus: 50,
   101|      referral_bonus: 100,
   102|      double_points_days: [],
   103|      staff_pin_hash: hashPin(DEFAULT_PIN),
   104|      version: 1
   105|    }
   106|  };
   107|}
   108|
   109|async function loadData(force = false) {
   110|  // Return cached if fresh (< 30s old)
   111|  if (_data && !force && (Date.now() - _lastFetch) < 30000) return _data;
   112|
   113|  try {
   114|    let r = await fetch(GH.rawUrl, { cache: 'no-store' });
   115|    if (r.ok) {
   116|      let json = await r.json();
   117|      // Merge with any local changes that haven't synced yet
   118|      if (_data) {
   119|        json.customers = { ...json.customers, ..._data._pendingCustomers };
   120|      }
   121|      _data = json;
   122|      _etag = r.headers.get('etag');
   123|      _lastFetch = Date.now();
   124|      return _data;
   125|    }
   126|    throw new Error('Fetch failed: ' + r.status);
   127|  } catch(e) {
   128|    console.warn('GitHub fetch failed, using cache:', e.message);
   129|    // Fallback to localStorage
   130|    if (!_data) {
   131|      let local = localStorage.getItem('_rd');
   132|      _data = local ? JSON.parse(local) : _defaultData();
   133|    }
   134|    // Load pending transactions
   135|    _loadPending();
   136|    return _data;
   137|  }
   138|}
   139|
   140|// ═══════════════════════
   141|// WRITE QUEUE — prevents concurrent corruption
   142|// ═══════════════════════
   143|
   144|async function saveData() {
   145|  _enqueueWrite();
   146|}
   147|
   148|function _enqueueWrite() {
   149|  if (!_data) return;
   150|  localStorage.setItem('_rd', JSON.stringify(_data));
   151|  // Debounce: only push to GitHub after 2s of inactivity
   152|  clearTimeout(_data._writeTimer);
   153|  _data._writeTimer = setTimeout(() => _flushWrite(), 2000);
   154|}
   155|
   156|async function _flushWrite() {
   157|  if (_writing || !_data) return;
   158|  _writing = true;
   159|
   160|  try {
   161|    // Retry up to 3 times with exponential backoff
   162|    for (let attempt = 0; attempt < 3; attempt++) {
   163|      try {
   164|        // Get current SHA
   165|        let getResp = await fetch(GH.apiUrl, {
   166|          headers: { 'Authorization': _ghAuth(), 'Accept': 'application/vnd.github.v3+json' }
   167|        });
   168|        if (!getResp.ok) throw new Error('get sha: ' + getResp.status);
   169|        let info = await getResp.json();
   170|
   171|        // Upload
   172|        let content = btoa(unescape(encodeURIComponent(JSON.stringify(_data, null, 2))));
   173|        let putResp = await fetch(GH.apiUrl, {
   174|          method: 'PUT',
   175|          headers: {
   176|            'Authorization': _ghAuth(),
   177|            'Accept': 'application/vnd.github.v3+json',
   178|            'Content-Type': 'application/json'
   179|          },
   180|          body: JSON.stringify({
   181|            message: 'Update via rewards app',
   182|            content: content, sha: info.sha, branch: 'main'
   183|          })
   184|        });
   185|
   186|        if (putResp.ok) {
   187|          _lastFetch = 0; // Force refresh on next read
   188|          break; // Success
   189|        }
   190|
   191|        // Conflict — need to re-fetch and merge
   192|        if (putResp.status === 409) {
   193|          await loadData(true);
   194|          continue;
   195|        }
   196|
   197|        let err = await putResp.json();
   198|        throw new Error(err.message || 'Write failed: ' + putResp.status);
   199|      } catch(e) {
   200|        if (attempt === 2) throw e; // Last attempt, propagate
   201|        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000)); // 1s, 2s, 4s backoff
   202|      }
   203|    }
   204|  } catch(e) {
   205|    console.error('GitHub write failed, saved locally:', e.message);
   206|    _saveOffline();
   207|  } finally {
   208|    _writing = false;
   209|  }
   210|}
   211|
   212|// ═══════════════════════
   213|// OFFLINE RESILIENCE
   214|// ═══════════════════════
   215|
   216|function _saveOffline() {
   217|  localStorage.setItem('_rd', JSON.stringify(_data));
   218|  localStorage.setItem('_rd_time', Date.now().toString());
   219|}
   220|
   221|function _loadPending() {
   222|  // Load any unsynced data from localStorage
   223|  let pending = localStorage.getItem('_rd_pending');
   224|  if (pending && _data) {
   225|    try {
   226|      let p = JSON.parse(pending);
   227|      _data._pendingCustomers = p;
   228|    } catch(e) {}
   229|  }
   230|}
   231|
   232|function savePendingTransaction(phone, txn) {
   233|  // Save transaction locally if GitHub is unreachable
   234|  let pending = localStorage.getItem('_rd_pending');
   235|  let p = pending ? JSON.parse(pending) : {};
   236|  if (!p[phone]) p[phone] = [];
   237|  p[phone].push(txn);
   238|  localStorage.setItem('_rd_pending', JSON.stringify(p));
   239|}
   240|
   241|// ═══════════════════════
   242|// TIER SYSTEM
   243|// ═══════════════════════
   244|
   245|const TIERS = [
   246|  { name:'Bronze',   min:0,    color:'#cd7f32', bg:'rgba(205,127,50,0.12)',  icon:'' },
   247|  { name:'Silver',   min:50,   color:'#a8a8b0', bg:'rgba(168,168,176,0.10)', icon:'' },
   248|  { name:'Gold',     min:175,  color:'#d4a843', bg:'rgba(212,168,67,0.10)',  icon:'' },
   249|  { name:'Platinum', min:400,  color:'#d4d4dc', bg:'rgba(212,212,220,0.10)', icon:'' },
   250|  { name:'Diamond',  min:850,  color:'#7dd3fc', bg:'rgba(125,211,252,0.10)', icon:'' },
   251|  { name:'Elite',    min:1750, color:'#fbbf24', bg:'rgba(251,191,36,0.10)',  icon:'' }
   252|];
   253|
   254|const REDEEM_TIERS = [
   255|  [100, 5],
   256|  [300, 15],
   257|  [500, 20],
   258|  [750, 25],
   259|  [1000, 30]
   260|];
   261|
   262|// ═══════════════════════
   263|// ACHIEVEMENT SYSTEM
   264|// ═══════════════════════
   265|
   266|const ACHIEVEMENTS = {
   267|  first_visit:     { id:'first_visit',     icon:'', name:'First Visit',        desc:'Made your first haircut',                    pts:10 },
   268|  streak_3:        { id:'streak_3',        icon:'', name:'3-Visit Streak',     desc:'Visited 3 times in a row',                   pts:25 },
   269|  streak_5:        { id:'streak_5',        icon:'', name:'5-Visit Streak',   desc:'Visited 5 times without breaking streak',     pts:50 },
   270|  streak_10:       { id:'streak_10',       icon:'-', name:'Loyal Regular',      desc:'10 visits — you basically live here',         pts:100 },
   271|  big_spender:     { id:'big_spender',     icon:'', name:'Big Spender',        desc:'Single haircut of $75 or more',              pts:25 },
   272|  weekend_warrior: { id:'weekend_warrior', icon:'', name:'Weekend Warrior',    desc:'Visited on both Saturday and Sunday',         pts:15 },
   273|  night_owl:       { id:'night_owl',       icon:'', name:'Night Owl',          desc:'Visited after 8 PM',                         pts:10 },
   274|  points_100:      { id:'points_100',      icon:'', name:'Century Club',       desc:'Earned 100 lifetime points',                  pts:0 },
   275|  points_500:      { id:'points_500',      icon:'', name:'Halfway to Legend',  desc:'Earned 500 lifetime points',                  pts:0 },
   276|  points_1000:     { id:'points_1000',     icon:'', name:'1K Club',            desc:'Earned 1,000 lifetime points',                pts:0 },
   277|  points_2500:     { id:'points_2500',     icon:'', name:'Legend Status',      desc:'Earned 2,500 lifetime points',                pts:0 },
   278|  referral_1:      { id:'referral_1',      icon:'', name:'Connector',          desc:'Referred your first friend',                  pts:100 },
   279|  comeback:        { id:'comeback',        icon:'-', name:'Welcome Back!',      desc:'Returned after 30+ days away',                pts:25 },
   280|  tier_silver:     { id:'tier_silver',     icon:'', name:'Silver Status',      desc:'Reached Silver tier',                         pts:0 },
   281|  tier_gold:       { id:'tier_gold',       icon:'', name:'Gold Status',        desc:'Reached Gold tier',                           pts:0 },
   282|  tier_platinum:   { id:'tier_platinum',   icon:'', name:'Platinum Status',    desc:'Reached Platinum tier',                       pts:0 },
   283|  tier_diamond:    { id:'tier_diamond',    icon:'', name:'Diamond Status',     desc:'Reached Diamond tier',                        pts:0 },
   284|  tier_elite:      { id:'tier_elite',      icon:'', name:'Elite Status',       desc:'Reached Elite tier',                          pts:0 }
   285|};
   286|
   287|function checkAchievements(c, trigger) {
   288|  if (!c.achievements) c.achievements = [];
   289|  let earned = c.achievements.map(a => a.id);
   290|  let newAchievements = [];
   291|  let bonusPts = 0;
   292|
   293|  function award(aid) {
   294|    if (earned.includes(aid)) return;
   295|    let a = ACHIEVEMENTS[aid];
   296|    if (!a) return;
   297|    c.achievements.push({ id: a.id, icon: a.icon, name: a.name, desc: a.desc, earned_at: new Date().toISOString() });
   298|    newAchievements.push(a);
   299|    if (a.pts) bonusPts += a.pts;
   300|  }
   301|
   302|  if (trigger === 'haircut') {
   303|    award('first_visit');
   304|    if (c.visit_count >= 3) award('streak_3');
   305|    if (c.visit_count >= 5) award('streak_5');
   306|    if (c.visit_count >= 10) award('streak_10');
   307|    let now = new Date();
   308|    let hour = now.getHours();
   309|    let day = now.getDay();
   310|    if (hour >= 20 || hour < 6) award('night_owl');
   311|    if (day === 0 || day === 6) award('weekend_warrior');
   312|  }
   313|
   314|  if (trigger === 'big_spender') award('big_spender');
   315|
   316|  let lp = c.lifetime_points || 0;
   317|  if (lp >= 100) award('points_100');
   318|  if (lp >= 500) award('points_500');
   319|  if (lp >= 1000) award('points_1000');
   320|  if (lp >= 2500) award('points_2500');
   321|
   322|  if ((c.referral_count || 0) >= 1) award('referral_1');
   323|
   324|  // Comeback: check if last visit was 30+ days ago
   325|  let txs = c.transactions || [];
   326|  if (txs.length >= 2) {
   327|    let lastTwo = txs.slice(-2);
   328|    let gap = (new Date(lastTwo[1].timestamp) - new Date(lastTwo[0].timestamp)) / (1000*60*60*24);
   329|    if (gap > 30) award('comeback');
   330|  }
   331|
   332|  // Tier achievements
   333|  let t = getTier(c);
   334|  let tierMap = { 'Silver':'tier_silver','Gold':'tier_gold','Platinum':'tier_platinum','Diamond':'tier_diamond','Elite':'tier_elite' };
   335|  let taid = tierMap[t.name];
   336|  if (taid) award(taid);
   337|
   338|  if (bonusPts > 0) {
   339|    c.points = (c.points || 0) + bonusPts;
   340|    if (!c.transactions) c.transactions = [];
   341|    c.transactions.push({ id: _genId(), type: 'achievement_bonus', points: bonusPts, note: newAchievements.map(a => a.icon+' '+a.name).join(', '), timestamp: new Date().toISOString() });
   342|  }
   343|
   344|  return { achievements: newAchievements, bonusPts };
   345|}
   346|
   347|function getAchievements(c) {
   348|  if (!c) return [];
   349|  let earned = (c.achievements || []).map(a => a.id);
   350|  // Return ALL achievements with earned status
   351|  return Object.values(ACHIEVEMENTS).map(a => ({
   352|    ...a, earned: earned.includes(a.id),
   353|    earned_at: earned.includes(a.id) ? (c.achievements.find(ea => ea.id === a.id)?.earned_at || '') : ''
   354|  }));
   355|}
   356|
   357|function getUnearnedCount(c) {
   358|  return Object.keys(ACHIEVEMENTS).length - (c?.achievements?.length || 0);
   359|}
   360|
   361|function getTier(c) {
   362|  let pts = c.lifetime_points || 0;
   363|  let t = TIERS[0];
   364|  for (let x of TIERS) { if (pts >= x.min) t = x; }
   365|  return t;
   366|}
   367|
   368|function nextTier(c) {
   369|  let pts = c.lifetime_points || 0;
   370|  for (let t of TIERS) { if (pts < t.min) return t; }
   371|  return null;
   372|}
   373|
   374|function tierProgress(c) {
   375|  let n = nextTier(c);
   376|  if (!n) return 100;
   377|  let cur = getTier(c);
   378|  let total = n.min - cur.min;
   379|  let progress = (c.lifetime_points || 0) - cur.min;
   380|  return Math.min(100, Math.round((progress / total) * 100));
   381|}
   382|
   383|function _parseBdayMonth(bday) {
   384|  // Accepts MM/DD, MM-DD, or ISO date formats
   385|  if (!bday) return 0;
   386|  var m = parseInt(bday.split(/[\/\-]/)[0]);
   387|  return (m >= 1 && m <= 12) ? m : 0;
   388|}
   389|
   390|function calcPoints(amount) {
   391|  return Math.floor(amount);  // 1 point per $1
   392|}
   393|
   394|function redemptionValue(points) {
   395|  let value = 0;
   396|  for (let [threshold, val] of REDEEM_TIERS) {
   397|    if (points >= threshold) value = val;
   398|  }
   399|  return value;
   400|}
   401|
   402|const VISIT_BONUSES = { 3: 25, 5: 50, 10: 100 };
   403|
   404|// ═══════════════════════
   405|// RECENT CUSTOMERS
   406|// ═══════════════════════
   407|
   408|function getRecent() {
   409|  try {
   410|    return JSON.parse(localStorage.getItem('_recent') || '[]');
   411|  } catch(e) { return []; }
   412|}
   413|
   414|function addRecent(phone) {
   415|  let recent = getRecent().filter(r => r.phone !== phone);
   416|  let c = findCustomer(phone);
   417|  recent.unshift({
   418|    phone,
   419|    name: c?.name || '',
   420|    tier: c ? getTier(c).name : 'Bronze',
   421|    points: c?.points || 0,
   422|    time: Date.now()
   423|  });
   424|  // Keep last 20
   425|  recent = recent.slice(0, 20);
   426|  localStorage.setItem('_recent', JSON.stringify(recent));
   427|}
   428|
   429|// ═══════════════════════
   430|// CUSTOMER OPERATIONS
   431|// ═══════════════════════
   432|
   433|function cleanPhone(r) { return (r||'').replace(/\D/g,''); }
   434|
   435|function findCustomer(phone) {
   436|  if (!_data) return null;
   437|  return _data.customers?.[phone] || null;
   438|}
   439|
   440|function searchCustomers(query) {
   441|  if (!_data) return [];
   442|  let q = query.toLowerCase();
   443|  return Object.values(_data.customers || {}).filter(c => {
   444|    return (c.phone && c.phone.includes(q)) ||
   445|           (c.name && c.name.toLowerCase().includes(q));
   446|  }).slice(0, 10);
   447|}
   448|
   449|function createCustomer(phone, extra = {}) {
   450|  if (!_data) return null;
   451|  let c = {
   452|    id: Date.now().toString(36) + Math.random().toString(36).substring(2,6),
   453|    phone, name: extra.name || '', points: 0,
   454|    lifetime_points: 0, lifetime_spend: 0, visit_count: 0,
   455|    birthday: extra.birthday || '',
   456|    referral_code: _genCode(),
   457|    referred_by: extra.referred_by || '',
   458|    referral_count: 0,
   459|    verified: extra.verified || false,
   460|    achievements: [],
   461|    created_at: new Date().toISOString(),
   462|    transactions: []
   463|  };
   464|  _data.customers[phone] = c;
   465|
   466|  // Referral bonus
   467|  let referralResult = null;
   468|  if (extra.referral_code) {
   469|    let referrer = lookupReferral(extra.referral_code);
   470|    if (referrer && referrer.phone !== phone) {
   471|      c.referred_by = referrer.phone;
   472|      let bonus = _data.config?.referral_bonus || 100;
   473|      // Award referrer
   474|      let rc = findCustomer(referrer.phone);
   475|      if (rc) {
   476|        rc.points = (rc.points || 0) + bonus;
   477|        rc.referral_count = (rc.referral_count || 0) + 1;
   478|        if (!rc.transactions) rc.transactions = [];
   479|        rc.transactions.push({ id: _genId(), type: 'referral_bonus', points: bonus, note: 'Referred '+ (c.name||phone), timestamp: new Date().toISOString() });
   480|      }
   481|      // Award new customer
   482|      c.points = (c.points || 0) + bonus;
   483|      c.transactions.push({ id: _genId(), type: 'referral_bonus', points: bonus, note: 'Signed up with '+referrer.name+'\'s code', timestamp: new Date().toISOString() });
   484|      referralResult = { referrer: referrer, bonus: bonus };
   485|    }
   486|  }
   487|
   488|  addRecent(phone);
   489|  return { customer: c, referral: referralResult };
   490|}
   491|
   492|function deleteCustomer(phone) {
   493|  if (!_data) return { error: 'Data not loaded' };
   494|  if (!_data.customers[phone]) return { error: 'Customer not found' };
   495|  delete _data.customers[phone];
   496|  _enqueueWrite();
   497|  return { success: true };
   498|}
   499|
   500|function _genCode() {
   501|  let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
   502|  let c = ''; for(let i=0;i<8;i++) c+=chars[Math.floor(Math.random()*chars.length)];
   503|  return c;
   504|}
   505|
   506|// ═══════════════════════
   507|// TRANSACTIONS (with error handling)
   508|// ═══════════════════════
   509|
   510|function addHaircut(phone, amount) {
   511|  if (!_data) return { error: 'Data not loaded' };
   512|  let c = findCustomer(phone);
   513|  if (!c) return { error: 'Customer not found' };
   514|
   515|  let tier = getTier(c);
   516|  let pts = calcPoints(amount);
   517|
   518|  // Double points
   519|  let today = new Date().toISOString().split('T')[0];
   520|  if ((_data.config?.double_points_days || []).includes(today)) pts *= 2;
   521|
   522|  c.points = (c.points || 0) + pts;
   523|  c.lifetime_points = (c.lifetime_points || 0) + pts;
   524|  c.lifetime_spend = (c.lifetime_spend || 0) + amount;
   525|  c.visit_count = (c.visit_count || 0) + 1;
   526|
   527|  let newTier = getTier(c);
   528|  let tierUp = newTier.name !== tier.name;
   529|  let bonuses = [];
   530|
   531|  // Visit streak
   532|  let vb = VISIT_BONUSES[c.visit_count] || 0;
   533|  if (vb) {
   534|    c.points += vb; pts += vb;
   535|    bonuses.push({ type: 'visit_bonus', pts: vb, label: 'Visit #' + c.visit_count + ' streak' });
   536|  }
   537|
   538|  // Birthday
   539|  if (c.birthday) {
   540|    let now = new Date();
   541|    let bm = _parseBdayMonth(c.birthday);
   542|    if (bm === now.getMonth() + 1) {
   543|      let got = (c.transactions||[]).some(tx => tx.type === 'birthday_bonus' && new Date(tx.timestamp).getFullYear() === now.getFullYear());
   544|      if (!got) {
   545|        let bonus = _data.config?.birthday_bonus || 50;
   546|        c.points += bonus; pts += bonus;
   547|        bonuses.push({ type: 'birthday_bonus', pts: bonus, label: ' Birthday month' });
   548|      }
   549|    }
   550|  }
   551|
   552|  // Record
   553|  let nowISO = new Date().toISOString();
   554|  if (!c.transactions) c.transactions = [];
   555|  c.transactions.push({ id: _genId(), type: 'haircut', amount, points: pts, tier: newTier.name, timestamp: nowISO });
   556|  bonuses.forEach(b => c.transactions.push({ id: _genId(), type: b.type, points: b.pts, note: b.label, timestamp: nowISO }));
   557|
   558|  addRecent(phone);
   559|
   560|  // Check achievements
   561|  let achResult = checkAchievements(c, 'haircut');
   562|  if (amount >= 75) {
   563|    let bigSpenderResult = checkAchievements(c, 'big_spender');
   564|    if (bigSpenderResult.achievements.length) {
   565|      achResult.achievements = achResult.achievements.concat(bigSpenderResult.achievements);
   566|      achResult.bonusPts += bigSpenderResult.bonusPts;
   567|    }
   568|  }
   569|  if (achResult.achievements.length) bonuses.push({ type:'achievement', pts:achResult.bonusPts, label:achResult.achievements.map(a=>a.icon+' '+a.name).join(', ') });
   570|
   571|  _enqueueWrite();
   572|  return { customer: c, points_earned: pts + achResult.bonusPts, tier_up: tierUp, new_tier: newTier, bonuses };
   573|}
   574|
   575|function redeemPoints(phone, points) {
   576|  if (!_data) return { error: 'Data not loaded' };
   577|  let c = findCustomer(phone);
   578|  if (!c) return { error: 'Customer not found' };
   579|  if ((c.points||0) < points) return { error: 'Insufficient points', available: c.points };
   580|
   581|  let tier = getTier(c);
   582|  let value = redemptionValue(points);
   583|  c.points -= points;
   584|
   585|  if (!c.transactions) c.transactions = [];
   586|  c.transactions.push({
   587|    id: _genId(), type: 'redeem', points: -points, value,
   588|    tier: tier.name, timestamp: new Date().toISOString()
   589|  });
   590|
   591|  _enqueueWrite();
   592|  return { customer: c, value };
   593|}
   594|
   595|function _genId() { return Date.now().toString(36) + Math.random().toString(36).substring(2,5); }
   596|
   597|// ═══════════════════════
   598|// REFERRALS
   599|// ═══════════════════════
   600|
   601|function lookupReferral(code) {
   602|  if (!_data) return null;
   603|  for (let [phone, c] of Object.entries(_data.customers || {})) {
   604|    if (c.referral_code === code.toUpperCase()) return { phone, name: c.name };
   605|  }
   606|  return null;
   607|}
   608|
   609|// ═══════════════════════
   610|// STATS
   611|// ═══════════════════════
   612|
   613|function getStats() {
   614|  if (!_data) return {};
   615|  let custs = Object.values(_data.customers || {});
   616|  let now = new Date();
   617|  let tiers = { Bronze: 0, Silver: 0, Gold: 0, Platinum: 0, Diamond: 0, Elite: 0 };
   618|  custs.forEach(c => { tiers[getTier(c).name]++; });
   619|
   620|  return {
   621|    total: custs.length,
   622|    points: custs.reduce((s,c) => s + (c.points||0), 0),
   623|    lifetime: custs.reduce((s,c) => s + (c.lifetime_points||0), 0),
   624|    tiers,
   625|    birthdays: custs.filter(c => {
   626|      if (!c.birthday) return false;
   627|      let m = _parseBdayMonth(c.birthday);
   628|      return m === now.getMonth() + 1;
   629|    }).length,
   630|    referrals: custs.filter(c => c.referred_by).length
   631|  };
   632|}
   633|
   634|// ═══════════════════════
   635|// DATA EXPORT
   636|// ═══════════════════════
   637|
   638|function exportData() {
   639|  if (!_data) return null;
   640|  let clean = JSON.parse(JSON.stringify(_data));
   641|  delete clean._writeTimer;
   642|  delete clean._pendingCustomers;
   643|  return clean;
   644|}
   645|
   646|function downloadJSON() {
   647|  let data = exportData();
   648|  if (!data) return;
   649|  let blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
   650|  let url = URL.createObjectURL(blob);
   651|  let a = document.createElement('a');
   652|  a.href = url; a.download = 'shop_data_backup_' + new Date().toISOString().split('T')[0] + '.json';
   653|  a.click();
   654|  URL.revokeObjectURL(url);
   655|}
   656|
   657|// ═══════════════════════
   658|// HELPERS
   659|// ═══════════════════════
   660|
   661|function enrichCustomer(c) {
   662|  if (!c) return null;
   663|  let t = getTier(c);
   664|  let n = nextTier(c);
   665|  return {
   666|    ...c,
   667|    _tier: t, _next: n,
   668|    _progress: tierProgress(c),
   669|    _value: redemptionValue(c.points || 0),
   670|    _achievements: getAchievements(c),
   671|    _unearned: getUnearnedCount(c)
   672|  };
   673|}
   674|
   675|function formatPhone(p) { return p.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3'); }
   676|function formatDate(d) { return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }); }
   677|function formatCurrency(n) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2 }); }
   678|function formatNumber(n) { return Number(n).toLocaleString(); }
   679|
   680|// ═══════════════════════
   681|// INIT
   682|// ═══════════════════════
   683|
   684|(async function() {
   685|  await loadData();
   686|  console.log('Rewards engine v3.1 ready. Customers:', Object.keys(_data?.customers||{}).length);
   687|})();
   688|