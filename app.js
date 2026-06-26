(function () {
  const KEY = "restoqr_cloud_state_v1";
  const DEFAULT_QR = "./assets/phonepe-qr.jpeg";
  // Completed orders older than this are purged from `state.orders` to keep
  // the dataset lean. Before deleting, their totals are rolled up into a
  // per-day `billingArchive` entry so the owner can still see a summary on
  // the Billing panel by picking that date.
  const ORDER_RETENTION_DAYS = 32;
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  let state = seed();
  let db = null;
  let auth = null;
  let currentUser = null;  // Firebase Auth user
  let firebaseMode = false;
  let firebaseDataLoaded = false;
  let billingArchiveListening = false;
  let ownerTab = "overview";
  let customerCat = "";
  let customerSearch = "";        // live text typed into the customer menu search box
  let customerVegFilter = "all";  // "all" | "veg" | "nonveg" — customer menu veg/non-veg filter
  let cart = {};
  let selectedAddons = {}; // addonId -> true
  let billingDateFilter = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, default today
  let carouselInitialized = false; // Flag to ensure carousel is initialized only once
  let commonItemsTab = "resto"; // "resto" | "cafe" — tab shown in the Common Items panel

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
  // Staff auth: requires Firebase Auth login + active record under restoqr/staff/<slug>/<uid>
  // staffMembers cache is populated by listenStaffMembers() when staff panel is open
  let _staffMembers = {};  // { [slug]: { [uid]: { name, role, active } } }
  function isStaffUnlocked(slug) {
    if (!firebaseMode) return localStorage.getItem(staffKeyFor(slug)) === "yes"; // local fallback
    if (!currentUser) return false;
    const record = (_staffMembers[slug] || {})[currentUser.uid];
    return !!(record && record.active);
  }
  function staffRole(slug) {
    if (firebaseMode && currentUser) {
      const record = (_staffMembers[slug] || {})[currentUser.uid];
      return (record && record.role) || "waiter";
    }
    return localStorage.getItem("restoqr_staff_role_" + slug) || "waiter";
  }
  function currentStaffName(slug) {
    if (firebaseMode && currentUser) {
      const record = (_staffMembers[slug] || {})[currentUser.uid];
      return (record && record.name) || currentUser.email || "Staff";
    }
    return "Staff";
  }
  let _staffListeners = {}; // slug -> true, to avoid duplicate listeners
  function listenStaffMembers(slug) {
    if (!firebaseMode || !db || _staffListeners[slug]) return;
    _staffListeners[slug] = true;
    db.child("staff").child(slug).on("value", snap => {
      _staffMembers[slug] = snap.val() || {};
      render();
    });
  }

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

  const CAFE_ITEMS = [
    ["Espresso", "Coffee", 80, true], ["Americano", "Coffee", 100, true], ["Cappuccino", "Coffee", 130, true],
    ["Latte", "Coffee", 150, true], ["Flat White", "Coffee", 160, true], ["Mocha", "Coffee", 160, true],
    ["Cold Coffee", "Coffee", 150, true], ["Cold Brew", "Coffee", 180, true], ["Iced Latte", "Coffee", 170, true],
    ["Masala Chai", "Tea & More", 60, true], ["Cutting Chai", "Tea & More", 30, true], ["Green Tea", "Tea & More", 80, true],
    ["Lemon Iced Tea", "Tea & More", 110, true], ["Hot Chocolate", "Tea & More", 150, true],
    ["Croissant", "Bakery", 120, true], ["Blueberry Muffin", "Bakery", 100, true], ["Chocolate Muffin", "Bakery", 100, true],
    ["Banana Bread", "Bakery", 90, true], ["Cinnamon Roll", "Bakery", 130, true], ["Brownie", "Bakery", 110, true],
    ["Cookies (2 pcs)", "Bakery", 80, true],
    ["Veg Sandwich", "Snacks", 120, true], ["Grilled Cheese Sandwich", "Snacks", 140, true], ["Club Sandwich", "Snacks", 180, false],
    ["Paneer Wrap", "Snacks", 160, true], ["Cheese Toast", "Snacks", 100, true], ["Bruschetta", "Snacks", 130, true],
    ["French Fries", "Snacks", 120, true], ["Nachos with Dip", "Snacks", 150, true],
    ["Fruit Bowl", "Healthy", 140, true], ["Granola Bowl", "Healthy", 160, true], ["Avocado Toast", "Healthy", 200, true],
    ["Smoothie Bowl", "Healthy", 190, true], ["Fresh Orange Juice", "Healthy", 100, true],
    ["Waffles", "Desserts", 180, true], ["Pancakes", "Desserts", 160, true], ["Tiramisu", "Desserts", 200, true],
    ["Cheesecake", "Desserts", 180, true], ["Chocolate Lava Cake", "Desserts", 190, true]
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
      feedbacks: [],
      billingArchive: [] // per-day order summaries, see archiveOldOrders()
    };
  }

  function item(name, category, price, veg, notes) {
    return { id: uid(), name, category, price, veg, available: true, notes };
  }

  function start() {
    // ── Inject home-page section styles once into <head> ──────────
    (function() {
      if (document.getElementById("rqr-home-styles")) return;
      const s = document.createElement("style");
      s.id = "rqr-home-styles";
      s.textContent = `
        /* AI REVIEW BANNER */
        .ai-review-banner{padding:72px 24px;background:linear-gradient(135deg,#0f172a 0%,#1e1060 50%,#3b0764 100%);position:relative;overflow:hidden}
        .ai-review-banner-inner{max-width:1100px;margin:0 auto;display:flex;gap:48px;align-items:center;flex-wrap:wrap}
        .ai-review-banner-left{flex:1;min-width:280px;color:#fff}
        .ai-review-label{display:inline-block;background:rgba(255,200,50,.15);color:#fcd34d;font-size:12px;font-weight:800;padding:5px 16px;border-radius:99px;margin-bottom:18px;letter-spacing:.06em;text-transform:uppercase;border:1px solid rgba(252,211,77,.25)}
        .ai-review-title{font-size:clamp(22px,3.5vw,38px);font-weight:900;line-height:1.2;margin:0 0 16px;color:#fff}
        .ai-review-sub{font-size:15px;color:#c4b5e0;line-height:1.65;margin:0 0 28px;max-width:520px}
        .ai-review-steps{display:flex;flex-direction:column;gap:12px;margin-bottom:32px}
        .ai-review-step{display:flex;align-items:center;gap:14px;font-size:14px;color:#e2e8f0;font-weight:500}
        .ai-review-step-num{flex-shrink:0;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);color:#fff;font-size:13px;font-weight:900;display:flex;align-items:center;justify-content:center}
        .ai-review-stats{display:flex;gap:24px;flex-wrap:wrap}
        .ai-review-stat{text-align:center}
        .ai-review-stat strong{display:block;font-size:28px;font-weight:900;color:#fcd34d;line-height:1}
        .ai-review-stat span{font-size:12px;color:#a78bfa;font-weight:600;margin-top:4px;display:block}
        .ai-review-banner-right{flex-shrink:0;display:flex;justify-content:center}
        .ai-review-phone-mock{width:240px;background:#1e1b2e;border-radius:28px;padding:20px 16px;border:2px solid rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.5)}
        .ai-review-phone-screen{display:flex;flex-direction:column;gap:12px}
        .ai-review-phone-header{font-size:13px;font-weight:700;color:#e2e8f0;text-align:center;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.08)}
        .ai-review-stars{text-align:center;font-size:20px;letter-spacing:2px}
        .ai-review-phone-bubble{background:rgba(255,255,255,.07);border-radius:14px;padding:12px 14px;border:1px solid rgba(255,255,255,.1)}
        .ai-review-bubble-label{font-size:10px;font-weight:800;color:#a78bfa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
        .ai-review-phone-bubble p{margin:0;font-size:12px;color:#e2e8f0;line-height:1.55}
        .ai-review-phone-cta{text-align:center}
        .ai-review-google-btn{background:linear-gradient(135deg,#4285f4,#34a853);color:#fff;border:none;border-radius:10px;padding:10px 16px;font-size:12px;font-weight:800;cursor:pointer;width:100%}
        @media(max-width:680px){.ai-review-banner-right{width:100%;order:-1}.ai-review-phone-mock{width:200px}}
        /* WHY RESTOQR */
        .why-restoqr-section{padding:72px 20px;background:#fffdf9}
        .why-restoqr-inner{max-width:1100px;margin:0 auto}
        .why-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}
        .why-card{border-radius:18px;padding:28px 24px;position:relative;overflow:hidden}
        .why-card-orange{background:linear-gradient(135deg,#fff7ed,#ffece0);border:1.5px solid #ffd0b0}
        .why-card-purple{background:linear-gradient(135deg,#f5f0ff,#ede5ff);border:1.5px solid #d0b8ff}
        .why-card-green{background:linear-gradient(135deg,#ecfdf5,#d1fae5);border:1.5px solid #6ee7b7}
        .why-card-blue{background:linear-gradient(135deg,#eff6ff,#dbeafe);border:1.5px solid #93c5fd}
        .why-card-icon{font-size:34px;margin-bottom:12px}
        .why-card h3{margin:0 0 8px;font-size:18px;font-weight:800;color:#1c0e04}
        .why-card p{margin:0;font-size:14px;color:#4b5563;line-height:1.55}
        .why-compare-tag{display:inline-block;margin-top:14px;background:rgba(255,107,0,.12);color:#c24a00;font-size:11px;font-weight:800;padding:4px 12px;border-radius:99px;text-transform:uppercase;letter-spacing:.04em}
        /* COMPARISON TABLE */
        .comparison-section{padding:72px 20px;background:#f9f6f1}
        .comparison-inner{max-width:900px;margin:0 auto}
        .comparison-table-wrap{overflow-x:auto}
        .comparison-table{width:100%;border-collapse:separate;border-spacing:0;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.07)}
        .comparison-table th,.comparison-table td{padding:14px 18px;text-align:center;font-size:14px;border-bottom:1px solid #f0ede8}
        .comparison-table th{background:#1c0e04;color:#fff;font-weight:700;font-size:13px}
        .comparison-table .col-us{background:#fff7ed;font-weight:700;color:#c24a00}
        .comparison-table tbody tr:last-child td{border-bottom:none}
        .comparison-table tbody tr:hover{background:#fffbf5}
        /* AI HIGHLIGHT */
        .ai-highlight-section{padding:72px 20px;background:linear-gradient(135deg,#1a0a3e,#2d1060)}
        .ai-highlight-inner{max-width:800px;margin:0 auto;text-align:center;color:#fff}
        .ai-highlight-badge{display:inline-block;background:rgba(255,255,255,.15);color:#e0d0ff;font-size:12px;font-weight:800;padding:5px 16px;border-radius:99px;margin-bottom:20px;letter-spacing:.05em;text-transform:uppercase}
        .ai-highlight-inner h2{font-size:clamp(22px,3.5vw,36px);margin:0 0 14px;color:#fff}
        .ai-highlight-inner p{color:#c4b5e0;font-size:16px;line-height:1.6;margin-bottom:32px}
        .ai-queries-grid{display:flex;flex-wrap:wrap;gap:12px;justify-content:center}
        .ai-query-chip{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:13px;font-weight:600;padding:10px 18px;border-radius:99px}
        /* PRICING */
        .pricing-section{padding:72px 20px;background:#f9f6f1}
        .pricing-inner{max-width:500px;margin:0 auto}
        .pricing-cards-row{display:flex;justify-content:center}
        .pricing-card{background:#fff;border-radius:20px;padding:36px 32px;border:2px solid #f0ede8;width:100%;position:relative}
        .pricing-card-highlight{border-color:#ff6b00;box-shadow:0 12px 40px rgba(255,107,0,.15)}
        .pricing-badge{position:absolute;top:-14px;left:50%;transform:translateX(-50%);background:#ff6b00;color:#fff;font-size:11px;font-weight:800;padding:5px 16px;border-radius:99px;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em}
        .pricing-amount{font-size:48px;font-weight:900;color:#1c0e04;text-align:center}
        .pricing-amount span{font-size:20px;font-weight:500;color:#9ca3af}
        .pricing-name{text-align:center;font-size:15px;font-weight:700;color:#6b7280;margin:6px 0 24px}
        .pricing-features{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px}
        .pricing-features li{font-size:14px;color:#1c0e04;font-weight:500}
        /* AI REVIEW FEATURE CARD */
        .ai-review-feature-card{margin-top:24px;display:flex;gap:20px;align-items:flex-start;background:linear-gradient(135deg,#fffbeb,#fef3c7);border:2px solid #fcd34d;border-radius:20px;padding:28px;box-shadow:0 8px 24px rgba(234,179,8,.15)}
        .ai-review-feature-icon{flex-shrink:0;width:48px;height:48px;background:linear-gradient(135deg,#f59e0b,#ef4444);border-radius:14px;display:flex;align-items:center;justify-content:center;color:#fff}
        .ai-review-feature-body{flex:1}
        .ai-review-feature-badge{display:inline-block;background:rgba(234,179,8,.2);color:#92400e;font-size:11px;font-weight:800;padding:3px 12px;border-radius:99px;margin-bottom:8px;letter-spacing:.05em;text-transform:uppercase}
        .ai-review-feature-body h3{margin:0 0 8px;font-size:18px;font-weight:800;color:#1c0e04}
        .ai-review-feature-body p{margin:0 0 16px;font-size:14px;color:#4b5563;line-height:1.6}
        .ai-review-feature-pills{display:flex;flex-wrap:wrap;gap:8px}
        .ai-review-feature-pills span{background:#fff;border:1.5px solid #fcd34d;color:#92400e;font-size:12px;font-weight:700;padding:5px 14px;border-radius:99px}
        @media(max-width:560px){.ai-review-feature-card{flex-direction:column}.ai-review-feature-icon{width:40px;height:40px}}
        /* MAHARASHTRA BANNER */
        .maha-banner{position:relative;overflow:hidden;padding:72px 24px;background:linear-gradient(120deg,#1c0e04 0%,#7a1e00 50%,#c24a00 100%);text-align:center}
        .maha-banner-bg-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:clamp(80px,18vw,200px);font-weight:900;color:rgba(255,255,255,.04);pointer-events:none;user-select:none;letter-spacing:-.02em;white-space:nowrap}
        .maha-banner-inner{position:relative;z-index:2;max-width:720px;margin:0 auto}
        .maha-banner-flag{font-size:22px;letter-spacing:6px;margin-bottom:18px;opacity:.85}
        .maha-banner-title{font-size:clamp(24px,4vw,42px);font-weight:900;color:#fff;margin:0 0 16px;line-height:1.2}
        .maha-banner-sub{font-size:clamp(15px,2vw,18px);color:#ffd0b0;margin:0 0 32px;line-height:1.6}
        .maha-banner-cta{font-size:16px;padding:14px 32px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.3)}
        @media(max-width:900px){.grid-4{grid-template-columns:repeat(2,1fr)}}
        @media(max-width:560px){.grid-4{grid-template-columns:1fr}.why-grid{grid-template-columns:1fr}}
      `;
      document.head.appendChild(s);
    })();

    // Load review generator module
    (function() {
      if (!document.getElementById("rqr-review-gen-script")) {
        const s = document.createElement("script");
        s.id = "rqr-review-gen-script";
        s.src = "./review-generator.js";
        document.head.appendChild(s);
      }
    })();

    // Listen for feedback events from review-generator and save to state
    document.addEventListener("restoqr:feedback", function(e) {
      const { restaurantName, restaurantSlug, text, satisfaction } = e.detail || {};
      // Resolve slug from restaurantSlug (preferred) or fall back to name match
      const resolvedSlug = restaurantSlug || state.restaurants.find(r => r.name === restaurantName)?.slug || "";
      mutate(s => {
        s.feedbacks = s.feedbacks || [];
        s.feedbacks.push({
          id: uid(),
          restaurantSlug: resolvedSlug,
          restaurantName: restaurantName || "",
          text: text || "",
          satisfaction: satisfaction || 0,
          createdAt: Date.now()
        });
      });
    });
    firebaseMode = canUseFirebase();
    if (firebaseMode) {
      firebase.initializeApp(window.FIREBASE_CONFIG);
      const appCheck = firebase.appCheck();
      appCheck.activate("6LcjxjMtAAAAAK4rgarGJGd9_JhEI4FZPHzts1Si", true);
      auth = firebase.auth();
      db   = firebase.database().ref("restoqr");

      function markFirebaseLoaded() {
        if (firebaseDataLoaded) return;
        firebaseDataLoaded = true;
        repairCachedOwnerLink();
        render();
      }

      let ordersListening = false;

      function startPrivateDataListeners() {
        if (billingArchiveListening) return;
        billingArchiveListening = true;
        db.child("billingArchive").on("value", snap => {
          const raw = snap.val();
          state.billingArchive = (raw && typeof raw === "object" && !Array.isArray(raw)) ? Object.values(raw).filter(Boolean) : (Array.isArray(raw) ? raw : []);
          render();
        });
      }

      function startOrdersListener() {
        if (ordersListening) return;
        ordersListening = true;
        db.child("orders").on("value", snap => {
          const raw = snap.val();
          const orders = (raw && typeof raw === "object" && !Array.isArray(raw)) ? Object.values(raw).filter(Boolean) : (Array.isArray(raw) ? raw : []);
          const nextState = { ...state, orders };
          checkNewOrders(nextState);
          state.orders = orders;
          if (archiveOldOrders(state)) {
            (state.orders || []).forEach((o, i) => db.child("orders").child(String(i)).set(o));
            db.child("billingArchive").set(state.billingArchive || []);
          }
          render();
        });
      }

      function stopPrivateDataListeners() {
        if (!billingArchiveListening) return;
        db.child("billingArchive").off("value");
        billingArchiveListening = false;
      }

      // Listen for auth state — renders gated views correctly
      auth.onAuthStateChanged(user => {
        currentUser = user || null;
        _isAdminCache = null; // reset on every auth change
        if (currentUser && currentUser.email) {
          startPrivateDataListeners();
          startOrdersListener();
          repairCachedOwnerLink();
          // Ensure ownerIndex is populated for all restaurants this owner owns
          // so staff write rules work immediately without waiting for settings save
          setTimeout(() => {
            const email = normEmail(currentUser.email);
            state.restaurants.forEach(r => {
              if (normEmail(r.ownerEmail) === email && r.slug) {
                db.child("ownerIndex").child(r.slug).once("value").then(snap => {
                  if (!snap.exists()) db.child("ownerIndex").child(r.slug).set(email);
                });
              }
            });
          }, 1500); // wait for restaurants to load
        } else if (currentUser) {
          // anonymous user
          startPrivateDataListeners();
          startOrdersListener();
        } else {
          stopPrivateDataListeners();
        }
        render();
      });

      // Whole-root reads can be delayed or denied if rules protect any child
      // node. Do not let that leave the owner panel stuck on the loading screen.
      setTimeout(markFirebaseLoaded, 1800);

      // Listen only to app data children. A whole-root /restoqr listener is
      // denied by production rules because admin/meta nodes are protected.
      db.child("restaurants").on("value", snap => {
        const restaurants = snap.val();
        if (restaurants) {
          state.restaurants = normalizeState({ restaurants }).restaurants;
        } else if (!firebaseDataLoaded && currentUser) {
          // Write seed data per-index so $index rules are satisfied.
          // Parent-level .set() is blocked because there is no parent .write rule.
          const s = seed();
          s.restaurants.forEach((r, i) => db.child("restaurants").child(String(i)).set(r));
          // orders and feedbacks are empty arrays in seed — nothing to write
          db.child("billingArchive").set(s.billingArchive);
        }
        markFirebaseLoaded();
        render();
      });

      // Orders listener is now started inside onAuthStateChanged via startOrdersListener()
      // so it only attaches after auth is confirmed — avoids permission denied on startup.

      db.child("feedbacks").on("value", snap => {
        const raw = snap.val();
        state.feedbacks = (raw && typeof raw === "object" && !Array.isArray(raw)) ? Object.values(raw).filter(Boolean) : (Array.isArray(raw) ? raw : []);
        render();
      });

    }
    window.addEventListener("hashchange", () => {
      customerCat = "";
      customerSearch = "";
      customerVegFilter = "all";
      staffSheetTable = null;
      render();
    });

    // Idle safety net: sweep for orders that crossed the retention window
    // even if nobody triggers a mutation (e.g. a billing panel left open
    // overnight). Cheap no-op when nothing has aged past the cutoff.
    setInterval(() => {
      if (!archiveOldOrders(state)) return;
      if (firebaseMode && db) {
        // Per-index writes — parent .set() blocked by rules.
        (state.orders || []).forEach((o, i) => db.child("orders").child(String(i)).set(o));
        db.child("billingArchive").set(state.billingArchive || []);
      }
      render();
    }, 60 * 60 * 1000); // hourly
  }

  function canUseFirebase() {
    const c = window.FIREBASE_CONFIG || {};
    return !!(window.firebase && c.apiKey && c.databaseURL && c.projectId);
  }

  // ── Firebase Auth helpers ────────────────────────────────────────
  function authSignIn(email, password, onErr) {
    if (!auth) return onErr("Firebase not available");
    auth.signInWithEmailAndPassword(email, password)
      .then(credential => {
        const cachedSlug = cachedOwnerSlugForUser(credential.user);
        if (cachedSlug && route().path === "/owner") location.replace("#/owner?resto=" + cachedSlug);
      })
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
  function normEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function rememberOwnerLink(slug, email) {
    if (!slug) return;
    localStorage.setItem("restoqr_owner_slug", slug);
    const cleanEmail = normEmail(email || currentUser?.email);
    if (cleanEmail) localStorage.setItem("restoqr_owner_email", cleanEmail);
  }

  function ownerSlugForUser(user) {
    if (!user) return null;
    const email = normEmail(user.email);
    const linked = state.restaurants.find(r => normEmail(r.ownerEmail) === email);
    if (linked) {
      rememberOwnerLink(linked.slug, email);
      return linked.slug;
    }
    const cachedSlug = localStorage.getItem("restoqr_owner_slug") || "";
    const cachedEmail = normEmail(localStorage.getItem("restoqr_owner_email"));
    if (cachedSlug && cachedEmail === email && bySlug(cachedSlug)) return cachedSlug;
    return null;
  }

  function cachedOwnerSlugForUser(user) {
    if (!user) return "";
    const cachedSlug = localStorage.getItem("restoqr_owner_slug") || "";
    const cachedEmail = normEmail(localStorage.getItem("restoqr_owner_email"));
    return cachedSlug && cachedEmail === normEmail(user.email) ? cachedSlug : "";
  }

  function loadingOwnerView() {
    return `${topbar("owner")}<main class="wrap"><div class="card" style="text-align:center;padding:40px"><p class="muted">Loading your restaurant…</p></div></main>`;
  }

  function repairCachedOwnerLink() {
    if (!firebaseMode || !db || !currentUser || !firebaseDataLoaded) return;
    const email = normEmail(currentUser.email);
    const cachedSlug = localStorage.getItem("restoqr_owner_slug") || "";
    const cachedEmail = normEmail(localStorage.getItem("restoqr_owner_email"));
    if (!cachedSlug || cachedEmail !== email) return;
    const idx = state.restaurants.findIndex(r => r.slug === cachedSlug);
    if (idx < 0) return;
    const r = state.restaurants[idx];
    if (normEmail(r.ownerEmail) === email || normEmail(r.ownerEmail)) return;
    r.ownerEmail = email;
    db.child("restaurants").child(String(idx)).child("ownerEmail").set(email);
    db.child("ownerIndex").child(cachedSlug).set(email);
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
    next.billingArchive = next.billingArchive || [];
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

  // Rolls completed orders older than ORDER_RETENTION_DAYS into ONE summary
  // per restaurant + calendar month (not per day — a restaurant open for
  // years ends up with a few dozen archive rows instead of thousands), then
  // hard-deletes the raw order records. Each archive entry carries a single
  // human-readable text passage plus the handful of numbers needed to keep
  // totals accurate; safe to call repeatedly — merges into the same month's
  // entry instead of duplicating it. Returns true if anything was archived.
  function monthLabel(month) {
    return new Date(month + "-01T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  }

  function buildArchiveSummaryText(entry) {
    const grand = entry.upiTotal + entry.cashTotal;
    return `${monthLabel(entry.month)}: ${entry.totalOrders} orders closed, ₹${grand.toLocaleString("en-IN")} collected total `
      + `(UPI ${entry.upiOrders} orders · ₹${entry.upiTotal.toLocaleString("en-IN")}, Cash ${entry.cashOrders} orders · ₹${entry.cashTotal.toLocaleString("en-IN")}).`;
  }

  function archiveOldOrders(s) {
    s.billingArchive = s.billingArchive || [];
    const cutoff = Date.now() - days(ORDER_RETENTION_DAYS);
    const toArchive = (s.orders || []).filter(o => o.status === "completed" && o.createdAt < cutoff);
    if (!toArchive.length) return false;

    const groups = {};
    toArchive.forEach(o => {
      const month = new Date(o.createdAt).toISOString().slice(0, 7); // YYYY-MM
      const gKey = o.restaurantSlug + "|" + month;
      (groups[gKey] = groups[gKey] || { restaurantSlug: o.restaurantSlug, month, orders: [] }).orders.push(o);
    });

    Object.values(groups).forEach(g => {
      const upi = g.orders.filter(o => o.paymentStatus === "paid");
      const cash = g.orders.filter(o => o.paymentStatus === "cash_accepted");
      let entry = s.billingArchive.find(a => a.restaurantSlug === g.restaurantSlug && a.month === g.month);
      if (!entry) {
        entry = { id: uid(), restaurantSlug: g.restaurantSlug, month: g.month, totalOrders: 0, upiOrders: 0, upiTotal: 0, cashOrders: 0, cashTotal: 0, summary: "", archivedAt: Date.now() };
        s.billingArchive.push(entry);
      }
      entry.totalOrders += g.orders.length;
      entry.upiOrders += upi.length;
      entry.upiTotal += upi.reduce((s2, o) => s2 + o.total, 0);
      entry.cashOrders += cash.length;
      entry.cashTotal += cash.reduce((s2, o) => s2 + o.total, 0);
      entry.archivedAt = Date.now();
      entry.summary = buildArchiveSummaryText(entry); // single passage, regenerated from the running totals
    });

    const purgeIds = new Set(toArchive.map(o => o.id));
    s.orders = (s.orders || []).filter(o => !purgeIds.has(o.id));
    return true;
  }

  function save(next) {
    const prev = clone(state);
    state = clone(next || state);
    archiveOldOrders(state);
    checkNewOrders(state);
    if (firebaseMode && db) {
      // Never write meta/admins, and never rewrite unchanged nodes. This keeps
      // one screen with stale local data from overwriting admin updates made
      // from another screen.
      if (changed(prev.restaurants, state.restaurants)) syncArrayNode("restaurants", prev.restaurants, state.restaurants);
      if (changed(prev.orders, state.orders)) syncArrayNode("orders", prev.orders, state.orders);
      if (changed(prev.feedbacks, state.feedbacks)) syncArrayNode("feedbacks", prev.feedbacks, state.feedbacks);
      if (currentUser && changed(prev.billingArchive, state.billingArchive)) syncArrayNode("billingArchive", prev.billingArchive, state.billingArchive);
    }
    render();
  }

  function changed(a, b) {
    return JSON.stringify(a || []) !== JSON.stringify(b || []);
  }

  function syncArrayNode(path, prevArr, nextArr) {
    prevArr = prevArr || [];
    nextArr = nextArr || [];
    // When prevArr is empty write each item to its own $index.
    // Parent-level .set() is blocked because there is no parent .write rule.
    if (prevArr.length === 0) {
      nextArr.forEach((item, i) => db.child(path).child(String(i)).set(item));
      return;
    }
    const appendOnly = nextArr.length === prevArr.length + 1 && prevArr.every((item, i) => {
      const after = nextArr[i] || {};
      return (item.id && item.id === after.id) || (item.slug && item.slug === after.slug);
    });
    if (appendOnly) {
      // Write directly to the next numeric index instead of a transaction on the
      // parent node. Firebase rules only define .write at $index level — a
      // transaction on the parent is denied because there is no parent .write rule.
      const item = nextArr[nextArr.length - 1];
      db.child(path).once("value").then(snap => {
        const current = snap.val();
        const base = (current && typeof current === "object" && !Array.isArray(current))
          ? Object.values(current).filter(Boolean)
          : (Array.isArray(current) ? current : []);
        const key = item.id ? "id" : item.slug ? "slug" : "";
        if (key && base.some(x => x && x[key] === item[key])) return; // duplicate guard
        db.child(path).child(String(base.length)).set(item);
      });
      return;
    }
    const sameShape = prevArr.length === nextArr.length && nextArr.every((item, i) => {
      const before = prevArr[i] || {};
      return (item.id && item.id === before.id) || (item.slug && item.slug === before.slug);
    });
    if (!sameShape) {
      // Shape changed (deletions or reorders) — write per-index.
      // Parent-level .set() is blocked because there is no parent .write rule.
      nextArr.forEach((item, i) => db.child(path).child(String(i)).set(item));
      // Remove stale indexes beyond the new length — without this, deleted items
      // remain in Firebase and get read back on the next listener fire.
      for (let i = nextArr.length; i < prevArr.length; i++) {
        db.child(path).child(String(i)).remove();
      }
      return;
    }
    nextArr.forEach((item, i) => {
      if (changed(prevArr[i], item)) db.child(path).child(String(i)).set(item);
    });
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
    // In Firebase mode require a signed-in user; in local mode the slug alone is enough
    if (slug && (firebaseMode ? !!currentUser : true)) return slug;
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
      customize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87 2 2 0 1 1-2.83 2.83 1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.55V20a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34 2 2 0 1 1-2.83-2.83 1.7 1.7 0 0 0 .34-1.87A1.7 1.7 0 0 0 4.1 13.5H4a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87 2 2 0 1 1 2.83-2.83 1.7 1.7 0 0 0 1.87.34H10a1.7 1.7 0 0 0 1.03-1.55V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.87-.34 2 2 0 1 1 2.83 2.83 1.7 1.7 0 0 0-.34 1.87V10c.14.62.58 1.13 1.1 1.4"/></svg>`,
      review: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`
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
    const isMr = localStorage.getItem("restoqr_lang") === "mr";

    // If owner is logged in, show their panel button instead of generic login
    let heroActions;
    if (firebaseMode && currentUser) {
      if (isAdmin(currentUser)) {
        heroActions = `
          <a class="btn primary" href="#/admin">${isMr ? "अ‍ॅडमिन डॅशबोर्ड" : "Admin Dashboard"}</a>
          <button class="btn" data-action="auth-signout">${isMr ? "साइन आउट" : "Sign Out"}</button>`;
      } else {
        const ownerSlug = ownerSlugForUser(currentUser);
        const ownerResto = ownerSlug ? bySlug(ownerSlug) : null;
        heroActions = ownerResto
          ? `<a class="btn primary" href="#/owner?resto=${ownerSlug}">${isMr ? esc(ownerResto.name) + " पॅनेल" : "Go to " + esc(ownerResto.name) + " Panel"}</a>
             <button class="btn" data-action="auth-signout">${isMr ? "साइन आउट" : "Sign Out"}</button>`
          : `<a class="btn primary" href="#/register">${isMr ? "रेस्टॉरंट नोंदणी" : "Register Restaurant"}</a>
             <a class="btn" href="#/owner">${isMr ? "मालक लॉगिन" : "Restaurant Login"}</a>
             <button class="btn" data-action="auth-signout">${isMr ? "साइन आउट" : "Sign Out"}</button>`;
      }
    } else {
      heroActions = `
        <a class="btn primary" href="#/register">${isMr ? "रेस्टॉरंट नोंदणी करा" : "Register Restaurant"}</a>
        <a class="btn" href="#/owner">${isMr ? "मालक लॉगिन" : "Restaurant Login"}</a>
        <a class="btn ghost" href="#/admin">${isMr ? "सुपर अ‍ॅडमिन" : "Super Admin"}</a>`;
    }

    return `
      ${topbar("home")}
      
      <main class="hero">
        <div class="hero-inner">
          <section class="media-carousel">
          <div class="carousel-container">
            <div class="carousel-track">
          
              <div class="carousel-slide">
                <img src="assets/demo1.png" alt="Restaurant Demo">
              </div>
              <div class="carousel-slide">
                <img src="assets/demo2.png" alt="Restaurant Demo">
              </div>
              <div class="carousel-slide">
                <img src="assets/demo3.png" alt="Restaurant Demo">
              </div>
              <div class="carousel-slide">
                <img src="assets/demo4.png" alt="Restaurant Demo">
              </div>
              <div class="carousel-slide">
                <img src="assets/demo5.png" alt="Restaurant Demo" style="width:100%">
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

      <!-- ✅ AI REVIEW ASSISTANT BANNER -->
      <section class="ai-review-banner">
        <div class="ai-review-banner-inner">
          <div class="ai-review-banner-left">
            <div class="ai-review-label">⭐ ${isMr ? "AI रिव्ह्यू असिस्टंट" : "AI Review Assistant"}</div>
            <h2 class="ai-review-title">${isMr ? "जेवण झाले? AI रिव्ह्यू एका क्लिकमध्ये!" : "Meal Done? Get a Google Review in One Tap!"}</h2>
            <p class="ai-review-sub">${isMr ? "ग्राहक जेवणानंतर rating देतो — AI त्याच्या भाषेत छान review तयार करतो. ग्राहक Google वर paste करतो — तुमची rating वाढते, demand वाढते!" : "After every meal, customers rate their experience. Our AI instantly crafts a personalised review in their words. One tap to Google — and your restaurant's reputation soars."}</p>
            <div class="ai-review-steps">
              <div class="ai-review-step">
                <span class="ai-review-step-num">1</span>
                <span>${isMr ? "ग्राहक QR scan करून rating देतो" : "Customer scans QR &amp; rates experience"}</span>
              </div>
              <div class="ai-review-step">
                <span class="ai-review-step-num">2</span>
                <span>${isMr ? "AI त्यांच्यासाठी personalized review तयार करतो" : "AI generates a personalised review for them"}</span>
              </div>
              <div class="ai-review-step">
                <span class="ai-review-step-num">3</span>
                <span>${isMr ? "ग्राहक एका tap मध्ये Google वर post करतो" : "Customer posts it to Google in one tap"}</span>
              </div>
              <div class="ai-review-step">
                <span class="ai-review-step-num">4</span>
                <span>${isMr ? "तुमची rating वाढते, नवे ग्राहक येतात!" : "Your rating climbs — new customers discover you!"}</span>
              </div>
            </div>
            <div class="ai-review-stats">
              <div class="ai-review-stat"><strong>3×</strong><span>${isMr ? "जास्त reviews" : "More Reviews"}</span></div>
              <div class="ai-review-stat"><strong>4.8★</strong><span>${isMr ? "सरासरी rating" : "Avg Rating"}</span></div>
              <div class="ai-review-stat"><strong>60%</strong><span>${isMr ? "जास्त नवे ग्राहक" : "More Footfall"}</span></div>
            </div>
          </div>
          <div class="ai-review-banner-right">
            <div class="ai-review-phone-mock">
              <div class="ai-review-phone-screen">
                <div class="ai-review-phone-header">⭐ ${isMr ? "तुमचा अनुभव कसा होता?" : "How was your experience?"}</div>
                <div class="ai-review-stars">⭐⭐⭐⭐⭐</div>
                <div class="ai-review-phone-bubble">
                  <div class="ai-review-bubble-label">🤖 ${isMr ? "AI ने तयार केलेला review" : "AI-generated review"}</div>
                  <p>${isMr ? "\"Catalis Cafe मध्ये जेवण खूप छान होतं! Paneer Tikka एकदम मस्त आणि service जलद होती. नक्की परत येणार! 🍽️\"" : "\"Catalis Cafe was amazing! The Paneer Tikka was perfectly spiced and the service was lightning fast. Highly recommend — will definitely be back! 🍽️\""}</p>
                </div>
                <div class="ai-review-phone-cta">
                  <button class="ai-review-google-btn">🔍 ${isMr ? "Google वर Post करा" : "Post on Google"}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ✅ WHY RESTOQR BANNER -->
      <section class="why-restoqr-section">
        <div class="why-restoqr-inner">
          <p class="eyebrow center" style="color:#ff6b00">${isMr ? "आम्ही का चांगले आहोत?" : "Why Choose RestoQR?"}</p>
          <h2 style="text-align:center;margin-bottom:10px">${isMr ? "महाराष्ट्रातून बनवलेले — रेस्टॉरंटसाठी सर्वात स्वस्त आणि हुशार सॉफ्टवेअर" : "Made in Maharashtra — Smartest & Most Affordable Restaurant Software"}</h2>
          <p style="text-align:center;color:#6b7280;margin-bottom:40px;max-width:600px;margin-left:auto;margin-right:auto">${isMr ? "इतरांपेक्षा कमी किमतीत, जास्त सुविधा — AI सह, मराठीत!" : "More features, lower price than competitors — powered by AI, built for Bharat."}</p>
          <div class="why-grid">
            <div class="why-card why-card-orange">
              <div class="why-card-icon">💰</div>
              <h3>${isMr ? "फक्त ₹999/महिना" : "Only ₹999/month"}</h3>
              <p>${isMr ? "इतर apps ₹3000–₹8000 घेतात. आम्ही फक्त ₹999 मध्ये सर्व सुविधा देतो." : "Competitors charge ₹3,000–₹8,000/mo. We give you everything for just ₹999."}</p>
              <div class="why-compare-tag">${isMr ? "80% स्वस्त" : "80% cheaper"}</div>
            </div>
            <div class="why-card why-card-purple">
              <div class="why-card-icon">🤖</div>
              <h3>${isMr ? "AI सहाय्यक — फ्री!" : "AI Assistant — Free!"}</h3>
              <p>${isMr ? "तुमच्या विक्रीचे विश्लेषण करा, बेस्टसेलर शोधा, स्टॉक प्लान करा — सगळं मराठीत विचारा!" : "Ask your sales data anything in plain language. Best sellers, stock planning, revenue trends — all AI powered."}</p>
              <div class="why-compare-tag">${isMr ? "इतर apps मध्ये नाही" : "Not in rival apps"}</div>
            </div>
            <div class="why-card why-card-green">
              <div class="why-card-icon">📱</div>
              <h3>${isMr ? "कोणतेही app डाउनलोड नाही" : "No App Download Needed"}</h3>
              <p>${isMr ? "ग्राहक थेट QR scan करून order देतात. कोणताही app नाही, कोणताही account नाही — एकदम सोपे!" : "Customers scan a QR and order instantly. No app, no signup, no friction — works on any phone."}</p>
              <div class="why-compare-tag">${isMr ? "झटपट सुरुवात" : "Instant setup"}</div>
            </div>
            <div class="why-card why-card-blue">
              <div class="why-card-icon">⚡</div>
              <h3>${isMr ? "रिअल-टाइम ऑर्डर" : "Real-Time Orders"}</h3>
              <p>${isMr ? "नवीन order येताच आवाज येतो. स्वयंपाकघर, वेटर आणि काउंटर सगळे एकाच वेळी अपडेट!" : "Audio alerts on new orders. Kitchen, floor staff, and billing all in sync — no shouting across the room."}</p>
              <div class="why-compare-tag">${isMr ? "लाइव्ह अपडेट" : "Live updates"}</div>
            </div>
            <div class="why-card" style="background:linear-gradient(135deg,#fff8e1,#fef3c7);border:1.5px solid #fcd34d;grid-column:1/-1">
              <div style="display:flex;align-items:flex-start;gap:18px;flex-wrap:wrap">
                <div style="font-size:34px">⭐</div>
                <div style="flex:1;min-width:200px">
                  <h3 style="margin:0 0 8px">${isMr ? "AI Google Review असिस्टंट — Demand वाढवा!" : "AI Google Review Assistant — Boost Your Demand!"}</h3>
                  <p style="margin:0;font-size:14px;color:#4b5563;line-height:1.55">${isMr ? "जेवण झाल्यावर ग्राहक rating देतो. AI लगेच personalized review तयार करतो. ग्राहक Google वर एका tap मध्ये post करतो — तुमची rating वाढते, नवे ग्राहक येतात, sales वाढते!" : "After every meal, customers rate their experience. Our AI instantly crafts a personalised review in their own words — they post it to Google in one tap. More reviews = higher ranking = more customers walking through your door."}</p>
                </div>
                <div class="why-compare-tag" style="background:rgba(234,179,8,.15);color:#92400e;align-self:center;white-space:nowrap">${isMr ? "3× जास्त reviews" : "3× More Reviews"}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- ✅ COMPETITOR COMPARISON TABLE -->
      <section class="comparison-section">
        <div class="comparison-inner">
          <p class="eyebrow center">${isMr ? "तुलना करा" : "Compare"}</p>
          <h2 style="text-align:center;margin-bottom:32px">${isMr ? "RestoQR vs बाकी सॉफ्टवेअर" : "RestoQR vs The Rest"}</h2>
          <div class="comparison-table-wrap">
            <table class="comparison-table">
              <thead>
                <tr>
                  <th>${isMr ? "सुविधा" : "Feature"}</th>
                  <th class="col-us">RestoQR ✅</th>
                  <th>${isMr ? "स्पर्धक १" : "Competitor 1"}</th>
                  <th>${isMr ? "स्पर्धक २" : "Competitor 2"}</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>${isMr ? "मासिक किंमत" : "Monthly Price"}</td><td class="col-us">₹999</td><td>₹3,500+</td><td>₹5,000+</td></tr>
                <tr><td>${isMr ? "AI सहाय्यक" : "AI Assistant"}</td><td class="col-us">✅ ${isMr ? "फ्री" : "Free"}</td><td>❌</td><td>❌</td></tr>
                <tr><td>${isMr ? "AI Google Review" : "AI Review Generator"}</td><td class="col-us">✅ ${isMr ? "ऑटो-generate" : "Auto-Generate"}</td><td>❌</td><td>❌</td></tr>
                <tr><td>${isMr ? "QR ऑर्डरिंग" : "QR Table Ordering"}</td><td class="col-us">✅</td><td>✅</td><td>✅</td></tr>
                <tr><td>${isMr ? "App Install लागत नाही" : "No Customer App"}</td><td class="col-us">✅</td><td>❌</td><td>❌</td></tr>
                <tr><td>${isMr ? "मराठी भाषा" : "Marathi Language"}</td><td class="col-us">✅</td><td>❌</td><td>❌</td></tr>
                <tr><td>${isMr ? "स्टाफ मॅनेजमेंट" : "Staff Management"}</td><td class="col-us">✅</td><td>✅</td><td>✅</td></tr>
                <tr><td>${isMr ? "Google Review" : "Google Review Link"}</td><td class="col-us">✅</td><td>❌</td><td>❌</td></tr>
                <tr><td>${isMr ? "Setup वेळ" : "Setup Time"}</td><td class="col-us">${isMr ? "५ मिनिटे" : "5 minutes"}</td><td>${isMr ? "२–३ दिवस" : "2–3 days"}</td><td>${isMr ? "१ आठवडा" : "1 week"}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- ✅ AI HIGHLIGHT BANNER -->
      <section class="ai-highlight-section">
        <div class="ai-highlight-inner">
          <div class="ai-highlight-badge">🤖 ${isMr ? "AI पावर्ड" : "AI Powered"}</div>
          <h2>${isMr ? "तुमच्या रेस्टॉरंटचा डेटा, आता तुमच्या भाषेत" : "Your Restaurant Data, Now Speaks to You"}</h2>
          <p>${isMr ? "\"या आठवड्यातील बेस्टसेलर कोणता?\" — असे विचारा आणि AI सेकंदात उत्तर देईल. कुठलाही spreadsheet नाही, कुठलाही त्रास नाही." : "Ask \"What's my best seller this week?\" or \"How much revenue did I make today?\" — our AI answers instantly. No spreadsheets, no counting."}</p>
          <div class="ai-queries-grid">
            <div class="ai-query-chip">📊 ${isMr ? "\"आजचा महसूल किती?\"" : "\"What's today's revenue?\""}</div>
            <div class="ai-query-chip">🍽️ ${isMr ? "\"कोणता item जास्त विकतो?\"" : "\"Which dish sells most?\""}</div>
            <div class="ai-query-chip">📦 ${isMr ? "\"उद्यासाठी stock किती लागेल?\"" : "\"How much stock for tomorrow?\""}</div>
            <div class="ai-query-chip">📈 ${isMr ? "\"या महिन्यात वाढ झाली का?\"" : "\"Did revenue grow this month?\""}</div>
          </div>
        </div>
      </section>



      <!-- ✅ FEATURE SECTION (original, enhanced) -->
      <section class="feature-section">
        <div class="feature-section-inner">
          <div class="feature-head">
            <p class="eyebrow center">${isMr ? "तुम्हाला काय मिळते" : "What you get"}</p>
            <h2>${isMr ? "काउंटरला जे हवे ते सगळे — उगाच जास्त नाही." : "Everything a counter needs, nothing it doesn't."}</h2>
            <p>${isMr ? "टेबल ते बिल — पाच गोष्टी, सगळं कव्हर." : "Five powerful features cover the whole table-to-bill flow."}</p>
          </div>
          <div class="grid-4">
            ${featureCard("scan", isMr ? "स्कॅन करा & ऑर्डर द्या" : "Scan & order", isMr ? "प्रत्येक टेबलला एक QR. ग्राहक लाइव्ह मेनू बघून थेट फोनवरून ऑर्डर देतात." : "Each table gets one QR. Customers see the live menu and order straight from their phone.")}
            ${featureCard("orders", isMr ? "प्रत्येक ऑर्डर ट्रॅक करा" : "Track every order", isMr ? "नवीन ऑर्डर रिअल-टाइम येतात, किचनला जातात, पेमेंट काउंटरवर confirm होते." : "Watch new orders land in real time, move them through prep, and confirm payment at the counter.")}
            ${featureCard("growth", isMr ? "परत येणारे ग्राहक" : "Built for repeat visits", isMr ? "प्रत्येक ऑर्डरनंतर रेटिंग घ्या — खूश ग्राहक थेट Google Review वर जातात." : "Collect a rating after every order and route happy customers straight to your Google listing.")}
            ${featureCard("customize", isMr ? "तुमच्या मनासारखे बनवा" : "Make it yours", isMr ? "Categories, add-ons, QR codes — मिनिटांत सेट करा. कोणत्याही designer ची गरज नाही." : "Add categories, add-ons, and table QR codes in minutes — no designer or developer needed.")}
          </div>
          <!-- AI Review Feature — Full-width highlight card -->
          <div class="ai-review-feature-card">
            <div class="ai-review-feature-icon">${icon("review")}</div>
            <div class="ai-review-feature-body">
              <div class="ai-review-feature-badge">⭐ ${isMr ? "नवीन AI फीचर" : "New AI Feature"}</div>
              <h3>${isMr ? "AI Google Review Generator — Sales & Demand वाढवा" : "AI Google Review Generator — Grow Sales & Demand"}</h3>
              <p>${isMr ? "जेवणानंतर ग्राहक 1-tap rating देतो. AI त्याच्यासाठी personalized Google review तयार करतो. ग्राहक copy करतो आणि Google वर post करतो — तुमची rating वाढते, नवे ग्राहक येतात, revenue वाढते. इतर कुठल्याही restaurant software मध्ये हे नाही!" : "After every meal, customers give a 1-tap rating. AI instantly writes a personalised Google review for them — they copy and post it in seconds. Your star rating climbs, you rank higher on Google Maps, new customers discover you, and your revenue grows. No other restaurant software does this."}</p>
              <div class="ai-review-feature-pills">
                <span>⭐ ${isMr ? "Higher Google Rating" : "Higher Google Rating"}</span>
                <span>📈 ${isMr ? "जास्त Footfall" : "More Footfall"}</span>
                <span>💰 ${isMr ? "जास्त Sales" : "More Sales"}</span>
                <span>🤖 ${isMr ? "पूर्ण AI Automated" : "Fully AI Automated"}</span>
              </div>
            </div>
          </div>
        </div>
      </section>



      <!-- ✅ OWNER GUIDE STRIP (original) -->
      <section class="guide-strip">
        <div class="guide-strip-inner">
          <div class="guide-strip-head">
            <div>
              <p class="eyebrow">${isMr ? "मालक मार्गदर्शिका" : "Owner Guide"}</p>
              <h3>${isMr ? "एका वेळी एक slide — सगळं समजेल." : "Everything you need to know, one slide at a time."}</h3>
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
                <div class="guide-card-tag">${isMr ? "QR ऑर्डरिंग" : "QR Ordering"}</div>
                <h4>${isMr ? "ग्राहक स्वतःच्या फोनवरून scan करून order देतात" : "Customers scan &amp; order from their own phone"}</h4>
                <p>${isMr ? "प्रत्येक टेबलला unique QR code. ग्राहक लाइव्ह मेनू बघून order देतात — कोणताही app नाही, waiter लिहित नाही." : "Each table gets a unique QR code. Customers browse your live menu and place orders — no app, no waiter needed to write it down."}</p>
                <ul class="guide-steps">
                  <li>${isMr ? "Owner Panel → QR Codes tab मधून print करा" : "Print QR codes from Owner Panel → QR Codes tab"}</li>
                  <li>${isMr ? "ग्राहक scan करतो → मेनू बघतो → order confirm करतो" : "Customer scans → browses menu → confirms order"}</li>
                  <li>${isMr ? "Order लगेच Kitchen screen वर दिसतो" : "Order appears instantly on your Kitchen screen"}</li>
                  <li>${isMr ? "प्रत्येक नवीन order साठी आवाज येतो 🔔" : "You get an audio alert for every new order 🔔"}</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#7B4FD4;--accent-pale:#F0EAFF">
                <div class="guide-card-icon">🤖</div>
                <div class="guide-card-tag">${isMr ? "AI सहाय्यक" : "AI Assistant"}</div>
                <h4>${isMr ? "तुमच्या sales data ला साध्या भाषेत विचारा" : "Ask your sales data anything in plain language"}</h4>
                <p>${isMr ? "Owner page वरील AI button दाबा आणि सहकाऱ्याला विचाराल तसे विचारा — कोणताही spreadsheet नाही." : "The floating AI button on every owner page lets you ask questions like you'd ask a colleague — no spreadsheets needed."}</p>
                <ul class="guide-steps">
                  <li>${isMr ? "\"या आठवड्यातील बेस्टसेलर कोणता?\"" : "\"What was my best seller this week?\""}</li>
                  <li>${isMr ? "\"उद्यासाठी किती chicken लागेल?\"" : "\"How much chicken do I need tomorrow?\""}</li>
                  <li>${isMr ? "\"कोणते items कमी order होतात?\"" : "\"Which items are rarely ordered?\""}</li>
                  <li>${isMr ? "\"या आठवड्याचा vs मागील आठवड्याचा महसूल\"" : "\"Compare this week vs last week revenue\""}</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#2B6FFF;--accent-pale:#E6EEFF">
                <div class="guide-card-icon">📊</div>
                <div class="guide-card-tag">${isMr ? "Analytics & Billing" : "Analytics & Billing"}</div>
                <h4>${isMr ? "तुमचे आकडे, नेहमी अपडेट" : "Your numbers, always up to date"}</h4>
                <p>${isMr ? "Revenue, top items, payment status — कोणताही manual counting नाही. एका tap मध्ये filter करा आणि print करा." : "Track revenue, top items, and payment status without any manual counting. Filter by date and print records in one tap."}</p>
                <ul class="guide-steps">
                  <li>${isMr ? "Overview tab — आजचा महसूल आणि top sellers" : "Overview tab shows today's revenue and top sellers"}</li>
                  <li>${isMr ? "Billing tab — कोणत्याही तारखेसाठी filter" : "Billing tab lets you filter by any date range"}</li>
                  <li>${isMr ? "Cash Paid किंवा UPI Paid — लगेच mark करा" : "Mark orders as Cash Paid or UPI Paid instantly"}</li>
                  <li>${isMr ? "कोणत्याही order चे receipt print करा" : "Print receipts directly from any order"}</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#2D9B6F;--accent-pale:#E6F7F0">
                <div class="guide-card-icon">🔑</div>
                <div class="guide-card-tag">${isMr ? "स्टाफ Access" : "Staff Access"}</div>
                <h4>${isMr ? "आपले login share न करता टीमला access द्या" : "Give your team access without sharing your login"}</h4>
                <p>${isMr ? "Settings मधून Master Key बनवा आणि staff ला share करा. त्यांना Kitchen, Floor Plan आणि Billing — बाकी काही नाही." : "Generate a Master Key from Settings and share it with staff. They get Kitchen, Floor Plan, and Billing — nothing else."}</p>
                <ul class="guide-steps">
                  <li>${isMr ? "Owner Panel → Settings → Master Key Generate करा" : "Owner Panel → Settings → Generate Master Key"}</li>
                  <li>${isMr ? "WhatsApp वरून टीमला key share करा" : "Share the key with your team via WhatsApp"}</li>
                  <li>${isMr ? "Staff एकदा enter करतात — झाले!" : "Staff enter it once on their device — done"}</li>
                  <li>${isMr ? "Regenerate करा — जुना access लगेच बंद" : "Regenerate anytime to revoke old access instantly"}</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#FF6B2B;--accent-pale:#FFF0E9">
                <div class="guide-card-icon">🏪</div>
                <div class="guide-card-tag">${isMr ? "Owner Panel" : "Owner Panel"}</div>
                <h4>${isMr ? "एका screen वरून संपूर्ण रेस्टॉरंट चालवा" : "Run your entire restaurant from one screen"}</h4>
                <p>${isMr ? "एकदा login करा आणि signed in राहा. मेनू, orders, billing, QR codes, आणि AI — सगळं एका tab मध्ये." : "Log in once with your email and stay signed in. Every tool you need is one tab away — menu, orders, billing, QR codes, and AI."}</p>
                <ul class="guide-steps">
                  <li>${isMr ? "Menu tab — items, prices, addons, categories add करा" : "Menu tab — add items, prices, addons, categories"}</li>
                  <li>${isMr ? "Orders tab — table आणि item details सह live view" : "Orders tab — live view with table and item details"}</li>
                  <li>${isMr ? "QR Codes tab — table codes download आणि print करा" : "QR Codes tab — download and print table codes"}</li>
                  <li>${isMr ? "Settings tab — माहिती update करा, staff key manage करा" : "Settings tab — update info and manage staff key"}</li>
                </ul>
              </div>

              <div class="guide-card" style="--accent:#f59e0b;--accent-pale:#fffbeb">
                <div class="guide-card-icon">⭐</div>
                <div class="guide-card-tag">${isMr ? "AI Review Generator" : "AI Review Generator"}</div>
                <h4>${isMr ? "ग्राहकांना Google Review देणे सोपे करा — Sales वाढवा" : "Make it effortless for customers to leave Google Reviews — Boost Sales"}</h4>
                <p>${isMr ? "जेवण झाल्यावर ग्राहक rating देतो. AI लगेच त्यांच्यासाठी personalized review लिहितो. ग्राहक paste करतो, Google वर post करतो — तुमची star rating वाढते, नवे ग्राहक येतात!" : "After every meal, the customer rates their experience. Our AI instantly writes a personalised review for them. They paste and post it to Google in seconds — your star rating goes up, your Google Maps rank improves, and new customers walk in."}</p>
                <ul class="guide-steps">
                  <li>${isMr ? "ग्राहक order नंतर rating screen वर rating देतो" : "Customer gives a star rating on the post-order screen"}</li>
                  <li>${isMr ? "AI त्यांच्यासाठी personalized Google review तयार करतो" : "AI generates a personalised Google review for them instantly"}</li>
                  <li>${isMr ? "ग्राहक review copy करतो आणि Google वर paste करतो" : "Customer copies the review and pastes it on Google"}</li>
                  <li>${isMr ? "तुमची rating वाढते → नवे ग्राहक → जास्त revenue! 🚀" : "Your rating climbs → more new customers → higher revenue! 🚀"}</li>
                </ul>
              </div>

            </div>
          </div>
          <div class="guide-dots"></div>
        </div>
      </section>

      <!-- ✅ PRICING SECTION -->
      <section class="pricing-section">
        <div class="pricing-inner">
          <p class="eyebrow center">${isMr ? "किंमत" : "Pricing"}</p>
          <h2 style="text-align:center;margin-bottom:8px">${isMr ? "सोपे, स्वस्त, कोणत्याही hidden charge शिवाय" : "Simple, Affordable — No Hidden Charges"}</h2>
          <p style="text-align:center;color:#6b7280;margin-bottom:40px">${isMr ? "एकाच plan मध्ये सगळ्या सुविधा — AI सह!" : "One plan, all features — AI included!"}</p>
          <div class="pricing-cards-row">
            <div class="pricing-card pricing-card-highlight">
              <div class="pricing-badge">${isMr ? "सर्वात लोकप्रिय" : "Most Popular"}</div>
              <div class="pricing-amount">₹999<span>/${isMr ? "महिना" : "mo"}</span></div>
              <div class="pricing-name">${isMr ? "मासिक प्लॅन" : "Monthly Plan"}</div>
              <ul class="pricing-features">
                <li>✅ ${isMr ? "Unlimited QR ऑर्डर" : "Unlimited QR Orders"}</li>
                <li>✅ ${isMr ? "AI सहाय्यक — फ्री!" : "AI Assistant — Free!"}</li>
                <li>✅ ${isMr ? "AI Google Review Generator" : "AI Google Review Generator"}</li>
                <li>✅ ${isMr ? "रिअल-टाइम किचन अलर्ट" : "Real-time Kitchen Alerts"}</li>
                <li>✅ ${isMr ? "Billing & Analytics" : "Billing & Analytics"}</li>
                <li>✅ ${isMr ? "Staff Management" : "Staff Management"}</li>
                <li>✅ ${isMr ? "Google Review Integration" : "Google Review Integration"}</li>
                <li>✅ ${isMr ? "मराठी भाषा सपोर्ट" : "Marathi Language Support"}</li>
                <li>✅ ${isMr ? "WhatsApp Support" : "WhatsApp Support"}</li>
              </ul>
              <a class="btn primary block" href="#/register" style="margin-top:24px;text-align:center">${isMr ? "आता सुरू करा" : "Get Started Now"}</a>
            </div>
          </div>
        </div>
      </section>

      <!-- ✅ MAHARASHTRA PRIDE BANNER -->
      <section class="maha-banner">
        <div class="maha-banner-bg-text">महाराष्ट्र</div>
        <div class="maha-banner-inner">
          <div class="maha-banner-flag">🧡 🤍 🟢</div>
          <h2 class="maha-banner-title">
            ${isMr
              ? "महाराष्ट्रीयन अभिमानाने बनवले — महाराष्ट्रीयन लोकांसाठी"
              : "Made with Maharashtrian Pride — For Maharashtrian People"}
          </h2>
          <p class="maha-banner-sub">
            ${isMr
              ? "इतर कोणत्याही स्पर्धकापेक्षा चांगले आणि स्वस्त — हे आमचे वचन आहे."
              : "Better and cheaper than any other competition — that's our promise."}
          </p>
          <a class="btn primary maha-banner-cta" href="#/register">
            ${isMr ? "आजच सुरू करा →" : "Get Started Today →"}
          </a>
        </div>
      </section>

      <!-- ✅ FLOATING CUSTOMER SUPPORT BUTTON -->
      <div id="support-btn-wrap" style="position:fixed;bottom:28px;left:24px;z-index:500;display:flex;flex-direction:column;align-items:flex-start;gap:10px">
        <div id="support-popup" style="display:none;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.18);padding:20px 22px;min-width:240px;border:1.5px solid #f0ede8">
          <p style="margin:0 0 4px;font-weight:800;font-size:15px;color:#1c0e04">${isMr ? "📞 आम्हाला कॉल करा" : "📞 Call / WhatsApp Us"}</p>
          <p style="margin:0 0 12px;font-size:12px;color:#9ca3af">${isMr ? "सोम–शनि, सकाळी १० – रात्री ८" : "Mon–Sat, 10 AM – 8 PM"}</p>
          <a href="tel:7972736023" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:#1c0e04;font-weight:700;font-size:14px;padding:10px 14px;background:#fff7ed;border-radius:10px;margin-bottom:8px">
            📱 7972736023
          </a>
          <a href="tel:7887584140" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:#1c0e04;font-weight:700;font-size:14px;padding:10px 14px;background:#fff7ed;border-radius:10px;margin-bottom:12px">
            📱 7887584140
          </a>
          <a href="https://wa.me/917972736023" target="_blank" style="display:flex;align-items:center;justify-content:center;gap:8px;text-decoration:none;background:#25D366;color:#fff;font-weight:700;font-size:13px;padding:10px 14px;border-radius:10px">
            💬 ${isMr ? "WhatsApp वर chat करा" : "Chat on WhatsApp"}
          </a>
        </div>
        <button onclick="(function(){var p=document.getElementById('support-popup');p.style.display=p.style.display==='none'?'block':'none';})()" style="display:flex;align-items:center;gap:8px;background:#ff6b00;color:#fff;border:none;border-radius:999px;padding:13px 20px;font-weight:800;font-size:14px;cursor:pointer;box-shadow:0 8px 24px rgba(255,107,0,.4);transition:transform .15s" onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
          💬 ${isMr ? "मदत हवी आहे?" : "Need Help?"}
        </button>
      </div>

  `;
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
    // Firebase mode: if not logged in, show login immediately
    if (firebaseMode && !currentUser) return authLoginView("owner");

    const requestedSlug = params.get("resto") || "";
    const cachedSlug = firebaseMode && currentUser ? cachedOwnerSlugForUser(currentUser) : "";
    const instantSlug = requestedSlug || cachedSlug;
    const instantResto = instantSlug ? bySlug(instantSlug) : null;

    if (firebaseMode && currentUser) {
      const linkedSlug = ownerSlugForUser(currentUser);
      const adminUser  = isAdmin(currentUser);

      // State may not have loaded yet from Firebase DB listener — show a spinner
      // instead of "restaurant not found" which confuses owners on hard refresh.
      if (!instantResto && (!firebaseDataLoaded || (!linkedSlug && !adminUser && !_adminCheckInFlight && state.restaurants.length === 0))) {
        return loadingOwnerView();
      }

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

    const slug = requestedSlug || (firebaseMode && currentUser ? ownerSlugForUser(currentUser) : null) || cachedSlug || localStorage.getItem("restoqr_owner_slug") || (state.restaurants[0]?.slug || "");

    // Persist slug so refreshes don't lose context in local mode.
    // In Firebase mode we only remember it after access is verified below.
    if (slug && !firebaseMode) rememberOwnerLink(slug);

    const r = bySlug(slug);
    if (!r) {
      // In Firebase mode with a signed-in user but no match yet, show spinner
      // (DB listener might still be loading)
      if (firebaseMode && currentUser && (!firebaseDataLoaded || state.restaurants.length === 0)) {
        return loadingOwnerView();
      }
      return shell("Owner Panel", `<section class="card">${empty("Restaurant not found. Your account may not be linked to a restaurant yet.")}<a class="btn primary" href="#/register">Register Restaurant</a></section>`, "owner");
    }
    // Firebase mode: require signed-in owner email linked to this restaurant
    if (firebaseMode) {
      if (!currentUser) return authLoginView("owner");
      const linkedSlug = ownerSlugForUser(currentUser);
      if (!linkedSlug) {
        // Allow admin to open any restaurant panel
        if (!firebaseDataLoaded && cachedSlug === r.slug) {
          rememberOwnerLink(r.slug, currentUser.email);
        } else if (!firebaseDataLoaded) {
          return loadingOwnerView();
        }
        if (!isAdmin(currentUser)) return authLoginView("owner", "Your account is not linked to any restaurant.");
      } else if (linkedSlug !== r.slug) {
        // Redirect owner to their own restaurant
        location.replace("#/owner?resto=" + linkedSlug);
        return "";
      }
      if (linkedSlug === r.slug) rememberOwnerLink(r.slug, currentUser.email);
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
    if (ownerTab === "analytics") return analyticsPanel(r);
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
        <div class="section-head"><div><h2>Common Items</h2><p>Select ready-made items and only change the price.</p></div></div>
        <div class="tab-bar" style="margin-bottom:16px;display:flex;gap:8px;border-bottom:2px solid var(--line);padding-bottom:0">
          <button class="tab-btn ${commonItemsTab === "resto" ? "active" : ""}" data-action="common-items-tab" data-tab="resto" style="border-radius:8px 8px 0 0;margin-bottom:-2px">🍛 Resto / Dhaba</button>
          <button class="tab-btn ${commonItemsTab === "cafe" ? "active" : ""}" data-action="common-items-tab" data-tab="cafe" style="border-radius:8px 8px 0 0;margin-bottom:-2px">☕ Cafe</button>
        </div>
        <div class="catalog-grid">
          ${(commonItemsTab === "cafe" ? CAFE_ITEMS : COMMON_ITEMS).map((c, idx) => {
            const dotStyle = `color:${c[3] ? "var(--ok)" : "var(--bad)"}`;
            const dataSource = commonItemsTab === "cafe" ? "cafe" : "resto";
            return `
            <div class="catalog-card">
              <div><strong><span style="${dotStyle}">●</span> ${esc(c[0])}</strong><p class="muted small">${esc(c[1])}</p></div>
              <div class="row-left">
                <input id="common-price-${dataSource}-${idx}" type="number" value="${c[2]}" aria-label="${esc(c[0])} price">
                <button class="btn primary" data-action="add-common" data-slug="${r.slug}" data-index="${idx}" data-source="${dataSource}">Add</button>
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

  function billingStatsBlock(upiCount, upiSum, cashCount, cashSum, totalCount) {
    return `<div class="billing-summary">
      <div class="stat"><p>🔵 UPI Collected</p><strong>${upiCount} orders · ₹${upiSum.toLocaleString("en-IN")}</strong></div>
      <div class="stat"><p>💵 Cash Collected</p><strong>${cashCount} orders · ₹${cashSum.toLocaleString("en-IN")}</strong></div>
      <div class="stat"><p>📦 Total Orders</p><strong>${totalCount} · ₹${(upiSum + cashSum).toLocaleString("en-IN")}</strong></div>
    </div>`;
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

    // All completed orders still in storage, newest first. Orders older than
    // ORDER_RETENTION_DAYS have already been rolled into state.billingArchive
    // (one entry per calendar month) and removed from here (see archiveOldOrders).
    const allCompleted = state.orders
      .filter(o => o.restaurantSlug === r.slug && o.status === "completed")
      .slice().reverse();

    // One-passage-per-month summaries for months whose raw orders were already purged
    const archived = (state.billingArchive || []).filter(a => a.restaurantSlug === r.slug);
    const archivedTotals = archived.reduce((acc, a) => {
      acc.totalOrders += a.totalOrders;
      acc.upiOrders += a.upiOrders;
      acc.upiTotal += a.upiTotal;
      acc.cashOrders += a.cashOrders;
      acc.cashTotal += a.cashTotal;
      return acc;
    }, { totalOrders: 0, upiOrders: 0, upiTotal: 0, cashOrders: 0, cashTotal: 0 });

    // Dropdown: exact live dates (full detail still available) + one entry
    // per archived month (day-level detail for those no longer exists)
    const liveDates = [...new Set(allCompleted.map(o => new Date(o.createdAt).toISOString().slice(0, 10)))].sort((a, b) => b.localeCompare(a));
    const archivedMonthOptions = archived
      .map(a => a.month + "-01")
      .sort((a, b) => b.localeCompare(a));

    // Orders for the selected exact date (only ones still kept in full detail)
    const filtered = billingDateFilter
      ? allCompleted.filter(o => new Date(o.createdAt).toISOString().slice(0, 10) === billingDateFilter)
      : allCompleted;

    // If nothing live matches the picked date, fall back to that month's
    // archived summary (the day-level breakdown was already consolidated).
    const filterMonth = billingDateFilter ? billingDateFilter.slice(0, 7) : null;
    const archivedForMonth = (!filtered.length && filterMonth) ? archived.find(a => a.month === filterMonth) : null;

    const dateLabel = billingDateFilter
      ? new Date(billingDateFilter + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
      : "All Time";

    let statsBlock = "";
    let listHtml = "";

    if (archivedForMonth) {
      // Day-level detail for this date is gone — show the month's single
      // summary passage instead.
      statsBlock = billingStatsBlock(archivedForMonth.upiOrders, archivedForMonth.upiTotal, archivedForMonth.cashOrders, archivedForMonth.cashTotal, archivedForMonth.totalOrders);
      listHtml = empty(archivedForMonth.summary + ` (Orders older than ${ORDER_RETENTION_DAYS} days are consolidated into one monthly summary and the originals are deleted to save space.)`);
    } else {
      // Live detail for the selection, plus archived totals folded in for "All Time"
      const upiCount = filtered.filter(o => o.paymentStatus === "paid").length + (!billingDateFilter ? archivedTotals.upiOrders : 0);
      const cashCount = filtered.filter(o => o.paymentStatus === "cash_accepted").length + (!billingDateFilter ? archivedTotals.cashOrders : 0);
      const upiSum = filtered.filter(o => o.paymentStatus === "paid").reduce((s, o) => s + o.total, 0) + (!billingDateFilter ? archivedTotals.upiTotal : 0);
      const cashSum = filtered.filter(o => o.paymentStatus === "cash_accepted").reduce((s, o) => s + o.total, 0) + (!billingDateFilter ? archivedTotals.cashTotal : 0);
      const totalCount = filtered.length + (!billingDateFilter ? archivedTotals.totalOrders : 0);

      if (totalCount) statsBlock = billingStatsBlock(upiCount, upiSum, cashCount, cashSum, totalCount);

      if (filtered.length) {
        listHtml = `<div class="order-scroll-wrap"><div class="order-scroll closed">${filtered.map(billCardClosed).join("")}</div></div>`;
      } else if (!billingDateFilter && archivedTotals.totalOrders) {
        // All-time totals include archived history but no live orders remain to list
        listHtml = empty(`Detailed line items older than ${ORDER_RETENTION_DAYS} days have been consolidated into monthly summaries — totals above include that history. Pick an archived month below to read its summary.`);
      } else {
        listHtml = empty(billingDateFilter ? "No closed orders for " + dateLabel : "No closed orders yet");
      }
    }

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
          <div><h2>Closed Tables</h2><p>All completed orders — filter by date for verification. Orders older than ${ORDER_RETENTION_DAYS} days are consolidated into one summary per month to save storage.</p></div>
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
              ${liveDates.map(d => {
                const label = new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
                return '<option value="' + d + '" ' + (d === billingDateFilter ? 'selected' : '') + '>' + label + '</option>';
              }).join("")}
              ${archivedMonthOptions.map(d => {
                const label = new Date(d + "T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" });
                return '<option value="' + d + '" ' + (d === billingDateFilter ? 'selected' : '') + '>' + label + ' (archived summary)</option>';
              }).join("")}
            </select>
            ${billingDateFilter ? `<button class="btn" style="font-size:12px;padding:6px 10px" data-action="billing-date-clear">✕ Clear</button>` : ""}
          </div>
        </div>

        ${statsBlock}
        ${listHtml}
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
          <p class="muted small">${orders.length} order${orders.length > 1 ? "s" : ""} · ${new Date(orders[0].createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}${(() => {
            const closer = orders.find(o => o.closedBy)?.closedBy;
            const upiBy  = orders.find(o => o.upiConfirmedBy)?.upiConfirmedBy;
            const cashBy = orders.find(o => o.cashConfirmedBy)?.cashConfirmedBy;
            if (closer)  return ` · 🔒 Closed by ${esc(closer.name)}`;
            if (upiBy)   return ` · ✅ UPI by ${esc(upiBy.name)}`;
            if (cashBy)  return ` · 💵 Cash by ${esc(cashBy.name)}`;
            return "";
          })()}</p>
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
          ${orders.map(o => {
            const staffTag = o.closedBy ? ` · 🔒 ${esc(o.closedBy.name)}`
              : o.upiConfirmedBy ? ` · ✅ ${esc(o.upiConfirmedBy.name)}`
              : o.cashConfirmedBy ? ` · 💵 ${esc(o.cashConfirmedBy.name)}`
              : "";
            return `<p style="margin:2px 0;font-size:12px;color:var(--muted,#6b7280)">#${o.id.slice(-5).toUpperCase()} · ${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} · ${money(o.total)} · <span style="color:${o.paymentStatus==="paid"||o.paymentStatus==="cash_accepted"?"var(--ok)":"#b5790c"}">${o.paymentStatus==="paid"?"UPI Paid":o.paymentStatus==="cash_accepted"?"Cash Received":o.paymentStatus==="cash_sent"?"In Kitchen":o.paymentStatus==="cash_pending"?"Cash Pending":"Pending"}</span><span style="color:#a89880">${staffTag}</span></p>`;
          }).join("")}
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
              <p class="muted small" style="margin:4px 0 0">${f.table ? "Table " + f.table + " · " : ""}${f.orderId ? "Order #" + f.orderId.slice(-5).toUpperCase() + " · " : ""}${new Date(f.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p>
            </div>
            <span class="pill ${f.stars >= 4 ? "ok" : f.stars >= 3 ? "warn" : "bad"}">${f.stars}/5</span>
          </div>
          ${f.text ? `<p style="margin:8px 0 0;font-size:14px">"${esc(f.text)}"</p>` : ""}
        </div>`).join("") || empty("No feedback yet")}
    </section>`;
  }


  function analyticsPanel(r) {
    // ── Inject Chart.js ──────────────────────────────────────────────
    if (!window._chartjsLoaded) {
      window._chartjsLoaded = true;
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js";
      s.onload = () => { window._chartjsReady = true; render(); };
      s.onerror = () => { window._chartjsLoaded = false; window._chartjsReady = false; render(); };
      document.head.appendChild(s);
    }
    if (!window._chartjsReady) {
      return `<section class="card"><div class="empty">Loading charts… <button class="btn" onclick="window._chartjsLoaded=false;window._chartjsReady=false;document.querySelector('[data-action=owner-tab][data-tab=analytics]')?.click()">Retry</button></div></section>`;
    }

    // ── Inject analytics styles once ────────────────────────────────
    if (!document.getElementById("rqr-analytics-styles")) {
      const st = document.createElement("style");
      st.id = "rqr-analytics-styles";
      st.textContent = `
        .an-filter-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:20px}
        .an-period-tabs{display:flex;background:var(--bg,#f9f5ef);border-radius:10px;padding:3px;gap:2px}
        .an-period-tab{padding:7px 16px;border:none;background:transparent;border-radius:8px;font-size:13px;font-weight:600;color:var(--muted,#6b7280);cursor:pointer;transition:all .15s}
        .an-period-tab.active{background:#8b4513;color:#fff;box-shadow:0 2px 8px rgba(139,69,19,.25)}
        .an-period-tab:hover:not(.active){background:rgba(139,69,19,.1);color:#8b4513}
        .an-select{padding:7px 10px;border:1px solid var(--line,#e5e7eb);border-radius:8px;font-size:13px;background:var(--card,#fff);color:var(--text,#1c0e04)}
        .an-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px}
        .an-kpi{background:var(--card,#fff);border:1.5px solid var(--line,#e5e7eb);border-radius:14px;padding:16px 18px;position:relative;overflow:hidden}
        .an-kpi::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--kpi-accent,#8b4513)}
        .an-kpi-icon{font-size:20px;margin-bottom:6px}
        .an-kpi-val{font-size:22px;font-weight:900;color:var(--text,#1c0e04);line-height:1;margin-bottom:3px}
        .an-kpi-lbl{font-size:11px;font-weight:600;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.05em}
        .an-kpi-sub{font-size:11px;color:var(--muted,#9ca3af);margin-top:3px}
        .an-section{background:var(--bg,#f9f5ef);border-radius:14px;padding:16px;margin-bottom:14px}
        .an-section-title{font-size:11px;font-weight:700;color:var(--muted,#6b7280);text-transform:uppercase;letter-spacing:.06em;margin:0 0 4px}
        .an-section-sub{font-size:12px;color:var(--muted,#9ca3af);margin:0 0 12px}
        .an-chart-wrap{position:relative}
        .an-2col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
        .an-3col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px}
        .an-progress-row{display:flex;flex-direction:column;gap:10px}
        .an-bar-item{font-size:13px}
        .an-bar-label{display:flex;justify-content:space-between;margin-bottom:4px}
        .an-bar-track{background:var(--line,#e5e7eb);border-radius:4px;height:8px;overflow:hidden}
        .an-bar-fill{height:100%;border-radius:4px;transition:width .4s}
        .an-table-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line,#e5e7eb);font-size:13px}
        .an-table-row:last-child{border-bottom:none}
        .an-badge{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px}
        .an-insight-chip{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#fff7ed,#ffece0);border:1.5px solid #ffd0b0;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:600;color:#7a1e00;margin:4px}
        .an-insights-row{display:flex;flex-wrap:wrap;margin-bottom:14px}
        @media(max-width:600px){.an-2col,.an-3col{grid-template-columns:1fr}.an-kpi-grid{grid-template-columns:repeat(2,1fr)}}
      `;
      document.head.appendChild(st);
    }

    // ── Period state ─────────────────────────────────────────────────
    const period = window._analyticsPeriod || "month"; // "day" | "week" | "month"
    const now = new Date();

    const allOrders = state.orders.filter(o => o.restaurantSlug === r.slug);
    const currentMonth = now.getMonth();
    const currentYear  = now.getFullYear();
    const selMonth = window._analyticsMonth != null ? window._analyticsMonth : currentMonth;
    const selYear  = window._analyticsYear  != null ? window._analyticsYear  : currentYear;

    // Week offset (0 = current week, -1 = last week, etc.)
    const weekOffset = window._analyticsWeekOffset != null ? window._analyticsWeekOffset : 0;
    // Day offset (0 = today, -1 = yesterday, etc.)
    const dayOffset = window._analyticsDayOffset != null ? window._analyticsDayOffset : 0;

    // ── Resolve target dates and label ──────────────────────────────
    let orders, periodLabel, trendLabels, trendData;

    if (period === "day") {
      const target = new Date(now);
      target.setDate(target.getDate() + dayOffset);
      const targetStr = target.toISOString().slice(0,10);
      orders = allOrders.filter(o => new Date(o.createdAt).toISOString().slice(0,10) === targetStr);
      periodLabel = dayOffset === 0 ? "Today" : dayOffset === -1 ? "Yesterday" : target.toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"short"});
      // Hourly trend
      trendLabels = Array.from({length:24},(_,h)=> h===0?"12am": h<12?h+"am": h===12?"12pm":(h-12)+"pm");
      const hrBuckets = Array(24).fill(0);
      orders.forEach(o => { if (o.paymentStatus==="paid"||o.paymentStatus==="cash_accepted") hrBuckets[new Date(o.createdAt).getHours()] += o.total; });
      trendData = hrBuckets;
    } else if (period === "week") {
      // Find the Monday of the selected week
      const monday = new Date(now);
      const day = monday.getDay();
      monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1) + weekOffset * 7);
      monday.setHours(0,0,0,0);
      const sunday = new Date(monday); sunday.setDate(sunday.getDate() + 6); sunday.setHours(23,59,59,999);
      orders = allOrders.filter(o => { const t = o.createdAt; return t >= monday.getTime() && t <= sunday.getTime(); });
      const opts = {day:"numeric",month:"short"};
      periodLabel = monday.toLocaleDateString("en-IN",opts) + " – " + sunday.toLocaleDateString("en-IN",opts) + (weekOffset === 0 ? " (This week)" : weekOffset === -1 ? " (Last week)" : "");
      // Daily trend for the week
      trendLabels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
      const wkBuckets = Array(7).fill(0);
      orders.forEach(o => {
        if (o.paymentStatus==="paid"||o.paymentStatus==="cash_accepted") {
          const d = new Date(o.createdAt).getDay();
          const idx = d === 0 ? 6 : d - 1; // Mon=0..Sun=6
          wkBuckets[idx] += o.total;
        }
      });
      trendData = wkBuckets;
    } else {
      // Month
      const monthsWithOrders = [];
      const seenM = new Set();
      allOrders.forEach(o => {
        const d = new Date(o.createdAt);
        const key = d.getFullYear() + "-" + d.getMonth();
        if (!seenM.has(key)) { seenM.add(key); monthsWithOrders.push({ year: d.getFullYear(), month: d.getMonth() }); }
      });
      monthsWithOrders.sort((a,b) => b.year - a.year || b.month - a.month);
      if (!monthsWithOrders.length) monthsWithOrders.push({ year: currentYear, month: currentMonth });
      window._analyticsMonthOptions = monthsWithOrders;
      orders = allOrders.filter(o => {
        const d = new Date(o.createdAt);
        return d.getMonth() === selMonth && d.getFullYear() === selYear;
      });
      periodLabel = new Date(selYear, selMonth, 1).toLocaleDateString("en-IN",{month:"long",year:"numeric"});
      // Daily revenue trend
      const daysInMonth = new Date(selYear, selMonth+1, 0).getDate();
      trendLabels = Array.from({length:daysInMonth},(_,i)=>i+1);
      trendData = Array(daysInMonth).fill(0);
      orders.forEach(o => {
        if (o.paymentStatus==="paid"||o.paymentStatus==="cash_accepted") trendData[new Date(o.createdAt).getDate()-1] += o.total;
      });
    }

    // ── Core metrics ─────────────────────────────────────────────────
    const paidOrders   = orders.filter(o => o.paymentStatus === "paid" || o.paymentStatus === "cash_accepted");
    const totalRevenue = paidOrders.reduce((s,o) => s + o.total, 0);
    const upiRevenue   = orders.filter(o => o.paymentStatus === "paid").reduce((s,o) => s + o.total, 0);
    const cashRevenue  = orders.filter(o => o.paymentStatus === "cash_accepted").reduce((s,o) => s + o.total, 0);
    const avgOrderVal  = paidOrders.length ? Math.round(totalRevenue / paidOrders.length) : 0;
    const completionRate = orders.length ? Math.round(paidOrders.length / orders.length * 100) : 0;
    const openOrders   = orders.filter(o => o.status !== "completed").length;

    // Items — track veg/nonveg separately using menu lookup
    const itemMap = {}, itemVegMap = {};
    let vegQty = 0, nonVegQty = 0;
    orders.forEach(o => {
      (o.items || []).forEach(i => {
        itemMap[i.name] = (itemMap[i.name] || 0) + i.qty;
        const menuItem = (r.menu || []).find(m => m.name === i.name);
        if (menuItem) {
          if (menuItem.veg) vegQty += i.qty; else nonVegQty += i.qty;
          itemVegMap[i.name] = menuItem.veg;
        }
      });
      (o.addons || []).forEach(a => { itemMap[a.name] = (itemMap[a.name] || 0) + (a.qty || 1); });
    });
    const topItems = Object.entries(itemMap).sort((a,b) => b[1]-a[1]).slice(0,10);

    // Category revenue
    const catRevMap = {};
    orders.forEach(o => {
      (o.items || []).forEach(i => {
        const menuItem = (r.menu || []).find(m => m.name === i.name);
        const cat = menuItem ? menuItem.category : "Other";
        catRevMap[cat] = (catRevMap[cat] || 0) + i.price * i.qty;
      });
    });
    const topCats = Object.entries(catRevMap).sort((a,b)=>b[1]-a[1]);

    // Hours
    const hourMap = Array(24).fill(0);
    orders.forEach(o => { hourMap[new Date(o.createdAt).getHours()]++; });
    const peakHour = hourMap.indexOf(Math.max(...hourMap));
    const peakHourLabel = peakHour === 0 ? "12am" : peakHour < 12 ? peakHour+"am" : peakHour === 12 ? "12pm" : (peakHour-12)+"pm";
    const peakHourEnd  = (peakHour+1) === 12 ? "12pm" : (peakHour+1) < 12 ? (peakHour+1)+"am" : (peakHour+1) === 24 ? "12am" : (peakHour+1-12)+"pm";

    // Days of week
    const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const dayMap   = Array(7).fill(0);
    orders.forEach(o => { dayMap[new Date(o.createdAt).getDay()]++; });
    const busiestDay = dayNames[dayMap.indexOf(Math.max(...dayMap))];

    // Tables
    const tableMap = {};
    orders.forEach(o => { tableMap[o.table] = (tableMap[o.table]||0)+1; });
    const topTables = Object.entries(tableMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const repeatTables = Object.values(tableMap).filter(c=>c>1).length;

    // Feedback
    const feedbacks = (state.feedbacks||[]).filter(f => {
      if (f.restaurantSlug !== r.slug) return false;
      if (period === "day") {
        const target = new Date(now); target.setDate(target.getDate() + dayOffset);
        return new Date(f.createdAt).toISOString().slice(0,10) === target.toISOString().slice(0,10);
      }
      const d = new Date(f.createdAt);
      return d.getMonth()===selMonth && d.getFullYear()===selYear;
    });
    const avgSatisfaction = feedbacks.length ? Math.round(feedbacks.reduce((s,f)=>s+(f.satisfaction||0),0)/feedbacks.length) : 0;
    const avgRating = feedbacks.length ? (feedbacks.reduce((s,f)=>s+(f.stars||0),0)/feedbacks.length) : 0;
    const starDist  = [5,4,3,2,1].map(s => ({ star:s, count: feedbacks.filter(f=>f.stars===s).length }));

    // ── Insight chips ────────────────────────────────────────────────
    const insights = [];
    if (orders.length) {
      if (peakHour && hourMap[peakHour]) insights.push(`🔥 Rush hour: ${peakHourLabel}–${peakHourEnd}`);
      if (busiestDay) insights.push(`📅 Best day: ${busiestDay}`);
      if (topItems.length) insights.push(`⭐ Top item: ${topItems[0][0]}`);
      if (completionRate >= 80) insights.push(`✅ ${completionRate}% orders completed`);
      else if (completionRate > 0) insights.push(`⚠️ ${completionRate}% completion rate`);
      if (upiRevenue > cashRevenue) insights.push(`📲 UPI preferred (${Math.round(upiRevenue/(totalRevenue||1)*100)}%)`);
      else if (cashRevenue > 0) insights.push(`💵 Cash preferred (${Math.round(cashRevenue/(totalRevenue||1)*100)}%)`);
      if (topTables.length) insights.push(`🪑 Busiest: Table ${topTables[0][0]}`);
    }

    // ── Chart IDs ────────────────────────────────────────────────────
    const cid = Date.now();
    const cTrend    = "ch-trend-"    + cid;
    const cHours    = "ch-hours-"    + cid;
    const cDays     = "ch-days-"     + cid;
    const cPayment  = "ch-payment-"  + cid;
    const cItems    = "ch-items-"    + cid;
    const cFeedback = "ch-feedback-" + cid;
    const cCategory = "ch-category-" + cid;
    const cVegNv    = "ch-vegnv-"    + cid;

    // ── Draw charts ──────────────────────────────────────────────────
    setTimeout(() => {
      if (!window.Chart) return;
      const defaults = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: {} } }
      };
      const BROWN = "#8b4513", BROWN_LIGHT = "rgba(139,69,19,0.15)";
      const GREEN  = "#2e7d32", BLUE = "#1a73e8", GOLD = "#c4a96a";
      const PAL = [BROWN,"#a0522d",GREEN,"#388e3c","#558b2f",BLUE,"#c4a96a","#9ca3af","#ef6c00","#6b7280"];

      // 1. Revenue / Orders trend
      const elTrend = document.getElementById(cTrend);
      if (elTrend) new Chart(elTrend, {
        type: period === "day" ? "bar" : "line",
        data: {
          labels: trendLabels,
          datasets: [{
            data: trendData,
            borderColor: BROWN,
            backgroundColor: period === "day" ? trendData.map(v=>v>0?BROWN:BROWN_LIGHT) : BROWN_LIGHT,
            fill: period !== "day",
            tension: 0.4,
            borderRadius: 5,
            pointRadius: trendData.map(v=>v>0?3:0),
            pointBackgroundColor: BROWN
          }]
        },
        options: { ...defaults, scales: {
          x: { grid:{display:false}, ticks:{font:{size:10}, maxTicksLimit: period==="day"?12:15} },
          y: { grid:{color:"#f0ebe3"}, ticks:{font:{size:10}, callback:v=>"₹"+(v>=1000?Math.round(v/1000)+"k":v)}}
        }, plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>"₹"+ctx.raw.toLocaleString("en-IN")}}}}
      });

      // 2. Peak Hours bar
      const elHrs = document.getElementById(cHours);
      if (elHrs) new Chart(elHrs, {
        type: "bar",
        data: {
          labels: Array.from({length:24},(_,h)=> h===0?"12a": h<12?h+"a": h===12?"12p":(h-12)+"p"),
          datasets: [{ data: hourMap, backgroundColor: hourMap.map((_,h)=> h===peakHour ? BROWN : BROWN_LIGHT), borderRadius: 3 }]
        },
        options: { ...defaults, scales: {
          x: { grid:{display:false}, ticks:{font:{size:9}, maxRotation:0} },
          y: { grid:{color:"#f0ebe3"}, ticks:{font:{size:9}, stepSize:1} }
        }, plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.raw+" orders"}}}}
      });

      // 3. Day of week bar
      const elDays = document.getElementById(cDays);
      if (elDays) new Chart(elDays, {
        type: "bar",
        data: {
          labels: dayNames,
          datasets: [{ data: dayMap, backgroundColor: dayMap.map((_,i)=>i===dayMap.indexOf(Math.max(...dayMap))?BROWN:BROWN_LIGHT), borderRadius: 4 }]
        },
        options: { ...defaults, scales: {
          x: { grid:{display:false}, ticks:{font:{size:11}} },
          y: { grid:{color:"#f0ebe3"}, ticks:{font:{size:10}, stepSize:1} }
        }, plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.raw+" orders"}}}}
      });

      // 4. Payment doughnut
      const elPay = document.getElementById(cPayment);
      if (elPay && (upiRevenue||cashRevenue)) new Chart(elPay, {
        type: "doughnut",
        data: {
          labels: ["UPI 📲","Cash 💵"],
          datasets: [{ data: [upiRevenue, cashRevenue], backgroundColor: [BLUE, GOLD], borderWidth: 2, borderColor: "#fff" }]
        },
        options: { ...defaults, cutout:"68%",
          plugins:{legend:{display:true,position:"bottom",labels:{font:{size:12}}},
          tooltip:{callbacks:{label:ctx=>"₹"+ctx.raw.toLocaleString("en-IN")}}}}
      });

      // 5. Top items horizontal bar
      const elItm = document.getElementById(cItems);
      if (elItm && topItems.length) new Chart(elItm, {
        type: "bar",
        data: {
          labels: topItems.map(([n])=>n),
          datasets: [{ data: topItems.map(([,q])=>q), backgroundColor: PAL.slice(0,topItems.length), borderRadius: 4 }]
        },
        options: { ...defaults, indexAxis:"y",
          scales: {
            x: { grid:{color:"#f0ebe3"}, ticks:{font:{size:10}, stepSize:1} },
            y: { grid:{display:false}, ticks:{font:{size:11}} }
          },
          plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.raw+" sold"}}}}
      });

      // 6. Star / satisfaction feedback doughnut
      const elFb = document.getElementById(cFeedback);
      if (elFb && feedbacks.length) {
        const hasSatisfaction = feedbacks.some(f => f.satisfaction != null);
        if (hasSatisfaction) {
          const buckets = { "😍 Great (80-100)":0, "🙂 OK (60-79)":0, "😞 Poor (<60)":0 };
          feedbacks.forEach(f => {
            const s = f.satisfaction || 0;
            if (s >= 80) buckets["😍 Great (80-100)"]++;
            else if (s >= 60) buckets["🙂 OK (60-79)"]++;
            else buckets["😞 Poor (<60)"]++;
          });
          new Chart(elFb, {
            type: "doughnut",
            data: { labels: Object.keys(buckets), datasets:[{ data: Object.values(buckets), backgroundColor:[GREEN,"#c4a96a","#c93333"], borderWidth:2, borderColor:"#fff" }]},
            options: { ...defaults, cutout:"60%", plugins:{legend:{display:true,position:"bottom",labels:{font:{size:11}}}, tooltip:{callbacks:{label:ctx=>ctx.label+": "+ctx.raw}}}}
          });
        } else {
          new Chart(elFb, {
            type: "doughnut",
            data: { labels:["5★","4★","3★","2★","1★"], datasets:[{ data: starDist.map(s=>s.count), backgroundColor:[GREEN,"#66bb6a",GOLD,"#ef6c00","#c93333"], borderWidth:2, borderColor:"#fff" }]},
            options: { ...defaults, cutout:"60%", plugins:{legend:{display:true,position:"bottom",labels:{font:{size:11}}}, tooltip:{callbacks:{label:ctx=>ctx.label+" · "+ctx.raw+" reviews"}}}}
          });
        }
      }

      // 7. Category revenue pie
      const elCat = document.getElementById(cCategory);
      if (elCat && topCats.length) new Chart(elCat, {
        type: "pie",
        data: {
          labels: topCats.map(([n])=>n),
          datasets: [{ data: topCats.map(([,v])=>v), backgroundColor: PAL.slice(0,topCats.length), borderWidth: 2, borderColor:"#fff" }]
        },
        options: { ...defaults, plugins:{legend:{display:true,position:"bottom",labels:{font:{size:11},padding:10}},
          tooltip:{callbacks:{label:ctx=>"₹"+ctx.raw.toLocaleString("en-IN")+" · "+ctx.label}}}}
      });

      // 8. Veg vs Non-veg doughnut
      const elVeg = document.getElementById(cVegNv);
      if (elVeg && (vegQty || nonVegQty)) new Chart(elVeg, {
        type: "doughnut",
        data: {
          labels: ["🟢 Veg","🔴 Non-veg"],
          datasets: [{ data: [vegQty, nonVegQty], backgroundColor: [GREEN,"#c93333"], borderWidth:2, borderColor:"#fff" }]
        },
        options: { ...defaults, cutout:"65%",
          plugins:{legend:{display:true,position:"bottom",labels:{font:{size:12}}},
          tooltip:{callbacks:{label:ctx=>ctx.label+": "+ctx.raw+" items"}}}}
      });

    }, 80);

    // ── Period selector HTML ─────────────────────────────────────────
    const monthsOpts = (window._analyticsMonthOptions || [{year:currentYear,month:currentMonth}]);
    const periodControls = `
      <div class="an-filter-bar">
        <div class="an-period-tabs">
          <button class="an-period-tab ${period==="day"?"active":""}" data-action="analytics-period" data-period="day">Day</button>
          <button class="an-period-tab ${period==="week"?"active":""}" data-action="analytics-period" data-period="week">Week</button>
          <button class="an-period-tab ${period==="month"?"active":""}" data-action="analytics-period" data-period="month">Month</button>
        </div>
        ${period === "day" ? `
          <button class="btn" style="padding:6px 12px;font-size:13px" data-action="analytics-nav" data-dir="-1">← Prev</button>
          <button class="btn" style="padding:6px 12px;font-size:13px" data-action="analytics-nav" data-dir="1" ${dayOffset>=0?"disabled":""}>Next →</button>
        ` : period === "week" ? `
          <button class="btn" style="padding:6px 12px;font-size:13px" data-action="analytics-nav" data-dir="-1">← Prev</button>
          <button class="btn" style="padding:6px 12px;font-size:13px" data-action="analytics-nav" data-dir="1" ${weekOffset>=0?"disabled":""}>Next →</button>
        ` : `
          <select class="an-select" onchange="(function(v){var p=v.split('-');window._analyticsMonth=Number(p[1]);window._analyticsYear=Number(p[0]);})(this.value)" data-action="analytics-month-select">
            ${monthsOpts.map(m => {
              const lbl = new Date(m.year,m.month,1).toLocaleDateString("en-IN",{month:"long",year:"numeric"});
              return `<option value="${m.year}-${m.month}" ${m.month===selMonth&&m.year===selYear?"selected":""}>${lbl}</option>`;
            }).join("")}
          </select>
        `}
      </div>`;

    // ── KPI cards ────────────────────────────────────────────────────
    const kpiCards = [
      { icon:"💰", val: money(totalRevenue), lbl:"Total Revenue", sub: paidOrders.length+" paid orders", accent:"#8b4513" },
      { icon:"🧾", val: orders.length, lbl:"Total Orders", sub: openOrders+" still open", accent:"#1a73e8" },
      { icon:"📊", val: money(avgOrderVal), lbl:"Avg Order Value", sub: completionRate+"% completion", accent:"#2e7d32" },
      { icon:"📲", val: money(upiRevenue), lbl:"UPI Revenue", sub: money(cashRevenue)+" via cash", accent:"#1a73e8" },
      { icon:"🕐", val: orders.length ? peakHourLabel+"–"+peakHourEnd : "—", lbl:"Peak Hour", sub: hourMap[peakHour]+" orders at peak", accent:"#ef6c00" },
      { icon:"📅", val: orders.length ? busiestDay : "—", lbl:"Busiest Day", sub: dayMap[dayMap.indexOf(Math.max(...dayMap))]+" orders", accent:"#8b4513" },
      { icon:"⭐", val: avgRating ? avgRating.toFixed(1)+"/5" : "—", lbl:"Avg Rating", sub: feedbacks.length+" feedbacks", accent:"#f59e0b" },
      { icon:"✅", val: completionRate+"%", lbl:"Completion Rate", sub: paidOrders.length+" completed", accent:"#2e7d32" }
    ];

    return `
      <section class="card">
        <div class="section-head" style="margin-bottom:16px">
          <div>
            <h2 style="margin:0 0 2px">📊 Analytics</h2>
            <p style="margin:0;font-size:13px;color:var(--muted,#6b7280)">${periodLabel}</p>
          </div>
        </div>

        ${periodControls}

        ${!orders.length ? `
          <div class="empty" style="padding:48px 0;text-align:center">
            <div style="font-size:40px;margin-bottom:12px">📭</div>
            <p style="font-weight:700;margin:0 0 6px">No orders for ${periodLabel}</p>
            <p class="muted" style="margin:0">Try a different date range or check back later</p>
          </div>
        ` : `

        <!-- Insight chips -->
        ${insights.length ? `<div class="an-insights-row">${insights.map(i=>`<span class="an-insight-chip">${i}</span>`).join("")}</div>` : ""}

        <!-- KPI grid -->
        <div class="an-kpi-grid">
          ${kpiCards.map(k=>`
            <div class="an-kpi" style="--kpi-accent:${k.accent}">
              <div class="an-kpi-icon">${k.icon}</div>
              <div class="an-kpi-val">${k.val}</div>
              <div class="an-kpi-lbl">${k.lbl}</div>
              <div class="an-kpi-sub">${k.sub}</div>
            </div>`).join("")}
        </div>

        <!-- Revenue Trend -->
        <div class="an-section">
          <p class="an-section-title">📈 ${period==="day"?"Hourly Revenue":period==="week"?"Daily Revenue This Week":"Daily Revenue"}</p>
          <p class="an-section-sub">Total: ${money(totalRevenue)} · ${paidOrders.length} paid orders</p>
          <div class="an-chart-wrap" style="height:170px"><canvas id="${cTrend}"></canvas></div>
        </div>

        <!-- Peak Hours + Day of Week -->
        <div class="an-2col">
          <div class="an-section" style="margin-bottom:0">
            <p class="an-section-title">🕐 Peak Hours</p>
            <p class="an-section-sub">Rush: <strong>${peakHourLabel}–${peakHourEnd}</strong> · ${hourMap[peakHour]} orders</p>
            <div class="an-chart-wrap" style="height:130px"><canvas id="${cHours}"></canvas></div>
          </div>
          <div class="an-section" style="margin-bottom:0">
            <p class="an-section-title">📅 Orders by Day</p>
            <p class="an-section-sub">Busiest: <strong>${busiestDay}</strong></p>
            <div class="an-chart-wrap" style="height:130px"><canvas id="${cDays}"></canvas></div>
          </div>
        </div>
        <div style="margin-bottom:14px"></div>

        <!-- Payment + Feedback -->
        <div class="an-2col">
          <div class="an-section" style="margin-bottom:0">
            <p class="an-section-title">💳 Payment Split</p>
            <p class="an-section-sub">UPI ${money(upiRevenue)} · Cash ${money(cashRevenue)}</p>
            <div class="an-chart-wrap" style="height:190px">
              ${upiRevenue||cashRevenue ? `<canvas id="${cPayment}"></canvas>` : `<p class="muted small" style="padding-top:50px;text-align:center">No paid orders</p>`}
            </div>
          </div>
          <div class="an-section" style="margin-bottom:0">
            <p class="an-section-title">⭐ Customer Feedback</p>
            <p class="an-section-sub">${feedbacks.length} reviews · Avg ${avgRating?avgRating.toFixed(1):"—"}${avgSatisfaction?` · Satisfaction ${avgSatisfaction}%`:""}</p>
            <div class="an-chart-wrap" style="height:190px">
              ${feedbacks.length ? `<canvas id="${cFeedback}"></canvas>` : `<p class="muted small" style="padding-top:50px;text-align:center">No feedback yet</p>`}
            </div>
          </div>
        </div>
        <div style="margin-bottom:14px"></div>

        <!-- Category Pie + Veg/Non-veg -->
        <div class="an-2col">
          <div class="an-section" style="margin-bottom:0">
            <p class="an-section-title">🍽 Revenue by Category</p>
            <p class="an-section-sub">Which categories drive the most revenue</p>
            <div class="an-chart-wrap" style="height:200px">
              ${topCats.length ? `<canvas id="${cCategory}"></canvas>` : `<p class="muted small" style="padding-top:50px;text-align:center">No data</p>`}
            </div>
          </div>
          <div class="an-section" style="margin-bottom:0">
            <p class="an-section-title">🟢 Veg vs Non-veg</p>
            <p class="an-section-sub">By items sold · Veg ${vegQty} · Non-veg ${nonVegQty}</p>
            <div class="an-chart-wrap" style="height:200px">
              ${vegQty||nonVegQty ? `<canvas id="${cVegNv}"></canvas>` : `<p class="muted small" style="padding-top:50px;text-align:center">No data</p>`}
            </div>
          </div>
        </div>
        <div style="margin-bottom:14px"></div>

        <!-- Top Items horizontal bar -->
        <div class="an-section">
          <p class="an-section-title">🏆 Top Ordered Items</p>
          <p class="an-section-sub">${topItems.length} items sold in this period</p>
          <div class="an-chart-wrap" style="height:${Math.max(topItems.length*34,100)}px">
            ${topItems.length ? `<canvas id="${cItems}"></canvas>` : `<p class="muted small">No items data</p>`}
          </div>
        </div>

        <!-- Tables + Order Health -->
        <div class="an-2col">
          <div class="an-section" style="margin-bottom:0">
            <p class="an-section-title">🪑 Busiest Tables</p>
            <p class="an-section-sub">${repeatTables} tables with repeat orders</p>
            ${topTables.length ? topTables.map(([tbl,count],i)=>`
              <div class="an-table-row">
                <span>${i===0?"🥇":i===1?"🥈":i===2?"🥉":"  "} Table ${tbl}</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="width:60px;background:var(--line,#e5e7eb);border-radius:3px;height:6px;overflow:hidden">
                    <div style="width:${Math.round(count/(topTables[0][1]||1)*100)}%;height:100%;background:#8b4513;border-radius:3px"></div>
                  </div>
                  <strong>${count}</strong>
                </div>
              </div>`).join("") : `<p class="muted small">No data</p>`}
          </div>
          <div class="an-section" style="margin-bottom:0">
            <p class="an-section-title">📦 Order Health</p>
            <p class="an-section-sub">Completion rate: <strong>${completionRate}%</strong></p>
            <div class="an-progress-row">
              ${[
                ["Total Placed", orders.length, orders.length, "#8b4513"],
                ["Completed", paidOrders.length, orders.length, "#2e7d32"],
                ["Still Open", openOrders, orders.length, "#ef6c00"],
                ["Cancelled/Other", Math.max(0,orders.length-paidOrders.length-openOrders), orders.length, "#9ca3af"]
              ].map(([label,val,total,color])=>`
                <div class="an-bar-item">
                  <div class="an-bar-label"><span>${label}</span><strong>${val}</strong></div>
                  <div class="an-bar-track"><div class="an-bar-fill" style="width:${total?Math.round(val/total*100):0}%;background:${color}"></div></div>
                </div>`).join("")}
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
  let staffSoundEnabled = localStorage.getItem("restoqr_staff_sound_off") !== "yes";
  function ensureStaffAudio() {
    if (!staffAudioCtx) {
      try { staffAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) { staffAudioCtx = null; }
    }
    if (staffAudioCtx && staffAudioCtx.state === "suspended") staffAudioCtx.resume();
    return staffAudioCtx;
  }
  // Double-pulse for waiter/bill requests
  function playWaiterAlertSound() {
    if (!staffSoundEnabled) return;
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
    if (!staffSoundEnabled) return;
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
    if (hasWaiterAlert && staffRole(slug) === "waiter") playWaiterAlertSound();
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

    listenStaffMembers(slug);
    if (!isStaffUnlocked(slug)) return staffLoginView(resto);
    return staffMainView(resto);
  }

  // no-op — styles injected at parse time above
  function injectStaffStyles_noop() {}

  // ================================================================
  // STAFF DASHBOARD — login view
  // ================================================================
  function staffLoginView(r) {
    const isFirebase = firebaseMode && !!auth;
    return `<div class="staff-shell">
      <div class="staff-topbar">
        <div><p class="staff-resto-name">${esc(r.name)}</p><h1>Staff Login</h1></div>
        <a href="#/owner?resto=${r.slug}" style="color:#c4a96a;font-size:12px;text-decoration:none">Owner ›</a>
      </div>
      <div class="staff-login-wrap">
        <div class="staff-login-card">
          <div style="font-size:40px;margin-bottom:12px;text-align:center">🔑</div>
          <h2 style="text-align:center;margin-bottom:6px">Staff Access</h2>
          ${isFirebase ? `
            <p style="text-align:center;font-size:13px;color:#a89880;margin-bottom:18px">Sign in with your staff credentials.</p>
            <input id="staff-email-input" class="staff-input" type="email" placeholder="your@email.com" autocomplete="username" style="margin-bottom:8px">
            <input id="staff-pass-input" class="staff-input" type="password" placeholder="Password" autocomplete="current-password"
              onkeydown="if(event.key==='Enter')document.querySelector('[data-action=staff-login]').click()">
            <button class="sbtn primary" style="width:100%;margin-top:10px" data-action="staff-login" data-slug="${r.slug}">Sign In</button>
            <p id="staff-login-err" style="color:#c0392b;font-size:12px;text-align:center;margin-top:8px;min-height:16px"></p>
            <p style="text-align:center;font-size:11px;color:#c4a96a;margin-top:8px;opacity:.7">Your account must be created by the restaurant owner.</p>
          ` : `
            <p style="text-align:center;font-size:13px;color:#a89880;margin-bottom:18px">Enter the master key provided by the restaurant owner.</p>
            <input id="staff-key-input" class="staff-input" type="password" placeholder="Enter master key" autocomplete="off"
              onkeydown="if(event.key==='Enter')document.querySelector('[data-action=staff-login]').click()">
            <button class="sbtn primary" style="width:100%;margin-top:10px" data-action="staff-login" data-slug="${r.slug}">Enter Dashboard</button>
            <p style="text-align:center;font-size:11px;color:#c4a96a;margin-top:16px;opacity:.7">Unlocks Kitchen · Floor Plan · Billing</p>
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
          <h1>Staff Dashboard${firebaseMode && currentUser ? ` <span style="font-size:12px;font-weight:400;color:#c4a96a">· ${esc(currentStaffName(r.slug))}</span>` : ""}</h1>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${pendingAlerts ? `<div style="background:#e74c3c;color:#fff;border-radius:20px;padding:5px 14px;font-size:12px;font-weight:800;letter-spacing:.02em;animation:pulse-red 1.5s infinite">⚡ ${pendingAlerts} Alert${pendingAlerts>1?"s":""}</div>` : ""}
          ${staffRole(r.slug) === "waiter" ? `<button class="sbtn plain" style="font-size:18px;padding:6px 10px;background:rgba(255,255,255,.08);border:1px solid rgba(196,169,106,.3)" data-action="staff-toggle-sound" data-slug="${r.slug}" title="${staffSoundEnabled ? "Mute alerts" : "Unmute alerts"}">${staffSoundEnabled ? "🔔" : "🔕"}</button>` : ""}
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

  function staffMembersList(slug) {
    listenStaffMembers(slug);
    const members = _staffMembers[slug] || {};
    const entries = Object.entries(members);
    if (!entries.length) return `<p class="muted small" style="margin:0">No staff added yet.</p>`;
    return `<table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:1.5px solid #e8dcc8;color:#a89880">
        <th style="text-align:left;padding:6px 8px">Name</th>
        <th style="text-align:left;padding:6px 8px">Email</th>
        <th style="text-align:left;padding:6px 8px">Role</th>
        <th style="text-align:left;padding:6px 8px">Status</th>
        <th style="padding:6px 8px"></th>
      </tr></thead>
      <tbody>
        ${entries.map(([uid, m]) => `
          <tr style="border-bottom:1px solid #f0e8dc">
            <td style="padding:8px">${esc(m.name || "—")}</td>
            <td style="padding:8px;color:#a89880;font-size:12px">${esc(m.email || "—")}</td>
            <td style="padding:8px">${esc(m.role || "waiter")}</td>
            <td style="padding:8px">${m.active
              ? `<span style="color:#27ae60;font-weight:700">● Active</span>`
              : `<span style="color:#e74c3c;font-weight:700">○ Inactive</span>`}</td>
            <td style="padding:8px;text-align:right">
              <button class="sbtn ${m.active ? "danger" : "ok"}" style="font-size:11px;padding:5px 10px"
                data-action="staff-toggle-active" data-slug="${slug}" data-uid="${uid}" data-active="${m.active ? "1" : "0"}">
                ${m.active ? "Deactivate" : "Reactivate"}
              </button>
            </td>
          </tr>`).join("")}
      </tbody>
    </table>`;
  }

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
            <input id="set-owner-email" type="email" placeholder="owner@email.com" value="${esc(r.ownerEmail || "")}" ${_isAdminCache === true ? "" : "readonly"}>
           
          </div>` : ""}
        <button class="btn primary" data-action="save-settings" data-slug="${r.slug}">Save Settings</button>
        ${firebaseMode
          ? `<button class="btn" data-action="auth-signout">Sign Out</button>`
          : `<button class="btn" data-action="owner-logout" data-slug="${r.slug}">Logout</button>`}
      </section>

      <section class="card" style="max-width:640px;margin-top:14px">
        <div class="section-head">
          <div>
            <h2>Staff Management</h2>
            <p>Add staff accounts — they log in with email and password on their own devices.</p>
          </div>
        </div>
        ${firebaseMode ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
            <input id="staff-add-name"  class="field input" type="text"     placeholder="Name (e.g. Ravi)"          style="flex:1;min-width:120px">
            <input id="staff-add-email" class="field input" type="email"    placeholder="Email"                      style="flex:1;min-width:160px">
            <input id="staff-add-pass"  class="field input" type="password" placeholder="Password (min 6 chars)"     style="flex:1;min-width:140px">
            <select id="staff-add-role" class="field input" style="flex:0 0 auto">
              <option value="waiter">Waiter</option>
              <option value="kitchen">Kitchen</option>
              <option value="billing">Billing</option>
            </select>
            <button class="btn primary" data-action="staff-add-member" data-slug="${r.slug}">Add Staff</button>
          </div>
          <div id="staff-list-wrap">
            ${staffMembersList(r.slug)}
          </div>
        ` : `<p class="muted small">Staff management requires Firebase to be configured.</p>`}
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
    // Customers need Firebase Auth to write orders — sign in anonymously if not already signed in
    if (firebaseMode && auth && !currentUser) {
      auth.signInAnonymously().catch(() => {});
    }
    const slug = params.get("resto") || (state.restaurants[0]?.slug || "");
    const r = bySlug(slug);
    // If Firebase hasn't finished loading yet, show a loading screen instead of
    // "not found" — state.restaurants may still be empty on first render.
    if (!r && firebaseMode && !firebaseDataLoaded) {
      return customerShell("Loading\u2026", `<div class="empty" style="padding:40px 0"><p style="font-size:15px;color:#9a8878">Loading menu, please wait\u2026</p></div>`);
    }
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
    const searchQuery = (customerSearch || "").trim();
    const searchLower = searchQuery.toLowerCase();
    let items = searchLower
      ? r.menu.filter(i => i.available && i.name.toLowerCase().includes(searchLower))
      : r.menu.filter(i => i.available && i.category === customerCat);
    if (customerVegFilter === "veg") items = items.filter(i => i.veg);
    else if (customerVegFilter === "nonveg") items = items.filter(i => !i.veg);
    // Add-ons are searchable too: when a query is typed, only matching add-ons
    // show under the "Add-ons" header; with no query, all active add-ons show
    // (same as before search existed).
    const matchedAddons = searchLower
      ? r.addons.filter(a => a.active && a.name.toLowerCase().includes(searchLower))
      : r.addons.filter(a => a.active);
    const noResults = items.length === 0 && matchedAddons.length === 0;
    const totalMatches = items.length + matchedAddons.length;
    const total = cartTotal(r);
    return `
      <div class="customer-shell">
        <div class="customer-head"><p>${esc(r.name)}</p><h1>Table Ordering</h1></div>
        <div style="padding:12px 14px;border-bottom:1px solid var(--line)" class="row">
          <span class="muted">Table number</span>
          <input class="table-box" id="customer-table" value="${table}" type="number" min="1">
        </div>
        ${lastOrder && (lastOrder.status === "completed" || lastOrder.status === "delivered") ? customerStatusCard(r, lastOrder) : ""}
        ${customerMenuSearchBar(searchQuery)}
        ${searchLower
          ? `<div style="padding:10px 14px 0;font-size:13px;color:var(--muted,#6b7280)">${totalMatches} result${totalMatches === 1 ? "" : "s"} for &ldquo;${esc(searchQuery)}&rdquo;</div>`
          : `<div class="cat-strip">${unique(r.menu.map(i => i.category)).map(c => `<button class="${c === customerCat ? "active" : ""}" data-action="customer-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>`}
        <div style="padding-bottom:${(cartCount() || addonCartCount()) ? "160px" : "80px"}">
          <!-- Scrolls internally once content exceeds ~5-6 rows, instead of stretching the whole page -->
          <div style="max-height:420px;overflow-y:auto;-webkit-overflow-scrolling:touch">
            ${items.map(i => customerItem(r, i)).join("")}
            ${matchedAddons.length ? `
              <div style="padding:10px 14px 4px;border-top:1px solid var(--line);margin-top:8px">
                <p style="font-size:12px;font-weight:600;color:var(--muted,#6b7280);margin:0 0 6px;text-transform:uppercase;letter-spacing:.05em">Add-ons</p>
                ${matchedAddons.map(a => customerAddonItem(a)).join("")}
              </div>` : ""}
            ${noResults ? empty(searchLower ? "No items match your search" : "No items available") : ""}
          </div>
        </div>
        ${(cartCount() || addonCartCount()) ? checkoutBox(r, total) : ""}
      </div>`;
  }

  // Search box + Veg/Non-veg filter pills shown above the customer menu.
  // Search matches dish names across the whole menu (not just the active
  // category); the veg/non-veg pill narrows whichever list is showing.
  function customerMenuSearchBar(searchQuery) {
    const pill = (value, label) => {
      const active = customerVegFilter === value;
      return `<button data-action="customer-veg-filter" data-veg="${value}"
        style="flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;padding:7px 14px;border-radius:999px;
        font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer;
        border:1px solid ${active ? "var(--kpi-accent,#8b4513)" : "var(--line,#e5e7eb)"};
        background:${active ? "var(--kpi-accent,#8b4513)" : "var(--card,#fff)"};
        color:${active ? "#fff" : "var(--text,#1a1a1a)"};">${label}</button>`;
    };
    return `
      <div style="padding:12px 14px 10px;border-bottom:1px solid var(--line)">
        <div style="position:relative;display:flex;align-items:center">
          <svg style="position:absolute;left:12px;width:17px;height:17px;color:var(--muted,#9ca3af);pointer-events:none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input id="customer-search-input" data-action="customer-search" type="text" value="${esc(searchQuery)}"
            placeholder="Search dishes &amp; add-ons…" autocomplete="off"
            style="width:100%;box-sizing:border-box;padding:11px 38px 11px 36px;border:1px solid var(--line,#e5e7eb);
            border-radius:999px;font-size:14.5px;background:var(--card,#fff);color:var(--text,#1a1a1a);outline:none">
          ${searchQuery ? `<button data-action="customer-search-clear" aria-label="Clear search"
            style="position:absolute;right:8px;width:22px;height:22px;border:none;border-radius:50%;
            background:var(--line,#e5e7eb);color:var(--muted,#6b7280);font-size:13px;line-height:1;
            display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0">✕</button>` : ""}
        </div>
        <div style="display:flex;gap:8px;margin-top:10px;overflow-x:auto">
          ${pill("all", "All")}
          ${pill("veg", "🟢 Veg")}
          ${pill("nonveg", "🔴 Non-veg")}
        </div>
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
        <button class="btn block" style="width:100%;margin-bottom:10px;background:#fff7ed;border:1.5px solid #f59e0b;color:#92400e;font-weight:700" data-action="call-waiter" data-order="${o.id}" data-slug="${r.slug}">${o.waiterRequest === "waiter" ? "🔔 Serving Staff Notified" : "🔔 Call Serving Staff"}</button>
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
    const lang = localStorage.getItem("restoqr_lang") || "en";
    const isMr = lang === "mr";

    if (!delivered) {
      return `<div class="review-card">
        <div class="row">
          <div><strong>Order #${o.id.slice(-5).toUpperCase()}</strong><p class="muted small">Table ${o.table} · ${label}</p></div>
          <span class="pill blue">Active</span>
        </div>
        <p class="muted small">${isMr ? "Counter payment verify केल्यावर तुमची order kitchen मध्ये जाईल." : "Your order will move to kitchen after counter verifies payment."}</p>
      </div>`;
    }

    // Delivered — show satisfaction slider + review/feedback trigger
    return `<div class="review-card" id="rqr-status-card-${o.id}">
      <div class="row" style="margin-bottom:12px">
        <div><strong>Order #${o.id.slice(-5).toUpperCase()}</strong><p class="muted small">Table ${o.table} · ${isMr ? "Delivered ✅" : "Delivered ✅"}</p></div>
        <span class="pill ok">${isMr ? "पोहोचला" : "Delivered"}</span>
      </div>

      <p style="font-weight:700;font-size:15px;margin:0 0 4px;color:#1c0e04">
        ${isMr ? "🙏 तुमचा अनुभव कसा होता?" : "🙏 How was your experience?"}
      </p>
      <p class="muted small" style="margin:0 0 14px">
        ${isMr ? "खाली slider ओढा — 80% पेक्षा जास्त असेल तर आम्ही review बनवतो!" : "Slide below — above 80% and we'll write a Google review for you!"}
      </p>

      <!-- Satisfaction Slider -->
      <div style="position:relative;margin-bottom:10px">
        <div id="rqr-inline-track-${o.id}" style="position:relative;height:48px;background:linear-gradient(90deg,#fee2e2 0%,#fef9c3 50%,#dcfce7 100%);border-radius:24px;overflow:visible">
          <!-- threshold marker at 80% -->
          <div style="position:absolute;top:0;bottom:0;left:80%;width:2px;background:rgba(0,0,0,.15);border-radius:1px;pointer-events:none">
            <span style="position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-size:10px;font-weight:800;color:#6b7280;white-space:nowrap">80%</span>
          </div>
          <!-- keyword bands -->
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:space-around;padding:0 12px;pointer-events:none">
            <span id="rqr-kw0-${o.id}" style="font-size:10px;font-weight:700;opacity:.4;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap">${isMr ? "😞 समाधान नाही" : "😞 Not Happy"}</span>
            <span id="rqr-kw1-${o.id}" style="font-size:10px;font-weight:700;opacity:.4;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap">${isMr ? "🙂 बरे होते" : "🙂 Pretty Good"}</span>
            <span id="rqr-kw2-${o.id}" style="font-size:10px;font-weight:700;opacity:.4;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap">${isMr ? "🤩 अप्रतिम!" : "🤩 Amazing!"}</span>
          </div>
          <!-- thumb -->
          <div id="rqr-inline-thumb-${o.id}" style="position:absolute;top:50%;transform:translateY(-50%);left:calc(80% - 19px);width:38px;height:38px;background:#fff;border-radius:50%;box-shadow:0 3px 12px rgba(0,0,0,.22);display:flex;align-items:center;justify-content:center;font-size:18px;pointer-events:none;border:2px solid #e5e0d8;transition:left .08s">😊</div>
          <input type="range" min="0" max="100" value="80" step="1" id="rqr-inline-slider-${o.id}"
            style="position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;z-index:2;margin:0">
        </div>
      </div>

      <div style="text-align:center;margin:8px 0 4px">
        <span id="rqr-inline-pct-${o.id}" style="font-size:26px;font-weight:900;color:#16a34a">80%</span>
      </div>
      <p id="rqr-inline-sub-${o.id}" style="text-align:center;font-size:13px;color:#6b7280;margin:0 0 16px;min-height:18px">
        ${isMr ? "छान! ✨ Review बनवायला मदत करतो." : "Great! ✨ We'll help you write a review."}
      </p>

      <button id="rqr-inline-cta-${o.id}" class="btn primary block"
        style="background:#ff6b00;border:none;color:#fff;font-weight:800;font-size:15px;padding:14px;border-radius:14px;width:100%;cursor:pointer;margin-bottom:10px"
        data-action="open-review-sheet"
        data-slug="${r.slug}"
        data-name="${esc(r.name)}"
        data-url="${esc(r.googleReviewUrl || "")}"
        data-oid="${o.id}">
        ✨ ${isMr ? "माझ्यासाठी Review बनवा" : "Generate My Review"}
      </button>
      <button class="btn block" data-action="dismiss-review" data-slug="${r.slug}"
        style="font-size:13px;color:#9ca3af">
        ${isMr ? "नंतर करतो" : "Maybe later"}
      </button>
      <button class="btn block" style="width:100%;margin-top:8px;background:#fff7ed;border:1.5px solid #f59e0b;color:#92400e;font-weight:700" data-action="call-waiter" data-order="${o.id}" data-slug="${r.slug}">${o.waiterRequest === "waiter" ? "🔔 Serving Staff Notified" : "🔔 Call Serving Staff"}</button>
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

    const staffInfo = [];
    if (o.upiConfirmedBy) staffInfo.push(`✅ UPI confirmed by <strong>${esc(o.upiConfirmedBy.name)}</strong> at ${new Date(o.upiConfirmedBy.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`);
    if (o.cashConfirmedBy) staffInfo.push(`💵 Cash received by <strong>${esc(o.cashConfirmedBy.name)}</strong> at ${new Date(o.cashConfirmedBy.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`);
    if (o.closedBy) staffInfo.push(`🔒 Closed by <strong>${esc(o.closedBy.name)}</strong> at ${new Date(o.closedBy.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`);

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
      ${staffInfo.length ? `<div style="margin-top:8px;padding:8px 10px;background:var(--bg,#f9f6f1);border-radius:8px;display:flex;flex-direction:column;gap:4px">
        ${staffInfo.map(s => `<p class="muted small" style="margin:0">${s}</p>`).join("")}
      </div>` : ""}
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
      const slug = el.dataset.slug;
      if (!confirm("Delete " + (bySlug(slug)?.name || "this restaurant") + "? This cannot be undone.")) return;
      mutate(s => {
        s.restaurants    = s.restaurants.filter(r => r.slug !== slug);
        s.orders         = s.orders.filter(o => o.restaurantSlug !== slug);
        s.feedbacks      = s.feedbacks.filter(f => f.restaurantSlug !== slug);
        s.billingArchive = (s.billingArchive || []).filter(a => a.restaurantSlug !== slug);
      });
      if (firebaseMode && db) {
        db.child("ownerIndex").child(slug).remove();
        db.child("staff").child(slug).remove();
      }
      return;
    }
    if (action === "toggle-active") return updateRestaurant(el.dataset.slug, r => r.active = !r.active);
    if (action === "toggle-qr") return updateRestaurant(el.dataset.slug, r => r.qrEnabled = !r.qrEnabled);
    if (action === "extend-sub") return updateRestaurant(el.dataset.slug, r => { r.active = true; r.qrEnabled = true; r.subscriptionEnds = Math.max(Date.now(), r.subscriptionEnds || 0) + days(30); });
    if (action === "owner-tab") return ownerTab = el.dataset.tab, render();
    if (action === "common-items-tab") return commonItemsTab = el.dataset.tab, render();
    if (action === "analytics-period") { window._analyticsPeriod = el.dataset.period; if (el.dataset.period === "day") window._analyticsDayOffset = 0; if (el.dataset.period === "week") window._analyticsWeekOffset = 0; return render(); }
    if (action === "analytics-nav") { var dir = Number(el.dataset.dir); var p = window._analyticsPeriod || "month"; if (p === "day") window._analyticsDayOffset = (window._analyticsDayOffset || 0) + dir; if (p === "week") window._analyticsWeekOffset = (window._analyticsWeekOffset || 0) + dir; return render(); }
    if (action === "print-qr") return window.print();
    if (action === "add-item") return addMenuItem(el.dataset.slug);
    if (action === "add-common") return addCommonItem(el.dataset.slug, Number(el.dataset.index), el.dataset.source);
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
    if (action === "customer-veg-filter") return customerVegFilter = el.dataset.veg, render();
    if (action === "customer-search-clear") {
      customerSearch = "";
      render();
      const ni = document.getElementById("customer-search-input");
      if (ni) ni.focus();
      return;
    }
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
    if (action === "open-review-sheet") {
      const oid = el.dataset.oid;
      const slider = document.getElementById("rqr-inline-slider-" + oid);
      const pct = slider ? parseInt(slider.value) : 80;
      const rSlug = el.dataset.slug;
      const rName = el.dataset.name;
      const rUrl  = el.dataset.url;
      const rLang = localStorage.getItem("restoqr_lang") || "en";
      const rDb   = (typeof db !== "undefined") ? db : null;
      const rFbMode = (typeof firebaseMode !== "undefined") ? firebaseMode : false;
      window._rqr_slug = rSlug;
      if (window.RestoReview) {
        window.RestoReview.show({ restaurantName: rName, restaurantSlug: rSlug, googleReviewUrl: rUrl, lang: rLang, satisfaction: pct, db: rDb, firebaseMode: rFbMode });
      } else {
        toast("Review generator is loading, please try again in a moment.");
      }
      return;
    }
    if (action === "dismiss-review") return localStorage.removeItem("restoqr_last_order_" + el.dataset.slug), render();
    if (action === "refresh-order") return render();
    if (action === "call-waiter") {
      mutate(s => { const o = s.orders.find(x => x.id === el.dataset.order); if (o && o.waiterRequest !== "waiter") o.waiterRequest = "waiter"; });
      return;
    }
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
      const loginSlug = el.dataset.slug;
      if (firebaseMode && auth) {
        // Firebase Auth login
        const emailEl = document.getElementById("staff-email-input");
        const passEl  = document.getElementById("staff-pass-input");
        const errEl   = document.getElementById("staff-login-err");
        const email    = (emailEl ? emailEl.value : "").trim();
        const password = passEl ? passEl.value : "";
        if (!email || !password) { if (errEl) errEl.textContent = "Please enter email and password."; return; }
        const btn = document.querySelector("[data-action='staff-login']");
        if (btn) { btn.textContent = "Signing in…"; btn.disabled = true; }
        auth.signInWithEmailAndPassword(email, password)
          .then(() => {
            // onAuthStateChanged will fire → render() → isStaffUnlocked() will check staff record
            staffTab = "kitchen";
            toast("Welcome!");
          })
          .catch(e => {
            if (btn) { btn.textContent = "Sign In"; btn.disabled = false; }
            const msg = friendlyAuthError(e.code);
            if (errEl) errEl.textContent = msg; else toast(msg);
          });
        return;
      }
      // Fallback: master key (non-Firebase mode)
      const input = document.getElementById("staff-key-input");
      const entered = (input ? input.value : "").trim();
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
      if (firebaseMode && auth) {
        auth.signOut().then(() => { staffSheetTable = null; render(); });
      } else {
        localStorage.removeItem(staffKeyFor(el.dataset.slug));
        localStorage.removeItem("restoqr_staff_role_" + el.dataset.slug);
        staffSheetTable = null;
        render();
      }
      return;
    }
    if (action === "staff-toggle-active") {
      if (!firebaseMode || !db) return toast("Firebase not available");
      const { slug, uid: staffUid, active } = el.dataset;
      const newActive = active !== "1";
      db.child("staff").child(slug).child(staffUid).update({ active: newActive })
        .then(() => toast(newActive ? "Staff reactivated." : "Staff deactivated."))
        .catch(() => toast("Failed to update staff status."));
      return;
    }
    if (action === "staff-add-member") {
      if (!firebaseMode || !auth || !db) return toast("Firebase not available");
      const slug      = el.dataset.slug;
      const name      = (document.getElementById("staff-add-name")?.value  || "").trim();
      const email     = (document.getElementById("staff-add-email")?.value || "").trim();
      const password  = (document.getElementById("staff-add-pass")?.value  || "").trim();
      const role      = document.getElementById("staff-add-role")?.value || "waiter";
      if (!name)               return toast("Enter staff name");
      if (!email)              return toast("Enter staff email");
      if (password.length < 6) return toast("Password must be at least 6 characters");
      el.textContent = "Adding…"; el.disabled = true;

      // Step 1 — create Firebase Auth account via secondary app (keeps owner signed in)
      let secondaryApp;
      try { secondaryApp = firebase.app("staffCreator"); }
      catch(e) { secondaryApp = firebase.initializeApp(window.FIREBASE_CONFIG, "staffCreator"); }
      const secondaryAuth = secondaryApp.auth();

      secondaryAuth.createUserWithEmailAndPassword(email, password)
        .then(credential => {
          const staffUid = credential.user.uid;
          // Step 2 — write staff record as owner (owner's db reference, so rules pass)
          return db.child("staff").child(slug).child(staffUid).set({
            name, email, role, active: true, createdAt: Date.now()
          })
          .then(() => secondaryAuth.signOut())  // Step 3 — clean up secondary session
          .then(() => staffUid);
        })
        .then(staffUid => {
          toast(`${name} added as ${role}!`);
          ["staff-add-name", "staff-add-email", "staff-add-pass"].forEach(id => {
            const inp = document.getElementById(id); if (inp) inp.value = "";
          });
          el.textContent = "Add Staff"; el.disabled = false;
          render();
        })
        .catch(e => {
          el.textContent = "Add Staff"; el.disabled = false;
          const msg = {
            "auth/email-already-in-use": "This email already has a staff account.",
            "auth/invalid-email":        "Please enter a valid email address.",
            "auth/weak-password":        "Password must be at least 6 characters."
          }[e.code] || friendlyAuthError(e.code);
          toast(msg);
        });
      return;
    }
    if (action === "staff-tab") { staffTab = el.dataset.tab; staffSheetTable = null; return render(); }
    if (action === "staff-toggle-sound") {
      staffSoundEnabled = !staffSoundEnabled;
      localStorage.setItem("restoqr_staff_sound_off", staffSoundEnabled ? "no" : "yes");
      if (staffSoundEnabled) { ensureStaffAudio(); playWaiterAlertSound(); }
      toast(staffSoundEnabled ? "🔔 Alert sound ON" : "🔕 Alert sound muted");
      return render();
    }
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
      const staffInfo = firebaseMode && currentUser ? {
        uid: currentUser.uid, name: currentStaffName(el.dataset.slug || ""), at: Date.now()
      } : null;
      mutate(s => ids.forEach(id => {
        const o = s.orders.find(x => x.id === id);
        if (o) { o.paymentStatus = "paid"; o.status = "pending"; if (staffInfo) o.upiConfirmedBy = staffInfo; }
      }));
      return toast("✅ UPI payment confirmed");
    }
    if (action === "staff-send-cash-kitchen") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      mutate(s => ids.forEach(id => { const o = s.orders.find(x => x.id === id); if (o && o.paymentStatus === "cash_pending") { o.paymentStatus = "cash_sent"; o.status = "pending"; } }));
      return toast("🍳 Sent to kitchen");
    }
    if (action === "staff-confirm-cash") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      const staffInfo = firebaseMode && currentUser ? {
        uid: currentUser.uid, name: currentStaffName(el.dataset.slug || ""), at: Date.now()
      } : null;
      mutate(s => ids.forEach(id => {
        const o = s.orders.find(x => x.id === id);
        if (o && o.paymentStatus === "cash_sent") { o.paymentStatus = "cash_accepted"; if (staffInfo) o.cashConfirmedBy = staffInfo; }
      }));
      return toast("💵 Cash received");
    }
    if (action === "staff-close-table") {
      const ids = el.dataset.ids.split(",").filter(Boolean);
      const staffInfo = firebaseMode && currentUser ? {
        uid: currentUser.uid, name: currentStaffName(el.dataset.slug || ""), at: Date.now()
      } : null;
      mutate(s => ids.forEach(id => {
        const o = s.orders.find(x => x.id === id);
        if (o) { o.status = "completed"; if (staffInfo) o.closedBy = staffInfo; }
      }));
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

    const btn = document.querySelector("[data-action='register']");

    function saveRestaurant(ownerEmail) {
      const newRestaurant = {
        id: uid(), slug, name, owner, phone, city, ownerPin: pin, active: false, qrEnabled: false,
        plan: "Pending", subscriptionEnds: Date.now(), paymentQr: DEFAULT_QR,
        upiId: upiId || "", upiName: upi || owner, googleReviewUrl: review,
        couponCode: coupon,
        ownerEmail: ownerEmail || "",
        tables: [1, 2, 3, 4].map(no => ({ no, seats: 4 })),
        categories: ["Starters", "Main Course", "Breads", "Beverages"],
        menu: [], addons: [], createdAt: Date.now()
      };

      // Write directly to restaurants/<nextIndex> instead of a transaction on
      // the parent node. Firebase rules evaluate at $index level — a transaction
      // on the parent is denied because there is no parent-level .write rule.
      // Reading the current array first and writing to the next numeric index
      // satisfies the $index rule (ownerEmail on newData matches auth.token.email).
      db.child("restaurants").once("value").then(snap => {
        const current = snap.val();
        const arr = (current && typeof current === "object" && !Array.isArray(current))
          ? Object.values(current).filter(Boolean)
          : (Array.isArray(current) ? current : []);
        const nextIndex = arr.length;
        return db.child("restaurants").child(String(nextIndex)).set(newRestaurant);
      }).then(() => {
        state.restaurants.push(newRestaurant);
        rememberOwnerLink(slug, ownerEmail);
        if (btn) { btn.textContent = "Submit Registration"; btn.disabled = false; }
        toast("Registered! Admin will activate your subscription.");
        location.hash = "#/owner?resto=" + slug;
        render();
      }).catch(e => {
        if (btn) { btn.textContent = "Submit Registration"; btn.disabled = false; }
        toast("Save failed: " + e.message);
      });
    }

    if (firebaseMode && auth) {
      if (btn) { btn.textContent = "Registering…"; btn.disabled = true; }

      auth.createUserWithEmailAndPassword(email, password)
        .then(credential => {
          saveRestaurant(credential.user.email || email);
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
    } else {
      toast("Firebase is not configured. Registration requires Firebase.");
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

  function addCommonItem(slug, index, source) {
    const list = source === "cafe" ? CAFE_ITEMS : COMMON_ITEMS;
    const c = list[index];
    if (!c) return;
    const priceInputId = "common-price-" + (source || "resto") + "-" + index;
    const price = Number(val(priceInputId)) || c[2];
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
    const cleanOwnerEmail = settingsOwnerEmail();
    // Keep ownerIndex in sync so staff write rules can verify ownership by slug
    if (firebaseMode && db && cleanOwnerEmail) {
      db.child("ownerIndex").child(slug).set(cleanOwnerEmail);
    }
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
          if (cleanOwnerEmail) r.ownerEmail = cleanOwnerEmail;
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
        if (cleanOwnerEmail) r.ownerEmail = cleanOwnerEmail;
      });
      toast("Settings saved!");
    }
  }

  function settingsOwnerEmail() {
    const typed = normEmail(val("set-owner-email"));
    if (!firebaseMode) return typed;
    if (_isAdminCache === true) return typed;
    return normEmail(currentUser?.email) || typed;
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
      return m ? { id, name: m.name, price: m.price, qty } : null;
    }).filter(Boolean);
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
    customerSearch = "";
    customerVegFilter = "all";
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
      return m ? { id, name: m.name, price: m.price, qty } : null;
    }).filter(Boolean);
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
    customerSearch = "";
    customerVegFilter = "all";
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
    const isMarathi = localStorage.getItem("restoqr_lang") === "mr";
    const ownerNavSlug = r?.slug || (firebaseMode && currentUser ? ownerSlugForUser(currentUser) : "") || localStorage.getItem("restoqr_owner_slug") || "";
    return `<header class="topbar"><div class="topbar-inner">
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
        <a class="btn ${active === "register" ? "primary" : ""}" href="#/register">${isMarathi ? "नोंदणी" : "Register"}</a>
        <a class="btn ${active === "owner" ? "primary" : ""}" href="#/owner${ownerNavSlug ? "?resto=" + ownerNavSlug : ""}">${isMarathi ? "मालक" : "Owner"}</a>
        <a class="btn ${active === "staff" ? "primary" : ""}" href="#/staff${r ? "?resto=" + r.slug : "?resto=" + (state.restaurants[0]?.slug || "")}">${isMarathi ? "स्टाफ" : "Staff"}</a>
        <a class="btn ${active === "admin" ? "primary" : ""}" href="#/admin">${isMarathi ? "व्यवस्थापक" : "Admin"}</a>
        <button class="btn lang-toggle-btn" id="lang-toggle-btn" title="${isMarathi ? "Switch to English" : "मराठीत बघा"}" onclick="(function(){var cur=localStorage.getItem('restoqr_lang')||'en';localStorage.setItem('restoqr_lang',cur==='mr'?'en':'mr');location.reload();})()" style="display:inline-flex;align-items:center;gap:5px;padding:7px 12px;font-weight:700;font-size:13px;border-radius:8px;background:${isMarathi ? '#ff6b00' : '#c24a00'};color:#fff;border:none;cursor:pointer">
          ${isMarathi ? "🇮🇳 EN" : "🇮🇳 मराठी"}
        </button>
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
    dot.addEventListener("click", () => showSlide(i));
    dotsWrap.appendChild(dot);
  });

  const dots = dotsWrap.querySelectorAll("button");

  function stopAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(() => showSlide(current + 1), 5000);
  }

  function showSlide(index) {
    slides[current].classList.remove("active");
    dots[current].classList.remove("active");
    current = (index + slides.length) % slides.length;
    slides[current].classList.add("active");
    dots[current].classList.add("active");
    startAuto();
  }

  document.querySelector(".carousel-btn.next")?.addEventListener("click", () => showSlide(current + 1));
  document.querySelector(".carousel-btn.prev")?.addEventListener("click", () => showSlide(current - 1));

  const carouselEl = document.querySelector(".carousel-container");
  carouselEl?.addEventListener("mouseenter", stopAuto);
  carouselEl?.addEventListener("mouseleave", startAuto);

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
    if (document.querySelector("[id^='rqr-inline-track-']")) {
      initReviewSliders();
    }
  });
}
  function initReviewSliders() {
    document.querySelectorAll("[id^='rqr-inline-track-']").forEach(function(track) {
      var oid = track.id.replace("rqr-inline-track-", "");
      var slider = document.getElementById("rqr-inline-slider-" + oid);
      var thumb  = document.getElementById("rqr-inline-thumb-" + oid);
      var pctEl  = document.getElementById("rqr-inline-pct-" + oid);
      var subEl  = document.getElementById("rqr-inline-sub-" + oid);
      var ctaBtn = document.getElementById("rqr-inline-cta-" + oid);
      var kw0    = document.getElementById("rqr-kw0-" + oid);
      var kw1    = document.getElementById("rqr-kw1-" + oid);
      var kw2    = document.getElementById("rqr-kw2-" + oid);
      if (!slider || !thumb || !track) return;
      var lang = localStorage.getItem("restoqr_lang") || "en";
      var isMr = lang === "mr";

      function update(pct) {
        var high = pct >= 80;
        var tw = track.getBoundingClientRect().width || track.offsetWidth || 300;
        var th = 38;
        thumb.style.left = ((pct / 100) * (tw - th) + th / 2) + "px";
        thumb.textContent = pct >= 90 ? "🤩" : pct >= 80 ? "😊" : pct >= 65 ? "🙂" : pct >= 40 ? "😐" : "😞";
        pctEl.textContent = pct + "%";
        pctEl.style.color = high ? "#16a34a" : "#dc2626";
        [kw0, kw1, kw2].forEach(function(k) { if (k) k.style.opacity = ".4"; });
        if (pct < 50 && kw0) kw0.style.opacity = "1";
        else if (pct < 80 && kw1) kw1.style.opacity = "1";
        else if (kw2) kw2.style.opacity = "1";
        if (pct >= 90) subEl.textContent = isMr ? "अप्रतिम! 🤩 Review generate करू का?" : "Amazing! 🤩 Let us write a review for you!";
        else if (pct >= 80) subEl.textContent = isMr ? "छान! ✨ Review बनवायला मदत करतो." : "Great! ✨ We'll help you write a review.";
        else if (pct >= 65) subEl.textContent = isMr ? "ठीकठाक — Feedback द्याल का?" : "Pretty good — care to leave feedback instead?";
        else subEl.textContent = isMr ? "माफ करा 😔 — Feedback नक्की पाठवा." : "We're sorry 😔 — please share your feedback.";
        if (ctaBtn) {
          ctaBtn.style.background = high ? "#ff6b00" : "#1c0e04";
          ctaBtn.innerHTML = high
            ? "✨ " + (isMr ? "माझ्यासाठी Review बनवा" : "Generate My Review")
            : "📝 " + (isMr ? "Feedback द्या" : "Leave Feedback Instead");
        }
      }

      slider.addEventListener("input", function() { update(parseInt(slider.value)); });
      requestAnimationFrame(function() { update(parseInt(slider.value)); });
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
  document.addEventListener("input", function(e) {
    const el = e.target.closest("[data-action='customer-search']");
    if (!el) return;
    customerSearch = el.value;
    const pos = el.selectionStart;
    render();
    const ni = document.getElementById("customer-search-input");
    if (ni) { ni.focus(); ni.setSelectionRange(pos, pos); }
  });
  document.addEventListener("change", function(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    if (el.dataset.action === "billing-date-pick" || el.dataset.action === "billing-date-select") {
      billingDateFilter = el.value;
      render();
    }
    if (el.dataset.action === "analytics-month-select") {
      const parts = el.value.split("-");
      window._analyticsYear  = Number(parts[0]);
      window._analyticsMonth = Number(parts[1]);
      render();
    }
  });
  start();
})();