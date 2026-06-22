(function () {
  const KEY = "restoqr_cloud_state_v1";
  const DEFAULT_QR = "./assets/phonepe-qr.png";
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  let state = seed();
  let db = null;
  let firebaseMode = false;
  let ownerTab = "overview";
  let customerCat = "";
  let cart = {};
  let selectedAddons = {}; // addonId -> true

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
      db = firebase.database().ref("restoqr");
      db.on("value", snap => {
        const value = snap.val();
        if (value && value.restaurants) state = normalizeState(value);
        else save(seed());
        render();
      });
    } else {
      try { state = JSON.parse(localStorage.getItem(KEY)) || state; } catch {}
      state = normalizeState(state);
      render();
    }
    window.addEventListener("hashchange", () => {
      customerCat = "";
      render();
    });
  }

  function canUseFirebase() {
    const c = window.FIREBASE_CONFIG || {};
    return !!(window.firebase && c.apiKey && c.databaseURL && c.projectId);
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
      r.tables = r.tables || [];
      r.menu = r.menu || [];
      r.addons = r.addons || [];
      r.categories = unique([...(r.categories || []), ...r.menu.map(i => i.category)]);
    });
    return next;
  }

  function save(next) {
    state = clone(next || state);
    if (firebaseMode && db) db.set(state);
    else localStorage.setItem(KEY, JSON.stringify(state));
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

  function render() {
    const r = route();
    if (r.path === "/register") return html(registerView());
    if (r.path === "/admin") return html(adminView());
    if (r.path === "/owner") return html(ownerView(r.params));
    if (r.path === "/order") return html(customerView(r.params));
    return html(homeView());
  }

  function homeView() {
    const active = state.restaurants.filter(r => r.active).length;
    const waiting = state.orders.filter(o => o.paymentStatus === "waiting").length;
    const today = state.orders.filter(o => sameDay(o.createdAt, Date.now()));
    return `
      ${topbar("home")}
      <main class="hero">
        <div class="hero-inner">
          <section>
            <h1>RestoQR Cloud</h1>
            <p>QR ordering system for restaurants: owner panels, customer menu, kitchen display, billing counter, payment verification, subscriptions, and review collection.</p>
            <div class="hero-actions">
              <a class="btn primary" href="#/register">Register Restaurant</a>
              <a class="btn" href="#/owner">Restaurant Login</a>
              <a class="btn" href="#/admin">Super Admin</a>
            </div>
          </section>
          <section class="demo-board">
            <div class="grid-2">
              ${stat("Restaurants", state.restaurants.length)}
              ${stat("Active", active)}
              ${stat("Payment Checks", waiting)}
              ${stat("Orders Today", today.length)}
            </div>
            <div class="card">
              <div class="section-head">
                <div><h2>Restaurant Operations</h2><p>Manage registrations, QR ordering, kitchen flow, billing, and customer reviews from one place.</p></div>
                <span class="pill ok">Ready</span>
              </div>
              <div class="row">
                <span class="muted">Restaurant owner access</span>
                <a class="btn blue" href="#/owner">Owner Login</a>
              </div>
            </div>
          </section>
        </div>
      </main>`;
  }

  function registerView() {
    return `
      ${topbar("register")}
      <main class="wrap split">
        <section class="card">
          <div class="section-head"><div><h2>Restaurant Registration</h2><p>Restaurant pays you on PhonePe, then you activate it from admin.</p></div></div>
          <div class="grid-2">
            ${field("Restaurant Name", "reg-name", "input", "Cafe Aroma")}
            ${field("Owner Name", "reg-owner", "input", "Owner name")}
            ${field("Phone", "reg-phone", "input", "Mobile number")}
            ${field("City", "reg-city", "input", "City")}
            ${field("Owner Login PIN", "reg-pin", "input", "4 digit PIN", "password")}
            ${field("UPI ID (VPA)", "reg-upiid", "input", "name@upi or 9999999999@paytm")}
            ${field("UPI Display Name", "reg-upi", "input", "Shown under payment QR")}
            ${field("Google Review Link", "reg-review", "input", "Paste Google review link")}
          </div>
          <button class="btn primary" data-action="register">Submit Registration</button>
        </section>
        <aside class="qr-box">
          <p class="small">Pay registration/subscription here</p>
          <img src="${DEFAULT_QR}" alt="PhonePe QR">
          <h3>PhonePe accepted here</h3>
          <p class="small">After payment, admin will activate the restaurant manually.</p>
        </aside>
      </main>`;
  }

  function adminView() {
    if (localStorage.getItem("restoqr_admin_unlocked") !== "yes") {
      return `
        ${topbar("admin")}
        <main class="wrap">
          <section class="card" style="max-width:420px">
            <div class="section-head"><div><h2>Super Admin</h2><p>Enter your admin passcode.</p></div></div>
            ${field("Admin Passcode", "admin-pin", "input", "Enter passcode", "password")}
            <button class="btn primary block" data-action="admin-login">Unlock Admin</button>
          </section>
        </main>`;
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
          <div class="section-head"><div><h2>Restaurants</h2><p>Activate subscriptions, disable QR ordering, and control access.</p></div><button class="btn" data-action="admin-logout">Lock</button></div>
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
          </div>
        </div>
        <div class="row" style="margin-top:12px; flex-wrap:wrap">
          <span class="muted small">${orders.length} orders · Owner PIN ${esc(r.ownerPin)}</span>
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
    const slug = params.get("resto") || localStorage.getItem("restoqr_owner_slug") || (state.restaurants[0]?.slug || "");
    const r = bySlug(slug);
    if (!r) return shell("Owner Panel", `<section class="card">${empty("Restaurant not found")}<a class="btn primary" href="#/register">Register</a></section>`, "owner");
    const unlocked = localStorage.getItem("restoqr_owner_" + r.slug) === "yes";
    if (!unlocked) {
      return shell("Owner Login", `
        <section class="card" style="max-width:440px">
          <div class="section-head"><div><h2>${esc(r.name)}</h2><p>Enter the owner PIN shared during registration.</p></div></div>
          ${selectRestaurant(r.slug)}
          ${field("Owner PIN", "owner-pin", "input", "Enter PIN", "password")}
          <button class="btn primary block" data-action="owner-login" data-slug="${r.slug}">Open Restaurant Panel</button>
        </section>`, "owner");
    }
    return `
      ${topbar("owner", r)}
      <main class="wrap">
        <div class="tabs">
          ${["overview", "menu", "addons", "tables", "kitchen", "billing", "feedback", "settings"].map(t => `<button class="tab-btn ${ownerTab === t ? "active" : ""}" data-action="owner-tab" data-tab="${t}">${title(t)}</button>`).join("")}
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
          ${COMMON_ITEMS.map((c, idx) => `
            <div class="catalog-card">
              <div><strong><span style="color:${c[3] ? "var(--ok)" : "var(--bad)"}">●</span> ${esc(c[0])}</strong><p class="muted small">${esc(c[1])}</p></div>
              <div class="row-left">
                <input id="common-price-${idx}" type="number" value="${c[2]}" aria-label="${esc(c[0])} price">
                <button class="btn primary" data-action="add-common" data-slug="${r.slug}" data-index="${idx}">Add</button>
              </div>
            </div>`).join("")}
        </div>
      </section>
      <section class="card" style="margin-top:14px">
        ${r.menu.map(i => `
          <div class="list-item menu-item">
            <div><strong><span style="color:${i.veg ? "var(--ok)" : "var(--bad)"}">●</span> ${esc(i.name)}</strong><p class="muted small">${esc(i.category)} · ${money(i.price)} · ${i.available ? "Available" : "Hidden"}</p></div>
            <div class="row-left">
              <input id="price-${i.id}" type="number" value="${i.price}" aria-label="${esc(i.name)} price" style="width:92px">
              <button class="btn blue" data-action="update-price" data-slug="${r.slug}" data-id="${i.id}">Save</button>
              <button class="btn" data-action="toggle-item" data-slug="${r.slug}" data-id="${i.id}">${i.available ? "Hide" : "Show"}</button>
              <button class="btn bad" data-action="delete-item" data-slug="${r.slug}" data-id="${i.id}">Delete</button>
            </div>
          </div>`).join("")}
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
    const orders = state.orders.filter(o => o.restaurantSlug === r.slug && o.paymentStatus === "paid" && o.status !== "completed");
    return `<section class="card"><div class="section-head"><div><h2>Kitchen</h2><p>Paid orders appear here after counter verifies payment.</p></div></div>${orders.map(orderCard).join("") || empty("No paid kitchen orders")}</section>`;
  }

  function billingPanel(r) {
    const orders = state.orders.filter(o => o.restaurantSlug === r.slug && o.status !== "completed");
    return `<section class="card"><div class="section-head"><div><h2>Billing Counter</h2><p>Check PhonePe payment, mark paid, and close tables.</p></div></div>${orders.map(billCard).join("") || empty("No active bills")}</section>`;
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
              <span style="color:#f59e0b;font-size:18px">${stars(f.stars)}</span>
              <p class="muted small" style="margin:4px 0 0">Table ${f.table} · Order #${f.orderId.slice(-5).toUpperCase()} · ${new Date(f.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p>
            </div>
            <span class="pill ${f.stars >= 4 ? "ok" : f.stars >= 3 ? "warn" : "bad"}">${f.stars}/5</span>
          </div>
          ${f.text ? `<p style="margin:8px 0 0;font-size:14px">"${esc(f.text)}"</p>` : ""}
        </div>`).join("") || empty("No feedback yet")}
    </section>`;
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
        <button class="btn primary" data-action="save-settings" data-slug="${r.slug}">Save Settings</button>
        <button class="btn" data-action="owner-logout" data-slug="${r.slug}">Logout</button>
      </section>`;
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
    // If there's an active (non-completed) order, show the order tracking view
    if (lastOrder && lastOrder.status !== "completed") {
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
        ${lastOrder && lastOrder.status === "completed" ? customerStatusCard(r, lastOrder) : ""}
        <div class="cat-strip">${unique(r.menu.map(i => i.category)).map(c => `<button class="${c === customerCat ? "active" : ""}" data-action="customer-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
        <div style="padding-bottom:${cartCount() ? "0" : "80px"}">
          ${items.map(i => customerItem(r, i)).join("") || empty("No items available")}
          ${r.addons.filter(a => a.active).length ? `
            <div style="padding:10px 14px 4px;border-top:1px solid var(--line);margin-top:8px">
              <p style="font-size:12px;font-weight:600;color:var(--muted,#6b7280);margin:0 0 6px;text-transform:uppercase;letter-spacing:.05em">Add-ons</p>
              ${r.addons.filter(a => a.active).map(a => `
                <div class="customer-item">
                  <label style="display:flex;align-items:center;gap:10px;cursor:pointer;flex:1">
                    <input type="checkbox" data-action="addon-toggle" data-addon="${a.id}" data-price="${a.price}" data-base="0" data-pa="${r.upiId||""}" data-pn="${esc(r.upiName||r.name)}" class="addon-chk" ${selectedAddons[a.id] ? "checked" : ""} style="width:18px;height:18px;accent-color:var(--ok,#16a34a)">
                    <div><strong>+ ${esc(a.name)}</strong><p class="muted small">${money(a.price)}</p></div>
                  </label>
                </div>`).join("")}
            </div>` : ""}
        </div>
        ${cartCount() ? checkoutBox(r, total) : ""}
      </div>`;
  }

  function customerItem(r, i) {
    const q = cart[i.id] || 0;
    return `<div class="customer-item">
      <div><strong><span style="color:${i.veg ? "var(--ok)" : "var(--bad)"}">●</span> ${esc(i.name)}</strong><p class="muted small">${money(i.price)}</p></div>
      ${q ? `<div class="qty"><button data-action="cart-dec" data-id="${i.id}">-</button><strong>${q}</strong><button class="plus" data-action="cart-inc" data-id="${i.id}">+</button></div>` : `<button class="btn primary" data-action="cart-inc" data-id="${i.id}">Add</button>`}
    </div>`;
  }

  function checkoutBox(r, total) {
    const pa = encodeURIComponent(r.upiId || "");
    const pn = encodeURIComponent(r.upiName || r.name);
    const addonTotal = Object.keys(selectedAddons).reduce((s, id) => {
      const a = find(r.addons, id);
      return s + (a ? a.price : 0);
    }, 0);
    const grand = total + addonTotal;
    const selectedAddonList = Object.keys(selectedAddons).map(id => find(r.addons, id)).filter(Boolean);

    return `<div class="cart-bar" style="display:flex;flex-direction:column;max-height:70vh;">

      <div class="cart-scrollable" style="overflow-y:auto;flex:1;min-height:0;padding-bottom:4px">
        <div class="cart-summary">
          ${Object.entries(cart).map(([id, qty]) => {
            const m = find(r.menu, id);
            return m ? `<div class="cart-row"><span>${esc(m.name)} × ${qty}</span><span>${money(m.price * qty)}</span></div>` : "";
          }).join("")}
          ${selectedAddonList.map(a => `<div class="cart-row"><span>+ ${esc(a.name)}</span><span>${money(a.price)}</span></div>`).join("")}
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
        ${!r.upiId ? `<p style="color:#ef4444;font-size:12px;margin:4px 0">⚠ UPI ID not set — add in Settings.</p>` : ""}
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
    const statusColor = { payment_check: "#f59e0b", pending: "#3b82f6", preparing: "#8b5cf6", ready: "#10b981", completed: "#10b981" };
    const color = statusColor[o.status] || "#3b82f6";
    return `
      <div style="padding:16px 14px">

        <div style="background:${color}15;border:1.5px solid ${color};border-radius:12px;padding:16px;margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div>
              <p style="margin:0;font-size:12px;color:var(--muted,#6b7280);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Order #${o.id.slice(-5).toUpperCase()}</p>
              <p style="margin:2px 0 0;font-size:13px;color:var(--muted,#6b7280)">Table ${o.table} · ${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p>
            </div>
            <span style="background:${color};color:#fff;padding:5px 12px;border-radius:20px;font-size:13px;font-weight:600">${stepLabels[Math.max(0, currentStep)] || "Active"}</span>
          </div>

          <div style="display:flex;align-items:center;gap:0;margin:12px 0 4px">
            ${statusSteps.slice(0, -1).map((s, i) => `
              <div style="flex:1;height:4px;border-radius:2px;background:${i <= currentStep ? color : "#e5e7eb"}"></div>
              ${i < statusSteps.length - 2 ? `<div style="width:8px;height:8px;border-radius:50%;background:${i < currentStep ? color : i === currentStep ? color : "#e5e7eb"};flex-shrink:0"></div>` : ""}
            `).join("")}
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:6px">
            ${stepLabels.slice(0, -1).map((l, i) => `<span style="font-size:10px;color:${i <= currentStep ? color : "var(--muted,#9ca3af)"};font-weight:${i === currentStep ? "700" : "400"}">${l}</span>`).join("")}
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
          ${o.paymentStatus === "waiting" ? "⏳ Waiting for payment verification by counter..." : o.status === "preparing" ? "👨‍🍳 Your food is being prepared!" : o.status === "ready" ? "🛎 Your order is ready! Counter will serve you shortly." : "✅ Payment verified. Order confirmed!"}
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
    const delivered = o.status === "completed";
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
    const next = o.status === "pending" ? "preparing" : o.status === "preparing" ? "ready" : "completed";
    return `<div class="list-item">
      <div class="row"><div><strong>Table ${o.table}</strong><p class="muted small">#${o.id.slice(-5).toUpperCase()} · ${new Date(o.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</p></div><span class="pill blue">${title(o.status)}</span></div>
      ${orderLines(o)}
      ${o.note ? `<p class="pill warn">Note: ${esc(o.note)}</p>` : ""}
      <div class="row" style="margin-top:10px"><strong>${money(o.total)}</strong><button class="btn ok" data-action="advance-order" data-id="${o.id}" data-next="${next}">${next === "completed" ? "Complete" : "Mark " + title(next)}</button></div>
    </div>`;
  }

  function billCard(o) {
    return `<div class="list-item">
      <div class="row"><div><strong>Table ${o.table}</strong><p class="muted small">Order #${o.id.slice(-5).toUpperCase()}</p></div><span class="pill ${o.paymentStatus === "paid" ? "ok" : "warn"}">${o.paymentStatus === "paid" ? "Paid" : "Check Payment"}</span></div>
      ${orderLines(o)}
      <div class="row" style="margin-top:10px"><strong>Total ${money(o.total)}</strong><div class="row-left">
        ${o.paymentStatus === "waiting" ? `<button class="btn ok" data-action="mark-paid" data-id="${o.id}">Payment Received</button>` : ""}
        <button class="btn bad" data-action="close-order" data-id="${o.id}">Close</button>
      </div></div>
    </div>`;
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
    if (action === "admin-login") return adminLogin();
    if (action === "admin-logout") return localStorage.removeItem("restoqr_admin_unlocked"), render();
    if (action === "register") return registerRestaurant();
    if (action === "toggle-active") return updateRestaurant(el.dataset.slug, r => r.active = !r.active);
    if (action === "toggle-qr") return updateRestaurant(el.dataset.slug, r => r.qrEnabled = !r.qrEnabled);
    if (action === "extend-sub") return updateRestaurant(el.dataset.slug, r => { r.active = true; r.qrEnabled = true; r.subscriptionEnds = Math.max(Date.now(), r.subscriptionEnds || 0) + days(30); });
    if (action === "owner-login") return ownerLogin(el.dataset.slug);
    if (action === "owner-logout") return localStorage.removeItem("restoqr_owner_" + el.dataset.slug), render();
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
    if (action === "addon-change") return updatePaymentTotal();
    if (action === "dismiss-review") return localStorage.removeItem("restoqr_last_order_" + el.dataset.slug), render();
    if (action === "refresh-order") return render();
    if (action === "set-star") return setStar(el);
    if (action === "submit-feedback") return submitFeedback(el);
    if (action === "mark-paid") return updateOrder(el.dataset.id, o => { o.paymentStatus = "paid"; o.status = "pending"; });
    if (action === "advance-order") return updateOrder(el.dataset.id, o => o.status = el.dataset.next);
    if (action === "close-order") return updateOrder(el.dataset.id, o => o.status = "completed");
  }

  function adminLogin() {
    if (val("admin-pin") === state.meta.adminPin) {
      localStorage.setItem("restoqr_admin_unlocked", "yes");
      toast("Admin unlocked");
      render();
    } else toast("Wrong passcode");
  }

  function registerRestaurant() {
    const name = val("reg-name"), owner = val("reg-owner"), phone = val("reg-phone"), city = val("reg-city"), pin = val("reg-pin"), upiId = val("reg-upiid"), upi = val("reg-upi"), review = val("reg-review");
    if (!name || !owner || !phone || !pin) return toast("Fill restaurant, owner, phone, and PIN");
    const slug = slugify(name);
    if (bySlug(slug)) return toast("Restaurant name already exists");
    mutate(s => s.restaurants.push({
      id: uid(), slug, name, owner, phone, city, ownerPin: pin, active: false, qrEnabled: false,
      plan: "Pending", subscriptionEnds: Date.now(), paymentQr: DEFAULT_QR, upiId: upiId || "", upiName: upi || owner, googleReviewUrl: review,
      tables: [1, 2, 3, 4].map(no => ({ no, seats: 4 })),
      categories: ["Starters", "Main Course", "Breads", "Beverages"],
      menu: [], addons: [], createdAt: Date.now()
    }));
    toast("Registered. Admin can activate after payment.");
    location.hash = "#/owner?resto=" + slug;
  }

  function ownerLogin(slug) {
    const r = bySlug(slug);
    if (r && val("owner-pin") === r.ownerPin) {
      localStorage.setItem("restoqr_owner_" + slug, "yes");
      localStorage.setItem("restoqr_owner_slug", slug);
      toast("Owner panel opened");
      render();
    } else toast("Wrong PIN");
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
    updateRestaurant(slug, r => {
      r.name = val("set-name") || r.name;
      r.owner = val("set-owner") || r.owner;
      r.phone = val("set-phone") || r.phone;
      r.upiName = val("set-upi") || r.upiName;
      r.upiId = val("set-upiid");
      r.googleReviewUrl = val("set-review") || "";
      r.paymentQr = val("set-qr") || DEFAULT_QR;
    });
  }

  function placeOrder(slug) {
    const r = bySlug(slug);
    const table = Number(val("customer-table"));
    if (!table) return toast("Enter table number");
    const pickedAddons = [...document.querySelectorAll("[data-addon]:checked")].map(x => find(r.addons, x.dataset.addon)).filter(Boolean);
    const items = Object.entries(cart).map(([id, qty]) => {
      const m = find(r.menu, id);
      return { id, name: m.name, price: m.price, qty };
    });
    const total = items.reduce((s, i) => s + i.price * i.qty, 0) + pickedAddons.reduce((s, a) => s + a.price, 0);
    if (!items.length) return toast("Cart is empty");
    const orderId = uid();
    mutate(s => s.orders.push({
      id: orderId, restaurantSlug: slug, table, items,
      addons: pickedAddons.map(a => ({ id: a.id, name: a.name, price: a.price })),
      note: val("order-note"), total, paymentStatus: "waiting", status: "payment_check", createdAt: Date.now()
    }));
    localStorage.setItem("restoqr_last_order_" + slug, orderId);
    cart = {};
    customerCat = "";
    toast("Order placed! Waiting for payment verification.");
    // Re-render stays on the same hash — render() will now show the order status card at top
    render();
  }

  function setStar(el) {
    const n = Number(el.dataset.star);
    document.querySelectorAll("[data-action='set-star']").forEach((btn, i) => {
      btn.textContent = i < n ? "★" : "☆";
      btn.style.color = i < n ? "#f59e0b" : "#d1d5db";
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
    return `<header class="topbar"><div class="topbar-inner">
      <a class="brand" href="#/"><span class="mark">RQ</span><span><h1>RestoQR Cloud</h1><p>Restaurant QR ordering</p></span></a>
      <nav class="nav">
        <a class="btn ${active === "register" ? "primary" : ""}" href="#/register">Register</a>
        <a class="btn ${active === "owner" ? "primary" : ""}" href="#/owner${r ? "?resto=" + r.slug : ""}">Owner</a>
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
    const placeholderOnly = ["Cafe Aroma", "Owner name", "Mobile number", "City", "4 digit PIN", "Shown under payment QR", "Paste Google review link", "name@upi or 9999999999@paytm", "Paneer Tikka", "Starters", "220", "Extra Roti", "30", "7", "4", "Enter passcode", "Enter PIN"];
    const value = placeholder && !placeholderOnly.includes(placeholder) ? placeholder : "";
    if (tag === "textarea") return `<div class="field"><label>${label}</label><textarea id="${id}" placeholder="${placeholder || ""}">${value}</textarea></div>`;
    return `<div class="field"><label>${label}</label><input id="${id}" type="${type || "text"}" placeholder="${placeholder || ""}" value="${esc(value)}"></div>`;
  }

  function stat(label, value) { return `<div class="stat"><p>${label}</p><strong>${value}</strong></div>`; }
  function empty(text) { return `<div class="empty">${text}</div>`; }
  function val(id) { return (document.getElementById(id)?.value || "").trim(); }
  function bySlug(slug) { return state.restaurants.find(r => r.slug === slug); }
  function find(arr, id) { return arr.find(x => String(x.id) === String(id)); }
  function cartCount() { return Object.values(cart).reduce((s, q) => s + q, 0); }
  function cartTotal(r) { return Object.entries(cart).reduce((s, [id, q]) => { const i = find(r.menu, id); return s + (i ? i.price * q : 0); }, 0); }
  function decCart(id) { if (cart[id] > 1) cart[id] -= 1; else delete cart[id]; render(); }
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
  function html(s) { app.innerHTML = s; }
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.hidden = true, 2400);
  }

  document.addEventListener("click", bindClicks);
  start();
})();