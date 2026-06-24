(function () {
  const KEY = "restoqr_cloud_state_v1";
  const DEFAULT_QR = "./assets/phonepe-qr.jpeg";
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  let state = seed();
  let db = null;
  let auth = null;
  let currentUser = null;  // Firebase Auth user
  let firebaseMode = false;
  let ownerTab = "overview";
  let customerCat = "";
  let cart = {};
  let selectedAddons = {}; // addonId -> true
  let billingDateFilter = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, default today
  let carouselInitialized = false; // Flag to ensure carousel is initialized only once

  // ================================================================
  // STAFF DASHBOARD — state
  // ================================================================
  let staffTab = "waiter";      // "waiter" | "tables" | "kitchen" | "billing"
  let staffSheetTable = null;   // table number shown in bottom sheet
  let staffSelectedRole = "waiter"; // role selected on login screen

  // Staff alert fingerprints — tracks order changes to trigger sounds
  let staffSeenFingerprints = {};
  let staffAlertsInitialized = false;

  // Staff master key generation (same algorithm as displayed in Settings)
  function generateMasterKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return "STF-" + Array.from(bytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("").toUpperCase().slice(0, 24);
  }

  function staffKeyFor(slug) { return "restoqr_staff_" + slug; }
  function isStaffUnlocked(slug) { return localStorage.getItem(staffKeyFor(slug)) === "yes"; }
  function staffRole(slug) { return localStorage.getItem("restoqr_staff_role_" + slug) || "waiter"; }

  // Hash a master key with SHA-256 via Web Crypto — returns hex string promise
  async function hashMasterKey(key) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.trim()));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  // ================================================================

  // ---- New Order Alert Sound ----
  let soundEnabled = localStorage.getItem("restoqr_sound_off") !== "yes";
  let audioCtx = null;
  let seenOrderIds = new Set();
  let seenOrdersInitialized = false;

  // ---- Reprint Bill: print-only receipt styles (self-contained, no external CSS needed) ----
  (function injectReceiptPrintStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #print-receipt-holder { display: none; }
      @media print {
        body.printing-receipt > *:not(#print-receipt-holder) { display: none !important; }
        body.printing-receipt #print-receipt-holder { display: block !important; }
        #print-receipt-holder .receipt { width: 300px; margin: 0 auto; font-family: 'Courier New', monospace; color: #000; }
        #print-receipt-holder .receipt h2 { margin: 0 0 4px; font-size: 16px; text-align: center; }
        #print-receipt-holder .receipt p { margin: 2px 0; font-size: 12px; text-align: center; }
        #print-receipt-holder .receipt table { width: 100%; margin-top: 8px; border-collapse: collapse; }
        #print-receipt-holder .receipt th, #print-receipt-holder .receipt td { padding: 2px 4px; font-size: 12px; }
        #print-receipt-holder .receipt hr { border: none; border-top: 1px dashed #000; margin: 8px 0; }
        #print-receipt-holder .receipt .receipt-total { display: flex; justify-content: space-between; font-weight: 700; font-size: 14px; text-align: left; }
      }
    `;
    document.head.appendChild(style);
  })();

  const COMMON_ITEMS = [
    ["Paneer Tikka", "Starters", 220, true], ["Chicken 65", "Starters", 280, false], ["Veg Manchurian", "Starters", 180, true],
    ["Masala Papad", "Starters", 60, true], ["French Fries", "Starters", 120, true], ["Dal Fry", "Main Course", 170, true],
    ["Dal Tadka", "Main Course", 190, true], ["Dal Makhani", "Main Course", 240, true], ["Paneer Butter Masala", "Main Course", 280, true],
    ["Veg Kolhapuri", "Main Course", 240, true], ["Butter Chicken", "Main Course", 320, false], ["Chicken Curry", "Main Course", 290, false],
    ["Veg Biryani", "Rice", 220, true], ["Chicken Biryani", "Rice", 280, false], ["Jeera Rice", "Rice", 140, true],
    ["Steamed Rice", "Rice", 120, true], ["Butter Roti", "Breads", 30, true], ["Tandoori Roti", "Breads", 25, true],
    ["Garlic Naan", "Breads", 60, true], ["Butter Naan", "Breads", 55, true], ["Chapati", "Breads", 20, true],
    ["Masala Chai", "Beverages", 40, true], ["Cold Coffee", "Beverages", 120, true], ["Fresh Lime Soda", "Beverages", 80, true],
    ["Mineral Water", "Beverages", 25, true], ["Gulab Jamun", "Desserts", 90, true], ["Ice Cream", "Desserts", 100, true]
  ];

  function seed() {
    const now = Date.now();
    return {
      meta: { adminPin: "9090", createdAt: now },
      restaurants: [
        {
          id: uid(),
          slug: "catalis-cafe",
          name: "Catalis Cafe",
          owner: "Mayur Jadhav",
          phone: "9999999999",
          city: "Pune",
          ownerPin: "1234",
          active: true,
          qrEnabled: true,
          plan: "Monthly",
          subscriptionEnds: now + days(30),
          paymentQr: DEFAULT_QR,
          upiId: "mayur@upi",
          upiName: "Mr. Mayur Ravindra Jadhav",
          googleReviewUrl: "https://www.google.com/search?q=Catalis+Cafe+Google+review",
          tables: [1, 2, 3, 4, 5, 6].map(n => ({ no: n, seats: n === 6 ? 8 : 4 })),
          categories: ["Starters", "Main Course", "Breads", "Beverages"],
          menu: [
            item("Paneer Tikka", "Starters", 220, true, ["Extra chutney"]),
            item("Chicken 65", "Starters", 280, false, ["Extra spicy"]),
            item("Dal Makhani", "Main Course", 240, true, ["Butter topping"]),
            item("Paneer Butter Masala", "Main Course", 280, true, ["Extra gravy"]),
            item("Butter Chicken", "Main Course", 320, false, ["Extra gravy"]),
            item("Garlic Naan", "Breads", 60, true, []),
            item("Butter Roti", "Breads", 30, true, []),
            item("Masala Chai", "Beverages", 40, true, []),
            item("Cold Coffee", "Beverages", 120, true, [])
          ],
          addons: [
            { id: uid(), name: "Extra Roti", price: 30, active: true },
            { id: uid(), name: "Extra Cheese", price: 40, active: true },
            { id: uid(), name: "Mineral Water", price: 25, active: true }
          ],
          createdAt: now
        }
      ],
      orders: [],
      feedbacks: []
    };
  }

  function item(name, category, price, veg, notes) {
    return { id: uid(), name, category, price, veg, available: true, notes };
  }

  function start() {
    firebaseMode = canUseFirebase();
    if (firebaseMode) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      auth = firebase.auth();
      db   = firebase.database().ref("restoqr");

      // Listen for auth state — renders gated views correctly
      auth.onAuthStateChanged(user => {
        currentUser = user || null;
        _isAdminCache = null; // reset on every auth change
        render();
      });

      // Live DB listener
      db.on("value", snap => {
        const value = snap.val();
        if (value && value.restaurants) {
          // Existing data — load it, preserve admins and other nodes
          const normalized = normalizeState(value);
          checkNewOrders(normalized);
          state = normalized;
        } else if (!value) {
          // Truly empty DB — seed only the app data, never touch admins node
          const s = seed();
          db.child("meta").set(s.meta);
          db.child("restaurants").set(s.restaurants);
          db.child("orders").set(s.orders);
          db.child("feedbacks").set(s.feedbacks);
          // Do NOT call save(seed()) — that would overwrite the entire restoqr node
          // including any manually added admins
        }
        // If value exists but has no restaurants yet (e.g. only admins node),
        // just normalize what we have without overwriting
        else {
          const normalized = normalizeState(value);
          state = normalized;
        }
        render();
      });
    }
    window.addEventListener("hashchange", () => {
      customerCat = "";
      staffSheetTable = null;
      render();
    });
  }

  function canUseFirebase() {
    const c = window.FIREBASE_CONFIG || {};
    return !!(window.firebase && c.apiKey && c.databaseURL && c.projectId);
  }

  // ── Firebase Auth helpers ────────────────────────────────────────
  function authSignIn(email, password, onErr) {
    if (!auth) return onErr("Firebase not available");
    auth.signInWithEmailAndPassword(email, password)
      .catch(e => onErr(friendlyAuthError(e.code)));
  }

  function authSignOut() {
    if (auth) auth.signOut();
    currentUser = null;
    _isAdminCache = null;
    render();
  }

  function friendlyAuthError(code) {
    const map = {
      "auth/user-not-found":      "No account found for this email.",
      "auth/wrong-password":       "Incorrect password. Try again.",
      "auth/invalid-email":        "Please enter a valid email address.",
      "auth/too-many-requests":    "Too many attempts. Please wait a moment.",
      "auth/invalid-credential":   "Incorrect email or password.",
      "auth/network-request-failed": "Network error. Check your connection."
    };
    return map[code] || "Login failed. Please try again.";
  }

  // Returns the restaurant slug linked to the signed-in owner account.
  // We store   restoqr_owner_email_<slug> = email   in Firebase under each restaurant,
  // so we just scan for a match.
  function ownerSlugForUser(user) {
    if (!user) return null;
    const email = (user.email || "").toLowerCase();
    return state.restaurants.find(r => (r.ownerEmail || "").toLowerCase() === email)?.slug || null;
  }

  // Cache for admin status — reset on sign out
  let _isAdminCache = null;
  let _adminCheckInFlight = false;

  // True when the signed-in user's UID exists under restoqr/admins/<uid>
  // Result is cached after first DB check so renders are instant after that.
  function isAdmin(user) {
    if (!user || !db) return false;
    if (_isAdminCache !== null) return _isAdminCache;
    if (_adminCheckInFlight) return false;
    _adminCheckInFlight = true;
    db.child("admins").child(user.uid).once("value", snap => {
      _isAdminCache = snap.exists();
      _adminCheckInFlight = false;
      render(); // re-render now that we know the result
    }).catch(() => {
      _adminCheckInFlight = false;
      _isAdminCache = false;
    });
    return false; // show loading state until DB responds
  }

  function normalizeState(raw) {
    const next = clone(raw || seed());
    next.restaurants = next.restaurants || [];
    next.orders = next.orders || [];
    next.feedbacks = next.feedbacks || [];
    next.restaurants.forEach(r => {
      r.paymentQr = r.paymentQr || DEFAULT_QR;
      r.googleReviewUrl = r.googleReviewUrl || "";
      r.upiName = r.upiName || r.owner || r.name;
      r.upiId = r.upiId || "";
      r.couponCode = r.couponCode || "";
      r.staffKey = r.staffKey || "";
      r.masterKeyHash = r.masterKeyHash || "";
      r.ownerEmail = r.ownerEmail || "";
      r.tables = r.tables || [];
      r.tableCount = r.tableCount || r.tables.length || 4;
      r.menu = r.menu || [];
      r.addons = r.addons || [];
      r.categories = unique([...(r.categories || []), ...r.menu.map(i => i.category)]);
    });
    return next;
  }

  function save(next) {
    state = clone(next || state);
    checkNewOrders(state);
    if (firebaseMode && db) {
      // Only write app data keys — never touch the admins node
      db.child("meta").set(state.meta || {});
      db.child("restaurants").set(state.restaurants || []);
      db.child("orders").set(state.orders || []);
      db.child("feedbacks").set(state.feedbacks || []);
    }
    render();
  }

  function mutate(fn) {
    const next = clone(state);
    fn(next);
    save(next);
  }

  function route() {
    const raw = location.hash || "#/";
    const [path, qs = ""] = raw.replace(/^#/, "").split("?");
    return { path: path || "/", params: new URLSearchParams(qs) };
  }

  // ---- New Order Alert Sound: detection + chime ----

  function currentOwnerSlugIfAny() {
    const r = route();
    if (r.path !== "/owner") return null;
    const slug = r.params.get("resto") || localStorage.getItem("restoqr_owner_slug") || "";
    if (slug && currentUser) return slug;
    return null;
  }

  function ensureAudioCtx() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audioCtx = null; }
    }
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function playOrderAlertSound() {
    if (!soundEnabled) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    [0, 0.22, 0.44].forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = i % 2 === 0 ? 880 : 660;
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.35, now + t + 0.02);
      gain.gain.linearRampToValueAtTime(0, now + t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + t);
      osc.stop(now + t + 0.2);
    });
  }

  // Tracks a fingerprint (total + item count) per order so we fire the alert
  // whenever anything changes — new orders, same-table additions, add-ons, etc.
  let seenOrderFingerprints = {}; // orderId -> "total:itemCount"

  function orderFingerprint(o) {
    const itemQty = (o.items || []).reduce((s, i) => s + i.qty, 0);
    const addonQty = (o.addons || []).reduce((s, a) => s + (a.qty || 1), 0);
    return `${o.total}:${itemQty}:${addonQty}`;
  }

  function checkNewOrders(nextState) {
    const orders = nextState.orders || [];
    if (!seenOrdersInitialized) {
      orders.forEach(o => { seenOrderFingerprints[o.id] = orderFingerprint(o); });
      seenOrderIds = new Set(orders.map(o => o.id));
      seenOrdersInitialized = true;
      return;
    }

    const slug = currentOwnerSlugIfAny();
    let shouldChime = false;

    orders.forEach(o => {
      if (o.restaurantSlug !== slug) return;
      const fp = orderFingerprint(o);
      const prev = seenOrderFingerprints[o.id];
      if (prev === undefined) {
        // Brand new order
        shouldChime = true;
        toast("🔔 New order — Table " + o.table);
      } else if (prev !== fp) {
        // Existing order updated (items added, add-ons, etc.)
        shouldChime = true;
        toast("➕ Order updated — Table " + o.table);
      }
      seenOrderFingerprints[o.id] = fp;
    });

    // Clean up fingerprints for deleted/completed orders
    const currentIds = new Set(orders.map(o => o.id));
    Object.keys(seenOrderFingerprints).forEach(id => {
      if (!currentIds.has(id)) delete seenOrderFingerprints[id];
    });
    seenOrderIds = currentIds;

    if (shouldChime && slug) playOrderAlertSound();
  }

  function render() {
    const r = route();
    if (r.path === "/register") return html(registerView());
    if (r.path === "/admin") return html(adminView());
    if (r.path === "/owner") return html(ownerView(r.params));
    if (r.path === "/order") return html(customerView(r.params));
    if (r.path === "/staff") return html(staffView(r.params));
    return html(homeView());
  }

  /* ---------------- icons & decorative illustrations ---------------- */

  function icon(name) {
    const icons = {
      scan: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M4 8V5a1 1 0 0 1 1-1h3"/><path d="M16 4h3a1 1 0 0 1 1 1v3"/><path d="M20 16v3a1 1 0 0 1-1 1h-3"/><path d="M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>`,
      orders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 3.5h6a1 1 0 0 1 1 1V6H8V4.5a1 1 0 0 1 1-1Z"/><path d="m8.5 12 2 2 4-4.5"/><path d="M8 17h8"/></svg>`,
      growth: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M4 19h16"/><path d="M7 19v-5"/><path d="M12 19V8"/><path d="M17 19v-9"/><path d="m14 5 3-2 3 2"/><path d="M17 3v4"/></svg>`,
      customize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87 2 2 0 1 1-2.83 2.83 1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34 2 2 0 1 1-2.83-2.83 1.7 1.7 0 0 0 .34-1.87A1.7 1.7 0 0 0 4.1 13.5H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87 2 2 0 1 1 2.83-2.83 1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1.03-1.55V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34 2 2 0 1 1 2.83 2.83 1.7 1.7 0 0 0-.34 1.87V10c.14.62.58 1.13 1.1 1.4"/></svg>`
    };
    return icons[name] || "";
  }

  // Decorative fort skyline used behind the culture banner — a silhouette, not a portrait
  // or named figure, kept generic so it reads as texture rather than a depiction.
  function skylineArt() {
    return `
      <svg class="skyline" viewBox="0 0 1200 220" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M0 220V150h40V120h24v30h28v-50h20v20h18V96h26v54h30v-40h22v18h20v-60h30v34h24V96h40v54h26v-70h22v26h18v-30h32v44h30v-50h24v22h20V70h36v60h24v-40h20v60h30v-30h26v50h36v20H0Z" fill="#5c2510" opacity=".55"/>
        <path d="M520 220v-86h14v-20h10v20h12v-40h16v18h10V72h18v40h12v-20h10v50h14v-46h10v66h170v16Z" fill="#3f1808" opacity=".5"/>
      </svg>
      <svg class="sun" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="26" fill="#fff1cf" opacity=".9"/>
        <circle cx="50" cy="50" r="38" fill="none" stroke="#fff1cf" stroke-width="2" opacity=".35"/>
      </svg>`;
  }

  function featureCard(name, title, text) {
    return `<div class="feature-card">
      <div class="feature-icon">${icon(name)}</div>
      <h3>${title}</h3>
      <p>${text}</p>
    </div>`;
  }

  function homeView() {
    const active = state.restaurants.filter(r => r.active).length;
    const waiting = state.orders.filter(o => o.paymentStatus === "waiting").length;
    const today = state.orders.filter(o => sameDay(o.createdAt, Date.now()));

    // If owner is logged in, show their panel button instead of generic login
    let heroActions;
    if (firebaseMode && currentUser) {
      if (isAdmin(currentUser)) {
        heroActions = `
          <a class="btn primary" href="#/admin">Admin Dashboard</a>
          <button class="btn" data-action="auth-signout">Sign Out</button>`;
      } else {
        const ownerSlug = ownerSlugForUser(currentUser);
        const ownerResto = ownerSlug ? bySlug(ownerSlug) : null;
        heroActions = ownerResto
          ? `<a class="btn primary" href="#/owner?resto=${ownerSlug}">Go to ${esc(ownerResto.name)} Panel</a>
             <button class="btn" data-action="auth-signout">Sign Out</button>`
          : `<a class="btn primary" href="#/register">Register Restaurant</a>
             <a class="btn" href="#/owner">Restaurant Login</a>
             <button class="btn" data-action="auth-signout">Sign Out</button>`;
      }
    } else {
      heroActions = `
        <a class="btn primary" href="#/register">Register Restaurant</a>
        <a class="btn" href="#/owner">Restaurant Login</a>
        <a class="btn ghost" href="#/admin">Super Admin</a>`;
    }

    return `
      ${topbar("home")}
      
      <main class="hero">
        <div class="hero-inner">
          <section class="media-carousel">
          <div class="carousel-container">
            <div class="carousel-track">
              <div class="carousel-slide active" id="video-slide">
                <iframe
                  src="https://www.youtube.com/embed/wKurYY4WfNc?autoplay=1&mute=1&rel=0"
                  width="560"
                  height="360"
                  frameborder="0"
                  allow="autoplay; encrypted-media"
                  allowfullscreen>
                </iframe>
              </div>
              
              <div class="carousel-slide">
                <img src="assets/demo1.png" alt="Restaurant Demo">
              </div>

              

              <div class="carousel-slide">
                <img src="assets/demo2.png" alt="Restaurant Demo">
              </div>

              <div class="carousel-slide">
                <img src="assets/demo3.png  " alt="Restaurant Demo">
              </div>
              <div class="carousel-slide">
                <img src="assets/demo4.png" alt="Restaurant Demo">
              </div>

            </div>

            <button class="carousel-btn prev">❮</button>
            <button class="carousel-btn next">❯</button>

            <div class="carousel-dots"></div>
          </div>
          <div class="hero-actions">
              ${heroActions}
            </div>
        </section>
          
            
            
          
        </div>
      </main>
      

      

      <section class="feature-section">
        <div class="feature-section-inner">
          <div class="feature-head">
            <p class="eyebrow center">What you get</p>
            <h2>Everything a counter needs, nothing it doesn't.</h2>
            <p>Four moving parts cover the whole table-to-bill flow.</p>
          </div>
          <div class="grid-4">
            ${featureCard("scan", "Scan & order", "Each table gets one QR. Customers see the live menu and order straight from their phone.")}
            ${featureCard("orders", "Track every order", "Watch new orders land in real time, move them through prep, and confirm payment at the counter.")}
            ${featureCard("growth", "Built for repeat visits", "Collect a rating after every order and route happy customers straight to your Google listing.")}
            ${featureCard("customize", "Make it yours", "Add categories, add-ons, and table QR codes in minutes — no designer or developer needed.")}
          </div>
        </div>
      </section>

      <section class="guide-strip">
        <div class="guide-strip-inner">
          <div class="guide-strip-head">
            <div>
              <p class="eyebrow">Owner Guide</p>
              <h3>Everything you need to know, one slide at a time.</h3>
            </div>
            <div class="guide-strip-nav">
              <button class="guide-prev" aria-label="Previous">&#8592;</button>
              <button class="guide-next" aria-label="Next">&#8594;</button>
            </div>
          </div>
          <div class="guide-track-wrap">
            <div class="guide-track">

              <div class="guide-card" style="--accent:#FF6B2B;--accent-pale:#FFF0E9">
                <div class="guide-card-icon">📱</div>
                <div class="guide-card-tag">QR Ordering</div>
                <h4>Customers scan &amp; order from their own phone</h4>
                <p>Each table gets a unique QR code. Customers browse your live menu and place orders — no app, no waiter needed to write it down.</p>
                <ul class="guide-steps">
                  <li>Print QR codes from Owner Panel → QR Codes tab</li>
                  <li>Customer scans → browses menu → confirms order</li>
                  <li>Order appears instantly on your Kitchen screen</li>
                  <li>You get an audio alert for every new order 🔔</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#7B4FD4;--accent-pale:#F0EAFF">
                <div class="guide-card-icon">🤖</div>
                <div class="guide-card-tag">AI Assistant</div>
                <h4>Ask your sales data anything in plain language</h4>
                <p>The floating AI button on every owner page lets you ask questions like you'd ask a colleague — no spreadsheets needed.</p>
                <ul class="guide-steps">
                  <li>"What was my best seller this week?"</li>
                  <li>"How much chicken do I need tomorrow?"</li>
                  <li>"Which items are rarely ordered?"</li>
                  <li>"Compare this week vs last week revenue"</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#2B6FFF;--accent-pale:#E6EEFF">
                <div class="guide-card-icon">📊</div>
                <div class="guide-card-tag">Analytics & Billing</div>
                <h4>Your numbers, always up to date</h4>
                <p>Track revenue, top items, and payment status without any manual counting. Filter by date and print records in one tap.</p>
                <ul class="guide-steps">
                  <li>Overview tab shows today's revenue and top sellers</li>
                  <li>Billing tab lets you filter by any date range</li>
                  <li>Mark orders as Cash Paid or UPI Paid instantly</li>
                  <li>Print receipts directly from any order</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#2D9B6F;--accent-pale:#E6F7F0">
                <div class="guide-card-icon">🔑</div>
                <div class="guide-card-tag">Staff Access</div>
                <h4>Give your team access without sharing your login</h4>
                <p>Generate a Master Key from Settings and share it with staff. They get Kitchen, Floor Plan, and Billing — nothing else.</p>
                <ul class="guide-steps">
                  <li>Owner Panel → Settings → Generate Master Key</li>
                  <li>Share the key with your team via WhatsApp</li>
                  <li>Staff enter it once on their device — done</li>
                  <li>Regenerate anytime to revoke old access instantly</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#FF6B2B;--accent-pale:#FFF0E9">
                <div class="guide-card-icon">🏪</div>
                <div class="guide-card-tag">Owner Panel</div>
                <h4>Run your entire restaurant from one screen</h4>
                <p>Log in once with your email and stay signed in. Every tool you need is one tab away — menu, orders, billing, QR codes, and AI.</p>
                <ul class="guide-steps">
                  <li>Menu tab — add items, prices, addons, categories</li>
                  <li>Orders tab — live view with table and item details</li>
                  <li>QR Codes tab — download and print table codes</li>
                  <li>Settings tab — update info and manage staff key</li>
                </ul>
              </div>

            </div>
          </div>
          <div class="guide-dots"></div>
        </div>
      </section>

      <section class="culture-banner">
        ${skylineArt()}
        <div class="culture-banner-inner">
          <p class="kicker">Built for the local favourite</p>
          <h2>From the corner dhaba to the rooftop café, every table deserves a menu people enjoy using.</h2>
          <p class="sub">RestoQR runs on the phone your customers already carry, and the counter you already staff.</p>
        </div>
      </section>`;
  }

  function registerView() {
    return `
      ${topbar("register")}
      <main class="wrap">
        <div class="culture-banner" style="margin:0 0 26px">
          <div class="culture-banner-inner" style="padding:36px 24px 30px">
            <p class="kicker">Get started</p>
            <h2 style="font-size:clamp(22px,3vw,30px)">Bring your restaurant onto RestoQR at just ₹999</h2>
            <p class="sub">Pay the one-time fee for entire month </p>
          </div>
        </div>
        <div class="split">
          <section class="card">
            <div class="section-head"><div><h2>Restaurant Registration</h2><p>Restaurant pays you on PhonePe, then you activate it from admin.</p></div></div>
            <div class="grid-2">
              ${field("Restaurant Name", "reg-name", "input", "Cafe Aroma")}
              ${field("Owner Name", "reg-owner", "input", "Owner name")}
              ${field("Phone", "reg-phone", "input", "Mobile number")}
              ${field("City", "reg-city", "input", "City")}
              ${field("Owner Email", "reg-owner-email", "input", "owner@email.com", "email")}
              ${field("Owner Password", "reg-owner-password", "input", "Min 6 characters", "password")}
              ${field("UPI ID (VPA)", "reg-upiid", "input", "name@upi or 9999999999@paytm")}
              ${field("UPI Display Name", "reg-upi", "input", "Shown under payment QR")}
              ${field("Google Review Link", "reg-review", "input", "Paste Google review link")}
              <input type="hidden" id="reg-coupon" value="">
              <input type="hidden" id="reg-pin" value="0000">
            </div>
            <button class="btn primary" data-action="register">Submit Registration</button>
          </section>
          <aside class="qr-box">
            <p class="small">Pay registration / subscription</p>
            <div id="reg-payment-panel">

              <div class="rqr-flip" id="reg-flip">
                <div class="rqr-flip-inner" id="reg-flip-inner">
                  <div class="rqr-flip-face rqr-flip-front">
                    <img src="./assets/maharaj.png" alt="RestoQR">
                  </div>
                  <div class="rqr-flip-face rqr-flip-back">
                    <img id="reg-qr-img" src="" alt="UPI QR">
                  </div>
                </div>
              </div>

              <div style="text-align:center;margin:12px 0 14px">
                <span id="reg-amount-display" style="font-size:20px;font-weight:900;color:#1c0e04">₹999</span>
                <span class="small" style="opacity:.65"> · Registration · 30 days access</span>
                <div id="reg-coupon-badge" style="display:none;margin-top:6px">
                  <span style="background:#d4edda;color:#155724;font-size:12px;font-weight:700;padding:4px 12px;border-radius:20px">🎟 Coupon applied — ₹300 off!</span>
                </div>
              </div>

              <button class="btn primary block" id="reg-pay-btn" onclick="(function(){
                var name = (document.getElementById('reg-name')||{}).value||'restaurant';
                var coupon = ((document.getElementById('reg-coupon')||{}).value||'').trim().toUpperCase();
                var amount = coupon === '@MARATHIMANUS' ? 699 : 999;
                var slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,20) || 'restaurant';
                var note = 'REG-' + slug.toUpperCase()+'-' + Date.now().toString().slice(-6);
                var upiId = '7972736023@ybl';
                var upiName = 'RestoQR';
                var upiLink = 'upi://pay?pa=' + encodeURIComponent(upiId) + '&pn=' + encodeURIComponent(upiName) + '&am=' + amount + '&tn=' + encodeURIComponent(note) + '&cu=INR';
                var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(upiLink);
                var qrImg = document.getElementById('reg-qr-img');
                var flipInner = document.getElementById('reg-flip-inner');
                var noteEl = document.getElementById('reg-upi-note');
                var noteWrap = document.getElementById('reg-upi-note-wrap');
                var deeplink = document.getElementById('reg-upi-deeplink');
                var btn = document.getElementById('reg-pay-btn');
                var msg = document.getElementById('reg-payment-msg');
                if(qrImg) qrImg.src = qrUrl;
                if(noteEl) noteEl.textContent = note;
                if(deeplink) deeplink.href = upiLink;
                if(flipInner) flipInner.classList.add('flipped');
                if(noteWrap) noteWrap.style.display = 'block';
                if(deeplink) deeplink.style.display = 'inline-block';
                if(btn){ btn.disabled = true; btn.style.opacity = '0.55'; btn.textContent = '✅ QR Ready Above'; }
                if(msg) setTimeout(function(){ msg.style.display='block'; }, 750);
              })()">💳 Make Payment</button>
              <p class="pay-upi-label">PhonePe · GPay · UPI</p>
              <p class="small" id="reg-upi-note-wrap" style="display:none;margin:6px 0 0">Ref: <strong id="reg-upi-note" style="color:#c4a96a;font-family:monospace"></strong></p>
              <a id="reg-upi-deeplink" href="#" style="display:none;margin-top:8px;font-size:12px;color:#1a73e8;text-decoration:none;font-weight:600">📱 Open in UPI App</a>

              <div id="reg-payment-msg" style="display:none;margin-top:12px">
                <div class="pay-verify-badge">⏳ Verifying payment</div>
                <p class="small">We'll verify and activate your restaurant within 2–4 hours. Our team will contact you on the phone number provided.</p>
              </div>
            </div>

            <style>
              .rqr-flip{ width:200px;height:200px;margin:0 auto;perspective:1200px; }
              .rqr-flip-inner{ position:relative;width:100%;height:100%;transition:transform .8s cubic-bezier(.4,.1,.2,1);transform-style:preserve-3d; }
              .rqr-flip-inner.flipped{ transform:rotateY(180deg); }
              .rqr-flip-face{ position:absolute;inset:0;backface-visibility:hidden;border-radius:14px;overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.18); }
              .rqr-flip-front img{ width:100%;height:100%;object-fit:cover; }
              .rqr-flip-back{ transform:rotateY(180deg); }
              .rqr-flip-back img{ width:100%;height:100%;object-fit:contain;padding:10px;box-sizing:border-box; }
            </style>
          </aside>
        </div>
      </main>

      <button type="button" onclick="document.getElementById('coupon-modal-overlay').style.display='flex';setTimeout(function(){var i=document.getElementById('coupon-modal-input'); if(i) i.focus();},50)"
        style="position:fixed;bottom:24px;right:24px;z-index:200;display:flex;align-items:center;gap:8px;background:#1a1a1a;color:#fff;border:none;border-radius:999px;padding:13px 22px;font-weight:700;font-size:14px;cursor:pointer;box-shadow:0 12px 28px rgba(0,0,0,.25)">
        🎟 Add Coupon
      </button>

      <div id="coupon-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(15,12,10,.55);z-index:300;align-items:center;justify-content:center;padding:16px">
        <div style="background:#fff;border-radius:16px;padding:28px 26px 24px;max-width:360px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,.3);position:relative;font-family:inherit">
          <button type="button" onclick="document.getElementById('coupon-modal-overlay').style.display='none'"
            style="position:absolute;top:12px;right:14px;background:none;border:none;font-size:18px;line-height:1;cursor:pointer;color:#9ca3af">✕</button>
          <div style="font-size:30px;margin-bottom:8px">🎟</div>
          <h3 style="margin:0 0 4px;font-size:18px;color:#1a1a1a">Have a Coupon Code?</h3>
          <p style="margin:0 0 16px;font-size:13px;color:#6b7280;line-height:1.4">Enter it below — we'll add it to your registration form automatically.</p>
          <input id="coupon-modal-input" placeholder="e.g. LAUNCH999" autocomplete="off"
            style="width:100%;box-sizing:border-box;padding:11px 12px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:14px;letter-spacing:.04em;text-transform:uppercase;margin-bottom:14px"
            onkeydown="if(event.key==='Enter'){event.preventDefault();this.nextElementSibling.click();}">
          <button type="button" class="btn primary block" style="width:100%;padding:12px;border-radius:10px;font-weight:700" onclick="(function(){
              var input=document.getElementById('coupon-modal-input');
              var code=(input.value||'').trim().toUpperCase();
              if(!code){ input.style.border='1.5px solid #c93333'; input.focus(); return; }
              var valid = code === '@MARATHIMANUS';
              if(!valid){ input.style.border='1.5px solid #c93333'; input.focus();
                var t=document.getElementById('toast');
                if(t){ t.textContent='❌ Invalid coupon code'; t.hidden=false; clearTimeout(t._ct); t._ct=setTimeout(function(){t.hidden=true;},2400); }
                return;
              }
              var target=document.getElementById('reg-coupon');
              if(target) target.value=code;
              document.getElementById('coupon-modal-overlay').style.display='none';
              input.value=''; input.style.border='';
              var t=document.getElementById('toast');
              if(t){ t.textContent='🎟 Coupon applied — ₹300 off! You pay ₹699'; t.hidden=false; clearTimeout(t._ct); t._ct=setTimeout(function(){t.hidden=true;},3000); }
              var amtEl=document.getElementById('reg-amount-display');
              if(amtEl){ amtEl.textContent='₹699'; amtEl.style.color='#1e8a50'; }
              var badge=document.getElementById('reg-coupon-badge');
              if(badge) badge.style.display='block';
            })()">Apply Coupon</button>
        </div>
      </div>`;
  }

  // ================================================================
  // FIREBASE AUTH — shared login screen (admin + owner)
  // ================================================================
  function authLoginView(role, errorMsg) {
    const isAdmin = role === "admin";
    const title   = isAdmin ? "Admin Login" : "Owner Login";
    const hint    = isAdmin
      ? "Sign in with your admin Google/email account."
      : "Sign in with the email linked to your restaurant.";
    const icon    = isAdmin ? "🔐" : "🏪";

    return `
      ${topbar(role)}
      <main class="wrap">
        <section class="card" style="max-width:420px;margin:0 auto">
          <div style="text-align:center;margin-bottom:22px">
            <div style="font-size:44px;margin-bottom:8px">${icon}</div>
            <h2 style="margin:0 0 6px">${title}</h2>
            <p class="muted" style="margin:0">${hint}</p>
          </div>
          ${errorMsg ? `<div style="background:#fff0f0;border:1px solid #f5c6c6;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#c0392b;font-size:13px;font-weight:600">${esc(errorMsg)}</div>` : ""}
          <div id="auth-err" style="display:none;background:#fff0f0;border:1px solid #f5c6c6;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#c0392b;font-size:13px;font-weight:600"></div>
          <div class="field"><label>Email</label><input id="auth-email" type="email" placeholder="your@email.com" autocomplete="username"></div>
          <div class="field"><label>Password</label><input id="auth-password" type="password" placeholder="Password" autocomplete="current-password"></div>
          <button class="btn primary block" id="auth-submit-btn" data-action="auth-login" data-role="${role}">Sign In</button>
          <p class="muted small" style="text-align:center;margin-top:14px">Forgot password? Contact your administrator.</p>
        </section>
      </main>`;
  }

  function adminView() {
    // Firebase mode: require signed-in admin email
    if (firebaseMode) {
      if (!currentUser) return authLoginView("admin");
      if (_adminCheckInFlight) return `${topbar("admin")}<main class="wrap"><div class="card" style="text-align:center;padding:40px"><p class="muted">Verifying admin access…</p></div></main>`;
      if (!isAdmin(currentUser)) return authLoginView("admin", "This account does not have admin access.");
    }
    const totalOrders = state.orders.length;
    const revenue = state.orders.filter(o => o.paymentStatus === "paid").reduce((s, o) => s + o.total, 0);
    return `
      ${topbar("admin")}
      <main class="wrap">
        <div class="grid-4">
          ${stat("Restaurants", state.restaurants.length)}
          ${stat("Active", state.restaurants.filter(r => r.active).length)}
          ${stat("Orders", totalOrders)}
          ${stat("Paid Value", money(revenue))}
        </div>
        <section class="card" style="margin-top:14px">
          <div class="section-head">
            <div><h2>Restaurants</h2><p>Activate subscriptions, disable QR ordering, and control access.</p></div>
            <button class="btn" data-action="auth-signout">Sign Out</button>
          </div>
          ${state.restaurants.map(r => restaurantAdminCard(r)).join("") || empty("No restaurants yet")}
        </section>
      </main>`;
  }

  function restaurantAdminCard(r) {
    const left = Math.ceil((r.subscriptionEnds - Date.now()) / days(1));
    const orders = state.orders.filter(o => o.restaurantSlug === r.slug);
    return `
      <div class="list-item">
        <div class="row">
          <div>
            <h3 style="margin:0">${esc(r.name)}</h3>
            <p class="muted small" style="margin:4px 0 0">${esc(r.owner)} · ${esc(r.phone)} · /${esc(r.slug)}</p>
          </div>
          <div class="row-left">
            <span class="pill ${r.active ? "ok" : "bad"}">${r.active ? "Active" : "Inactive"}</span>
            <span class="pill ${r.qrEnabled ? "blue" : "neutral"}">QR ${r.qrEnabled ? "On" : "Off"}</span>
            <span class="pill ${left > 5 ? "ok" : left > 0 ? "warn" : "bad"}">${left > 0 ? left + " days left" : "Expired"}</span>
            ${r.couponCode ? `<span class="pill warn">🎟 ${esc(r.couponCode)}</span>` : ""}
          </div>
        </div>
        <div class="row" style="margin-top:12px; flex-wrap:wrap">
          <span class="muted small">${orders.length} orders · Owner PIN ${esc(r.ownerPin)}${r.couponCode ? ` · Coupon used: <strong>${esc(r.couponCode)}</strong>` : ""}</span>
          <div class="row-left">
            <button class="btn ${r.active ? "bad" : "ok"}" data-action="toggle-active" data-slug="${r.slug}">${r.active ? "Deactivate" : "Activate"}</button>
            <button class="btn" data-action="toggle-qr" data-slug="${r.slug}">${r.qrEnabled ? "Disable QR" : "Enable QR"}</button>
            <button class="btn blue" data-action="extend-sub" data-slug="${r.slug}">Add 30 Days</button>
            <a class="btn" href="#/owner?resto=${r.slug}">Open Panel</a>
            <button class="btn bad" data-action="delete-resto" data-slug="${r.slug}">Delete</button>
          </div>
        </div>
      </div>`;
  }

  function ownerView(params) {
    // Firebase mode: if logged in, resolve slug from their account first
    if (firebaseMode && currentUser) {
      const linkedSlug = ownerSlugForUser(currentUser);
      const adminUser  = isAdmin(currentUser);
      // If owner has a linked restaurant and no explicit slug in URL, redirect to theirs
      if (linkedSlug && !params.get("resto")) {
        location.replace("#/owner?resto=" + linkedSlug);
        return "";
      }
      // If owner tries to access a different restaurant's slug, redirect to their own
      if (linkedSlug && params.get("resto") && params.get("resto") !== linkedSlug && !adminUser) {
        location.replace("#/owner?resto=" + linkedSlug);
        return "";
      }
    }

    const slug = params.get("resto") || (firebaseMode && currentUser ? ownerSlugForUser(currentUser) : null) || localStorage.getItem("restoqr_owner_slug") || (state.restaurants[0]?.slug || "");
    const r = bySlug(slug);
    // Firebase mode: if not logged in, always show login form first
    if (firebaseMode && !currentUser) return authLoginView("owner");
    if (!r) return shell("Owner Panel", `<section class="card">${empty("Restaurant not found")}<a class="btn primary" href="#/register">Register</a></section>`, "owner");
    // Firebase mode: require signed-in owner email linked to this restaurant
    if (firebaseMode) {
      if (!currentUser) return authLoginView("owner");
      const linkedSlug = ownerSlugForUser(currentUser);
      if (!linkedSlug) {
        // Allow admin to open any restaurant panel
        if (!isAdmin(currentUser)) return authLoginView("owner", "Your account is not linked to any restaurant.");
      } else if (linkedSlug !== r.slug) {
        // Redirect owner to their own restaurant
        location.replace("#/owner?resto=" + linkedSlug);
        return "";
      }
    }
    const signOutBtn = `<button class="btn" style="margin-left:auto" data-action="auth-signout">Sign Out</button>`;
    return `
      ${topbar("owner", r)}
      <main class="wrap">
        <div class="tabs" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
          ${["overview", "menu", "addons", "tables", "kitchen", "billing", "feedback", "analytics", "settings", "ai"].map(t => `<button class="tab-btn ${ownerTab === t ? "active" : ""}" data-action="owner-tab" data-tab="${t}">${t === "ai" ? "🤖 RestoAI" : title(t)}</button>`).join("")}
          ${signOutBtn}
        </div>
        ${ownerContent(r)}
      </main>`;
  }

  function ownerContent(r) {
    if (ownerTab === "menu") return menuPanel(r);
    if (ownerTab === "addons") return addonPanel(r);
    if (ownerTab === "tables") return tablesPanel(r);
    if (ownerTab === "kitchen") return kitchenPanel(r);
    if (ownerTab === "billing") return billingPanel(r);
    if (ownerTab === "feedback") return feedbackPanel(r);
    if (ownerTab === "settings") return settingsPanel(r);
    if (ownerTab === "ai") return restoAiPanel(r);
    const open = state.orders.filter(o => o.restaurantSlug === r.slug && o.status !== "completed");
    return `
      <div class="grid-4">
        ${stat("Open Orders", open.length)}
        ${stat("Waiting Payment", open.filter(o => o.paymentStatus === "waiting").length)}
        ${stat("Menu Items", r.menu.length)}
        ${stat("Tables", r.tables.length)}
      </div>
      <section class="card" style="margin-top:14px">
        <div class="section-head"><div><h2>${esc(r.name)}</h2><p>${isRestaurantOpen(r) ? "Customer QR ordering is active." : "Customer QR ordering is currently unavailable."}</p></div>${statusPills(r)}</div>
        <div class="row" style="flex-wrap:wrap">
          <span class="muted">Subscription ends ${new Date(r.subscriptionEnds).toLocaleDateString("en-IN")}</span>
          <div class="row-left">
            <a class="btn blue" href="#/order?resto=${r.slug}">Customer View</a>
            <button class="btn" onclick="window.print()">Print</button>
          </div>
        </div>
      </section>
      <section class="card" style="margin-top:14px" id="owner-sub-card">
        <div class="section-head"><div><h2>Subscription Payment</h2><p>Renew your RestoQR subscription for another 30 days.</p></div></div>

        <div class="rqr-flip" id="owner-flip">
          <div class="rqr-flip-inner" id="owner-flip-inner">
            <div class="rqr-flip-face rqr-flip-front">
              <img src="./assets/maharaj.png" alt="RestoQR">
            </div>
            <div class="rqr-flip-face rqr-flip-back">
              <img id="owner-qr-img" src="" alt="UPI QR">
            </div>
          </div>
        </div>

        <div style="text-align:center;margin:12px 0 16px">
          <span style="font-size:20px;font-weight:900;color:#1c0e04">₹999</span>
          <span class="small" style="opacity:.65"> · 30 days access · ${esc(r.name)}</span>
          <div style="font-size:12px;color:#a89880;margin-top:4px">
            Current plan expires
            <strong style="color:${(r.subscriptionEnds - Date.now()) < days(5) ? "#c0392b" : "#2a1a0e"}">${new Date(r.subscriptionEnds).toLocaleDateString("en-IN", {day:"numeric",month:"short",year:"numeric"})}</strong>
          </div>
        </div>

        <div style="text-align:center">
          <button class="btn primary" id="owner-make-payment-btn" onclick="(function(){
            var slug = '${esc(r.slug)}';
            var name = '${esc(r.name)}';
            var amount = 999;
            var note = 'RENEW-' + slug.toUpperCase().slice(0,20)+ Date.now().toString().slice(-6);
            var upiId = '7972736023@ybl';
            var upiLink = 'upi://pay?pa=' + encodeURIComponent(upiId) + '&pn=RestoQR&am=' + amount + '&tn=' + encodeURIComponent(note) + '&cu=INR';
            var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(upiLink);
            var qrImg = document.getElementById('owner-qr-img');
            var flipInner = document.getElementById('owner-flip-inner');
            var noteEl = document.getElementById('owner-upi-note');
            var noteWrap = document.getElementById('owner-upi-note-wrap');
            var deeplink = document.getElementById('owner-upi-deeplink');
            var btn = document.getElementById('owner-make-payment-btn');
            var msg = document.getElementById('owner-payment-msg');
            if(qrImg) qrImg.src = qrUrl;
            if(noteEl) noteEl.textContent = note;
            if(deeplink) deeplink.href = upiLink;
            if(flipInner) flipInner.classList.add('flipped');
            if(noteWrap) noteWrap.style.display = 'block';
            if(deeplink) deeplink.style.display = 'inline-block';
            if(btn){ btn.disabled = true; btn.style.opacity = '0.55'; btn.textContent = '✅ QR Ready Above'; }
            if(msg) setTimeout(function(){ msg.style.display='block'; }, 750);
          })()">💳 Pay ₹999 to Renew</button>
          <p class="small" id="owner-upi-note-wrap" style="display:none;margin:6px 0 0">Ref: <strong id="owner-upi-note" style="color:#c4a96a;font-family:monospace"></strong></p>
          <a id="owner-upi-deeplink" href="#" style="display:none;margin-top:8px;font-size:12px;color:#1a73e8;text-decoration:none;font-weight:600">📱 Open in UPI App</a>
        </div>

        <div id="owner-payment-msg" style="display:none;margin-top:12px">
          <span class="pill blue">⏳ Verification in progress</span>
          <p style="margin:8px 0 0;font-size:13px;color:var(--muted)">We'll verify and activate your plan within 2–4 hours. Contact us if it takes longer.</p>
        </div>

        <style>
          .rqr-flip{ width:200px;height:200px;margin:0 auto;perspective:1200px; }
          .rqr-flip-inner{ position:relative;width:100%;height:100%;transition:transform .8s cubic-bezier(.4,.1,.2,1);transform-style:preserve-3d; }
          .rqr-flip-inner.flipped{ transform:rotateY(180deg); }
          .rqr-flip-face{ position:absolute;inset:0;backface-visibility:hidden;border-radius:14px;overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.18); }
          .rqr-flip-front img{ width:100%;height:100%;object-fit:cover; }
          .rqr-flip-back{ transform:rotateY(180deg); }
          .rqr-flip-back img{ width:100%;height:100%;object-fit:contain;padding:10px;box-sizing:border-box; }
        </style>
      </section>`;
  }

  function menuPanel(r) {
    return `
      <section class="card">
        <div class="section-head"><div><h2>Menu</h2><p>Add products, prices, categories, and availability.</p></div></div>
        <div class="grid-4">
          ${field("Item Name", "item-name", "input", "Paneer Tikka")}
          ${field("Category", "item-cat", "input", "Starters")}
          ${field("Price", "item-price", "input", "220", "number")}
          <div class="field"><label>Type</label><select id="item-veg"><option value="true">Veg</option><option value="false">Non-veg</option></select></div>
        </div>
        <button class="btn primary" data-action="add-item" data-slug="${r.slug}">Add Item</button>
      </section>
      <section class="card" style="margin-top:14px">
        <div class="section-head"><div><h2>Common Restaurant Items</h2><p>Select ready-made items and only change the price.</p></div></div>
        <div class="catalog-grid">
          ${COMMON_ITEMS.map((c, idx) => {
            const dotStyle = `color:${c[3] ? "var(--ok)" : "var(--bad)"}`;
            return `
            <div class="catalog-card">
              <div><strong><span style="${dotStyle}">●</span> ${esc(c[0])}</strong><p class="muted small">${esc(c[1])}</p></div>
              <div class="row-left">
                <input id="common-price-${idx}" type="number" value="${c[2]}" aria-label="${esc(c[0])} price">
                <button class="btn primary" data-action="add-common" data-slug="${r.slug}" data-index="${idx}">Add</button>
              </div>
            </div>`;
          }).join("")}
        </div>
      </section>
      <section class="card" style="margin-top:14px">
        ${r.menu.map(i => {
          const dotStyle = `color:${i.veg ? "var(--ok)" : "var(--bad)"}`;
          return `
          <div class="list-item menu-item">
            <div><strong><span style="${dotStyle}">●</span> ${esc(i.name)}</strong><p class="muted small">${esc(i.category)} · ${money(i.price)} · ${i.available ? "Available" : "Hidden"}</p></div>
            <div class="row-left">
              <input id="price-${i.id}" type="number" value="${i.price}" aria-label="${esc(i.name)} price" style="width:92px">
              <button class="btn blue" data-action="update-price" data-slug="${r.slug}" data-id="${i.id}">Save</button>
              <button class="btn" data-action="toggle-item" data-slug="${r.slug}" data-id="${i.id}">${i.available ? "Hide" : "Show"}</button>
              <button class="btn bad" data-action="delete-item" data-slug="${r.slug}" data-id="${i.id}">Delete</button>
            </div>
          </div>`;
        }).join("")}
      </section>`;
  }

  function addonPanel(r) {
    return `
      <section class="card">
        <div class="section-head"><div><h2>Add-ons</h2><p>Customers can add roti, water, cheese, extra gravy, and more.</p></div></div>
        <div class="grid-2">
          ${field("Add-on Name", "addon-name", "input", "Extra Roti")}
          ${field("Price", "addon-price", "input", "30", "number")}
        </div>
        <button class="btn primary" data-action="add-addon" data-slug="${r.slug}">Add Add-on</button>
      </section>
      <section class="card" style="margin-top:14px">
        ${r.addons.map(a => `
          <div class="list-item row">
            <div><strong>${esc(a.name)}</strong><p class="muted small">${money(a.price)} · ${a.active ? "Active" : "Hidden"}</p></div>
            <div class="row-left">
              <button class="btn" data-action="toggle-addon" data-slug="${r.slug}" data-id="${a.id}">${a.active ? "Hide" : "Show"}</button>
              <button class="btn bad" data-action="delete-addon" data-slug="${r.slug}" data-id="${a.id}">Delete</button>
            </div>
          </div>`).join("") || empty("No add-ons yet")}
      </section>`;
  }

  function tablesPanel(r) {
    const base = location.href.split("#")[0];
    const mainLink = `${base}#/order?resto=${r.slug}`;
    const ownerLink = `${base}#/owner?resto=${r.slug}`;
    const mainQr = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(mainLink)}`;
    return `
      <section class="card">
        <div class="section-head"><div><h2>Main Restaurant QR</h2><p>Print this one QR for every table. Customer enters the table number after scanning.</p></div></div>
        <div class="split">
          <div>
            <img src="${mainQr}" alt="${esc(r.name)} QR" style="width:220px;max-width:100%;border:1px solid var(--line);border-radius:8px;background:#fff">
            <input value="${mainLink}" readonly style="margin-top:10px">
            <div class="row-left" style="margin-top:10px;flex-wrap:wrap">
              <button class="btn primary" data-action="print-qr">Print QR</button>
              <a class="btn blue" target="_blank" rel="noopener" href="${mainQr}">Save QR Image</a>
            </div>
          </div>
          <div class="info-panel">
            <strong>Recommended setup</strong>
            <p class="muted">One restaurant QR is easier to print, replace, and explain. Table number is typed by the customer before placing the order.</p>
            <a class="btn blue" href="${mainLink}">Open customer page</a>
            <div style="margin-top:14px">
              <strong>Owner login link</strong>
              <p class="muted">Share this with the restaurant owner to manage menu, kitchen, billing, and QR.</p>
              <input value="${ownerLink}" readonly>
            </div>
          </div>
        </div>
      </section>
      <section class="card" style="margin-top:14px">
        <div class="section-head"><div><h2>Optional Table QR Links</h2><p>Use these only if a restaurant asks for table-specific QR codes.</p></div></div>
        <div class="grid-2">
          ${field("Table Number", "table-no", "input", "7", "number")}
          ${field("Seats", "table-seats", "input", "4", "number")}
        </div>
        <button class="btn primary" data-action="add-table" data-slug="${r.slug}">Add Table</button>
      </section>
      <section class="grid-3" style="margin-top:14px">
        ${r.tables.map(t => {
          const link = `${base}#/order?resto=${r.slug}&table=${t.no}`;
          const qr = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(link)}`;
          return `<div class="card">
            <div class="section-head"><div><h3>Table ${t.no}</h3><p>${t.seats} seats</p></div><button class="btn bad" data-action="delete-table" data-slug="${r.slug}" data-table="${t.no}">Delete</button></div>
            <img src="${qr}" alt="Table ${t.no} QR" style="width:100%;max-width:190px;border:1px solid var(--line);border-radius:8px">
            <input value="${link}" readonly style="margin-top:10px">
          </div>`;
        }).join("")}
      </section>`;
  }

  function kitchenPanel(r) {
    const orders = state.orders.filter(o => o.restaurantSlug === r.slug && (o.paymentStatus === "paid" || o.paymentStatus === "cash_sent" || o.paymentStatus === "cash_accepted") && o.status !== "completed" && o.status !== "delivered");
    return `<section class="card">
      <div class="section-head"><div><h2>Kitchen</h2><p>Paid & cash-accepted orders appear here for preparation.</p></div></div>
      <div class="order-scroll-wrap">
        <div class="order-scroll">
          ${orders.map(o => orderCard(o)).join("") || empty("No active kitchen orders")}
        </div>
      </div>
    </section>`;
  }

  function billingPanel(r) {
    const active = state.orders.filter(o => o.restaurantSlug === r.slug && o.status !== "completed");

    // Group active orders by table number
    const tableMap = {};
    active.forEach(o => {
      if (!tableMap[o.table]) tableMap[o.table] = [];
      tableMap[o.table].push(o);
    });
    const tableGroups = Object.entries(tableMap).sort((a, b) => Number(a[0]) - Number(b[0]));

    // All completed orders, newest first
    const allCompleted = state.orders
      .filter(o => o.restaurantSlug === r.slug && o.status === "completed")
      .slice().reverse();

    // Unique dates for the date filter dropdown (YYYY-MM-DD)
    const uniqueDates = [...new Set(allCompleted.map(o => new Date(o.createdAt).toISOString().slice(0, 10)))];

    // Orders for the selected date
    const filtered = billingDateFilter
      ? allCompleted.filter(o => new Date(o.createdAt).toISOString().slice(0, 10) === billingDateFilter)
      : allCompleted;

    // Summary for selected date
    const upiTotal = filtered.filter(o => o.paymentStatus === "paid").reduce((s, o) => s + o.total, 0);
    const cashTotal = filtered.filter(o => o.paymentStatus === "cash_accepted").reduce((s, o) => s + o.total, 0);

    const dateLabel = billingDateFilter
      ? new Date(billingDateFilter + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
      : "All Time";

    return `
      <section class="card">
        <div class="section-head"><div><h2>Billing Counter</h2><p>Orders grouped by table — close the full table when done.</p></div></div>
        <div class="order-scroll-wrap">
          <div class="order-scroll">
            ${tableGroups.map(([table, orders]) => tableGroupCard(r, table, orders)).join("") || empty("No active bills")}
          </div>
        </div>
      </section>

      <section class="card" style="margin-top:14px">
        <div class="section-head">
          <div><h2>Closed Tables</h2><p>All completed orders — filter by date for verification.</p></div>
        </div>

        <div class="billing-filter-bar">
          <label>Filter by date:</label>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <input type="date" id="billing-date-picker" value="${billingDateFilter}"
              data-action="billing-date-pick"
              style="padding:7px 10px;border:1px solid var(--line,#e5e7eb);border-radius:8px;font-size:14px;background:var(--card,#fff);color:var(--text,#1a1a1a);cursor:pointer">
            <select id="billing-date-filter" data-action="billing-date-select"
              style="padding:7px 10px;border:1px solid var(--line,#e5e7eb);border-radius:8px;font-size:14px;background:var(--card,#fff)">
              <option value="">All Time</option>
              ${uniqueDates.map(d => {
                const label = new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
                return '<option value="' + d + '" ' + (d === billingDateFilter ? 'selected' : '') + '>' + label + '</option>';
              }).join("")}
            </select>
            ${billingDateFilter ? `<button class="btn" style="font-size:12px;padding:6px 10px" data-action="billing-date-clear">✕ Clear</button>` : ""}
          </div>
        </div>

        ${filtered.length ? `
          <div class="billing-summary">
            <div class="stat"><p>🔵 UPI Collected</p><strong>${filtered.filter(o => o.paymentStatus === "paid").length} orders · ₹${upiTotal.toLocaleString("en-IN")}</strong></div>
            <div class="stat"><p>💵 Cash Collected</p><strong>${filtered.filter(o => o.paymentStatus === "cash_accepted").length} orders · ₹${cashTotal.toLocaleString("en-IN")}</strong></div>
            <div class="stat"><p>📦 Total Orders</p><strong>${filtered.length} · ₹${(upiTotal + cashTotal).toLocaleString("en-IN")}</strong></div>
          </div>
          <div class="order-scroll-wrap">
            <div class="order-scroll closed">
              ${filtered.map(billCardClosed).join("")}
            </div>
          </div>
        ` : empty(billingDateFilter ? "No closed orders for " + dateLabel : "No closed orders yet")}
      </section>`;
  }

  function tableGroupCard(r, table, orders) {
    const grandTotal = orders.reduce((s, o) => s + o.total, 0);
    const allPaid = orders.every(o => o.paymentStatus === "paid" || o.paymentStatus === "cash_accepted");
    const anyWaiting = orders.some(o => o.paymentStatus === "waiting");
    const anyCashPending = orders.some(o => o.paymentStatus === "cash_pending");
    const anyCashSent = orders.some(o => o.paymentStatus === "cash_sent");
    const upiPaidCount = orders.filter(o => o.paymentStatus === "paid").length;
    const cashPaidCount = orders.filter(o => o.paymentStatus === "cash_accepted").length;
    const isSplitPayment = upiPaidCount > 0 && cashPaidCount > 0;

    // Waiting orders (UPI unverified) — only show UPI button for those
    const waitingIds = orders.filter(o => o.paymentStatus === "waiting").map(o => o.id).join(",");
    // Cash pending orders — only send those to kitchen
    const cashPendingIds = orders.filter(o => o.paymentStatus === "cash_pending").map(o => o.id).join(",");
    const cashSentIds = orders.filter(o => o.paymentStatus === "cash_sent").map(o => o.id).join(",");

    // Overall status label for the table
    const tableStatus = allPaid ? "ok" : anyCashSent ? "blue" : anyCashPending ? "warn" : "warn";
    const tableLabel = allPaid
      ? (isSplitPayment ? "✅ Split Paid (UPI + Cash)" : upiPaidCount ? "✅ UPI Paid" : "✅ Cash Received")
      : anyCashSent ? "🍳 In Kitchen – Cash Due"
      : anyCashPending ? "💵 Cash – Awaiting"
      : "⏳ Check Payment";

    // Merge all items across orders for the combined view
    const mergedItems = [];
    orders.forEach(o => {
      (o.items || []).forEach(i => {
        const existing = mergedItems.find(x => x.id === i.id);
        if (existing) existing.qty += i.qty;
        else mergedItems.push({ ...i });
      });
      (o.addons || []).forEach(a => {
        const existing = mergedItems.find(x => x.name === "+ " + a.name);
        if (existing) existing.qty += (a.qty || 1);
        else mergedItems.push({ id: "addon_" + a.id, name: "+ " + a.name, price: a.price, qty: a.qty || 1 });
      });
    });

    const orderIds = orders.map(o => o.id).join(",");

    return `<div class="list-item" style="border-left:3px solid ${allPaid ? "var(--ok,#2e7d32)" : anyCashSent ? "#1a73e8" : "#c4a96a"}">
      <div class="row">
        <div>
          <strong>Table ${table}</strong>
          <p class="muted small">${orders.length} order${orders.length > 1 ? "s" : ""} · ${new Date(orders[0].createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p>
        </div>
        <span class="pill ${tableStatus}">${tableLabel}</span>
      </div>

      <div style="margin-top:10px">
        ${mergedItems.map(i => `
          <div class="row small">
            <span>${esc(i.name)} × ${i.qty}</span>
            <span>${money(i.price * i.qty)}</span>
          </div>`).join("")}
      </div>

      ${orders.length > 1 ? `
        <div style="margin-top:8px;padding:8px;background:var(--bg,#f9f5ef);border-radius:8px">
          <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">Individual Orders</p>
          ${orders.map(o => `<p style="margin:2px 0;font-size:12px;color:var(--muted,#6b7280)">#${o.id.slice(-5).toUpperCase()} · ${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · ${money(o.total)} · <span style="color:${o.paymentStatus==="paid"||o.paymentStatus==="cash_accepted"?"var(--ok)":"#b5790c"}">${o.paymentStatus==="paid"?"UPI Paid":o.paymentStatus==="cash_accepted"?"Cash Received":o.paymentStatus==="cash_sent"?"In Kitchen":o.paymentStatus==="cash_pending"?"Cash Pending":"Pending"}</span></p>`).join("")}
        </div>` : ""}

      <div style="margin-top:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <strong style="font-size:16px">Total ${money(grandTotal)}</strong>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          ${anyWaiting ? `<button class="btn ok" data-action="mark-paid-table" data-ids="${waitingIds}">✓ UPI Paid (${waitingIds.split(",").length})</button>` : ""}
          ${anyCashPending ? `<button class="btn" style="background:#e8d9a0;border:1.5px solid #c4a96a;color:#7a5c1e;font-weight:600" data-action="accept-cash-table" data-ids="${cashPendingIds}">🍳 Send to Kitchen (${cashPendingIds.split(",").length})</button>` : ""}
          ${anyCashSent ? `<button class="btn ok" data-action="cash-received-table" data-ids="${cashSentIds}">💵 Cash Received</button>` : ""}
          ${allPaid ? `<button class="btn bad" data-action="close-table" data-ids="${orderIds}">Close Table</button>` : ""}
          <button class="btn" data-action="print-table-bill" data-ids="${orderIds}">🧾 Print Bill</button>
        </div>
      </div>
    </div>`;
  }

  function feedbackPanel(r) {
    const fbs = (state.feedbacks || []).filter(f => f.restaurantSlug === r.slug).reverse();
    const avg = fbs.length ? (fbs.reduce((s, f) => s + (f.stars || 0), 0) / fbs.length).toFixed(1) : "-";
    const stars = n => [1,2,3,4,5].map(i => i <= n ? "★" : "☆").join("");
    return `<section class="card">
      <div class="section-head">
        <div><h2>Customer Feedback</h2><p>${fbs.length} feedback${fbs.length !== 1 ? "s" : ""} · Avg rating ${avg}/5</p></div>
      </div>
      ${fbs.map(f => `
        <div class="list-item">
          <div class="row">
            <div>
              <span style="color:#ffba00;font-size:18px">${stars(f.stars)}</span>
              <p class="muted small" style="margin:4px 0 0">Table ${f.table} · Order #${f.orderId.slice(-5).toUpperCase()} · ${new Date(f.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p>
            </div>
            <span class="pill ${f.stars >= 4 ? "ok" : f.stars >= 3 ? "warn" : "bad"}">${f.stars}/5</span>
          </div>
          ${f.text ? `<p style="margin:8px 0 0;font-size:14px">"${esc(f.text)}"</p>` : ""}
        </div>`).join("") || empty("No feedback yet")}
    </section>`;
  }


  function analyticsPanel(r) {
    // Inject Chart.js from CDN if not already loaded
    if (!window._chartjsLoaded) {
      window._chartjsLoaded = true;
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js";
      s.onload = () => { window._chartjsReady = true; render(); };
      document.head.appendChild(s);
    }
    if (!window._chartjsReady) {
      return `<section class="card"><div class="empty">Loading charts...</div></section>`;
    }

    const allOrders = state.orders.filter(o => o.restaurantSlug === r.slug);
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear  = now.getFullYear();

    const selMonth = window._analyticsMonth != null ? window._analyticsMonth : currentMonth;
    const selYear  = window._analyticsYear  != null ? window._analyticsYear  : currentYear;

    // Months dropdown
    const monthsWithOrders = [];
    const seenM = new Set();
    allOrders.forEach(o => {
      const d = new Date(o.createdAt);
      const key = d.getFullYear() + "-" + d.getMonth();
      if (!seenM.has(key)) { seenM.add(key); monthsWithOrders.push({ year: d.getFullYear(), month: d.getMonth() }); }
    });
    monthsWithOrders.sort((a,b) => b.year - a.year || b.month - a.month);
    if (!monthsWithOrders.length) monthsWithOrders.push({ year: currentYear, month: currentMonth });

    // Filtered orders
    const orders = allOrders.filter(o => {
      const d = new Date(o.createdAt);
      return d.getMonth() === selMonth && d.getFullYear() === selYear;
    });
    const paidOrders   = orders.filter(o => o.paymentStatus === "paid" || o.paymentStatus === "cash_accepted");
    const totalRevenue = paidOrders.reduce((s,o) => s + o.total, 0);
    const upiRevenue   = orders.filter(o => o.paymentStatus === "paid").reduce((s,o) => s + o.total, 0);
    const cashRevenue  = orders.filter(o => o.paymentStatus === "cash_accepted").reduce((s,o) => s + o.total, 0);
    const avgOrderVal  = paidOrders.length ? Math.round(totalRevenue / paidOrders.length) : 0;

    // Items
    const itemMap = {};
    orders.forEach(o => {
      (o.items  || []).forEach(i => { itemMap[i.name] = (itemMap[i.name] || 0) + i.qty; });
      (o.addons || []).forEach(a => { itemMap[a.name] = (itemMap[a.name] || 0) + (a.qty || 1); });
    });
    const topItems = Object.entries(itemMap).sort((a,b) => b[1]-a[1]).slice(0,8);

    // Hours
    const hourMap = Array(24).fill(0);
    orders.forEach(o => { hourMap[new Date(o.createdAt).getHours()]++; });
    const peakHour   = hourMap.indexOf(Math.max(...hourMap));

    // Days of week
    const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const dayMap   = Array(7).fill(0);
    orders.forEach(o => { dayMap[new Date(o.createdAt).getDay()]++; });
    const busiestDay = dayNames[dayMap.indexOf(Math.max(...dayMap))];

    // Daily revenue
    const daysInMonth  = new Date(selYear, selMonth+1, 0).getDate();
    const dailyRevenue = Array(daysInMonth).fill(0);
    paidOrders.forEach(o => { dailyRevenue[new Date(o.createdAt).getDate()-1] += o.total; });

    // Tables
    const tableMap = {};
    orders.forEach(o => { tableMap[o.table] = (tableMap[o.table]||0)+1; });
    const topTables = Object.entries(tableMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const tableOrderCounts = Object.values(tableMap);
    const repeatTables = tableOrderCounts.filter(c=>c>1).length;

    // Feedback
    const feedbacks = (state.feedbacks||[]).filter(f => {
      if (f.restaurantSlug !== r.slug) return false;
      const d = new Date(f.createdAt);
      return d.getMonth()===selMonth && d.getFullYear()===selYear;
    });
    const avgRating = feedbacks.length ? (feedbacks.reduce((s,f)=>s+f.stars,0)/feedbacks.length) : 0;
    const starDist  = [5,4,3,2,1].map(s => ({ star:s, count: feedbacks.filter(f=>f.stars===s).length }));

    const monthLabel = new Date(selYear, selMonth, 1).toLocaleDateString("en-IN",{month:"long",year:"numeric"});

    // Unique chart IDs per render to avoid canvas reuse issues
    const uid = Date.now();
    const cRevenue  = "ch-revenue-"  + uid;
    const cHours    = "ch-hours-"    + uid;
    const cDays     = "ch-days-"     + uid;
    const cPayment  = "ch-payment-"  + uid;
    const cItems    = "ch-items-"    + uid;
    const cFeedback = "ch-feedback-" + uid;

    // Schedule chart draws after DOM is painted
    setTimeout(() => {
      if (!window.Chart) return;

      const defaults = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: {} } }
      };

      // 1. Daily Revenue Line Chart
      const elRev = document.getElementById(cRevenue);
      if (elRev) new Chart(elRev, {
        type: "line",
        data: {
          labels: Array.from({length:daysInMonth},(_,i)=>i+1),
          datasets: [{
            data: dailyRevenue,
            borderColor: "#8b4513",
            backgroundColor: "rgba(139,69,19,0.08)",
            fill: true,
            tension: 0.4,
            pointRadius: dailyRevenue.map(v=>v>0?3:0),
            pointBackgroundColor: "#8b4513"
          }]
        },
        options: { ...defaults, scales: {
          x: { grid:{display:false}, ticks:{font:{size:10}, maxTicksLimit:10} },
          y: { grid:{color:"#f0ebe3"}, ticks:{font:{size:10}, callback:v=>"₹"+v.toLocaleString("en-IN")} }
        }, plugins: { legend:{display:false}, tooltip:{ callbacks:{ label: ctx=>"₹"+ctx.raw.toLocaleString("en-IN") } } } }
      });

      // 2. Peak Hours Bar Chart
      const elHrs = document.getElementById(cHours);
      if (elHrs) new Chart(elHrs, {
        type: "bar",
        data: {
          labels: Array.from({length:24},(_,h)=> h===0?"12am": h<12?h+"am": h===12?"12pm":(h-12)+"pm"),
          datasets: [{
            data: hourMap,
            backgroundColor: hourMap.map((_,h)=> h===peakHour ? "#8b4513" : "rgba(139,69,19,0.2)"),
            borderRadius: 4
          }]
        },
        options: { ...defaults, scales: {
          x: { grid:{display:false}, ticks:{font:{size:9}, maxRotation:45} },
          y: { grid:{color:"#f0ebe3"}, ticks:{font:{size:10}, stepSize:1} }
        }, plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>ctx.raw+" orders" } } } }
      });

      // 3. Day of Week Bar Chart
      const elDays = document.getElementById(cDays);
      if (elDays) new Chart(elDays, {
        type: "bar",
        data: {
          labels: dayNames,
          datasets: [{
            data: dayMap,
            backgroundColor: dayMap.map((_,i)=> i===dayMap.indexOf(Math.max(...dayMap)) ? "#8b4513" : "rgba(139,69,19,0.2)"),
            borderRadius: 4
          }]
        },
        options: { ...defaults, scales: {
          x: { grid:{display:false}, ticks:{font:{size:11}} },
          y: { grid:{color:"#f0ebe3"}, ticks:{font:{size:10}, stepSize:1} }
        }, plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>ctx.raw+" orders" } } } }
      });

      // 4. Payment Doughnut
      const elPay = document.getElementById(cPayment);
      if (elPay && (upiRevenue||cashRevenue)) new Chart(elPay, {
        type: "doughnut",
        data: {
          labels: ["UPI","Cash"],
          datasets: [{
            data: [upiRevenue, cashRevenue],
            backgroundColor: ["#1a73e8","#c4a96a"],
            borderWidth: 2,
            borderColor: "#fff"
          }]
        },
        options: { ...defaults, cutout:"68%",
          plugins: { legend:{display:true, position:"bottom", labels:{font:{size:12}}},
            tooltip:{ callbacks:{ label:ctx=>"₹"+ctx.raw.toLocaleString("en-IN") } } } }
      });

      // 5. Top Items Horizontal Bar
      const elItm = document.getElementById(cItems);
      if (elItm && topItems.length) new Chart(elItm, {
        type: "bar",
        data: {
          labels: topItems.map(([n])=>n),
          datasets: [{
            data: topItems.map(([,q])=>q),
            backgroundColor: ["#2e7d32","#388e3c","#558b2f","#8b4513","#a0522d","#c4a96a","#9ca3af","#6b7280"],
            borderRadius: 4
          }]
        },
        options: { ...defaults, indexAxis:"y",
          scales: {
            x: { grid:{color:"#f0ebe3"}, ticks:{font:{size:10}, stepSize:1} },
            y: { grid:{display:false}, ticks:{font:{size:11}} }
          },
          plugins: { legend:{display:false}, tooltip:{ callbacks:{ label:ctx=>ctx.raw+" sold" } } } }
      });

      // 6. Star Rating Doughnut
      const elFb = document.getElementById(cFeedback);
      if (elFb && feedbacks.length) new Chart(elFb, {
        type: "doughnut",
        data: {
          labels: ["5★","4★","3★","2★","1★"],
          datasets: [{
            data: starDist.map(s=>s.count),
            backgroundColor: ["#2e7d32","#66bb6a","#c4a96a","#ef6c00","#c93333"],
            borderWidth: 2,
            borderColor: "#fff"
          }]
        },
        options: { ...defaults, cutout:"60%",
          plugins: { legend:{display:true, position:"bottom", labels:{font:{size:11}}},
            tooltip:{ callbacks:{ label:ctx=>ctx.label+" · "+ctx.raw+" reviews" } } } }
      });

    }, 80);

    return `
      <section class="card">
        <div class="section-head">
          <div><h2>📊 Analytics</h2><p>Business insights for ${monthLabel}</p></div>
          <select onchange="window._analyticsMonth=Number(this.value.split('-')[1]);window._analyticsYear=Number(this.value.split('-')[0]);document.querySelector('[data-action=owner-tab][data-tab=analytics]').click()"
            style="padding:7px 10px;border:1px solid var(--line,#e5e7eb);border-radius:8px;font-size:13px;background:var(--card,#fff)">
            ${monthsWithOrders.map(m => {
              const lbl = new Date(m.year,m.month,1).toLocaleDateString("en-IN",{month:"long",year:"numeric"});
              const val = m.year+"-"+m.month;
              return `<option value="${val}" ${m.month===selMonth&&m.year===selYear?"selected":""}>${lbl}</option>`;
            }).join("")}
          </select>
        </div>

        ${!orders.length ? `<div class="empty">No orders found for ${monthLabel}</div>` : `

        <!-- KPIs -->
        <div class="grid-4" style="margin-bottom:18px">
          ${stat("Total Orders", orders.length)}
          ${stat("Revenue", money(totalRevenue))}
          ${stat("Avg Order", money(avgOrderVal))}
          ${stat("Avg Rating", avgRating ? "⭐ "+avgRating.toFixed(1)+" / 5" : "—")}
        </div>

        <!-- Daily Revenue Line -->
        <div style="background:var(--bg,#f9f5ef);border-radius:12px;padding:16px;margin-bottom:14px">
          <p style="margin:0 0 12px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">📈 Daily Revenue — ${monthLabel}</p>
          <div style="position:relative;height:160px"><canvas id="${cRevenue}"></canvas></div>
        </div>

        <!-- Peak Hours + Day of Week -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div style="background:var(--bg,#f9f5ef);border-radius:12px;padding:16px">
            <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">🕐 Peak Hours</p>
            <p style="margin:0 0 10px;font-size:12px;color:var(--muted,#6b7280)">Busiest: <strong>${peakHour}:00–${peakHour+1}:00</strong></p>
            <div style="position:relative;height:140px"><canvas id="${cHours}"></canvas></div>
          </div>
          <div style="background:var(--bg,#f9f5ef);border-radius:12px;padding:16px">
            <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">📅 Orders by Day</p>
            <p style="margin:0 0 10px;font-size:12px;color:var(--muted,#6b7280)">Busiest: <strong>${busiestDay}</strong></p>
            <div style="position:relative;height:140px"><canvas id="${cDays}"></canvas></div>
          </div>
        </div>

        <!-- Payment Split + Feedback Rating -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
          <div style="background:var(--bg,#f9f5ef);border-radius:12px;padding:16px">
            <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">💳 Payment Split</p>
            <p style="margin:0 0 10px;font-size:12px;color:var(--muted,#6b7280)">UPI ${money(upiRevenue)} · Cash ${money(cashRevenue)}</p>
            <div style="position:relative;height:180px">
              ${upiRevenue||cashRevenue ? `<canvas id="${cPayment}"></canvas>` : `<p class="muted small" style="padding-top:40px;text-align:center">No paid orders</p>`}
            </div>
          </div>
          <div style="background:var(--bg,#f9f5ef);border-radius:12px;padding:16px">
            <p style="margin:0 0 4px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">⭐ Feedback Ratings</p>
            <p style="margin:0 0 10px;font-size:12px;color:var(--muted,#6b7280)">${feedbacks.length} reviews · Avg ${avgRating?avgRating.toFixed(1):"—"}</p>
            <div style="position:relative;height:180px">
              ${feedbacks.length ? `<canvas id="${cFeedback}"></canvas>` : `<p class="muted small" style="padding-top:40px;text-align:center">No feedback yet</p>`}
            </div>
          </div>
        </div>

        <!-- Top Items Horizontal Bar -->
        <div style="background:var(--bg,#f9f5ef);border-radius:12px;padding:16px;margin-bottom:14px">
          <p style="margin:0 0 12px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">🍽 Top Ordered Items</p>
          <div style="position:relative;height:${Math.max(topItems.length*36,100)}px">
            ${topItems.length ? `<canvas id="${cItems}"></canvas>` : `<p class="muted small">No items data</p>`}
          </div>
        </div>

        <!-- Busiest Tables + Order Health -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          <div style="background:var(--bg,#f9f5ef);border-radius:12px;padding:16px">
            <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">🪑 Busiest Tables</p>
            ${topTables.length ? topTables.map(([tbl,count],i)=>`
              <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--line,#e5e7eb)">
                <span style="font-size:13px">${i===0?"🥇":i===1?"🥈":i===2?"🥉":"  "} Table ${tbl}</span>
                <strong style="font-size:13px">${count} orders</strong>
              </div>`).join("") : `<p class="muted small">No data</p>`}
            <p style="margin:10px 0 0;font-size:12px;color:var(--muted,#6b7280)">🔁 ${repeatTables} tables ordered more than once</p>
          </div>
          <div style="background:var(--bg,#f9f5ef);border-radius:12px;padding:16px">
            <p style="margin:0 0 10px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">📦 Order Health</p>
            <div style="display:flex;flex-direction:column;gap:10px">
              ${[
                ["Placed", orders.length, "#8b4513"],
                ["Completed", paidOrders.length, "#2e7d32"],
                ["Still Open", orders.filter(o=>o.status!=="completed").length, "#c4a96a"]
              ].map(([label,val,color])=>`
                <div>
                  <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>${label}</span><strong>${val}</strong></div>
                  <div style="background:var(--line,#e5e7eb);border-radius:4px;height:8px;overflow:hidden">
                    <div style="width:${orders.length?Math.round(val/orders.length*100):0}%;height:100%;background:${color};border-radius:4px"></div>
                  </div>
                </div>`).join("")}
              <p style="margin:4px 0 0;font-size:13px">Completion rate: <strong>${orders.length?Math.round(paidOrders.length/orders.length*100):0}%</strong></p>
            </div>
          </div>
        </div>

        `}
      </section>`;
  }

  // ================================================================
  // STAFF DASHBOARD — sounds
  // ================================================================

  let staffAudioCtx = null;
  function ensureStaffAudio() {
    if (!staffAudioCtx) {
      try { staffAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { staffAudioCtx = null; }
    }
    if (staffAudioCtx && staffAudioCtx.state === "suspended") staffAudioCtx.resume();
    return staffAudioCtx;
  }
  // Double-pulse for waiter/bill requests
  function playWaiterAlertSound() {
    const ctx = ensureStaffAudio(); if (!ctx) return;
    const now = ctx.currentTime;
    [0, 0.18, 0.36, 0.54].forEach((t, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = i % 2 === 0 ? 1050 : 880;
      gain.gain.setValueAtTime(0, now+t); gain.gain.linearRampToValueAtTime(0.4, now+t+0.02); gain.gain.linearRampToValueAtTime(0, now+t+0.14);
      osc.connect(gain).connect(ctx.destination); osc.start(now+t); osc.stop(now+t+0.16);
    });
  }
  // Softer chime for new kitchen orders
  function playOrderChimeSound() {
    const ctx = ensureStaffAudio(); if (!ctx) return;
    const now = ctx.currentTime;
    [0, 0.22].forEach((t, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = i === 0 ? 660 : 880;
      gain.gain.setValueAtTime(0, now+t); gain.gain.linearRampToValueAtTime(0.3, now+t+0.02); gain.gain.linearRampToValueAtTime(0, now+t+0.2);
      osc.connect(gain).connect(ctx.destination); osc.start(now+t); osc.stop(now+t+0.22);
    });
  }

  function staffOrderFingerprint(o) {
    const itemQty  = (o.items  || []).reduce((s, i) => s + i.qty, 0);
    const addonQty = (o.addons || []).reduce((s, a) => s + (a.qty || 1), 0);
    return `${o.waiterRequest||""}:${o.total}:${itemQty}:${addonQty}:${o.status}:${o.paymentStatus}`;
  }

  function checkStaffAlerts(slug) {
    const orders = state.orders.filter(o => o.restaurantSlug === slug && o.status !== "completed");
    if (!staffAlertsInitialized) {
      orders.forEach(o => { staffSeenFingerprints[o.id] = staffOrderFingerprint(o); });
      staffAlertsInitialized = true;
      return;
    }
    let hasWaiterAlert = false, hasOrderUpdate = false;
    orders.forEach(o => {
      const fp = staffOrderFingerprint(o);
      const prev = staffSeenFingerprints[o.id];
      if (prev === undefined) { hasOrderUpdate = true; toast("🔔 New order — Table " + o.table); }
      else if (prev !== fp) {
        const prevWaiter = prev.split(":")[0], currWaiter = o.waiterRequest || "";
        if (currWaiter && prevWaiter !== currWaiter) { hasWaiterAlert = true; toast(currWaiter === "bill" ? "💳 Bill requested — Table " + o.table : "🔔 Waiter called — Table " + o.table); }
        else hasOrderUpdate = true;
      }
      staffSeenFingerprints[o.id] = fp;
    });
    const currentIds = new Set(orders.map(o => o.id));
    Object.keys(staffSeenFingerprints).forEach(id => { if (!currentIds.has(id)) delete staffSeenFingerprints[id]; });
    if (hasWaiterAlert) playWaiterAlertSound();
    else if (hasOrderUpdate) playOrderChimeSound();
  }

  // ================================================================
  // STAFF DASHBOARD — CSS (injected once)
  // ================================================================
  (function injectStaffStyles() {
    if (document.getElementById("staff-css")) return;
    const style = document.createElement("style");
    style.id = "staff-css";
    style.textContent = `
      /* ── STAFF SHELL ─────────────────────────────────────────────── */
      .staff-shell { min-height:100vh; background:#f5f0e8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }

      /* ── TOPBAR ──────────────────────────────────────────────────── */
      .staff-topbar {
        position:sticky; top:0; z-index:200;
        background:linear-gradient(135deg,#1c0e04 0%,#2e1a0a 100%);
        color:#f5ead8; display:flex; align-items:center;
        justify-content:space-between; padding:16px 20px; gap:12px;
        box-shadow:0 4px 24px rgba(0,0,0,.45);
      }
      .staff-topbar h1 { font-size:18px;font-weight:800;color:#f5ead8;margin:0;letter-spacing:-.01em; }
      .staff-topbar .staff-resto-name { font-size:10px;color:#c4a96a;margin:0 0 3px;letter-spacing:.08em;text-transform:uppercase;font-weight:700; }

      /* ── TAB BAR ─────────────────────────────────────────────────── */
      .staff-tab-bar {
        display:flex; background:#fff;
        border-bottom:2px solid #ede6d8;
        box-shadow:0 2px 8px rgba(42,26,14,.06);
      }
      .staff-tab-bar button {
        flex:1; padding:16px 8px; background:none; border:none;
        color:#a89880; font-size:14px; font-weight:700; cursor:pointer;
        letter-spacing:.01em; border-bottom:3px solid transparent;
        transition:all .18s; position:relative;
      }
      .staff-tab-bar button.active {
        color:#2a1a0e; border-bottom-color:#c4a96a; background:#fdf8f0;
      }
      .stab-badge {
        display:inline-flex; align-items:center; justify-content:center;
        background:#c0392b; color:#fff; border-radius:10px;
        font-size:10px; font-weight:800; padding:1px 5px;
        margin-left:4px; vertical-align:middle;
      }
      .stab-badge-hot { background:#e07a30; }

      /* ── BODY ────────────────────────────────────────────────────── */
      .staff-body { padding:16px 14px; padding-bottom:100px; }

      /* ── SECTION LABEL ───────────────────────────────────────────── */
      .staff-section-lbl {
        font-size:10px; font-weight:800; color:#a89880;
        text-transform:uppercase; letter-spacing:.1em;
        margin:20px 0 10px; padding-bottom:8px;
        border-bottom:1.5px solid #e8dcc8;
      }

      /* ── EMPTY STATE ─────────────────────────────────────────────── */
      .staff-empty { text-align:center; color:#a89880; padding:52px 20px; font-size:15px; }
      .staff-empty .se-icon { font-size:48px; margin-bottom:14px; display:block; }

      /* ── ORDER CARD ──────────────────────────────────────────────── */
      .s-order-card {
        background:#fff; border-radius:16px; padding:16px;
        margin-bottom:12px; border:1px solid #e8dcc8;
        box-shadow:0 2px 8px rgba(42,26,14,.06);
      }
      .s-order-card .oc-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
      .s-order-card .oc-table { font-size:20px; font-weight:800; color:#1c0e04; letter-spacing:-.01em; }
      .s-order-card .oc-id { font-size:11px; color:#a89880; margin-top:3px; }
      .s-order-card .oc-items { border-top:1px dashed #e8dcc8; padding-top:10px; margin-bottom:10px; }
      .s-order-card .oc-item-row { display:flex; justify-content:space-between; font-size:14px; padding:4px 0; color:#3a2510; }
      .s-order-card .oc-total { display:flex; justify-content:space-between; font-weight:800; font-size:16px; border-top:2px solid #e8dcc8; padding-top:10px; color:#1c0e04; margin-top:4px; }
      .s-order-card .oc-actions { display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; }
      .s-order-card .oc-note { font-size:12px; color:#a89880; background:#faf5ec; border-radius:8px; padding:8px 12px; margin:8px 0; border-left:3px solid #c4a96a; }

      /* ── STATUS PILLS ────────────────────────────────────────────── */
      .spill { display:inline-block; padding:4px 10px; border-radius:20px; font-size:11px; font-weight:700; letter-spacing:.02em; }
      .spill.green { background:#d4edda; color:#155724; }
      .spill.amber { background:#fff3cd; color:#7a5c1e; }
      .spill.red   { background:#f8d7da; color:#721c24; }
      .spill.blue  { background:#cce5ff; color:#004085; }
      .spill.gray  { background:#ede6d8; color:#5a4030; }

      /* ── ACTION BUTTONS ──────────────────────────────────────────── */
      .sbtn {
        flex:1; min-width:0; padding:13px 10px; border-radius:12px;
        font-size:13px; font-weight:700; border:none; cursor:pointer;
        transition:transform .12s, box-shadow .12s; text-align:center;
      }
      .sbtn:active { transform:scale(0.96); }
      .sbtn.primary { background:#c4a96a; color:#1c0e04; box-shadow:0 3px 10px rgba(196,169,106,.4); }
      .sbtn.ok      { background:#1e8a50; color:#fff; box-shadow:0 3px 10px rgba(30,138,80,.3); }
      .sbtn.danger  { background:#c0392b; color:#fff; box-shadow:0 3px 10px rgba(192,57,43,.3); }
      .sbtn.plain   { background:#f0e8d8; color:#5a4030; border:1.5px solid #d4c4a8; }

      /* ── WAITER ALERT ────────────────────────────────────────────── */
      .waiter-alert {
        background:linear-gradient(135deg,#c0392b,#9b2c1f);
        color:#fff; border-radius:14px; padding:14px 16px; margin-bottom:12px;
        display:flex; align-items:center; justify-content:space-between;
        gap:12px; box-shadow:0 4px 16px rgba(192,57,43,.35);
      }
      .waiter-alert .wa-info { flex:1; }
      .waiter-alert .wa-table { font-size:19px; font-weight:800; }
      .waiter-alert .wa-msg { font-size:12px; opacity:.85; margin-top:3px; }

      /* ── FLOOR PLAN ──────────────────────────────────────────────── */
      .floor-plan-wrap {
        background:linear-gradient(160deg,#180c04 0%,#2a1a0e 100%);
        border-radius:18px; padding:20px 16px 16px;
        border:2px solid #4a2f18;
        box-shadow:inset 0 2px 12px rgba(0,0,0,.5), 0 6px 28px rgba(0,0,0,.3);
        overflow:hidden; position:relative;
      }
      .floor-plan-svg { width:100%; display:block; cursor:pointer; }

      /* ── BOTTOM SHEET ────────────────────────────────────────────── */
      .tbl-sheet-bg {
        position:fixed; inset:0; background:rgba(20,10,4,.65);
        z-index:500; display:flex; align-items:flex-end;
        backdrop-filter:blur(4px);
      }
      .tbl-sheet {
        background:#fff; border-radius:26px 26px 0 0;
        padding:22px 20px 48px; width:100%; box-sizing:border-box;
        max-height:88vh; overflow-y:auto;
        box-shadow:0 -12px 48px rgba(0,0,0,.25);
      }
      .tbl-sheet-handle { width:44px; height:5px; background:#e0d5c5; border-radius:3px; margin:0 auto 20px; }

      /* ── SVG ELEMENTS ────────────────────────────────────────────── */
      .svg-table-no { fill:#c4a96a; font-size:11px; font-weight:800; font-family:-apple-system,sans-serif; text-anchor:middle; dominant-baseline:central; }
      .svg-amt { fill:#a08060; font-size:7px; font-weight:600; font-family:-apple-system,sans-serif; text-anchor:middle; dominant-baseline:central; }

      /* ── TABLE STATS ─────────────────────────────────────────────── */
      .tbl-stats { display:flex; gap:10px; margin-bottom:14px; }
      .tbl-stat { flex:1; background:#1c0e04; border-radius:12px; padding:12px 10px; text-align:center; border:1px solid #3a2010; }
      .tbl-stat .ts-num { font-size:22px; font-weight:800; }
      .tbl-stat .ts-lbl { font-size:10px; color:#7a5a38; text-transform:uppercase; letter-spacing:.07em; font-weight:700; margin-top:2px; }

      /* ── ANIMATIONS ──────────────────────────────────────────────── */
      @keyframes pulse-red { 0%,100%{box-shadow:0 0 0 3px rgba(231,76,60,.35);}50%{box-shadow:0 0 0 8px rgba(231,76,60,.08);} }
      @keyframes slide-up { from{transform:translateY(30px);opacity:0} to{transform:translateY(0);opacity:1} }
      .tbl-sheet { animation:slide-up .22s ease; }
    `;
    document.head.appendChild(style);
  })();

  // ================================================================
  // STAFF DASHBOARD — main view router
  // ================================================================
  function staffView(params) {
    injectStaffStyles_noop(); // styles already injected above at boot
    const slug = params.get("resto") || localStorage.getItem("restoqr_owner_slug") || (state.restaurants[0]?.slug || "");

    // No slug — show restaurant picker
    if (!slug) {
      const list = state.restaurants || [];
      if (list.length === 1) { location.replace("#/staff?resto=" + list[0].slug); return ""; }
      return `<div style="padding:32px 16px;font-family:sans-serif;max-width:400px;margin:0 auto">
        <h2 style="margin:0 0 16px;color:#2a1a0e">Select Restaurant</h2>
        ${list.map(rx => `<a href="#/staff?resto=${rx.slug}" style="display:block;padding:14px 18px;margin-bottom:10px;background:#fff;border:1.5px solid #e8dcc8;border-radius:12px;color:#2a1a0e;text-decoration:none;font-weight:600">${esc(rx.name)}</a>`).join("")}
      </div>`;
    }

    const resto = bySlug(slug);
    if (!resto) return `<div style="padding:40px;text-align:center;color:#9a8878;font-family:sans-serif">Restaurant not found. <a href="#/">Go home</a></div>`;

    // Check alerts on each render
    checkStaffAlerts(slug);

    if (!isStaffUnlocked(slug)) return staffLoginView(resto);
    return staffMainView(resto);
  }

  // no-op — styles injected at parse time above
  function injectStaffStyles_noop() {}

  // ================================================================
  // STAFF DASHBOARD — login view
  // ================================================================
  function staffLoginView(r) {
    const hasKey = !!(r.masterKeyHash);
    return `<div class="staff-shell">
      <div class="staff-topbar">
        <div><p class="staff-resto-name">${esc(r.name)}</p><h1>Staff Login</h1></div>
        <a href="#/owner?resto=${r.slug}" style="color:#c4a96a;font-size:12px;text-decoration:none">Owner ›</a>
      </div>
      <div class="staff-login-wrap">
        <div class="staff-login-card">
          <div style="font-size:40px;margin-bottom:12px;text-align:center">🔑</div>
          <h2 style="text-align:center;margin-bottom:6px">Staff Access</h2>
          ${hasKey ? `
            <p style="text-align:center;font-size:13px;color:#a89880;margin-bottom:18px">Enter the master key provided by the restaurant owner.</p>
            <input id="staff-key-input" class="staff-input" type="password" placeholder="Enter master key" autocomplete="off"
              onkeydown="if(event.key==='Enter')document.querySelector('[data-action=staff-login]').click()">
            <button class="sbtn primary" style="width:100%;margin-top:10px" data-action="staff-login" data-slug="${r.slug}">Enter Dashboard</button>
            <p style="text-align:center;font-size:11px;color:#c4a96a;margin-top:16px;opacity:.7">Unlocks Kitchen · Floor Plan · Billing</p>
          ` : `
            <p style="text-align:center;font-size:13px;color:#c0392b;font-weight:600;margin-bottom:0">No master key has been set yet.</p>
            <p style="text-align:center;font-size:12px;color:#a89880;margin-top:8px">Ask the owner to set one in<br>Owner Panel → Settings → Staff Dashboard.</p>
          `}
        </div>
      </div>
    </div>`;
  }

  // ================================================================
  // STAFF DASHBOARD — main dashboard
  // ================================================================
  function staffMainView(r) {
    const pendingAlerts = state.orders.filter(o => o.restaurantSlug === r.slug && o.waiterRequest && o.status !== "completed").length;
    const activeKitchen = state.orders.filter(o => o.restaurantSlug === r.slug && (o.paymentStatus==="paid"||o.paymentStatus==="cash_sent"||o.paymentStatus==="cash_accepted") && o.status !== "completed" && o.status !== "delivered").length;
    const activeOrders  = state.orders.filter(o => o.restaurantSlug === r.slug && o.status !== "completed").length;

    if (!["kitchen","resto","billing"].includes(staffTab)) staffTab = "kitchen";

    const tabs = [
      { id: "kitchen", label: "Kitchen" + (activeKitchen ? ` <span class="stab-badge">${activeKitchen}</span>` : "") },
      { id: "resto",   label: "Floor Plan" },
      { id: "billing", label: "Billing" + (activeOrders ? ` <span class="stab-badge stab-badge-hot">${activeOrders}</span>` : "") },
    ];

    let body = "";
    if (staffTab === "kitchen") body = staffKitchenView(r);
    if (staffTab === "resto")   body = staffRestoView(r);
    if (staffTab === "billing") body = staffBillingView(r);

    const sheet = staffSheetTable !== null ? staffTableSheetView(r, staffSheetTable) : "";

    return `<div class="staff-shell" id="staff-app">
      <div class="staff-topbar">
        <div>
          <p class="staff-resto-name">${esc(r.name)}</p>
          <h1>Staff Dashboard</h1>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${pendingAlerts ? `<div style="background:#e74c3c;color:#fff;border-radius:20px;padding:5px 14px;font-size:12px;font-weight:800;letter-spacing:.02em;animation:pulse-red 1.5s infinite">⚡ ${pendingAlerts} Alert${pendingAlerts>1?"s":""}</div>` : ""}
          <button class="sbtn plain" style="font-size:11px;padding:7px 12px;background:rgba(255,255,255,.08);color:#c4a96a;border-color:rgba(196,169,106,.3);border:1px solid rgba(196,169,106,.3)" data-action="staff-logout" data-slug="${r.slug}">Exit</button>
        </div>
      </div>
      <div class="staff-tab-bar">
        ${tabs.map(t => `<button class="${staffTab===t.id?"active":""}" data-action="staff-tab" data-tab="${t.id}">${t.label}</button>`).join("")}
      </div>
      <div class="staff-body">${body}</div>
      ${sheet}
    </div>`;
  }

  // ================================================================
  // STAFF DASHBOARD — waiter view (requests + active orders)
  // ================================================================
  function staffWaiterView(r) {
    const allActive = state.orders.filter(o => o.restaurantSlug === r.slug && o.status !== "completed");
    const alerts = allActive.filter(o => o.waiterRequest);
    const regularOrders = allActive.filter(o => !o.waiterRequest).sort((a,b) => b.createdAt - a.createdAt);

    let html = "";

    // Alert banner section
    if (alerts.length) {
      html += `<div class="staff-section-lbl" style="color:#e74c3c;border-color:#f5c6c6">⚡ Urgent — Customer Requests (${alerts.length})</div>`;
      alerts.forEach(o => {
        const isBill = o.waiterRequest === "bill";
        html += `<div style="background:${isBill?"#fff5f0":"#fff0f0"};border:2px solid ${isBill?"#e07a30":"#e74c3c"};border-radius:14px;padding:16px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start">
            <div>
              <div style="font-size:22px;font-weight:800;color:#2a1a0e">${isBill?"💳":"🔔"} Table ${o.table}</div>
              <div style="font-size:13px;color:#7a4030;margin-top:4px">${isBill?"Wants the bill":"Called the waiter"} · #${o.id.slice(-5).toUpperCase()} · ${money(o.total)}</div>
              <div style="font-size:11px;color:#9a8878;margin-top:2px">${new Date(o.createdAt).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})}</div>
            </div>
            <button class="sbtn ok" style="flex:none;padding:10px 16px;font-size:13px" data-action="staff-dismiss-waiter" data-id="${o.id}">✓ Done</button>
          </div>
          <div style="margin-top:12px;border-top:1px dashed #e8b8a8;padding-top:10px">
            ${(o.items||[]).map(i=>`<div style="display:flex;justify-content:space-between;font-size:13px;padding:2px 0;color:#3a2510"><span>${esc(i.name)} × ${i.qty}</span><span>${money(i.price*i.qty)}</span></div>`).join("")}
            ${(o.addons||[]).map(a=>`<div style="display:flex;justify-content:space-between;font-size:13px;padding:2px 0;color:#9a8878"><span>+ ${esc(a.name)} × ${a.qty||1}</span><span>${money(a.price*(a.qty||1))}</span></div>`).join("")}
            <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px;margin-top:6px;padding-top:6px;border-top:1px solid #e8dcc8;color:#2a1a0e"><span>Total</span><span>${money(o.total)}</span></div>
          </div>
        </div>`;
      });
    } else {
      html += `<div style="background:linear-gradient(135deg,#d4edda,#c3e6cb);border-radius:14px;padding:16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
        <div style="font-size:28px">✅</div>
        <div><div style="font-weight:700;color:#155724;font-size:15px">All clear</div><div style="font-size:13px;color:#1e7e34">No waiter requests right now</div></div>
      </div>`;
    }

    // Active orders overview
    if (regularOrders.length) {
      html += `<div class="staff-section-lbl" style="margin-top:6px">📋 Active Tables (${regularOrders.length})</div>`;
      // Group by table
      const tableMap = {};
      regularOrders.forEach(o => { if(!tableMap[o.table]) tableMap[o.table]=[]; tableMap[o.table].push(o); });
      Object.entries(tableMap).sort((a,b)=>Number(a[0])-Number(b[0])).forEach(([table, orders]) => {
        const total = orders.reduce((s,o)=>s+o.total,0);
        const statuses = orders.map(o=>o.status);
        const statusLabel = statuses.includes("ready") ? `<span class="spill green">🛎 Ready to serve</span>`
          : statuses.includes("preparing") ? `<span class="spill blue">👨‍🍳 Preparing</span>`
          : statuses.includes("pending") ? `<span class="spill amber">⏳ In kitchen</span>`
          : `<span class="spill gray">Payment pending</span>`;
        html += `<div class="s-order-card" style="border-left:4px solid #c4a96a">
          <div class="oc-head">
            <div>
              <div class="oc-table">Table ${table}</div>
              <div class="oc-id">${orders.length} order${orders.length>1?"s":""} · ${new Date(orders[0].createdAt).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})}</div>
            </div>
            ${statusLabel}
          </div>
          <div class="oc-items">
            ${orders.flatMap(o=>o.items||[]).reduce((acc,i)=>{const e=acc.find(x=>x.id===i.id);if(e)e.qty+=i.qty;else acc.push({...i});return acc;},[]).map(i=>`<div class="oc-item-row"><span>${esc(i.name)} × ${i.qty}</span><span style="color:#9a8878">${money(i.price*i.qty)}</span></div>`).join("")}
          </div>
          <div class="oc-total"><span>Table Total</span><span>${money(total)}</span></div>
        </div>`;
      });
    } else if (!alerts.length) {
      html += `<div class="staff-empty"><div class="se-icon">🪑</div>No active orders right now</div>`;
    }

    return html;
  }

  // ================================================================
  // STAFF DASHBOARD — tables view (SVG floor plan)
  // ================================================================
  function staffRestoView(r) {
    const orders = state.orders.filter(o => o.restaurantSlug === r.slug && o.status !== "completed");
    const tableCount = r.tableCount || r.tables.length || 6;
    const tableNos = Array.from({ length: tableCount }, (_, i) => i + 1);
    orders.forEach(o => { if (!tableNos.includes(o.table)) tableNos.push(o.table); });
    tableNos.sort((a, b) => a - b);

    const freeCount  = tableNos.filter(n => !orders.some(o => o.table===n)).length;
    const busyCount  = tableNos.filter(n => orders.some(o => o.table===n)).length;
    const alertCount = tableNos.filter(n => orders.some(o => o.table===n && o.waiterRequest)).length;

    // Alert banners
    const alerts = orders.filter(o => o.waiterRequest);
    let alertHtml = "";
    if (alerts.length) {
      alertHtml = `<div class="staff-section-lbl" style="color:#c0392b;border-color:#f5c6c6">⚡ Requests (${alerts.length})</div>`;
      alerts.forEach(o => {
        const isBill = o.waiterRequest === "bill";
        alertHtml += `<div class="waiter-alert" style="margin-bottom:10px">
          <div class="wa-info">
            <div class="wa-table">${isBill?"💳":"🔔"} Table ${o.table}</div>
            <div class="wa-msg">${isBill?"Bill requested":"Waiter called"} · ${money(o.total)}</div>
          </div>
          <button class="sbtn plain" style="flex:none;font-size:12px;padding:8px 14px;background:rgba(255,255,255,.15);color:#fff;border:1.5px solid rgba(255,255,255,.3)" data-action="staff-dismiss-waiter" data-id="${o.id}">✓ Done</button>
        </div>`;
      });
    }

    // Build SVG floor plan
    // Layout: grid of tables with chairs rendered as SVG
    const cols = Math.min(3, tableNos.length);
    const rows = Math.ceil(tableNos.length / cols);
    const TW = 72, TH = 50;   // table rect width/height
    const CW = 14, CH = 10;   // chair size
    const GAP_X = 52, GAP_Y = 60;
    const PAD = 28;
    const svgW = cols * (TW + GAP_X) + PAD * 2 - GAP_X + CW * 2 + 4;
    const svgH = rows * (TH + GAP_Y) + PAD * 2 - GAP_Y + CH * 2 + 4 + 40;

    let svgTables = "";
    tableNos.forEach((no, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const cx = PAD + col * (TW + GAP_X) + CW + 2;
      const cy = PAD + row * (TH + GAP_Y) + CH + 2 + 30;

      const tOrders = orders.filter(o => o.table === no);
      const occupied = tOrders.length > 0;
      const hasAlert = tOrders.some(o => o.waiterRequest);
      const total = tOrders.reduce((s, o) => s + o.total, 0);

      // Colors: red=occupied, brown/tan=free
      const tableFill = hasAlert ? "#8b0000" : occupied ? "#8b1a1a" : "#6b4226";
      const tableStroke = hasAlert ? "#ff4444" : occupied ? "#cc3333" : "#a0632a";
      const tableLightFill = hasAlert ? "#c0392b" : occupied ? "#a32929" : "#7a4f2e";
      const chairFill = hasAlert ? "#7a0000" : occupied ? "#7a1515" : "#5a3520";
      const chairStroke = hasAlert ? "#ff6666" : occupied ? "#b83232" : "#8a5530";
      const numColor = occupied ? "#ffcccc" : "#e8c9a0";
      const statusTxt = hasAlert ? (tOrders.find(o=>o.waiterRequest)?.waiterRequest==="bill"?"Bill":"Alert!")
        : occupied ? money(total) : "Free";
      const statusColor = hasAlert ? "#ff8080" : occupied ? "#ffaaaa" : "#c4a96a";

      // Chairs: top row (2), bottom row (2), left (1), right (1)
      const chairsTop = [TW*0.28, TW*0.72].map(ox =>
        `<rect x="${cx+ox-CW/2}" y="${cy-CH-2}" width="${CW}" height="${CH}" rx="3" fill="${chairFill}" stroke="${chairStroke}" stroke-width="1"/>`
      ).join("");
      const chairsBot = [TW*0.28, TW*0.72].map(ox =>
        `<rect x="${cx+ox-CW/2}" y="${cy+TH+2}" width="${CW}" height="${CH}" rx="3" fill="${chairFill}" stroke="${chairStroke}" stroke-width="1"/>`
      ).join("");
      const chairL = `<rect x="${cx-CW-2}" y="${cy+TH*0.35}" width="${CH}" height="${CW}" rx="3" fill="${chairFill}" stroke="${chairStroke}" stroke-width="1"/>`;
      const chairR = `<rect x="${cx+TW+2}" y="${cy+TH*0.35}" width="${CH}" height="${CW}" rx="3" fill="${chairFill}" stroke="${chairStroke}" stroke-width="1"/>`;

      // Alert pulse ring
      const alertRing = hasAlert ? `<rect x="${cx-3}" y="${cy-3}" width="${TW+6}" height="${TH+6}" rx="7" fill="none" stroke="#ff4444" stroke-width="2" opacity="0.6" style="animation:pulse-red 1.2s infinite"/>` : "";

      svgTables += `<g class="svg-table-grp" data-action="staff-open-table" data-table="${no}" style="cursor:pointer">
        ${chairsTop}${chairsBot}${chairL}${chairR}
        ${alertRing}
        <rect x="${cx}" y="${cy}" width="${TW}" height="${TH}" rx="5"
          fill="${tableFill}" stroke="${tableStroke}" stroke-width="1.5"/>
        <rect x="${cx}" y="${cy}" width="${TW}" height="16" rx="5"
          fill="${tableLightFill}"/>
        <rect x="${cx}" y="${cy+11}" width="${TW}" height="5" fill="${tableLightFill}"/>
        <text x="${cx+TW/2}" y="${cy+9}" class="svg-table-no" style="fill:${numColor};font-size:10px;font-weight:900;font-family:-apple-system,sans-serif;text-anchor:middle;dominant-baseline:central">${no}</text>
        <text x="${cx+TW/2}" y="${cy+33}" class="svg-amt" style="fill:${statusColor};font-size:9px;font-weight:700;font-family:-apple-system,sans-serif;text-anchor:middle;dominant-baseline:central">${statusTxt}</text>
      </g>`;
    });

    // Legend
    const legend = `
      <rect x="8" y="${svgH-22}" width="12" height="8" rx="2" fill="#8b1a1a" stroke="#cc3333" stroke-width="1"/>
      <text x="24" y="${svgH-15}" style="fill:#a08060;font-size:9px;font-family:-apple-system,sans-serif;dominant-baseline:central">Occupied</text>
      <rect x="90" y="${svgH-22}" width="12" height="8" rx="2" fill="#6b4226" stroke="#a0632a" stroke-width="1"/>
      <text x="106" y="${svgH-15}" style="fill:#a08060;font-size:9px;font-family:-apple-system,sans-serif;dominant-baseline:central">Free</text>
      <rect x="160" y="${svgH-22}" width="12" height="8" rx="2" fill="#8b0000" stroke="#ff4444" stroke-width="1"/>
      <text x="176" y="${svgH-15}" style="fill:#a08060;font-size:9px;font-family:-apple-system,sans-serif;dominant-baseline:central">Alert</text>
    `;

    // Room label
    const roomLabel = `<text x="${svgW/2}" y="18" style="fill:#6a4e30;font-size:11px;font-weight:700;font-family:-apple-system,sans-serif;text-anchor:middle;letter-spacing:0.12em;text-transform:uppercase">DINING AREA</text>
    <line x1="20" y1="26" x2="${svgW-20}" y2="26" stroke="#3a2010" stroke-width="1"/>`;

    const svgFloor = `<svg viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg" class="floor-plan-svg" style="touch-action:manipulation">
      <rect width="${svgW}" height="${svgH}" rx="12" fill="#1a0e06"/>
      <rect x="6" y="6" width="${svgW-12}" height="${svgH-12}" rx="10" fill="none" stroke="#3a2010" stroke-width="1.5" stroke-dasharray="4,4"/>
      ${roomLabel}
      ${svgTables}
      ${legend}
    </svg>`;

    const statsHtml = `<div class="tbl-stats">
      <div class="tbl-stat"><div class="ts-num" style="color:#c4a96a">${freeCount}</div><div class="ts-lbl">Free</div></div>
      <div class="tbl-stat"><div class="ts-num" style="color:#e87060">${busyCount}</div><div class="ts-lbl">Occupied</div></div>
      <div class="tbl-stat"><div class="ts-num" style="color:#ff6a5a">${alertCount}</div><div class="ts-lbl">Alerts</div></div>
    </div>`;

    return `${alertHtml}
    <div class="staff-section-lbl">🍽 Floor Plan — ${tableNos.length} Tables</div>
    ${statsHtml}
    <div class="floor-plan-wrap" style="padding:12px 10px">
      ${svgFloor}
    </div>
    <p style="text-align:center;color:#7a5a38;font-size:11px;margin:14px 0 0;letter-spacing:.05em">TAP A TABLE TO VIEW ORDER DETAILS</p>`;
  }

    // ================================================================
  // STAFF DASHBOARD — table bottom sheet (full billing panel)
  // ================================================================
  function staffTableSheetView(r, tableNo) {
    const orders = state.orders.filter(o => o.restaurantSlug === r.slug && o.table === tableNo && o.status !== "completed");
    const grandTotal = orders.reduce((s, o) => s + o.total, 0);
    const allPaid = orders.length > 0 && orders.every(o => o.paymentStatus === "paid" || o.paymentStatus === "cash_accepted");
    const anyWaiting = orders.some(o => o.paymentStatus === "waiting");
    const anyCashPending = orders.some(o => o.paymentStatus === "cash_pending");
    const anyCashSent = orders.some(o => o.paymentStatus === "cash_sent");
    const hasAlert = orders.some(o => o.waiterRequest);
    const orderIds = orders.map(o => o.id).join(",");
    const waitingIds = orders.filter(o => o.paymentStatus === "waiting").map(o => o.id).join(",");
    const cashPendingIds = orders.filter(o => o.paymentStatus === "cash_pending").map(o => o.id).join(",");
    const cashSentIds = orders.filter(o => o.paymentStatus === "cash_sent").map(o => o.id).join(",");

    // Merge all items across orders
    const merged = [];
    orders.forEach(o => {
      (o.items||[]).forEach(i => {
        const e = merged.find(x => x.id === i.id);
        if (e) e.qty += i.qty; else merged.push({...i});
      });
      (o.addons||[]).forEach(a => {
        const e = merged.find(x => x._aid === a.id);
        if (e) e.qty += (a.qty||1); else merged.push({id:"a_"+a.id,_aid:a.id,name:"+ "+a.name,price:a.price,qty:a.qty||1});
      });
    });

    // Status
    const statusLabel = orders.length === 0 ? { text:"Free", cls:"gray" }
      : allPaid        ? { text:"✓ Paid", cls:"green" }
      : anyCashSent    ? { text:"🍳 In Kitchen", cls:"blue" }
      : anyCashPending ? { text:"💵 Cash Pending", cls:"amber" }
      : anyWaiting     ? { text:"⏳ UPI Check", cls:"amber" }
      : { text:"No Order", cls:"gray" };

    // Payment breakdown
    const upiPaid = orders.filter(o => o.paymentStatus === "paid").reduce((s,o) => s+o.total, 0);
    const cashPaid = orders.filter(o => o.paymentStatus === "cash_accepted").reduce((s,o) => s+o.total, 0);
    const pending = grandTotal - upiPaid - cashPaid;

    const timeStr = orders.length ? new Date(Math.min(...orders.map(o=>o.createdAt))).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}) : "";

    return `<div class="tbl-sheet-bg" data-action="staff-close-sheet">
      <div class="tbl-sheet" onclick="event.stopPropagation()">
        <div class="tbl-sheet-handle"></div>

        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
          <div>
            <div style="font-size:11px;color:#a89880;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px">Table</div>
            <div style="font-size:36px;font-weight:900;color:#1c0e04;line-height:1;letter-spacing:-.02em">${tableNo}</div>
            ${timeStr ? `<div style="font-size:12px;color:#a89880;margin-top:3px">Since ${timeStr} · ${orders.length} order${orders.length!==1?"s":""}</div>` : ""}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
            <span class="spill ${statusLabel.cls}">${statusLabel.text}</span>
            <button class="sbtn plain" style="flex:none;padding:7px 12px;font-size:12px" data-action="staff-close-sheet">✕</button>
          </div>
        </div>

        <!-- Alert banner -->
        ${hasAlert ? `<div style="background:linear-gradient(135deg,#fff0ee,#fde8e4);border:2px solid #e74c3c;border-radius:14px;padding:14px 16px;margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div>
              <div style="font-size:15px;font-weight:800;color:#c0392b">${orders.find(o=>o.waiterRequest)?.waiterRequest==="bill"?"💳 Bill requested":"🔔 Waiter called"}</div>
              <div style="font-size:12px;color:#9a8878;margin-top:3px">Customer needs attention</div>
            </div>
            <button class="sbtn ok" style="flex:none;padding:9px 14px;font-size:13px" data-action="staff-dismiss-table-alert" data-ids="${orderIds}">✓ Done</button>
          </div>
        </div>` : ""}

        ${orders.length === 0
          ? `<div class="staff-empty" style="padding:32px 0"><div class="se-icon">🪑</div>Table is free — no active orders</div>`
          : `
        <!-- Bill items -->
        <div style="background:#faf5ec;border-radius:14px;padding:14px 16px;margin-bottom:14px">
          <div style="font-size:11px;font-weight:700;color:#a89880;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">Order Summary</div>
          ${merged.map(i => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #ede6d8">
              <div>
                <span style="font-size:14px;font-weight:600;color:#2a1a0e">${esc(i.name)}</span>
                <span style="font-size:13px;color:#a89880;margin-left:6px">× ${i.qty}</span>
              </div>
              <span style="font-size:14px;font-weight:700;color:#2a1a0e">${money(i.price * i.qty)}</span>
            </div>`).join("")}
          <div style="display:flex;justify-content:space-between;font-weight:900;font-size:18px;margin-top:12px;color:#1c0e04">
            <span>Total</span><span>${money(grandTotal)}</span>
          </div>
          ${(upiPaid > 0 || cashPaid > 0) ? `
          <div style="margin-top:8px;padding-top:8px;border-top:1px dashed #d4c4a8">
            ${upiPaid > 0 ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:#1a73e8;font-weight:600"><span>🔵 UPI Paid</span><span>${money(upiPaid)}</span></div>` : ""}
            ${cashPaid > 0 ? `<div style="display:flex;justify-content:space-between;font-size:12px;color:#27ae60;font-weight:600"><span>💵 Cash Received</span><span>${money(cashPaid)}</span></div>` : ""}
            ${pending > 0 ? `<div style="display:flex;justify-content:space-between;font-size:13px;color:#c0392b;font-weight:800;padding-top:6px;border-top:1px solid #e8dcc8;margin-top:6px"><span>⏳ Pending</span><span>${money(pending)}</span></div>` : ""}
          </div>` : ""}
        </div>

        <div style="background:#f0e8d8;border-radius:12px;padding:14px 16px;text-align:center">
          <p style="margin:0;font-size:12px;color:#7a5a38;font-weight:600">For billing actions, go to the <strong>Billing</strong> tab</p>
        </div>`}
      </div>
    </div>`;
  }


  // ================================================================
  // STAFF DASHBOARD — kitchen view
  // ================================================================
  function staffKitchenView(r) {
    const orders = state.orders.filter(o =>
      o.restaurantSlug === r.slug &&
      (o.paymentStatus==="paid" || o.paymentStatus==="cash_sent" || o.paymentStatus==="cash_accepted") &&
      o.status !== "completed" && o.status !== "delivered"
    ).sort((a, b) => { const rank={pending:0,preparing:1,ready:2}; return (rank[a.status]??3)-(rank[b.status]??3)||a.createdAt-b.createdAt; });

    if (!orders.length) return `<div class="staff-empty"><div class="se-icon">🍳</div>No orders to prepare right now</div>`;

    return orders.map(o => {
      const next = o.status==="pending"?"preparing":o.status==="preparing"?"ready":"delivered";
      const elapsed = Math.floor((Date.now()-o.createdAt)/60000);
      const borderColor = elapsed>15?"#e74c3c":elapsed>8?"#f39c12":"#27ae60";
      const pill = o.status==="preparing" ? `<span class="spill blue">Preparing</span>` : o.status==="ready" ? `<span class="spill green">Ready</span>` : `<span class="spill amber">Pending</span>`;
      return `<div class="s-order-card" style="border-left:4px solid ${borderColor}">
        <div class="oc-head"><div><div class="oc-table">Table ${o.table}</div><div class="oc-id">#${o.id.slice(-5).toUpperCase()} · ${elapsed} min ago</div></div>${pill}</div>
        <div class="oc-items">
          ${(o.items||[]).map(i=>`<div class="oc-item-row"><span style="font-weight:600">${esc(i.name)} <span style="color:#9a8878">× ${i.qty}</span></span></div>`).join("")}
          ${(o.addons||[]).map(a=>`<div class="oc-item-row" style="color:#9a8878"><span>+ ${esc(a.name)} × ${a.qty||1}</span></div>`).join("")}
        </div>
        ${o.note?`<div class="oc-note">📝 ${esc(o.note)}</div>`:""}
        <div class="oc-actions">
          ${next==="delivered"
            ?`<button class="sbtn ok" data-action="advance-order" data-id="${o.id}" data-next="${next}">✅ Mark Served</button>`
            :`<button class="sbtn primary" data-action="advance-order" data-id="${o.id}" data-next="${next}">${next==="preparing"?"👨‍🍳 Start Preparing":"🛎 Mark Ready"}</button>`}
        </div>
      </div>`;
    }).join("");
  }

  // ================================================================
  // STAFF DASHBOARD — billing view
  // ================================================================
  function staffBillingView(r) {
    const active = state.orders.filter(o => o.restaurantSlug === r.slug && o.status !== "completed");
    const tableMap = {};
    active.forEach(o => { if(!tableMap[o.table]) tableMap[o.table]=[]; tableMap[o.table].push(o); });
    const tableGroups = Object.entries(tableMap).sort((a,b)=>Number(a[0])-Number(b[0]));

    if (!tableGroups.length) return `<div class="staff-empty"><div class="se-icon">💳</div>No active bills right now</div>`;

    return tableGroups.map(([table, orders]) => {
      const grandTotal = orders.reduce((s,o)=>s+o.total,0);
      const allPaid = orders.every(o=>o.paymentStatus==="paid"||o.paymentStatus==="cash_accepted");
      const anyWaiting = orders.some(o=>o.paymentStatus==="waiting");
      const anyCashPending = orders.some(o=>o.paymentStatus==="cash_pending");
      const anyCashSent = orders.some(o=>o.paymentStatus==="cash_sent");
      const orderIds = orders.map(o=>o.id).join(",");
      const waitingIds = orders.filter(o=>o.paymentStatus==="waiting").map(o=>o.id).join(",");
      const cashPendingIds = orders.filter(o=>o.paymentStatus==="cash_pending").map(o=>o.id).join(",");
      const cashSentIds = orders.filter(o=>o.paymentStatus==="cash_sent").map(o=>o.id).join(",");

      const merged = [];
      orders.forEach(o => {
        (o.items||[]).forEach(i=>{ const e=merged.find(x=>x.id===i.id); if(e) e.qty+=i.qty; else merged.push({...i}); });
        (o.addons||[]).forEach(a=>{ const e=merged.find(x=>x._aid===a.id); if(e) e.qty+=(a.qty||1); else merged.push({id:"a_"+a.id,_aid:a.id,name:"+ "+a.name,price:a.price,qty:a.qty||1}); });
      });

      const borderColor = allPaid?"#27ae60":anyCashSent?"#2980b9":"#c4a96a";
      const statusLabel = allPaid?`<span class="spill green">✓ Paid</span>`:anyCashSent?`<span class="spill blue">In Kitchen</span>`:anyCashPending?`<span class="spill amber">Cash pending</span>`:`<span class="spill amber">Payment check</span>`;

      return `<div class="s-order-card" style="border-left:4px solid ${borderColor}">
        <div class="oc-head"><div><div class="oc-table">Table ${table}</div><div class="oc-id">${orders.length} order${orders.length>1?"s":""} · since ${new Date(orders[0].createdAt).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"})}</div></div>${statusLabel}</div>
        <div class="oc-items">${merged.map(i=>`<div class="oc-item-row"><span>${esc(i.name)} × ${i.qty}</span><span>${money(i.price*i.qty)}</span></div>`).join("")}</div>
        <div class="oc-total"><span>Total</span><span>${money(grandTotal)}</span></div>
        <div class="oc-actions">
          ${anyWaiting?`<button class="sbtn ok" data-action="staff-confirm-upi" data-ids="${waitingIds}">✓ UPI Paid</button>`:""}
          ${anyCashPending?`<button class="sbtn primary" data-action="staff-send-cash-kitchen" data-ids="${cashPendingIds}">🍳 Send to Kitchen</button>`:""}
          ${anyCashSent?`<button class="sbtn ok" data-action="staff-confirm-cash" data-ids="${cashSentIds}">💵 Cash Received</button>`:""}
          ${allPaid?`<button class="sbtn danger" data-action="staff-close-table" data-ids="${orderIds}">🔒 Close Table</button>`:""}
          <button class="sbtn plain" data-action="print-table-bill" data-ids="${orderIds}">🧾 Bill</button>
        </div>
      </div>`;
    }).join("");
  }
  // ================================================================
  // END STAFF DASHBOARD VIEWS
  // ================================================================

  function settingsPanel(r) {
    return `
      <section class="card" style="max-width:640px">
        <div class="section-head"><div><h2>Restaurant Settings</h2><p>These details show to customers.</p></div></div>
        <div class="grid-2">
          ${field("Restaurant Name", "set-name", "input", r.name)}
          ${field("Owner Name", "set-owner", "input", r.owner)}
          ${field("Phone", "set-phone", "input", r.phone)}
          ${field("UPI Display Name", "set-upi", "input", r.upiName || r.owner)}
          ${field("UPI ID (VPA)", "set-upiid", "input", r.upiId || "")}
          ${field("Google Review Link", "set-review", "input", r.googleReviewUrl || "")}
        </div>
        ${field("Payment QR Image URL", "set-qr", "input", r.paymentQr || DEFAULT_QR)}
        <div class="field">
          <label>Total Tables in Restaurant</label>
          <input id="set-table-count" type="number" min="1" max="100" value="${r.tableCount || r.tables.length || 4}" placeholder="e.g. 12" style="max-width:160px">
          <p class="muted small" style="margin:4px 0 0">Staff dashboard will display this many tables in the floor plan.</p>
        </div>
        ${firebaseMode ? `
          <div class="field">
            <label>Owner Login Email <span class="muted"></span></label>
            <input id="set-owner-email" type="email" placeholder="owner@email.com" value="${esc(r.ownerEmail || "")}">
           
          </div>` : ""}
        <button class="btn primary" data-action="save-settings" data-slug="${r.slug}">Save Settings</button>
        ${firebaseMode
          ? `<button class="btn" data-action="auth-signout">Sign Out</button>`
          : `<button class="btn" data-action="owner-logout" data-slug="${r.slug}">Logout</button>`}
      </section>

      <section class="card" style="max-width:640px;margin-top:14px">
        <div class="section-head">
          <div>
            <h2>Staff Dashboard</h2>
            <p>Set a master key — share it with your team to access all staff panels.</p>
          </div>
        </div>
        <div class="field">
          <label>${r.masterKeyHash ? "Change Master Key" : "Set Master Key"}</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="set-master-key" type="text" placeholder="${r.masterKeyHash ? "Enter new key to change it" : "Click Generate or type your own"}" autocomplete="new-password" style="flex:1">
            <button type="button" class="btn blue" onclick="(function(){
              const bytes = crypto.getRandomValues(new Uint8Array(18));
              const key = 'STF-' + Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('').toUpperCase().slice(0,24);
              const input = document.getElementById('set-master-key');
              if(input){ input.value = key; input.type = 'text'; }
            })()">Generate</button>
          </div>
          <p class="muted small" style="margin:6px 0 0">
            ${r.masterKeyHash
              ? `✅ A master key is already set. Leave blank to keep the existing key, or generate/type a new one to replace it.`
              : `⚠ No master key set yet. Set one before sharing the staff dashboard link.`}
          </p>
          <p class="muted small" style="margin:4px 0 0">The key is stored as a one-way hash — even you cannot read it back. Anyone with it can access Kitchen, Floor Plan, and Billing panels.</p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">
          <button class="btn primary" data-action="save-settings" data-slug="${r.slug}">Save Key</button>
          <a href="#/staff?resto=${r.slug}" class="btn">🛎 Open Staff Dashboard</a>
        </div>
      </section>

      <section class="card" style="max-width:640px;margin-top:14px;border:1.5px solid #f5c6c6">
        <div class="section-head"><div><h2 style="color:#c0392b">⚠ Danger Zone</h2><p>Permanently delete all orders for ${esc(r.name)}. Menu and settings are kept.</p></div></div>
        <p class="muted small">This will remove all orders — active, completed, and closed — from the database. This cannot be undone.</p>
        <button class="btn bad" data-action="clear-orders" data-slug="${r.slug}">🗑 Clear All Orders</button>
      </section>`;
  }

  // ================================================================
  // RESTOAI PANEL
  // ================================================================
  let _aiMessages = []; // conversation history for current session
  let _aiLoading  = false;

  function restoAiPanel(r) {
    const orders = state.orders.filter(o => o.restaurantSlug === r.slug);
    const hasOrders = orders.length > 0;

    return `<section class="card" style="max-width:700px">
      <div class="section-head">
        <div><h2>🤖 RestoAI</h2><p>Ask anything about your restaurant — orders, revenue, menu, trends.</p></div>
        ${_aiMessages.length ? `<button class="btn" data-action="ai-clear-chat" data-slug="${r.slug}" style="font-size:12px">Clear chat</button>` : ""}
      </div>

      ${!hasOrders ? `<div style="background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:12px 16px;margin-bottom:14px;font-size:13px;color:#7a5c1e">⚠ No orders yet — AI will only have menu and settings context for now.</div>` : ""}

      <!-- Chat history -->
      <div id="ai-chat-box" style="min-height:120px;max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-bottom:14px;padding-right:2px">
        ${_aiMessages.length === 0 ? `
          <div style="text-align:center;padding:32px 16px;color:#a89880">
            <div style="font-size:36px;margin-bottom:10px">🤖</div>
            <p style="font-weight:600;margin:0 0 6px;color:#2a1a0e">Hi! I'm RestoAI.</p>
            <p style="font-weight:600;margin:0 0 6px;color:#2a1a0e">To start conversion with me please enter Hii.</p>
            <p style="font-size:13px;margin:0">Ask me about your sales, best-selling items, peak hours, revenue — anything about ${esc(r.name)}.</p>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;padding:0 8px">
            ${[
              "What was my revenue today?",
              "Which item sells the most?",
              "How many orders this week?",
              "What's my busiest hour?",
              "Compare UPI vs cash payments"
            ].map(q => `<button class="btn" style="font-size:12px;padding:7px 12px" data-action="ai-quick" data-slug="${r.slug}" data-q="${esc(q)}">${esc(q)}</button>`).join("")}
          </div>` :
          _aiMessages.map(m => m.role === "user"
            ? `<div style="align-self:flex-end;background:#1c0e04;color:#f5ead8;border-radius:14px 14px 4px 14px;padding:10px 14px;max-width:80%;font-size:14px;line-height:1.5">${esc(m.content)}</div>`
            : `<div style="align-self:flex-start;background:#f5f0e8;border:1px solid #e8dcc8;border-radius:14px 14px 14px 4px;padding:10px 14px;max-width:88%;font-size:14px;line-height:1.6;color:#2a1a0e;white-space:pre-wrap">${esc(m.content)}</div>`
          ).join("")
        }
        ${_aiLoading ? `<div style="align-self:flex-start;background:#f5f0e8;border:1px solid #e8dcc8;border-radius:14px;padding:10px 16px;font-size:13px;color:#a89880">
          <span style="display:inline-flex;gap:4px;align-items:center">
            <span style="animation:ai-dot 1.2s infinite .0s;opacity:0">●</span>
            <span style="animation:ai-dot 1.2s infinite .2s;opacity:0">●</span>
            <span style="animation:ai-dot 1.2s infinite .4s;opacity:0">●</span>
          </span>
        </div>
        <style>@keyframes ai-dot{0%,80%,100%{opacity:0}40%{opacity:1}}</style>` : ""}
      </div>

      <!-- Input -->
      <div style="display:flex;gap:8px;align-items:flex-end">
        <textarea id="ai-input" placeholder="Ask about your restaurant…" rows="2"
          style="flex:1;resize:none;border:1.5px solid #e8dcc8;border-radius:12px;padding:10px 12px;font-size:14px;font-family:inherit;background:#faf5ec"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();document.querySelector('[data-action=ai-send]').click()}"
        ></textarea>
        <button class="btn primary" data-action="ai-send" data-slug="${r.slug}"
          style="padding:12px 18px;border-radius:12px;font-size:15px;align-self:stretch"
          ${_aiLoading ? "disabled" : ""}>
          ${_aiLoading ? "…" : "➤"}
        </button>
      </div>
    </section>`;
  }

  async function sendRestoAiMessage(slug, userMsg) {
    if (!userMsg.trim() || _aiLoading) return;
    const r = bySlug(slug);
    if (!r) return;

    // Fetch key directly from Firebase on demand — never stored in state
    let groqKey = "";
    try {
      if (firebaseMode && db) {
        const snap = await db.child("meta/groq-api").once("value");
        groqKey = snap.val() || "";
      } else {
        groqKey = state?.meta?.["groq-api"] || "";
      }
    } catch(e) {
      groqKey = "";
    }
    if (!groqKey) return toast("Groq API key not found in Firebase (restoqr/meta/groq-api)");

    // Build context snapshot for AI
    const orders = state.orders.filter(o => o.restaurantSlug === slug);
    const today  = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

    const paidOrders = orders.filter(o => o.paymentStatus === "paid" || o.paymentStatus === "cash_accepted");
    const todayOrders = paidOrders.filter(o => new Date(o.createdAt).toISOString().slice(0, 10) === today);
    const yesterdayOrders = paidOrders.filter(o => new Date(o.createdAt).toISOString().slice(0, 10) === yesterday);

    // Item frequency map
    const itemFreq = {};
    orders.forEach(o => (o.items || []).forEach(i => { itemFreq[i.name] = (itemFreq[i.name] || 0) + i.qty; }));
    const topItems = Object.entries(itemFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Hour map
    const hourMap = Array(24).fill(0);
    orders.forEach(o => { hourMap[new Date(o.createdAt).getHours()]++; });
    const peakHour = hourMap.indexOf(Math.max(...hourMap));

    const upiTotal  = paidOrders.filter(o => o.paymentStatus === "paid").reduce((s, o) => s + o.total, 0);
    const cashTotal = paidOrders.filter(o => o.paymentStatus === "cash_accepted").reduce((s, o) => s + o.total, 0);

    const systemPrompt = `You are RestoAI, a smart restaurant analytics assistant for "${r.name}" owned by ${r.owner} in ${r.city || "India"}.

