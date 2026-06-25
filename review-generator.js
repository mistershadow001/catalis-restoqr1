// ================================================================
// RestoQR — Auto Review Generator
// Standalone module. Include this file after app.js.
// Exposes: window.RestoReview.show({ restaurantName, googleReviewUrl, lang, satisfaction, db, firebaseMode })
// API key is fetched from Firebase at restoqr/meta/groq-api — never hardcoded.
// To add more keys later, store them as restoqr/meta/groq-api-2, groq-api-3 etc.
// ================================================================

(function () {
  "use strict";

  const GROK_API_URL = "https://api.groq.com/openai/v1/chat/completions";
  const GROK_MODEL   = "llama-3.3-70b-versatile";

  // Fetch Grok key from Firebase the same way the AI assistant does in app.js
  // Falls back to window.GROK_API_KEY if Firebase not available
  async function fetchApiKey(db, firebaseMode) {
    try {
      if (firebaseMode && db) {
        const snap = await db.child("meta/groq-api").once("value");
        const key = snap.val() || "";
        if (key) return key;
      }
    } catch(e) { /* fall through */ }
    // Fallback: window global (dev/local only)
    return window.GROK_API_KEY || "";
  }

  // ── Styles ──────────────────────────────────────────────────────
  const STYLES = `
    #rqr-review-overlay {
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(15, 10, 5, 0.6);
      display: flex; align-items: flex-end; justify-content: center;
      padding: 0; animation: rqr-fadein .22s ease;
    }
    @keyframes rqr-fadein { from { opacity: 0 } to { opacity: 1 } }
    @keyframes rqr-slideup { from { transform: translateY(40px); opacity: 0 } to { transform: translateY(0); opacity: 1 } }

    #rqr-review-sheet {
      background: #fff; border-radius: 24px 24px 0 0;
      width: 100%; max-width: 560px;
      padding: 28px 24px 36px;
      animation: rqr-slideup .28s cubic-bezier(.2,.8,.3,1);
      max-height: 92vh; overflow-y: auto;
      box-shadow: 0 -12px 48px rgba(0,0,0,.18);
    }

    .rqr-drag-handle {
      width: 40px; height: 4px; background: #e5e0d8;
      border-radius: 99px; margin: 0 auto 20px;
    }

    .rqr-sheet-title {
      font-size: 20px; font-weight: 900; color: #1c0e04;
      margin: 0 0 4px; text-align: center;
    }
    .rqr-sheet-sub {
      font-size: 13px; color: #9ca3af; text-align: center; margin: 0 0 28px;
    }

    /* ── Satisfaction Slider ── */
    .rqr-slider-wrap {
      position: relative; margin-bottom: 10px;
    }
    .rqr-slider-track {
      position: relative; height: 44px;
      background: linear-gradient(90deg, #fee2e2 0%, #fef9c3 50%, #dcfce7 100%);
      border-radius: 22px; overflow: visible;
      display: flex; align-items: center;
    }
    .rqr-slider-fill {
      position: absolute; left: 0; top: 0; bottom: 0;
      background: transparent; pointer-events: none; border-radius: 22px;
      transition: width .1s;
    }
    .rqr-slider-keywords {
      position: absolute; inset: 0; display: flex;
      align-items: center; justify-content: space-around;
      pointer-events: none; padding: 0 16px;
    }
    .rqr-kw {
      font-size: 11px; font-weight: 700; opacity: .45;
      text-transform: uppercase; letter-spacing: .04em;
      transition: opacity .2s, color .2s;
      white-space: nowrap;
    }
    .rqr-kw.active { opacity: 1; color: #1c0e04; }

    input[type=range].rqr-slider {
      position: absolute; inset: 0; width: 100%; height: 100%;
      opacity: 0; cursor: pointer; z-index: 2; margin: 0;
    }
    .rqr-slider-thumb {
      position: absolute; top: 50%; transform: translateY(-50%);
      width: 38px; height: 38px; background: #fff;
      border-radius: 50%; box-shadow: 0 3px 12px rgba(0,0,0,.22);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; pointer-events: none; transition: left .08s;
      border: 2px solid #e5e0d8;
    }
    .rqr-pct-label {
      text-align: center; font-size: 28px; font-weight: 900;
      color: #1c0e04; margin: 12px 0 4px; transition: color .2s;
    }
    .rqr-pct-label.high { color: #16a34a; }
    .rqr-pct-label.low  { color: #dc2626; }
    .rqr-pct-sub {
      text-align: center; font-size: 13px; color: #6b7280; margin: 0 0 24px;
      min-height: 18px; transition: all .2s;
    }

    /* ── Threshold line ── */
    .rqr-threshold-line {
      position: absolute; top: 0; bottom: 0; width: 2px;
      background: rgba(0,0,0,.18); border-radius: 1px; pointer-events: none;
      left: 80%;
    }
    .rqr-threshold-tip {
      position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
      font-size: 10px; font-weight: 800; color: #6b7280;
      white-space: nowrap; letter-spacing: .04em;
    }

    /* ── CTA Button ── */
    .rqr-cta {
      width: 100%; padding: 15px 20px; border: none; border-radius: 14px;
      font-size: 15px; font-weight: 800; cursor: pointer;
      transition: opacity .15s, transform .1s; display: flex;
      align-items: center; justify-content: center; gap: 8px;
    }
    .rqr-cta:hover { opacity: .9; transform: scale(1.01); }
    .rqr-cta:active { transform: scale(.98); }
    .rqr-cta.review  { background: #ff6b00; color: #fff; }
    .rqr-cta.feedback { background: #f3f4f6; color: #374151; }

    /* ── Loading ── */
    .rqr-loading {
      text-align: center; padding: 32px 0;
      display: none;
    }
    .rqr-spinner {
      width: 36px; height: 36px; border: 3px solid #f0ede8;
      border-top-color: #ff6b00; border-radius: 50%;
      animation: rqr-spin .7s linear infinite; margin: 0 auto 12px;
    }
    @keyframes rqr-spin { to { transform: rotate(360deg) } }

    /* ── Review Card ── */
    .rqr-review-card {
      display: none; background: #fff8f0;
      border: 1.5px solid #ffd0a0; border-radius: 16px;
      padding: 20px; margin-top: 8px;
    }
    .rqr-review-text {
      font-size: 15px; line-height: 1.65; color: #1c0e04;
      margin: 0 0 16px; font-style: italic;
    }
    .rqr-review-actions { display: flex; flex-direction: column; gap: 10px; }
    .rqr-btn-copy {
      padding: 13px 20px; border-radius: 12px; font-size: 14px;
      font-weight: 800; border: none; cursor: pointer;
      background: #ff6b00; color: #fff;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .rqr-btn-copy.copied { background: #16a34a; }
    .rqr-btn-google {
      padding: 13px 20px; border-radius: 12px; font-size: 14px;
      font-weight: 800; border: 1.5px solid #e5e0d8; cursor: pointer;
      background: #fff; color: #1c0e04; text-decoration: none;
      display: flex; align-items: center; justify-content: center; gap: 8px;
    }
    .rqr-btn-regen {
      padding: 10px 16px; border-radius: 10px; font-size: 13px;
      font-weight: 700; border: none; cursor: pointer;
      background: #f3f4f6; color: #6b7280; margin-top: 4px;
    }

    /* ── Feedback Card ── */
    .rqr-feedback-card {
      display: none; margin-top: 8px;
    }
    .rqr-feedback-card textarea {
      width: 100%; box-sizing: border-box;
      padding: 14px; border: 1.5px solid #e5e0d8; border-radius: 12px;
      font-size: 14px; line-height: 1.5; resize: vertical;
      min-height: 110px; font-family: inherit; color: #1c0e04;
      margin-bottom: 10px;
    }
    .rqr-feedback-card textarea:focus { outline: none; border-color: #ff6b00; }
    .rqr-btn-send {
      width: 100%; padding: 13px; border-radius: 12px; font-size: 14px;
      font-weight: 800; border: none; cursor: pointer;
      background: #1c0e04; color: #fff;
    }
    .rqr-dismiss {
      display: block; width: 100%; padding: 12px; margin-top: 10px;
      background: none; border: none; font-size: 13px;
      color: #9ca3af; cursor: pointer; text-align: center;
    }
  `;

  // ── Keyword bands (mapped to slider %) ──────────────────────────
  const KEYWORDS_EN = [
    { min: 0,  max: 40,  label: "Not Happy",  emoji: "😞" },
    { min: 40, max: 65,  label: "It was okay", emoji: "😐" },
    { min: 65, max: 80,  label: "Pretty Good", emoji: "🙂" },
    { min: 80, max: 90,  label: "Loved it!",   emoji: "😊" },
    { min: 90, max: 101, label: "Amazing!",    emoji: "🤩" },
  ];
  const KEYWORDS_MR = [
    { min: 0,  max: 40,  label: "समाधान नाही", emoji: "😞" },
    { min: 40, max: 65,  label: "ठीकठाक होते", emoji: "😐" },
    { min: 65, max: 80,  label: "बरे होते",     emoji: "🙂" },
    { min: 80, max: 90,  label: "आवडले!",       emoji: "😊" },
    { min: 90, max: 101, label: "अप्रतिम!",     emoji: "🤩" },
  ];

  function getBand(pct, lang) {
    const bands = lang === "mr" ? KEYWORDS_MR : KEYWORDS_EN;
    return bands.find(b => pct >= b.min && pct < b.max) || bands[bands.length - 1];
  }

  // ── Fallback reviews (used when API fails) ───────────────────────
  const FALLBACK_REVIEWS_MR = [
    "जेवण एकदम मस्त होतं! ${name} मध्ये आलो आणि खूप छान अनुभव मिळाला. सेवा पण खूप चांगली होती, वेळेवर सगळं आलं. नक्की परत येणार.",
    "Mast jagah ahe yaar! Jevan khupach tasty hota, especially dal tadka ani roti. Service fast hoti ani staff pण friendly hota. Definitely recommend kartoy.",
    "Really loved the food here. The portions are generous and everything tasted fresh. The QR ordering made it super convenient — no waiting for the waiter. Will definitely be back!",
    "खाणं खूपच चविष्ट होतं आणि किंमत पण परवडणारी होती. QR ने order केलं, खूप easy होतं. Staff खूप helpful होते. ${name} ला नक्की visit करा.",
    "Ekdum value for money! Itke tasty jevan itakya kam kimat madhe milte hyavar vishwas thevat navhto. Pan ${name} ne prove kela. Full paisa vasool!",
    "Great ambience and even better food. Came here with family and everyone loved it. The service was quick and the staff was very polite. Highly recommend ${name}.",
    "QR ordering system khupach convenient hota — menu baghayala easy ani order lagar aali. Jevan fresh hota ani hot serve kela. Khup satisfied ahe mi!",
    "खरंच खूप छान जेवण होतं. ${name} मधला माहोल पण खूप सुंदर होता. Friends सोबत आलो होतो, सगळ्यांनी enjoy केलं. पुढच्या वेळी पण इथेच येणार.",
    "Yaar, ${name} madhe jevan khallyas tar khup bhari watate. Dal fry, paneer — sab kuch mast hota. Swach jagah, fast service. 5 stars deto mi!",
    "One of the best meals I've had in a while. The food at ${name} was fresh, flavorful, and served hot. Staff were attentive without being intrusive. Would absolutely come back.",
    "सेवा खूप जलद होती आणि जेवण गरम गरम आलं. ${name} मधला अनुभव खूपच चांगला होता. किंमत पण reasonable आहे. Family साठी perfect place आहे हे.",
    "Khup chan experience hota. Menu variety changla ahe ani jevan quality pण top class hoti. QR order system ne wait time kharach kami zala. Mast ahe!",
    "Came here on a recommendation and was not disappointed at all. The food was absolutely delicious and the service was prompt. ${name} is now my go-to place for dining out.",
    "अरे वाह! ${name} मध्ये जेवण खाऊन मन तृप्त झालं. सगळे पदार्थ एकदम fresh होते. Staff पण खूप friendly होते. एकदा नक्की या इथे!",
    "Bhai ek baar ${name} la jaun bagh — jevan khallyas ki parat yaychi iccha hoil. Sab kuch perfect hota, starting from taste to presentation. Worth every rupee!",
    "Really impressed with the quality and consistency here. Every dish we ordered was perfectly cooked and the flavours were spot on. The QR menu was easy to navigate too.",
    "खाणं खूप tasty होतं आणि वातावरण पण छान होतं. ${name} मध्ये येऊन खूप बरं वाटलं. मित्रांना पण सांगितलं इथे यायला. जरूर या एकदा!",
    "Staff khupach polite hote ani jevan lagar serve kela. ${name} madhe quality food milto ani kharach pocket-friendly ahe. Mi nakkiч recommend karto.",
    "Fantastic experience from start to finish. The food was rich in flavour and the portions were filling. Love that you can order from your phone — makes everything so easy.",
    "${name} madhe pahilyandach aalto, pan aata regular honar! Jevan ekdum ghar sarkhe tasty hota. Service fast hoti. Parat yeto lavakarach."
  ];

  // ── Prompt builder ───────────────────────────────────────────────
  function buildPrompt(restaurantName) {
    return `Write 20 distinct, authentic-sounding Google reviews for a restaurant called "${restaurantName}". These must sound like real Maharashtrian customers wrote them.

Rules:
- Separate each review with "|" only. No JSON, no numbering, no bullets.
- Each review: exactly 3-4 sentences.
- Do NOT use any punctuation marks — no full stops, no exclamation marks, no commas, no question marks, no apostrophes, nothing. Just plain words and spaces.
- Randomly mix these 3 styles across the 20 reviews (roughly 7 + 7 + 6 but order them randomly, NOT grouped):
  * Pure Marathi script (e.g. "जेवण एकदम मस्त होतं सेवा पण खूप छान होती नक्की परत येणार")
  * Romanized Marathi - Marathi words in English letters, NOT Hindi words (e.g. "Mast jevan hota ekdum hot ani fresh hote staff pan khup friendly hote nakkiч yeto parat")
  * Simple conversational English (e.g. "Really loved the food here fresh hot and great value will definitely be back")
- CRITICAL: Romanized style must use Marathi words only: jevan, mast, chan, bhari, ekdum, nakkiч, parat, ani, pan, khup, yeto, hota, hote, ahe, nahi — NOT Hindi words like khana, bahut, acha, bilkul, bhai.
- Vary focus across reviews: food taste, service speed, ambience, value, QR ordering, coming back.
- Do NOT mention any score, percentage, or rating number.
- No two reviews should start the same way.
- Output only the 20 reviews separated by "|". No preamble, no labels, no prefixes.`;
  }

  // ── Firebase cache helpers ───────────────────────────────────────
  // Cache lives at restoqr/reviewCache/<slug>
  // Structure: { reviews: "r1|r2|...|r20", generatedAt: timestamp }
  // When all reviews are used the node is deleted and regenerated on next request.

  async function getCachedReviews(db, slug) {
    if (!db || !slug) return null;
    try {
      const snap = await db.child("reviewCache/" + slug).once("value");
      const val = snap.val();
      if (!val || !val.reviews) return null;
      const arr = val.reviews.split("|").map(r => r.trim()).filter(r => r.length > 10);
      if (!arr.length) {
        // Empty/corrupt — delete and regenerate
        await db.child("reviewCache/" + slug).remove();
        return null;
      }
      return arr;
    } catch(e) { return null; }
  }

  async function saveCachedReviews(db, slug, reviews) {
    if (!db || !slug || !reviews.length) return;
    try {
      await db.child("reviewCache/" + slug).set({
        reviews: reviews.join("|"),
        generatedAt: Date.now()
      });
    } catch(e) { /* silent fail — will just regenerate next time */ }
  }

  async function sliceFromCache(db, slug, pool) {
    // Pick a random review from pool, save remaining back, delete if empty
    if (!pool.length) return null;
    const idx = Math.floor(Math.random() * pool.length);
    const review = pool.splice(idx, 1)[0];
    if (!db || !slug) return review;
    try {
      if (pool.length === 0) {
        // All 20 used — delete the row
        await db.child("reviewCache/" + slug).remove();
      } else {
        // Save remaining reviews back
        await db.child("reviewCache/" + slug).update({ reviews: pool.join("|") });
      }
    } catch(e) { /* silent */ }
    return review;
  }

  // ── Main pool fetcher — DB first, API fallback ───────────────────
  async function getReviewPool(restaurantName, slug, satisfaction, lang, db, firebaseMode) {
    // 1. Try Firebase cache first
    if (firebaseMode && db && slug) {
      const cached = await getCachedReviews(db, slug);
      if (cached && cached.length) return { pool: cached, fromCache: true };
    }

    // 2. Cache empty/missing — call API
    const key = await fetchApiKey(db, firebaseMode);
    if (!key) {
      return { pool: getFallbackReviews(restaurantName), fromCache: false };
    }

    try {
      const resp = await fetch(GROK_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key
        },
        body: JSON.stringify({
          model: GROK_MODEL,
          max_tokens: 2400,
          messages: [
            { role: "system", content: "You generate realistic restaurant reviews. Follow instructions exactly." },
            { role: "user",   content: buildPrompt(restaurantName) }
          ]
        })
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || "API error " + resp.status);
      }

      const data = await resp.json();
      const raw = (data.choices?.[0]?.message?.content || "").trim();

      const reviews = raw.split("|")
        .map(r => r.trim().replace(/^["']+|["']+$/g, "").trim())
        .map(r => r.replace(/[.,!?;:'"(){}\[\]]/g, "").replace(/\s+/g, " ").trim())
        .filter(r => r.length > 20);

      if (!reviews.length) throw new Error("No reviews returned");

      // Shuffle then save full batch to Firebase
      reviews.sort(() => Math.random() - 0.5);
      if (firebaseMode && db && slug) {
        await saveCachedReviews(db, slug, reviews);
      }

      return { pool: reviews, fromCache: false };
    } catch (err) {
      console.warn("RestoReview: API failed, using fallback reviews.", err.message);
      return { pool: getFallbackReviews(restaurantName), fromCache: false };
    }
  }

  // ── Fallback: inject restaurant name and return hardcoded pool ───
  function getFallbackReviews(restaurantName) {
    return FALLBACK_REVIEWS_MR
      .map(r => r.replace(/\$\{name\}/g, restaurantName))
      .map(r => r.replace(/[.,!?;:'"(){}\[\]]/g, "").replace(/\s+/g, " ").trim());
  }

  // ── Pick a random review from the pool ──────────────────────────
  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // ── Inject styles ────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById("rqr-review-styles")) return;
    const s = document.createElement("style");
    s.id = "rqr-review-styles";
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  // ── Main show() function ─────────────────────────────────────────
  function show({ restaurantName = "this restaurant", restaurantSlug = "", googleReviewUrl = "", lang = "en", satisfaction = 80, db = null, firebaseMode = false } = {}) {
    injectStyles();

    const isMr = lang === "mr";
    const slug = restaurantSlug || window._rqr_slug || "";
    let currentPct = Math.max(0, Math.min(100, satisfaction));
    let reviewPool = [];     // in-memory remainder after slicing from DB
    let currentReview = "";

    // ── Overlay & sheet ──
    const overlay = document.createElement("div");
    overlay.id = "rqr-review-overlay";

    overlay.innerHTML = `
      <div id="rqr-review-sheet">
        <div class="rqr-drag-handle"></div>

        <!-- Title -->
        <p class="rqr-sheet-title">${isMr ? "तुमचा अनुभव कसा होता?" : "How was your experience?"}</p>
        <p class="rqr-sheet-sub">${isMr ? "खाली slider ओढा आणि सांगा" : "Slide to tell us how you felt"}</p>

        <!-- Slider -->
        <div class="rqr-slider-wrap">
          <div class="rqr-slider-track" id="rqr-track">
            <div class="rqr-slider-fill" id="rqr-fill"></div>
            <div class="rqr-slider-keywords" id="rqr-kws">
              <!-- injected by JS -->
            </div>
            <div class="rqr-threshold-line">
              <span class="rqr-threshold-tip">${isMr ? "80% — review" : "80% review"}</span>
            </div>
            <input type="range" class="rqr-slider" id="rqr-slider" min="0" max="100" value="${currentPct}" step="1">
            <div class="rqr-slider-thumb" id="rqr-thumb">😊</div>
          </div>
        </div>

        <div class="rqr-pct-label high" id="rqr-pct">80%</div>
        <div class="rqr-pct-sub" id="rqr-pct-sub">${isMr ? "अप्रतिम! Review generate करत आहोत ✨" : "Loved it! We'll generate a review for you ✨"}</div>

        <!-- CTA -->
        <button class="rqr-cta review" id="rqr-cta">
          ✨ ${isMr ? "माझ्यासाठी review बनवा" : "Generate My Review"}
        </button>

        <!-- Loading -->
        <div class="rqr-loading" id="rqr-loading">
          <div class="rqr-spinner"></div>
          <p style="font-size:14px;color:#9ca3af;margin:0">${isMr ? "20 reviews तयार होत आहेत…" : "Crafting 20 reviews for you…"}</p>
        </div>

        <!-- Review Card -->
        <div class="rqr-review-card" id="rqr-review-card">
          <p style="font-size:12px;font-weight:800;color:#ff6b00;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px">
            ${isMr ? "✨ तुमची review तयार आहे" : "✨ Your review is ready"}
          </p>
          <p class="rqr-review-text" id="rqr-review-text"></p>
          <div class="rqr-review-actions">
            <button class="rqr-btn-copy" id="rqr-copy-btn">
              📋 ${isMr ? "Copy करा" : "Copy Review"}
            </button>
            <a class="rqr-btn-google" id="rqr-google-btn" href="${googleReviewUrl || '#'}" target="_blank" rel="noopener">
              ⭐ ${isMr ? "Google Reviews वर जा" : "Go to Google Reviews"}
            </a>
            <button class="rqr-btn-regen" id="rqr-regen-btn">
              🔄 ${isMr ? "वेगळी review दाखवा" : "Show different review"}
            </button>
          </div>
        </div>

        <!-- Feedback Card -->
        <div class="rqr-feedback-card" id="rqr-feedback-card">
          <p style="font-size:14px;color:#4b5563;margin:0 0 12px;line-height:1.5">
            ${isMr ? "😔 आम्हाला माफ करा. तुमच्या अनुभवाबद्दल आम्हाला सांगा — आम्ही सुधारणा करू." : "😔 We're sorry your experience wasn't great. Please share your feedback — we'll make it better."}
          </p>
          <textarea id="rqr-feedback-text" placeholder="${isMr ? "तुमचा अनुभव येथे लिहा…" : "Tell us what went wrong…"}"></textarea>
          <button class="rqr-btn-send" id="rqr-send-btn">
            ${isMr ? "Feedback पाठवा" : "Send Feedback"}
          </button>
        </div>

        <button class="rqr-dismiss" id="rqr-dismiss">${isMr ? "नंतर करतो" : "Maybe later"}</button>
      </div>
    `;

    document.body.appendChild(overlay);

    // ── Get elements ──
    const slider   = overlay.querySelector("#rqr-slider");
    const thumb    = overlay.querySelector("#rqr-thumb");
    const pctEl    = overlay.querySelector("#rqr-pct");
    const pctSub   = overlay.querySelector("#rqr-pct-sub");
    const ctaBtn   = overlay.querySelector("#rqr-cta");
    const loading  = overlay.querySelector("#rqr-loading");
    const revCard  = overlay.querySelector("#rqr-review-card");
    const revText  = overlay.querySelector("#rqr-review-text");
    const copyBtn  = overlay.querySelector("#rqr-copy-btn");
    const googleBtn= overlay.querySelector("#rqr-google-btn");
    const regenBtn = overlay.querySelector("#rqr-regen-btn");
    const fbCard   = overlay.querySelector("#rqr-feedback-card");
    const fbText   = overlay.querySelector("#rqr-feedback-text");
    const sendBtn  = overlay.querySelector("#rqr-send-btn");
    const dismiss  = overlay.querySelector("#rqr-dismiss");
    const kwsWrap  = overlay.querySelector("#rqr-kws");
    const track    = overlay.querySelector("#rqr-track");

    // ── Render keywords on track ──
    function renderKeywords(pct) {
      const bands = isMr ? KEYWORDS_MR : KEYWORDS_EN;
      kwsWrap.innerHTML = bands.map(b => {
        const active = pct >= b.min && pct < b.max;
        return `<span class="rqr-kw${active ? " active" : ""}">${b.emoji} ${b.label}</span>`;
      }).join("");
    }

    // ── Update UI on slider move ──
    function updateSlider(pct) {
      currentPct = pct;
      slider.value = pct;

      // Thumb position — recalculate track width each time
      const trackW = track.getBoundingClientRect().width || track.offsetWidth;
      const thumbW = 38;
      const left = (pct / 100) * (trackW - thumbW) + thumbW / 2;
      thumb.style.left = left + "px";

      const high = pct >= 80;

      // Emoji
      const band = getBand(pct, lang);
      thumb.textContent = band.emoji;

      // Percent label
      pctEl.textContent = pct + "%";
      pctEl.className = "rqr-pct-label " + (pct >= 80 ? "high" : "low");

      // Sub text
      if (pct >= 90) {
        pctSub.textContent = isMr ? "अप्रतिम! 🤩 Review generate करू का?" : "Amazing! 🤩 Let us write a review for you!";
      } else if (pct >= 80) {
        pctSub.textContent = isMr ? "छान! ✨ Review बनवायला मदत करतो." : "Great! ✨ We'll help you write a review.";
      } else if (pct >= 65) {
        pctSub.textContent = isMr ? "ठीकठाक — Feedback द्याल का?" : "Pretty good — care to leave feedback instead?";
      } else {
        pctSub.textContent = isMr ? "माफ करा 😔 — Feedback नक्की पाठवा." : "We're sorry 😔 — please share your feedback.";
      }

      // CTA
      if (high) {
        ctaBtn.className = "rqr-cta review";
        ctaBtn.innerHTML = `✨ ${isMr ? "माझ्यासाठी Review बनवा" : "Generate My Review"}`;
      } else {
        ctaBtn.className = "rqr-cta feedback";
        ctaBtn.innerHTML = `📝 ${isMr ? "Feedback द्या" : "Leave Feedback Instead"}`;
      }

      renderKeywords(pct);
    }

    // Init — defer until DOM is painted so offsetWidth is correct
    requestAnimationFrame(() => updateSlider(currentPct));

    slider.addEventListener("input", () => {
      // Hide cards when sliding
      revCard.style.display = "none";
      fbCard.style.display = "none";
      loading.style.display = "none";
      updateSlider(parseInt(slider.value));
    });

    // ── CTA click ──
    ctaBtn.addEventListener("click", async () => {
      if (currentPct >= 80) {
        ctaBtn.style.display = "none";
        revCard.style.display = "none";
        fbCard.style.display = "none";
        loading.style.display = "block";

        try {
          if (!reviewPool.length) {
            // Fetch from Firebase cache or generate fresh batch
            const result = await getReviewPool(restaurantName, slug, currentPct, lang, db, firebaseMode);
            reviewPool = result.pool;
          }
          // Slice one out, update/delete DB row accordingly
          const review = await sliceFromCache(db, slug, reviewPool);
          currentReview = review || reviewPool.shift() || "";
          revText.textContent = currentReview;
          loading.style.display = "none";
          revCard.style.display = "block";
        } catch (err) {
          loading.style.display = "none";
          ctaBtn.style.display = "flex";
          alert((isMr ? "Review तयार होऊ शकला नाही: " : "Could not generate review: ") + err.message);
        }
      } else {
        ctaBtn.style.display = "none";
        fbCard.style.display = "block";
        fbText.focus();
      }
    });

    // ── Copy ──
    copyBtn.addEventListener("click", () => {
      if (!currentReview) return;
      navigator.clipboard.writeText(currentReview).then(() => {
        copyBtn.className = "rqr-btn-copy copied";
        copyBtn.innerHTML = `✅ ${isMr ? "Copied! आता Google Reviews वर जा" : "Copied! Now go paste it on Google"}`;
        if (googleReviewUrl) {
          setTimeout(() => { window.open(googleReviewUrl, "_blank", "noopener"); }, 900);
        }
      }).catch(() => {
        const ta = document.createElement("textarea");
        ta.value = currentReview;
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        copyBtn.className = "rqr-btn-copy copied";
        copyBtn.innerHTML = `✅ ${isMr ? "Copied!" : "Copied!"}`;
      });
    });

    // ── Regenerate ──
    regenBtn.addEventListener("click", async () => {
      copyBtn.className = "rqr-btn-copy";
      copyBtn.innerHTML = `📋 ${isMr ? "Copy करा" : "Copy Review"}`;

      if (!reviewPool.length) {
        regenBtn.disabled = true;
        regenBtn.textContent = isMr ? "नवीन reviews येत आहेत…" : "Loading more…";
        try {
          const result = await getReviewPool(restaurantName, slug, currentPct, lang, db, firebaseMode);
          reviewPool = result.pool;
        } catch(e) { /* silent */ }
        regenBtn.disabled = false;
        regenBtn.innerHTML = `🔄 ${isMr ? "वेगळी review दाखवा" : "Show different review"}`;
        if (!reviewPool.length) return;
      }

      const review = await sliceFromCache(db, slug, reviewPool);
      currentReview = review || "";
      revText.textContent = currentReview;
    });

    // ── Send feedback ──
    sendBtn.addEventListener("click", () => {
      const text = fbText.value.trim();
      if (!text) { fbText.style.border = "1.5px solid #dc2626"; fbText.focus(); return; }
      fbText.style.border = "";

      // Dispatch event so parent app can handle saving
      document.dispatchEvent(new CustomEvent("restoqr:feedback", {
        detail: { restaurantName, restaurantSlug: (window._rqr_slug || ""), text, satisfaction: currentPct, lang }
      }));

      fbCard.innerHTML = `<div style="text-align:center;padding:20px 0">
        <div style="font-size:36px;margin-bottom:10px">🙏</div>
        <p style="font-weight:800;font-size:16px;color:#1c0e04;margin:0 0 6px">
          ${isMr ? "फीडबॅक मिळाला — धन्यवाद!" : "Feedback received — thank you!"}
        </p>
        <p style="font-size:13px;color:#9ca3af;margin:0">
          ${isMr ? "आम्ही सुधारणा करू." : "We'll work on making it better."}
        </p>
      </div>`;

      setTimeout(() => closeSheet(), 2800);
    });

    // ── Dismiss ──
    function closeSheet() {
      overlay.style.animation = "rqr-fadein .18s ease reverse";
      overlay.querySelector("#rqr-review-sheet").style.animation = "rqr-slideup .18s ease reverse";
      setTimeout(() => overlay.remove(), 180);
    }

    dismiss.addEventListener("click", closeSheet);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeSheet(); });
  }

  // ── Expose public API ────────────────────────────────────────────
  window.RestoReview = { show };

})();