Restaurant data snapshot (as of ${new Date().toLocaleString("en-IN")}):
- Menu items: ${r.menu.length} (${r.menu.filter(i => i.available).length} available)
- Menu: ${r.menu.map(i => `${i.name} (₹${i.price}, ${i.veg ? "veg" : "non-veg"}, ${i.available ? "available" : "hidden"})`).join(", ")}
- Categories: ${r.categories.join(", ")}
- Add-ons: ${(r.addons || []).map(a => `${a.name} ₹${a.price}`).join(", ") || "none"}
- Tables: ${r.tableCount || r.tables.length}

Orders summary:
- Total orders ever: ${orders.length}
- Paid orders: ${paidOrders.length}
- Total UPI revenue: ₹${upiTotal.toLocaleString("en-IN")}
- Total cash revenue: ₹${cashTotal.toLocaleString("en-IN")}
- Grand total revenue: ₹${(upiTotal + cashTotal).toLocaleString("en-IN")}
- Today's orders (${today}): ${todayOrders.length} orders, ₹${todayOrders.reduce((s, o) => s + o.total, 0).toLocaleString("en-IN")}
- Yesterday's orders (${yesterday}): ${yesterdayOrders.length} orders, ₹${yesterdayOrders.reduce((s, o) => s + o.total, 0).toLocaleString("en-IN")}
- Top 10 items by qty sold: ${topItems.map(([n, q]) => `${n} (${q})`).join(", ") || "no data"}
- Peak hour: ${peakHour}:00–${peakHour + 1}:00
- Average order value: ₹${paidOrders.length ? Math.round((upiTotal + cashTotal) / paidOrders.length) : 0}

Answer in clear, concise English. Use ₹ for currency. Be direct and helpful. If asked for suggestions, give practical advice for a small Indian restaurant.`;

    _aiMessages.push({ role: "user", content: userMsg });
    _aiLoading = true;
    ownerTab = "ai";
    render();

    // Scroll chat to bottom after render
    setTimeout(() => {
      const box = document.getElementById("ai-chat-box");
      if (box) box.scrollTop = box.scrollHeight;
    }, 50);

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + groqKey },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          max_tokens: 512,
          messages: [
            { role: "system", content: systemPrompt },
            ..._aiMessages
          ]
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "Groq error");
      const reply = data.choices?.[0]?.message?.content || "Sorry, I couldn't get a response.";
      _aiMessages.push({ role: "assistant", content: reply });
    } catch (err) {
      _aiMessages.push({ role: "assistant", content: "⚠ Error: " + err.message });
    }

    _aiLoading = false;
    render();
    setTimeout(() => {
      const box = document.getElementById("ai-chat-box");
      if (box) box.scrollTop = box.scrollHeight;
    }, 50);
  }

  function customerView(params) {
    const slug = params.get("resto") || (state.restaurants[0]?.slug || "");
    const r = bySlug(slug);
    if (!r) return customerShell("Restaurant unavailable", `<div class="empty">Restaurant not found.</div>`);
    if (!isRestaurantOpen(r)) {
      return customerShell(r.name, `<div class="empty">Ordering is currently unavailable. Please contact the counter.</div>`);
    }
    const table = Number(params.get("table")) || "";
    const lastOrder = state.orders.find(o => o.id === localStorage.getItem("restoqr_last_order_" + r.slug));
    // Once the kitchen marks the order delivered (or billing later closes it), show the
    // completed/review screen instead of the live tracking view.
    if (lastOrder && lastOrder.status !== "completed" && lastOrder.status !== "delivered") {
      return customerShell(r.name, customerOrderTrackingView(r, lastOrder));
    }
    if (!customerCat) customerCat = r.categories[0] || unique(r.menu.map(i => i.category))[0] || "";
    const items = r.menu.filter(i => i.available && i.category === customerCat);
    const total = cartTotal(r);
    return `
      <div class="customer-shell">
        <div class="customer-head"><p>${esc(r.name)}</p><h1>Table Ordering</h1></div>
        <div style="padding:12px 14px;border-bottom:1px solid var(--line)" class="row">
          <span class="muted">Table number</span>
          <input class="table-box" id="customer-table" value="${table}" type="number" min="1">
        </div>
        ${lastOrder && (lastOrder.status === "completed" || lastOrder.status === "delivered") ? customerStatusCard(r, lastOrder) : ""}
        <div class="cat-strip">${unique(r.menu.map(i => i.category)).map(c => `<button class="${c === customerCat ? "active" : ""}" data-action="customer-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
        <div style="padding-bottom:${(cartCount() || addonCartCount()) ? "160px" : "80px"}">
          ${items.map(i => customerItem(r, i)).join("") || empty("No items available")}
          ${r.addons.filter(a => a.active).length ? `
            <div style="padding:10px 14px 4px;border-top:1px solid var(--line);margin-top:8px">
              <p style="font-size:12px;font-weight:600;color:var(--muted,#6b7280);margin:0 0 6px;text-transform:uppercase;letter-spacing:.05em">Add-ons</p>
              ${r.addons.filter(a => a.active).map(a => customerAddonItem(a)).join("")}
            </div>` : ""}
        </div>
        ${(cartCount() || addonCartCount()) ? checkoutBox(r, total) : ""}
      </div>`;
  }

  function customerItem(r, i) {
    const q = cart[i.id] || 0;
    const dotStyle = `color:${i.veg ? "var(--ok)" : "var(--bad)"}`;
    return `<div class="customer-item">
      <div><strong><span style="${dotStyle}">●</span> ${esc(i.name)}</strong><p class="muted small">${money(i.price)}</p></div>
      ${q ? `<div class="qty"><button data-action="cart-dec" data-id="${i.id}">-</button><strong>${q}</strong><button class="plus" data-action="cart-inc" data-id="${i.id}">+</button></div>` : `<button class="btn primary" data-action="cart-inc" data-id="${i.id}">Add</button>`}
    </div>`;
  }

  function customerAddonItem(a) {
    const q = selectedAddons[a.id] || 0;
    return `<div class="customer-item">
      <div><strong>+ ${esc(a.name)}</strong><p class="muted small">${money(a.price)}</p></div>
      ${q ? `<div class="qty"><button data-action="addon-dec" data-id="${a.id}">-</button><strong>${q}</strong><button class="plus" data-action="addon-inc" data-id="${a.id}">+</button></div>` : `<button class="btn primary" data-action="addon-inc" data-id="${a.id}">Add</button>`}
    </div>`;
  }

  function checkoutBox(r, total) {
    const pa = encodeURIComponent(r.upiId || "");
    const pn = encodeURIComponent(r.upiName || r.name);
    const addonTotal = Object.entries(selectedAddons).reduce((s, [id, qty]) => {
      const a = find(r.addons, id);
      return s + (a ? a.price * qty : 0);
    }, 0);
    const grand = total + addonTotal;
    const selectedAddonList = Object.entries(selectedAddons).map(([id, qty]) => { const a = find(r.addons, id); return a ? {...a, qty} : null; }).filter(Boolean);

    return `<div class="cart-bar" style="position:fixed;bottom:0;left:0;right:0;z-index:100;display:flex;flex-direction:column;max-height:55vh;box-shadow:0 -4px 24px rgba(0,0,0,0.12);">

      <div class="cart-scrollable" style="overflow-y:auto;flex:1;min-height:0;padding-bottom:4px">
        <div class="cart-summary">
          ${Object.entries(cart).map(([id, qty]) => {
            const m = find(r.menu, id);
            return m ? `<div class="cart-row"><span>${esc(m.name)} × ${qty}</span><span>${money(m.price * qty)}</span></div>` : "";
          }).join("")}
          ${selectedAddonList.map(a => `<div class="cart-row"><span>+ ${esc(a.name)} × ${a.qty}</span><span>${money(a.price * a.qty)}</span></div>`).join("")}
          <div class="cart-row cart-total"><span>Total</span><strong>${money(grand)}</strong></div>
        </div>

        <textarea id="order-note" placeholder="Special instructions (optional)" rows="2" style="width:100%;margin:8px 0 8px;box-sizing:border-box"></textarea>

        <p class="muted small" style="margin-bottom:8px">
          Pay <strong>${money(grand)}</strong> to <strong>${esc(r.upiName || r.owner)}</strong>
        </p>

        <div style="display:flex;gap:10px;margin-bottom:4px">
          <a href="${r.upiId ? `phonepe://pay?pa=${pa}&pn=${pn}&am=${grand}&cu=INR` : `phonepe://`}"
             style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;border-radius:10px;background:#5f259f;color:#fff;font-weight:600;text-decoration:none;font-size:15px">
            🟣 PhonePe
          </a>
          <a href="${r.upiId ? `tez://upi/pay?pa=${pa}&pn=${pn}&am=${grand}&cu=INR` : `tez://`}"
             style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px;border-radius:10px;background:#1a73e8;color:#fff;font-weight:600;text-decoration:none;font-size:15px">
            🔵 GPay
          </a>
        </div>
        ${!r.upiId ? `<p style="color:#c93333;font-size:12px;margin:4px 0">⚠ UPI ID not set — add in Settings.</p>` : ""}

        <div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--line,#e5e7eb)">
          <p style="font-size:11px;color:var(--muted,#9ca3af);margin:0 0 6px;text-align:center">OR</p>
          <button class="btn block" data-action="place-order-cash" data-slug="${r.slug}"
            style="background:#f5f0e8;border:1.5px solid #c4a96a;color:#7a5c1e;font-weight:600;display:flex;align-items:center;justify-content:center;gap:8px;padding:13px">
            💵 I'll Pay in Cash at Counter
          </button>
        </div>
      </div>

      <div style="flex-shrink:0;padding-top:10px;border-top:1px solid var(--line,#e5e7eb)">
        <button class="btn primary block" data-action="place-order" data-slug="${r.slug}">
          ✓ I Paid · Confirm Order
        </button>
      </div>

    </div>`;
  }

  function customerOrderTrackingView(r, o) {
    const statusSteps = ["payment_check", "pending", "preparing", "ready", "completed"];
    const stepLabels  = ["Payment Check", "Confirmed", "Preparing", "Ready", "Delivered"];
    const currentStep = statusSteps.indexOf(o.status);
    const statusColor = { payment_check: "#b5790c", pending: "#3e4e7a", preparing: "#8b4513", ready: "#2e7d32", completed: "#2e7d32" };
    const color = statusColor[o.status] || "#3e4e7a";
    const trackColor = "#ead9bd";
    const headerStyle = `background:${color}15;border:1.5px solid ${color};border-radius:12px;padding:16px;margin-bottom:16px`;
    const badgeStyle = `background:${color};color:#fff;padding:5px 12px;border-radius:20px;font-size:13px;font-weight:600`;
    return `
      <div style="padding:16px 14px">

        <div style="${headerStyle}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div>
              <p style="margin:0;font-size:12px;color:var(--muted,#6b7280);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Order #${o.id.slice(-5).toUpperCase()}</p>
              <p style="margin:2px 0 0;font-size:13px;color:var(--muted,#6b7280)">Table ${o.table} · ${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p>
            </div>
            <span style="${badgeStyle}">${stepLabels[Math.max(0, currentStep)] || "Active"}</span>
          </div>

          <div style="display:flex;align-items:center;gap:0;margin:12px 0 4px">
            ${statusSteps.slice(0, -1).map((s, i) => {
              const barStyle = `flex:1;height:4px;border-radius:2px;background:${i <= currentStep ? color : trackColor}`;
              const dotStyle = `width:8px;height:8px;border-radius:50%;background:${i <= currentStep ? color : trackColor};flex-shrink:0`;
              return `
              <div style="${barStyle}"></div>
              ${i < statusSteps.length - 2 ? `<div style="${dotStyle}"></div>` : ""}
            `;
            }).join("")}
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:6px">
            ${stepLabels.slice(0, -1).map((l, i) => {
              const labelStyle = `font-size:10px;color:${i <= currentStep ? color : "var(--muted,#9ca3af)"};font-weight:${i === currentStep ? "700" : "400"}`;
              return `<span style="${labelStyle}">${l}</span>`;
            }).join("")}
          </div>
        </div>

        <div style="background:var(--card,#fff);border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:14px;margin-bottom:14px">
          <p style="margin:0 0 10px;font-weight:600;font-size:14px">Your Order</p>
          ${(o.items || []).map(i => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--line,#f3f4f6)">
              <span style="font-size:14px">${esc(i.name)} <span style="color:var(--muted,#6b7280)">× ${i.qty}</span></span>
              <span style="font-size:14px;font-weight:500">${money(i.price * i.qty)}</span>
            </div>`).join("")}
          ${(o.addons || []).length ? `
            <p style="margin:10px 0 6px;font-size:12px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em">Add-ons</p>
            ${o.addons.map(a => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--line,#f3f4f6)">
                <span style="font-size:14px">+ ${esc(a.name)}</span>
                <span style="font-size:14px;font-weight:500">${money(a.price)}</span>
              </div>`).join("")}` : ""}
          ${o.note ? `<p style="margin:10px 0 0;font-size:13px;color:var(--muted,#6b7280)">📝 ${esc(o.note)}</p>` : ""}
          <div style="display:flex;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:2px solid var(--line,#e5e7eb)">
            <span style="font-weight:700">Total</span>
            <span style="font-weight:700;font-size:16px">${money(o.total)}</span>
          </div>
        </div>

        <p style="text-align:center;font-size:13px;color:var(--muted,#6b7280);margin:0 0 16px">
          ${o.paymentStatus === "cash_pending" ? "💵 Please pay cash at the billing counter. Waiting for counter..." :
            o.paymentStatus === "cash_sent" ? "✅ Counter sent your order to kitchen! Please pay cash when served." :
            o.paymentStatus === "cash_accepted" ? "✅ Cash received. Enjoy your meal!" :
            o.paymentStatus === "waiting" ? "⏳ Waiting for payment verification by counter..." :
            o.status === "preparing" ? "👨‍🍳 Your food is being prepared!" :
            o.status === "ready" ? "🛎 Your order is ready! Counter will serve you shortly." : "✅ Payment verified. Order confirmed!"}
        </p>

        <button class="btn block" style="width:100%;margin-bottom:10px" data-action="refresh-order" data-slug="${r.slug}">↻ Refresh Status</button>
        <button class="btn block" style="width:100%;color:var(--muted,#6b7280)" data-action="dismiss-review" data-slug="${r.slug}">+ Order More Items</button>

        <div style="background:var(--card,#fff);border:1px solid var(--line,#e5e7eb);border-radius:12px;padding:14px;margin-top:14px">
          <p style="margin:0 0 10px;font-weight:600;font-size:14px">💬 Share Feedback</p>
          <p class="muted small" style="margin:0 0 10px">Rate your experience — sent directly to the kitchen and counter.</p>
          <div style="display:flex;gap:8px;margin-bottom:10px" id="star-row">
            ${[1,2,3,4,5].map(n => `<button data-action="set-star" data-star="${n}" data-order="${o.id}" style="font-size:26px;background:none;border:none;cursor:pointer;padding:0;line-height:1">☆</button>`).join("")}
          </div>
          <textarea id="feedback-text" placeholder="What did you love? What can we improve?" rows="3" style="width:100%;box-sizing:border-box;margin-bottom:10px;border:1px solid var(--line,#e5e7eb);border-radius:8px;padding:8px;font-size:14px"></textarea>
          <button class="btn primary block" data-action="submit-feedback" data-slug="${r.slug}" data-order="${o.id}" data-table="${o.table}">Send Feedback</button>
        </div>
      </div>`;
  }

  function customerStatusCard(r, o) {
    const delivered = o.status === "completed" || o.status === "delivered";
    const label = delivered ? "Delivered" : title(o.paymentStatus === "waiting" ? "payment check" : o.status);
    return `<div class="review-card">
      <div class="row">
        <div><strong>Order #${o.id.slice(-5).toUpperCase()}</strong><p class="muted small">Table ${o.table} · ${label}</p></div>
        <span class="pill ${delivered ? "ok" : "blue"}">${delivered ? "Delivered" : "Active"}</span>
      </div>
      ${delivered ? `
        <p>How was your experience at ${esc(r.name)}?</p>
        <div class="row-left">
          ${r.googleReviewUrl ? `<a class="btn primary" target="_blank" rel="noopener" href="${esc(r.googleReviewUrl)}">Review on Google</a>` : `<span class="pill warn">Review link not added</span>`}
          <button class="btn" data-action="dismiss-review" data-slug="${r.slug}">Order Again</button>
        </div>` : `<p class="muted small">Your order will move to kitchen after counter verifies PhonePe payment.</p>`}
    </div>`;
  }

  function orderCard(o) {
    const next = o.status === "pending" ? "preparing" : o.status === "preparing" ? "ready" : "delivered";
    return `<div class="list-item">
      <div class="row"><div><strong>Table ${o.table}</strong><p class="muted small">#${o.id.slice(-5).toUpperCase()} · ${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p></div><span class="pill blue">${title(o.status)}</span></div>
      ${orderLines(o)}
      ${o.note ? `<p class="pill warn">Note: ${esc(o.note)}</p>` : ""}
      <div class="row" style="margin-top:10px"><strong>${money(o.total)}</strong><button class="btn ok" data-action="advance-order" data-id="${o.id}" data-next="${next}">${next === "delivered" ? "✅ Mark Delivered" : "Mark " + title(next)}</button></div>
    </div>`;
  }

  function billCard(o) {
    const isCashPending = o.paymentStatus === "cash_pending";
    const isCashSent = o.paymentStatus === "cash_sent";
    const isCashAccepted = o.paymentStatus === "cash_accepted";
    const isPaid = o.paymentStatus === "paid";
    const pillClass = isPaid || isCashAccepted ? "ok" : isCashSent ? "blue" : "warn";
    const pillLabel = isPaid ? "UPI Paid" : isCashAccepted ? "💵 Cash Received" : isCashSent ? "🍳 In Kitchen – Cash Due" : isCashPending ? "💵 Cash – Awaiting" : "Check Payment";
    const cashBorder = isCashPending ? "border-left:3px solid #c4a96a" : isCashSent ? "border-left:3px solid #1a73e8" : "";
    return `<div class="list-item" style="${cashBorder}">
      <div class="row"><div><strong>Table ${o.table}</strong><p class="muted small">Order #${o.id.slice(-5).toUpperCase()} · ${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p></div><div class="row-left">${o.status === "delivered" ? `<span class="pill ok">🍽 Served</span>` : ""}<span class="pill ${pillClass}">${pillLabel}</span></div></div>
      ${orderLines(o)}
      <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;overflow-x:auto;min-width:0"><strong style="white-space:nowrap">Total ${money(o.total)}</strong><div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        ${o.paymentStatus === "waiting" ? `<button class="btn ok" data-action="mark-paid" data-id="${o.id}">✓ Payment Received</button>` : ""}
        ${isCashPending ? `<button class="btn" style="background:#e8d9a0;border:1.5px solid #c4a96a;color:#7a5c1e;font-weight:600" data-action="accept-cash" data-id="${o.id}">🍳 Send to Kitchen</button>` : ""}
        ${isCashSent ? `<button class="btn ok" data-action="cash-received" data-id="${o.id}">💵 Cash Received</button>` : ""}
        ${isPaid || isCashAccepted ? `<button class="btn bad" data-action="close-order" data-id="${o.id}">Close</button>` : ""}
        <button class="btn" data-action="reprint-bill" data-id="${o.id}">🧾 Print Bill</button>
      </div></div>
    </div>`;
  }

  function billCardClosed(o) {
    const isPaid = o.paymentStatus === "paid";
    const isCash = o.paymentStatus === "cash_accepted" || o.paymentStatus === "cash_sent";
    return `<div class="list-item" style="opacity:0.75">
      <div class="row">
        <div><strong>Table ${o.table}</strong><p class="muted small">Order #${o.id.slice(-5).toUpperCase()} · ${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p></div>
        <span class="pill ${isPaid || isCash ? "ok" : "neutral"}">${isPaid ? "UPI Paid" : isCash ? "Cash" : "Closed"}</span>
      </div>
      ${orderLines(o)}
      <div class="row" style="margin-top:6px">
        <strong>${money(o.total)}</strong>
        <div class="row-left">
          <span class="pill neutral">Closed</span>
          <button class="btn" data-action="reprint-bill" data-id="${o.id}">🧾 Reprint Bill</button>
        </div>
      </div>
    </div>`;
  }

  // ---- Reprint Bill: builds a clean printable receipt and triggers window.print() ----

  function receiptRow(name, qty, price) {
    return `<tr><td style="text-align:left">${esc(name)}</td><td style="text-align:center">${qty}</td><td style="text-align:right">${money(price * qty)}</td></tr>`;
  }

  function buildReceiptHTML(r, orders) {
    // Merge all items across orders
    const mergedItems = [];
    orders.forEach(o => {
      (o.items || []).forEach(i => {
        const existing = mergedItems.find(x => x.id === i.id);
        if (existing) existing.qty += i.qty;
        else mergedItems.push({ ...i });
      });
      (o.addons || []).forEach(a => {
        const existing = mergedItems.find(x => x.name === a.name && x._isAddon);
        if (existing) existing.qty += (a.qty || 1);
        else mergedItems.push({ id: "addon_" + a.id, name: a.name, price: a.price, qty: a.qty || 1, _isAddon: true });
      });
    });
    const grandTotal = orders.reduce((s, o) => s + o.total, 0);
    const o = orders[0]; // use first order for table/meta info
    const upiOrders = orders.filter(o => o.paymentStatus === "paid");
    const cashOrders = orders.filter(o => o.paymentStatus === "cash_accepted" || o.paymentStatus === "cash_sent");
    const payLabel = upiOrders.length && cashOrders.length
      ? `UPI \u20b9${upiOrders.reduce((s,o)=>s+o.total,0).toLocaleString("en-IN")} + Cash \u20b9${cashOrders.reduce((s,o)=>s+o.total,0).toLocaleString("en-IN")}`
      : upiOrders.length ? "UPI"
      : cashOrders.length ? "Cash"
      : "Pending";
    const rows = mergedItems.map(i => receiptRow(i._isAddon ? "+ " + i.name : i.name, i.qty, i.price)).join("");
    return `<div class="receipt">
      <h2>${esc(r.name)}</h2>
      ${r.city ? `<p>${esc(r.city)}</p>` : ""}
      <p>Table ${esc(String(o.table))}</p>
      <p>${new Date(o.createdAt).toLocaleString("en-IN")}</p>
      ${orders.length > 1 ? `<p style="font-size:11px">${orders.length} orders combined</p>` : `<p>#${o.id.slice(-5).toUpperCase()}</p>`}
      <hr>
      <table>
        <thead><tr><th style="text-align:left">Item</th><th>Qty</th><th style="text-align:right">Amt</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <hr>
      <p class="receipt-total"><span>Total</span><span>${money(grandTotal)}</span></p>
      <p>Payment: ${payLabel}</p>
      ${o.note ? `<p>Note: ${esc(o.note)}</p>` : ""}
      <p style="margin-top:10px">Thank you for visiting!</p>
    </div>`;
  }

  function printReceipt(orderId) {
    const o = state.orders.find(x => x.id === orderId);
    if (!o) return toast("Order not found");
    const r = bySlug(o.restaurantSlug);
    if (!r) return toast("Restaurant not found");
    let holder = document.getElementById("print-receipt-holder");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "print-receipt-holder";
      document.body.appendChild(holder);
    }
    holder.innerHTML = buildReceiptHTML(r, [o]);
    document.body.classList.add("printing-receipt");
    setTimeout(() => window.print(), 50);
    setTimeout(() => document.body.classList.remove("printing-receipt"), 3000);
  }

  function printTableBill(orderIds) {
    const orders = orderIds.map(id => state.orders.find(x => x.id === id)).filter(Boolean);
    if (!orders.length) return toast("Orders not found");
    const r = bySlug(orders[0].restaurantSlug);
    if (!r) return toast("Restaurant not found");
    let holder = document.getElementById("print-receipt-holder");
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "print-receipt-holder";
      document.body.appendChild(holder);
    }
    holder.innerHTML = buildReceiptHTML(r, orders);
    document.body.classList.add("printing-receipt");
    setTimeout(() => window.print(), 50);
    setTimeout(() => document.body.classList.remove("printing-receipt"), 3000);
  }

  function orderLines(o) {
    return `
      <div style="margin-top:10px">
        ${(o.items || []).map(i => `
          <div class="row small">
            <span>${esc(i.name)} x ${i.qty}</span>
            <span>${money(i.price * i.qty)}</span>
          </div>
        `).join("")}

        ${(o.addons || []).map(a => `
          <div class="row small">
            <span>${esc(a.name)}</span>
            <span>${money(a.price)}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function updatePaymentTotal() {
    const checkboxes = [...document.querySelectorAll('.addon-chk')];
    if (!checkboxes.length) return;
    const base = Number(checkboxes[0].dataset.base) || 0;
    const pa = checkboxes[0].dataset.pa || "";
    const pn = checkboxes[0].dataset.pn || "";
    const extra = checkboxes.filter(c => c.checked).reduce((s, c) => s + (Number(c.dataset.price) || 0), 0);
    const grand = base + extra;
    const fmt = "₹" + grand.toLocaleString("en-IN");
    const display = document.getElementById("pay-total-display");
    const label = document.getElementById("pay-amount-label");
    const pp = document.getElementById("phonepe-btn");
    const gp = document.getElementById("gpay-btn");
    if (display) display.textContent = fmt;
    if (label) label.textContent = fmt;
    if (pp) pp.href = pa ? `phonepe://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(pn)}&am=${grand}&cu=INR` : "phonepe://";
    if (gp) gp.href = pa ? `tez://upi/pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(pn)}&am=${grand}&cu=INR` : "tez://";
  }

  function bindClicks(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    if (action === "auth-login") return firebaseAuthLogin(el.dataset.role);
    if (action === "auth-signout") return authSignOut();
    if (action === "register") return registerRestaurant();
    if (action === "delete-resto") {
      if (!confirm("Delete " + (bySlug(el.dataset.slug)?.name || "this restaurant") + "? This cannot be undone.")) return;
      return mutate(s => { s.restaurants = s.restaurants.filter(r => r.slug !== el.dataset.slug); });
    }
    if (action === "toggle-active") return updateRestaurant(el.dataset.slug, r => r.active = !r.active);
    if (action === "toggle-qr") return updateRestaurant(el.dataset.slug, r => r.qrEnabled = !r.qrEnabled);
    if (action === "extend-sub") return updateRestaurant(el.dataset.slug, r => { r.active = true; r.qrEnabled = true; r.subscriptionEnds = Math.max(Date.now(), r.subscriptionEnds || 0) + days(30); });
    if (action === "owner-tab") return ownerTab = el.dataset.tab, render();
    if (action === "print-qr") return window.print();
    if (action === "add-item") return addMenuItem(el.dataset.slug);
    if (action === "add-common") return addCommonItem(el.dataset.slug, Number(el.dataset.index));
    if (action === "update-price") return updateRestaurant(el.dataset.slug, r => { const found = find(r.menu, el.dataset.id); if (found) found.price = Number(val("price-" + el.dataset.id)) || found.price; });
    if (action === "toggle-item") return updateRestaurant(el.dataset.slug, r => find(r.menu, el.dataset.id).available = !find(r.menu, el.dataset.id).available);
    if (action === "delete-item") return updateRestaurant(el.dataset.slug, r => r.menu = r.menu.filter(i => i.id !== el.dataset.id));
    if (action === "add-addon") return addAddon(el.dataset.slug);
    if (action === "toggle-addon") return updateRestaurant(el.dataset.slug, r => find(r.addons, el.dataset.id).active = !find(r.addons, el.dataset.id).active);
    if (action === "delete-addon") return updateRestaurant(el.dataset.slug, r => r.addons = r.addons.filter(a => a.id !== el.dataset.id));
    if (action === "add-table") return addTable(el.dataset.slug);
    if (action === "delete-table") return updateRestaurant(el.dataset.slug, r => r.tables = r.tables.filter(t => String(t.no) !== String(el.dataset.table)));
    if (action === "save-settings") return saveSettings(el.dataset.slug);
    if (action === "customer-cat") return customerCat = el.dataset.cat, render();
    if (action === "cart-inc") return cart[el.dataset.id] = (cart[el.dataset.id] || 0) + 1, render();
    if (action === "cart-dec") return decCart(el.dataset.id);
    if (action === "place-order") return placeOrder(el.dataset.slug);
    if (action === "place-order-cash") return placeOrderCash(el.dataset.slug);
    if (action === "accept-cash") return updateOrder(el.dataset.id, o => { o.paymentStatus = "cash_sent"; o.status = "pending"; });
    if (action === "billing-date-clear") return billingDateFilter = "", render();
    if (action === "cash-received") return updateOrder(el.dataset.id, o => { o.paymentStatus = "cash_accepted"; });
    if (action === "addon-change") return updatePaymentTotal();
    if (action === "addon-inc") return selectedAddons[el.dataset.id] = (selectedAddons[el.dataset.id] || 0) + 1, render();
    if (action === "addon-dec") return decAddon(el.dataset.id);
    if (action === "dismiss-review") return localStorage.removeItem("restoqr_last_order_" + el.dataset.slug), render();
    if (action === "refresh-order") return render();
    if (action === "set-star") return setStar(el);
    if (action === "submit-feedback") return submitFeedback(el);
    if (action === "mark-paid") return updateOrder(el.dataset.id, o => { o.paymentStatus = "paid"; o.status = "pending"; });
    if (action === "mark-paid-table") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      return mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o) { o.paymentStatus = "paid"; o.status = "pending"; } }));
    }
    if (action === "accept-cash-table") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      return mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o && o.paymentStatus === "cash_pending") { o.paymentStatus = "cash_sent"; o.status = "pending"; } }));
    }
    if (action === "cash-received-table") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      return mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o && o.paymentStatus === "cash_sent") o.paymentStatus = "cash_accepted"; }));
    }
    if (action === "close-order") return updateOrder(el.dataset.id, o => o.status = "completed");
    if (action === "close-table") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      return mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o) o.status = "completed"; }));
    }
    if (action === "reprint-bill") return printReceipt(el.dataset.id);
    if (action === "print-table-bill") return printTableBill(el.dataset.ids.split(","));
    if (action === "advance-order") return updateOrder(el.dataset.id, o => o.status = el.dataset.next);
    // ── Staff Dashboard actions ──────────────────────────────────────
    if (action === "staff-select-role") { staffSelectedRole = el.dataset.role; return render(); }
    if (action === "staff-login") {
      const input = document.getElementById("staff-key-input");
      const entered = (input ? input.value : "").trim();
      const loginSlug = el.dataset.slug;
      const resto = bySlug(loginSlug);
      if (!entered) { toast("Please enter the master key"); return; }
      if (!resto || !resto.masterKeyHash) {
        toast("No master key set yet — ask the owner to set one in Owner Panel → Settings");
        return;
      }
      hashMasterKey(entered).then(hash => {
        if (hash === resto.masterKeyHash) {
          localStorage.setItem(staffKeyFor(loginSlug), "yes");
          staffTab = "kitchen";
          toast("Welcome! All panels unlocked.");
          render();
        } else {
          toast("Wrong master key — check with the owner");
          if (input) { input.value = ""; input.style.borderColor = "#e74c3c"; input.focus(); setTimeout(() => input.style.borderColor = "", 2000); }
        }
      });
      return;
    }
    if (action === "staff-logout") {
      localStorage.removeItem(staffKeyFor(el.dataset.slug));
      localStorage.removeItem("restoqr_staff_role_" + el.dataset.slug);
      staffSheetTable = null;
      return render();
    }
    if (action === "staff-tab") { staffTab = el.dataset.tab; staffSheetTable = null; return render(); }
    if (action === "staff-open-table") { staffSheetTable = Number(el.dataset.table); return render(); }
    if (action === "staff-close-sheet") { staffSheetTable = null; return render(); }
    if (action === "staff-dismiss-waiter") {
      mutate(s => { const o = s.orders.find(x => x.id === el.dataset.id); if (o) delete o.waiterRequest; });
      return;
    }
    if (action === "staff-dismiss-table-alert") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o) delete o.waiterRequest; }));
      return;
    }
    if (action === "staff-confirm-upi") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o) { o.paymentStatus = "paid"; o.status = "pending"; } }));
      return toast("✅ UPI payment confirmed");
    }
    if (action === "staff-send-cash-kitchen") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o && o.paymentStatus === "cash_pending") { o.paymentStatus = "cash_sent"; o.status = "pending"; } }));
      return toast("🍳 Sent to kitchen");
    }
    if (action === "staff-confirm-cash") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o && o.paymentStatus === "cash_sent") o.paymentStatus = "cash_accepted"; }));
      return toast("💵 Cash received");
    }
    if (action === "staff-close-table") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o) o.status = "completed"; }));
      staffSheetTable = null;
      return toast("🔒 Table closed");
    }
    // ── End Staff Dashboard actions ──────────────────────────────────

    if (action === "ai-send") {
      const input = document.getElementById("ai-input");
      const msg = (input ? input.value : "").trim();
      if (input) input.value = "";
      return sendRestoAiMessage(el.dataset.slug, msg);
    }
    if (action === "ai-quick") {
      return sendRestoAiMessage(el.dataset.slug, el.dataset.q);
    }
    if (action === "ai-clear-chat") {
      _aiMessages = [];
      return render();
    }
    if (action === "clear-orders") {
      const r = bySlug(el.dataset.slug);
      if (!confirm(`Clear ALL orders for ${r?.name || "this restaurant"}? This cannot be undone.`)) return;
      mutate(s => { s.orders = s.orders.filter(o => o.restaurantSlug !== el.dataset.slug); });
      return toast("🗑 All orders cleared");
    }
    if (action === "toggle-sound") {
      soundEnabled = !soundEnabled;
      localStorage.setItem("restoqr_sound_off", soundEnabled ? "no" : "yes");
      if (soundEnabled) { ensureAudioCtx(); playOrderAlertSound(); }
      toast(soundEnabled ? "🔔 New-order alert sound is ON" : "🔕 New-order alert sound muted");
      return render();
    }
  }

  function firebaseAuthLogin(role) {
    const email    = (document.getElementById("auth-email")?.value || "").trim();
    const password = (document.getElementById("auth-password")?.value || "").trim();
    const errEl    = document.getElementById("auth-err");
    const btn      = document.getElementById("auth-submit-btn");
    if (!email || !password) {
      if (errEl) { errEl.textContent = "Please enter your email and password."; errEl.style.display = "block"; }
      return;
    }
    if (btn) { btn.textContent = "Signing in…"; btn.disabled = true; }
    if (errEl) errEl.style.display = "none";
    authSignIn(email, password, errMsg => {
      if (errEl) { errEl.textContent = errMsg; errEl.style.display = "block"; }
      if (btn)  { btn.textContent = "Sign In"; btn.disabled = false; }
    });
  }

  function registerRestaurant() {
    const name     = val("reg-name");
    const owner    = val("reg-owner");
    const phone    = val("reg-phone");
    const city     = val("reg-city");
    const pin      = val("reg-pin");
    const upiId    = val("reg-upiid");
    const upi      = val("reg-upi");
    const review   = val("reg-review");
    const coupon   = val("reg-coupon").toUpperCase();
    const email    = val("reg-owner-email").toLowerCase();
    const password = val("reg-owner-password");

    if (!name || !owner || !phone || !pin) return toast("Fill restaurant, owner, phone, and PIN");
    if (!email || !password) return toast("Fill owner email and password");
    if (password.length < 6) return toast("Password must be at least 6 characters");

    const slug = slugify(name);
    if (bySlug(slug)) return toast("Restaurant name already exists");

    function saveRestaurant(ownerEmail) {
      mutate(s => s.restaurants.push({
        id: uid(), slug, name, owner, phone, city, ownerPin: pin, active: false, qrEnabled: false,
        plan: "Pending", subscriptionEnds: Date.now(), paymentQr: DEFAULT_QR,
        upiId: upiId || "", upiName: upi || owner, googleReviewUrl: review,
        couponCode: coupon,
        ownerEmail: ownerEmail || "",
        tables: [1, 2, 3, 4].map(no => ({ no, seats: 4 })),
        categories: ["Starters", "Main Course", "Breads", "Beverages"],
        menu: [], addons: [], createdAt: Date.now()
      }));
      toast("Registered! You can now log in. Admin will activate your subscription.");
      location.hash = "#/owner?resto=" + slug;
    }

    if (firebaseMode && auth) {
      // Create Firebase Auth account for the owner, then save restaurant
      const btn = document.querySelector("[data-action='register']");
      if (btn) { btn.textContent = "Registering…"; btn.disabled = true; }

      auth.createUserWithEmailAndPassword(email, password)
        .then(() => {
          saveRestaurant(email);
        })
        .catch(e => {
          if (btn) { btn.textContent = "Submit Registration"; btn.disabled = false; }
          const msg = {
            "auth/email-already-in-use": "This email already has an account. Please log in as owner instead.",
            "auth/invalid-email":        "Please enter a valid email address.",
            "auth/weak-password":        "Password is too weak. Use at least 6 characters."
          }[e.code] || ("Registration failed: " + e.message);
          toast(msg);
        });
    }
  }

  function addMenuItem(slug) {
    const name = val("item-name"), category = val("item-cat"), price = Number(val("item-price")), veg = val("item-veg") === "true";
    if (!name || !category || !price) return toast("Fill item name, category, and price");
    updateRestaurant(slug, r => {
      if (!r.categories.includes(category)) r.categories.push(category);
      r.menu.push(item(name, category, price, veg, []));
    });
  }

  function addCommonItem(slug, index) {
    const c = COMMON_ITEMS[index];
    if (!c) return;
    const price = Number(val("common-price-" + index)) || c[2];
    updateRestaurant(slug, r => {
      if (!r.categories.includes(c[1])) r.categories.push(c[1]);
      if (r.menu.some(i => i.name.toLowerCase() === c[0].toLowerCase())) return toast("Item already exists");
      r.menu.push(item(c[0], c[1], price, c[3], []));
    });
  }

  function addAddon(slug) {
    const name = val("addon-name"), price = Number(val("addon-price"));
    if (!name || !price) return toast("Fill add-on name and price");
    updateRestaurant(slug, r => r.addons.push({ id: uid(), name, price, active: true }));
  }

  function addTable(slug) {
    const no = Number(val("table-no")), seats = Number(val("table-seats")) || 4;
    if (!no) return toast("Enter table number");
    updateRestaurant(slug, r => {
      if (r.tables.some(t => t.no === no)) return;
      r.tables.push({ no, seats });
      r.tables.sort((a, b) => a.no - b.no);
    });
  }

  function saveSettings(slug) {
    const newMasterKey = val("set-master-key");
    if (newMasterKey) {
      // Hash first, then save everything together
      hashMasterKey(newMasterKey).then(hash => {
        updateRestaurant(slug, r => {
          r.name = val("set-name") || r.name;
          r.owner = val("set-owner") || r.owner;
          r.phone = val("set-phone") || r.phone;
          r.upiName = val("set-upi") || r.upiName;
          r.upiId = val("set-upiid");
          r.googleReviewUrl = val("set-review") || "";
          r.paymentQr = val("set-qr") || DEFAULT_QR;
          const tc = Number(val("set-table-count"));
          if (tc > 0) r.tableCount = tc;
          const email = val("set-owner-email");
          if (email) r.ownerEmail = email.toLowerCase();
          r.masterKeyHash = hash;
        });
        toast("Settings saved! Master key updated.");
      });
    } else {
      updateRestaurant(slug, r => {
        r.name = val("set-name") || r.name;
        r.owner = val("set-owner") || r.owner;
        r.phone = val("set-phone") || r.phone;
        r.upiName = val("set-upi") || r.upiName;
        r.upiId = val("set-upiid");
        r.googleReviewUrl = val("set-review") || "";
        r.paymentQr = val("set-qr") || DEFAULT_QR;
        const tc = Number(val("set-table-count"));
        if (tc > 0) r.tableCount = tc;
        const email = val("set-owner-email");
        if (email) r.ownerEmail = email.toLowerCase();
      });
      toast("Settings saved!");
    }
  }

  function placeOrder(slug) {
    const r = bySlug(slug);
    const table = Number(val("customer-table"));
    if (!table) {
      const inp = document.getElementById("customer-table");
      if (inp) { inp.style.border = "2px solid #c93333"; inp.style.borderRadius = "8px"; inp.focus(); setTimeout(() => inp.style.border = "", 2000); }
      return toast("⚠ Please enter your table number");
    }
    const pickedAddons = Object.entries(selectedAddons)
      .map(([id, qty]) => { const a = find(r.addons, id); return a ? { id: a.id, name: a.name, price: a.price, qty } : null; })
      .filter(Boolean);
    const newItems = Object.entries(cart).map(([id, qty]) => {
      const m = find(r.menu, id);
      return { id, name: m.name, price: m.price, qty };
    });
    if (!newItems.length && !pickedAddons.length) return toast("Cart is empty");

    // Merge into existing open order for this table if one exists
    const existingOrder = state.orders.find(o =>
      o.restaurantSlug === slug &&
      o.table === table &&
      o.status !== "completed" &&
      o.status !== "delivered"
    );

    if (existingOrder) {
      mutate(s => {
        const o = s.orders.find(x => x.id === existingOrder.id);
        newItems.forEach(ni => {
          const existing = o.items.find(i => i.id === ni.id);
          if (existing) existing.qty += ni.qty;
          else o.items.push(ni);
        });
        pickedAddons.forEach(na => {
          const existing = (o.addons || []).find(a => a.id === na.id);
          if (existing) existing.qty += na.qty;
          else { o.addons = o.addons || []; o.addons.push(na); }
        });
        o.total = o.items.reduce((s, i) => s + i.price * i.qty, 0) +
                  (o.addons || []).reduce((s, a) => s + a.price * (a.qty || 1), 0);
        o.paymentStatus = "waiting";
      });
      localStorage.setItem("restoqr_last_order_" + slug, existingOrder.id);
      toast("Items added to your order! Waiting for payment verification.");
    } else {
      const total = newItems.reduce((s, i) => s + i.price * i.qty, 0) + pickedAddons.reduce((s, a) => s + a.price * a.qty, 0);
      const orderId = uid();
      mutate(s => s.orders.push({
        id: orderId, restaurantSlug: slug, table, items: newItems,
        addons: pickedAddons,
        note: val("order-note"), total, paymentStatus: "waiting", status: "payment_check", createdAt: Date.now()
      }));
      localStorage.setItem("restoqr_last_order_" + slug, orderId);
      toast("Order placed! Waiting for payment verification.");
    }

    cart = {};
    selectedAddons = {};
    customerCat = "";
    render();
  }

  function placeOrderCash(slug) {
    const r = bySlug(slug);
    const table = Number(val("customer-table"));
    if (!table) {
      const inp = document.getElementById("customer-table");
      if (inp) { inp.style.border = "2px solid #c93333"; inp.style.borderRadius = "8px"; inp.focus(); setTimeout(() => inp.style.border = "", 2000); }
      return toast("⚠ Please enter your table number");
    }
    const pickedAddons = Object.entries(selectedAddons)
      .map(([id, qty]) => { const a = find(r.addons, id); return a ? { id: a.id, name: a.name, price: a.price, qty } : null; })
      .filter(Boolean);
    const newItems = Object.entries(cart).map(([id, qty]) => {
      const m = find(r.menu, id);
      return { id, name: m.name, price: m.price, qty };
    });
    if (!newItems.length && !pickedAddons.length) return toast("Cart is empty");

    // Merge into existing open order for this table if one exists
    const existingOrder = state.orders.find(o =>
      o.restaurantSlug === slug &&
      o.table === table &&
      o.status !== "completed" &&
      o.status !== "delivered"
    );

    if (existingOrder) {
      mutate(s => {
        const o = s.orders.find(x => x.id === existingOrder.id);
        newItems.forEach(ni => {
          const existing = o.items.find(i => i.id === ni.id);
          if (existing) existing.qty += ni.qty;
          else o.items.push(ni);
        });
        pickedAddons.forEach(na => {
          const existing = (o.addons || []).find(a => a.id === na.id);
          if (existing) existing.qty += na.qty;
          else { o.addons = o.addons || []; o.addons.push(na); }
        });
        o.total = o.items.reduce((s, i) => s + i.price * i.qty, 0) +
                  (o.addons || []).reduce((s, a) => s + a.price * (a.qty || 1), 0);
        o.paymentStatus = "cash_pending";
      });
      localStorage.setItem("restoqr_last_order_" + slug, existingOrder.id);
      toast("Items added to your order! Counter will accept your payment.");
    } else {
      const total = newItems.reduce((s, i) => s + i.price * i.qty, 0) + pickedAddons.reduce((s, a) => s + a.price * a.qty, 0);
      const orderId = uid();
      mutate(s => s.orders.push({
        id: orderId, restaurantSlug: slug, table, items: newItems,
        addons: pickedAddons,
        note: val("order-note"), total, paymentStatus: "cash_pending", status: "payment_check", createdAt: Date.now()
      }));
      localStorage.setItem("restoqr_last_order_" + slug, orderId);
      toast("Cash order placed! Counter will accept your payment.");
    }

    cart = {};
    selectedAddons = {};
    customerCat = "";
    render();
  }

  function setStar(el) {
    const n = Number(el.dataset.star);
    document.querySelectorAll("[data-action='set-star']").forEach((btn, i) => {
      btn.textContent = i < n ? "★" : "☆";
      btn.style.color = i < n ? "#ffba00" : "#e8dcc8";
    });
    document.getElementById("star-row").dataset.selected = n;
  }

  function submitFeedback(el) {
    const stars = Number(document.getElementById("star-row")?.dataset.selected || 0);
    const text = (document.getElementById("feedback-text")?.value || "").trim();
    if (!stars) return toast("Please select a star rating");
    mutate(s => {
      s.feedbacks = s.feedbacks || [];
      s.feedbacks.push({
        id: uid(),
        restaurantSlug: el.dataset.slug,
        orderId: el.dataset.order,
        table: el.dataset.table,
        stars,
        text,
        createdAt: Date.now()
      });
    });
    toast("Thanks for your feedback! 🙏");
  }

  function updateRestaurant(slug, fn) {
    mutate(s => {
      const r = s.restaurants.find(x => x.slug === slug);
      if (r) fn(r);
    });
  }

  function updateOrder(id, fn) {
    mutate(s => {
      const o = s.orders.find(x => x.id === id);
      if (o) fn(o);
    });
  }

  function topbar(active, r) {
    return `<style>
      .order-scroll::-webkit-scrollbar { width: 5px; }
      .order-scroll::-webkit-scrollbar-track { background: transparent; }
      .order-scroll::-webkit-scrollbar-thumb { background: var(--line,#e5e7eb); border-radius: 99px; }
      .order-scroll::-webkit-scrollbar-thumb:hover { background: var(--muted,#9ca3af); }
    </style>
    <header class="topbar"><div class="topbar-inner">
      <a class="brand" href="#/"><img src="./assets/logo.png" alt="RestoQR" style="height: 60px;"></a>
      <nav class="nav">
        <a class="btn ${active === "home" ? "primary" : ""}" href="#/" title="Home" style="display:inline-flex;align-items:center;padding:8px 10px">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="18" height="18">
            <path d="M3 12L12 3l9 9"/>
            <path d="M9 21V12h6v9"/>
            <path d="M5 10v11h14V10"/>
          </svg>
        </a>
        ${r ? `<button class="btn" data-action="toggle-sound" title="${soundEnabled ? "Mute new-order alerts" : "Unmute new-order alerts"}" style="display:inline-flex;align-items:center;padding:8px 10px;font-size:16px">${soundEnabled ? "🔔" : "🔕"}</button>` : ""}
        <a class="btn ${active === "register" ? "primary" : ""}" href="#/register">Register</a>
        <a class="btn ${active === "owner" ? "primary" : ""}" href="#/owner${r ? "?resto=" + r.slug : ""}">Owner</a>
        <a class="btn ${active === "staff" ? "primary" : ""}" href="#/staff${r ? "?resto=" + r.slug : "?resto=" + (state.restaurants[0]?.slug || "")}">Staff</a>
        <a class="btn ${active === "admin" ? "primary" : ""}" href="#/admin">Admin</a>
      </nav>
    </div></header>`;
  }

  function shell(titleText, body, active) {
    return `${topbar(active)}<main class="wrap"><div class="section-head"><div><h2>${titleText}</h2></div></div>${body}</main>`;
  }

  function customerShell(name, body) {
    return `<div class="customer-shell"><div class="customer-head"><p>RestoQR</p><h1>${esc(name)}</h1></div>${body}</div>`;
  }

  function selectRestaurant(selected) {
    return `<div class="field"><label>Restaurant</label><select id="owner-resto" onchange="location.hash='#/owner?resto='+this.value">${state.restaurants.map(r => `<option value="${r.slug}" ${r.slug === selected ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></div>`;
  }

  function statusPills(r) {
    const left = Math.ceil((r.subscriptionEnds - Date.now()) / days(1));
    return `<div class="row-left"><span class="pill ${r.active ? "ok" : "bad"}">${r.active ? "Active" : "Inactive"}</span><span class="pill ${isRestaurantOpen(r) ? "blue" : "neutral"}">QR ${isRestaurantOpen(r) ? "On" : "Off"}</span><span class="pill ${left > 0 ? "ok" : "bad"}">${left > 0 ? left + " days" : "Expired"}</span></div>`;
  }

  function field(label, id, tag, placeholder, type) {
    const placeholderOnly = ["Cafe Aroma", "Owner name", "Mobile number", "City", "4 digit PIN", "Shown under payment QR", "Paste Google review link", "name@upi or 9999999999@paytm", "Paneer Tikka", "Starters", "220", "Extra Roti", "30", "7", "4", "Enter passcode", "Enter PIN", "Optional — have a code?", "e.g. LAUNCH999"];
    const value = placeholder && !placeholderOnly.includes(placeholder) ? placeholder : "";
    if (tag === "textarea") return `<div class="field"><label>${label}</label><textarea id="${id}" placeholder="${placeholder || ""}">${value}</textarea></div>`;
    return `<div class="field"><label>${label}</label><input id="${id}" type="${type || "text"}" placeholder="${placeholder || ""}" value="${esc(value)}"></div>`;
  }
 function initCarousel() {
  const slides = document.querySelectorAll(".carousel-slide");
  const dotsWrap = document.querySelector(".carousel-dots");

  if (!slides.length || !dotsWrap) return;

  let current = 0;
  let autoTimer = null;

  // Build dots
  slides.forEach((_, i) => {
    const dot = document.createElement("button");
    if (i === 0) dot.classList.add("active");

    dot.addEventListener("click", () => {
      showSlide(i);
    });

    dotsWrap.appendChild(dot);
  });

  const dots = dotsWrap.querySelectorAll("button");

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  function startAuto() {
    stopAuto();

    autoTimer = setInterval(() => {
      showSlide(current + 1);
    }, 5000);
  }

  function showSlide(index) {
    slides[current].classList.remove("active");
    dots[current].classList.remove("active");

    current = (index + slides.length) % slides.length;

    slides[current].classList.add("active");
    dots[current].classList.add("active");

    stopAuto();

    // Don't auto-slide while YouTube video slide is active
   
  }

  document.querySelector(".carousel-btn.next")?.addEventListener("click", () => {
    showSlide(current + 1);
  });

  document.querySelector(".carousel-btn.prev")?.addEventListener("click", () => {
    showSlide(current - 1);
  });

  // Start on video slide
  showSlide(0);
}

  function initGuideStrip() {
    const wrap    = document.querySelector(".guide-track-wrap");
    const track   = document.querySelector(".guide-track");
    const cards   = track ? Array.from(track.querySelectorAll(".guide-card")) : [];
    const dotsWrap = document.querySelector(".guide-dots");
    const prevBtn  = document.querySelector(".guide-prev");
    const nextBtn  = document.querySelector(".guide-next");

    if (!cards.length || !dotsWrap || !wrap) return;

    let current = 0;
    const GAP = 16;

    function visibleCount() {
      return window.innerWidth < 768 ? 1 : 3;
    }

    function cardWidth() {
      const n = visibleCount();
      return (wrap.offsetWidth - GAP * (n - 1)) / n;
    }

    function applyWidths() {
      const w = cardWidth();
      cards.forEach(c => { c.style.minWidth = w + "px"; c.style.maxWidth = w + "px"; });
    }

    // Build dots
    cards.forEach((_, i) => {
      const dot = document.createElement("button");
      dot.className = "guide-dot" + (i === 0 ? " active" : "");
      dot.addEventListener("click", () => goTo(i));
      dotsWrap.appendChild(dot);
    });
    const dots = dotsWrap.querySelectorAll(".guide-dot");

    function goTo(index) {
      const max = Math.max(0, cards.length - visibleCount());
      current = Math.max(0, Math.min(index, max));
      const offset = current * (cardWidth() + GAP);
      track.style.transform = `translateX(-${offset}px)`;
      dots.forEach((d, i) => d.classList.toggle("active", i === current));
    }

    prevBtn?.addEventListener("click", () => goTo(current - 1));
    nextBtn?.addEventListener("click", () => goTo(current + 1));

    let startX = 0;
    track.addEventListener("touchstart", e => { startX = e.touches[0].clientX; }, { passive: true });
    track.addEventListener("touchend", e => {
      const diff = startX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 40) goTo(diff > 0 ? current + 1 : current - 1);
    });

    window.addEventListener("resize", () => { applyWidths(); goTo(current); });

    // Init
    applyWidths();
    goTo(0);
  }

  function stat(label, value) { return `<div class="stat"><p>${label}</p><strong>${value}</strong></div>`; }
  function empty(text) { return `<div class="empty">${text}</div>`; }
  function val(id) { return (document.getElementById(id)?.value || "").trim(); }
  function bySlug(slug) { return state.restaurants.find(r => r.slug === slug); }
  function find(arr, id) { return arr.find(x => String(x.id) === String(id)); }
  function cartCount() { return Object.values(cart).reduce((s, q) => s + q, 0); }
  function addonCartCount() { return Object.values(selectedAddons).reduce((s, q) => s + q, 0); }
  function cartTotal(r) { return Object.entries(cart).reduce((s, [id, q]) => { const i = find(r.menu, id); return s + (i ? i.price * q : 0); }, 0); }
  function decCart(id) { if (cart[id] > 1) cart[id] -= 1; else delete cart[id]; render(); }
  function decAddon(id) { if (selectedAddons[id] > 1) selectedAddons[id] -= 1; else delete selectedAddons[id]; render(); }
  function money(n) { return "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN"); }
  function days(n) { return n * 24 * 60 * 60 * 1000; }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function slugify(s) { return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 38) || uid(); }
  function title(s) { return s.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function unique(a) { return [...new Set(a.filter(Boolean))]; }
  function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }
  function isRestaurantOpen(r) { return !!(r && r.active && r.qrEnabled && Number(r.subscriptionEnds || 0) > Date.now()); }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m])); }
  function html(s) {
    app.innerHTML = s;

  requestAnimationFrame(() => {
    if (document.querySelector(".media-carousel")) {
      initCarousel();
    }
    if (document.querySelector(".guide-track")) {
      initGuideStrip();
    }
  });
}
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.hidden = true, 2400);
  }


  document.addEventListener("click", bindClicks);
  document.addEventListener("click", function unlockAudioOnce() { ensureAudioCtx(); }, { once: true });
  window.addEventListener("afterprint", () => {
    document.body.classList.remove("printing-receipt");
  });
  document.addEventListener("change", function(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    if (el.dataset.action === "billing-date-pick" || el.dataset.action === "billing-date-select") {
      billingDateFilter = el.value;
      render();
    }
  });
  start();
})();