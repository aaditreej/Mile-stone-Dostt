// unlockAt = cumulative total coins spent to unlock this tier
const TIER_DATA = [
  { id: 1,  unlockAt: 200,   reward: "FREE 20 coins" },
  { id: 2,  unlockAt: 400,   reward: "FREE 20 coins" },
  { id: 3,  unlockAt: 700,   reward: "FREE 20 coins" },
  { id: 4,  unlockAt: 1000,  reward: "FREE 30 coins" },
  { id: 5,  unlockAt: 1400,  reward: "FREE 30 coins" },
  { id: 6,  unlockAt: 1900,  reward: "FREE 30 coins" },
  { id: 7,  unlockAt: 2500,  reward: "FREE 40 coins" },
  { id: 8,  unlockAt: 3200,  reward: "FREE 40 coins" },
  { id: 9,  unlockAt: 4000,  reward: "FREE 50 coins" },
  { id: 10, unlockAt: 4900,  reward: "FREE 50 coins" },
  { id: 11, unlockAt: 6100,  reward: "FREE 60 coins" },
  { id: 12, unlockAt: 7600,  reward: "FREE 60 coins" },
  { id: 13, unlockAt: 9600,  reward: "FREE 70 coins" },
  { id: 14, unlockAt: 12100, reward: "FREE 70 coins" },
  { id: 15, unlockAt: 15350, reward: "FREE 80 coins" },
  { id: 16, unlockAt: 19350, reward: "FREE 80 coins" },
  { id: 17, unlockAt: 24350, reward: "FREE 90 coins" },
];

const COINS = ["assets/coin-01.png", "assets/coin-02.png", "assets/coin-03.png", "assets/coin-04.png"];

function coinForReward(reward) {
  const match = reward.match(/FREE\s+(\d+)\s+coins/i);
  const amount = match ? Number(match[1]) : 0;
  if (amount <= 40) return COINS[0];
  if (amount <= 70) return COINS[1];
  if (amount <= 90) return COINS[2];
  return COINS[3];
}

const COUNTRIES = [
  { flag: "🇮🇳", name: "India",        code: "+91"  },
  { flag: "🇸🇦", name: "Saudi Arabia", code: "+966" },
  { flag: "🇳🇵", name: "Nepal",        code: "+977" },
  { flag: "🇧🇩", name: "Bangladesh",   code: "+880" },
  { flag: "🇧🇭", name: "Bahrain",      code: "+973" },
  { flag: "🇶🇦", name: "Qatar",        code: "+974" },
  { flag: "🇴🇲", name: "Oman",         code: "+968" },
  { flag: "🇦🇪", name: "UAE",          code: "+971" },
  { flag: "🇰🇼", name: "Kuwait",       code: "+965" },
  { flag: "🇱🇰", name: "Sri Lanka",    code: "+94"  },
  { flag: "🇲🇾", name: "Malaysia",     code: "+60"  },
];

const API_BASE = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:3001"
  : "/api";

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: res.status, data });
  return data;
}

const TEST_PHONES = ["9500365660", "9988818731"];

const state = {
  view: "login",
  prevView: "login",
  phone: "",
  country: COUNTRIES[0],
  showCountrySheet: false,
  countrySearch: "",
  totalSpent: 0,
  lastRefreshedAt: null,
  cycleEndDate: null,
  claimed: new Set(),
  toast: "",
  loading: false,
  // tester state
  isTester: false,
  testMode: null,        // null | "api" | "direct_select" | "bypass"
  claimType: "real",     // "real" | "dummy"
  showTestModal: false,
};

const root = document.getElementById("root");

// ─── Country sheet ────────────────────────────────────────────────────────────

function countrySheet() {
  const query = state.countrySearch.toLowerCase();
  const filtered = COUNTRIES.filter(c =>
    c.name.toLowerCase().includes(query) || c.code.includes(query)
  );
  return `
    <div id="sheet-overlay" class="fixed inset-0 z-40 bg-black/40"></div>
    <div id="country-sheet" class="country-sheet fixed bottom-0 z-50 flex flex-col bg-[#161d2a] rounded-t-[28px]" style="max-height:52vh;left:max(12px,calc(50% - 212px));right:max(12px,calc(50% - 212px))">
      <div class="flex justify-center pt-2.5 pb-2 shrink-0">
        <div class="h-[3px] w-9 rounded-full bg-white/25"></div>
      </div>
      <div class="px-4 pb-2 shrink-0">
        <div class="flex items-center gap-2 rounded-xl bg-[#1e2738] px-3 py-2">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="shrink-0" style="color:rgba(255,255,255,0.35)"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10 10L13 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          <input id="country-search" type="text" placeholder="Search for Country" autocomplete="off"
            value="${state.countrySearch}"
            class="flex-1 bg-transparent text-[13px] outline-none placeholder:text-white/35" style="color:#fff" />
        </div>
      </div>
      <div class="overflow-y-auto flex-1 pb-5">
        ${filtered.map(c => `
          <button class="country-option flex w-full items-center gap-3 px-4 py-2.5 border-b border-white/[0.06] last:border-0 active:bg-white/5" data-code="${c.code}" data-flag="${c.flag}" data-name="${c.name}">
            <span class="text-lg leading-none shrink-0">${c.flag}</span>
            <span class="flex-1 text-[13px] font-medium" style="color:#fff">${c.name} (${c.code})</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

// ─── Login page ───────────────────────────────────────────────────────────────

function loginPage() {
  return `
    <div class="mx-auto flex h-[100svh] w-full max-w-md flex-col bg-noise px-6">
      <div class="flex flex-1 flex-col justify-center">
        <div class="mb-10 flex flex-col items-center gap-3">
          <img src="assets/dostt_icon.png" alt="Dostt" class="h-16 w-16 object-contain" />
          <span class="text-[2rem] font-semibold leading-none tracking-tight">dostt</span>
        </div>

        <h1 class="mb-8 text-center text-[1.4rem] font-semibold leading-snug tracking-tight">
          Login to get started
        </h1>

        <div class="mb-5 flex items-center gap-0 rounded-2xl border border-white/12 bg-white/6 overflow-hidden focus-within:border-violet-400/60 transition-colors">
          <button id="country-picker-btn" class="flex items-center gap-1.5 px-4 py-3.5 shrink-0 border-r border-white/12 active:bg-white/8">
            <span class="text-xl leading-none">${state.country.flag}</span>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="text-white/50"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="text-sm font-semibold text-white/70">${state.country.code}</span>
          </button>
          <input
            id="phone-input"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            maxlength="10"
            placeholder="Enter mobile number"
            value="${state.phone}"
            class="flex-1 bg-transparent px-3 py-3.5 text-sm font-medium text-white outline-none placeholder:text-white/35"
          />
        </div>

        <button
          id="login-btn"
          class="w-full rounded-2xl bg-gradient-to-r from-violet-500 to-fuchsia-500 py-4 text-sm font-semibold text-white shadow-[0_4px_20px_rgba(139,92,246,0.45)] active:opacity-90 transition-opacity"
        >
          Login
        </button>
      </div>
    </div>
    ${state.showCountrySheet ? countrySheet() : ""}
  `;
}

function wireLoginEvents() {
  const loginBtn = document.getElementById("login-btn");
  if (!loginBtn) return;

  loginBtn.addEventListener("click", async () => {
    const input = document.getElementById("phone-input");
    const phone = (input ? input.value : "").replace(/\D/g, "");
    if (phone.length < 7) { input.focus(); return; }

    state.phone = phone;
    loginBtn.disabled = true;
    loginBtn.textContent = "Logging in…";

    try {
      const data = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ phone, countryCode: state.country.code }),
      });
      localStorage.setItem("dostt_session", JSON.stringify({ phone, country: state.country }));
      state.isTester = data.isTester || false;

      if (state.isTester) {
        state.testMode = null;
        state.showTestModal = true;
        render();
      } else {
        state.view = "rewards";
        rewardsRendered = false;
        render();
        initLottie();
        await loadRewardsData();
        render();
        initLottie();
      }
    } catch (err) {
      showLoginError(err.message);
      loginBtn.disabled = false;
      loginBtn.textContent = "Login";
    }
  });

  const phoneInput = document.getElementById("phone-input");
  if (phoneInput) {
    phoneInput.addEventListener("input", (e) => {
      state.phone = e.target.value.replace(/\D/g, "");
      e.target.value = state.phone;
    });
    phoneInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("login-btn")?.click();
    });
  }

  document.getElementById("country-picker-btn")?.addEventListener("click", () => {
    state.showCountrySheet = true;
    state.countrySearch = "";
    render();
    wireLoginEvents();
    wireCountrySheetEvents();
  });
}

function wireCountrySheetEvents() {
  document.getElementById("sheet-overlay")?.addEventListener("click", () => {
    state.showCountrySheet = false;
    render();
    wireLoginEvents();
  });

  document.getElementById("country-search")?.addEventListener("input", (e) => {
    state.countrySearch = e.target.value;
    const sheet = document.getElementById("country-sheet");
    if (!sheet) return;
    const query = state.countrySearch.toLowerCase();
    const filtered = COUNTRIES.filter(c =>
      c.name.toLowerCase().includes(query) || c.code.includes(query)
    );
    const listEl = sheet.querySelector(".overflow-y-auto");
    if (listEl) {
      listEl.innerHTML = filtered.map(c => `
        <button class="country-option flex w-full items-center gap-3 py-3 border-b border-white/6 last:border-0 text-left" data-code="${c.code}" data-flag="${c.flag}" data-name="${c.name}">
          <span class="text-xl leading-none shrink-0">${c.flag}</span>
          <span class="flex-1 text-sm font-medium text-white">${c.name} (${c.code})</span>
        </button>
      `).join("");
      wireCountryOptionEvents();
    }
  });

  wireCountryOptionEvents();
}

function wireCountryOptionEvents() {
  document.querySelectorAll(".country-option").forEach(btn => {
    btn.addEventListener("click", () => {
      state.country = { flag: btn.dataset.flag, name: btn.dataset.name, code: btn.dataset.code };
      state.showCountrySheet = false;
      state.countrySearch = "";
      render();
      wireLoginEvents();
    });
  });
}

function showLoginError(msg) {
  let err = document.getElementById("login-error");
  if (!err) {
    err = document.createElement("p");
    err.id = "login-error";
    err.className = "mt-3 text-center text-xs text-red-400";
    document.getElementById("login-btn").insertAdjacentElement("afterend", err);
  }
  err.textContent = msg;
}

// ─── Test mode modal ──────────────────────────────────────────────────────────

function testModeModal() {
  return `
    <div id="test-modal-overlay" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6">
      <div class="w-full max-w-sm rounded-2xl bg-[#161d2a] border border-white/10 p-6">
        <div class="mb-1 flex items-center gap-2">
          <span class="text-lg">🧪</span>
          <h2 class="text-base font-semibold text-white">Tester Mode</h2>
        </div>
        <p class="mb-5 text-xs text-white/50">You're logged in with a test number. Choose how you want to test:</p>
        <div class="flex flex-col gap-3">
          <button id="test-api-btn" class="w-full rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-500 py-3.5 text-sm font-semibold text-white shadow-[0_4px_20px_rgba(139,92,246,0.35)] active:opacity-90 text-left px-4">
            Test via API
            <p class="text-[11px] font-normal opacity-70 mt-0.5">Hits backend · saves to DB · normal points check</p>
          </button>
          <button id="test-direct-btn" class="w-full rounded-xl border border-violet-400/40 bg-violet-400/10 py-3.5 text-sm font-semibold text-white active:opacity-90 text-left px-4">
            Direct Select via API
            <p class="text-[11px] font-normal opacity-70 mt-0.5">All tiers unlocked · hits backend · saves to DB</p>
          </button>
          <button id="test-bypass-btn" class="w-full rounded-xl border border-white/15 bg-white/6 py-3.5 text-sm font-semibold text-white active:opacity-90 text-left px-4">
            Test Offline (Bypass)
            <p class="text-[11px] font-normal opacity-70 mt-0.5">No API · no DB · resets on logout</p>
          </button>
        </div>
      </div>
    </div>
  `;
}

function wireTestModal() {
  document.getElementById("test-api-btn")?.addEventListener("click", async () => {
    state.testMode = "api";
    state.showTestModal = false;
    state.view = "rewards";
    rewardsRendered = false;
    render();
    initLottie();
    await loadRewardsData();
    render();
    initLottie();
  });

  document.getElementById("test-direct-btn")?.addEventListener("click", async () => {
    state.testMode = "direct_select";
    state.showTestModal = false;
    state.view = "rewards";
    state.totalSpent = 24350;
    rewardsRendered = false;
    render();
    initLottie();
    await loadRewardsData();
    render();
    initLottie();
  });

  document.getElementById("test-bypass-btn")?.addEventListener("click", () => {
    state.testMode = "bypass";
    state.showTestModal = false;
    state.view = "rewards";
    state.totalSpent = 24350;
    state.claimed = new Set();
    rewardsRendered = false;
    render();
  });
}

// ─── Tester toolbar (shown on rewards page when isTester) ────────────────────
// Combined single-row bar: mode label + claim type toggle + cooldown timer if active

function testerToolbar() {
  const modeLabel = {
    api: "API",
    direct_select: "Direct Select",
    bypass: "Bypass",
  }[state.testMode] || "?";

  const isDummy = state.claimType === "dummy";

  return `
    <div class="mx-3 mt-2 rounded-xl border border-amber-400/30 bg-amber-400/8 px-3 py-1.5 flex items-center gap-2">
      <span class="text-[11px] font-semibold text-amber-300 shrink-0">🧪 ${modeLabel}</span>
      <span class="text-white/20 shrink-0">|</span>
      <span class="text-[11px] text-white/50 shrink-0">Claim:</span>
      <button id="claim-type-toggle"
        class="rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition-colors shrink-0 ${isDummy
          ? "bg-amber-400/20 text-amber-300 border border-amber-400/40"
          : "bg-violet-500/20 text-violet-300 border border-violet-400/40"
        }">
        ${isDummy ? "Dummy" : "Real"}
      </button>
    </div>
  `;
}

// ─── Progress helpers ─────────────────────────────────────────────────────────

function nextThreshold(totalSpent) {
  const next = TIER_DATA.find((t) => totalSpent < t.unlockAt);
  return next ? next.unlockAt : TIER_DATA[TIER_DATA.length - 1].unlockAt;
}

function progressWindow(totalSpent) {
  let prev = 0;
  let current = TIER_DATA[TIER_DATA.length - 1].unlockAt;
  for (const tier of TIER_DATA) {
    if (totalSpent < tier.unlockAt) {
      current = tier.unlockAt;
      break;
    }
    prev = tier.unlockAt;
  }
  return {
    spent: Math.max(0, totalSpent - prev),
    target: Math.max(1, current - prev),
  };
}

// ─── Tier card ────────────────────────────────────────────────────────────────

function tierCard(tier, isNextUp = false) {
  const isClaimed = state.claimed.has(tier.id);
  const isDirectSelect = state.testMode === "direct_select";
  const prevTierClaimed = tier.id === 1 || state.claimed.has(tier.id - 1);
  const claimable = (state.totalSpent >= tier.unlockAt || isDirectSelect) && !isClaimed && prevTierClaimed;
  const locked = !claimable && !isClaimed;

  const shellClass = locked
    ? "border border-white/10 bg-white/5 opacity-75"
    : claimable
      ? "border border-violet-300/60 bg-gradient-to-br from-violet-400/20 to-purple-500/20"
      : "border border-white/8 bg-white/4 opacity-50";

  let buttonContent, buttonClass, buttonDisabled;

  if (isClaimed) {
    buttonContent = "Claimed";
    buttonClass = "bg-white/15 text-white/40 cursor-not-allowed";
    buttonDisabled = true;
  } else if (locked) {
    buttonContent = "Claim";
    buttonClass = "bg-white/20 text-white/60 cursor-not-allowed";
    buttonDisabled = true;
  } else {
    buttonContent = "Claim";
    buttonClass = "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_0_12px_rgba(139,92,246,0.5)]";
    buttonDisabled = false;
  }

  let dotClass, dotContent;
  if (isClaimed) {
    dotClass = "tier-dot-claimed";
    dotContent = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><polyline points="2,6.5 4.5,9 10,3.5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  } else if (claimable || isNextUp) {
    dotClass = "tier-dot-claimable";
    dotContent = "";
  } else {
    dotClass = "tier-dot-locked";
    dotContent = "";
  }

  return `
    <div class="tier-row ${isClaimed ? "is-claimed" : ""}">
      <div class="tier-indicator ${dotClass}">${dotContent}</div>
      <article class="tier-card flex-1 ${shellClass}">
        <div class="tier-body">
          <div class="flex items-center gap-3">
            <img src="${coinForReward(tier.reward)}" alt="" aria-hidden="true" class="w-14 h-14 shrink-0 object-contain" />
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-semibold leading-tight">${tier.reward}</p>
              <p class="mt-1 text-xs text-dosttMuted">Unlocks at ${tier.unlockAt} Dostt Points</p>
            </div>
            <button
              class="claim-btn min-w-[86px] rounded-full px-4 py-2 text-xs font-semibold ${buttonClass}"
              data-tier="${tier.id}"
              ${buttonDisabled ? "disabled" : ""}
            >
              ${buttonContent}
            </button>
          </div>
        </div>
      </article>
    </div>
  `;
}

// ─── Rewards page ─────────────────────────────────────────────────────────────

function rewardsPage() {
  const isDirectSelect = state.testMode === "direct_select";
  const effectiveTotalSpent = isDirectSelect ? 24350 : state.totalSpent;

  const firstUnclaimed = TIER_DATA.find(t => !state.claimed.has(t.id));
  const firstUnclaimedId = firstUnclaimed ? firstUnclaimed.id : null;
  const target = firstUnclaimed ? firstUnclaimed.unlockAt : TIER_DATA[TIER_DATA.length - 1].unlockAt;
  const displayed = Math.min(effectiveTotalSpent, target);
  const ratio = Math.min((effectiveTotalSpent / target) * 100, 100);


  return `
    <div class="mx-auto w-full max-w-md h-[100svh] overflow-y-auto bg-noise">
      <div class="flex min-h-[100svh] flex-col">
      <header class="relative px-4 pt-5 pb-3 shrink-0">
        <div class="flex items-center gap-3">
          <img src="assets/dostt_icon.png" alt="Dostt" class="h-11 w-11 rounded-2xl" />
          <span class="text-[1.7rem] font-semibold leading-none tracking-tight">dostt</span>
        </div>
        <div class="mt-3">
          <h1 class="text-[1.35rem] font-semibold leading-tight tracking-tight">Dostt Free Rewards</h1>
          <p class="text-xs text-dosttMuted">Earn free rewards as you call</p>
        </div>
      </header>

      ${state.isTester ? testerToolbar() : ""}

      <section class="mx-3 mt-4 rounded-3xl border border-white/10 bg-[#1a2230] p-5 shadow-soft progress-card">
        <div class="lottie-wrap">
          <div id="coins-lottie" class="lottie-canvas" aria-hidden="true"></div>
        </div>
        <div>
          <div class="flex items-center justify-between">
            <p class="text-[11px] uppercase tracking-widest text-white/60">Your Progress</p>
            <div class="flex flex-col items-end gap-0.5">
              <p class="text-[10px] text-white/45">${state.lastRefreshedAt ? "Last updated: " + new Date(state.lastRefreshedAt).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) + " IST" : "Refreshes every 2 hours"}</p>
              ${state.cycleEndDate ? `<p class="text-[10px] text-dosttGold/80">Resets in ${Math.max(0, Math.ceil((new Date(state.cycleEndDate) - Date.now()) / (1000 * 60 * 60 * 24)))} days</p>` : ""}
            </div>
          </div>
          <p class="mt-1 text-xl font-semibold">${displayed} / ${target} Dostt Points earned</p>
        </div>
        <div class="relative mt-3 h-3 rounded-full bg-white/10">
          <div id="progress-bar-fill" data-target="${ratio}%" class="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#7c3aed] to-[#844aff] transition-all duration-500" style="width:${ratio}%"></div>
        </div>
        <div class="mt-4">
          <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-1.5 text-[13px] font-medium text-dosttMuted">
              <svg width="15" height="15" viewBox="0 0 13 13" fill="none" class="shrink-0"><circle cx="6.5" cy="6.5" r="6" stroke="currentColor" stroke-width="1.2"/><text x="6.5" y="10" text-anchor="middle" font-size="8" fill="currentColor" font-family="sans-serif">i</text></svg>
              How to earn Dostt Points?
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <article class="rounded-2xl border border-white/10 bg-gradient-to-r from-violet-400/20 to-purple-500/20 p-3">
              <div class="flex items-center gap-2">
                <img src="assets/audio-icon.png" alt="" aria-hidden="true" class="h-6 w-6 shrink-0" />
                <div class="min-w-0">
                  <h3 class="text-xs font-semibold">Audio Calls</h3>
                  <p class="text-[10px] text-dosttMuted leading-tight mt-0.5">Earn points by calling</p>
                </div>
              </div>
            </article>
            <article class="rounded-2xl border border-white/10 bg-gradient-to-r from-violet-300/15 to-fuchsia-400/15 p-3">
              <div class="flex items-center gap-2">
                <img src="assets/video-icon.png" alt="" aria-hidden="true" class="h-7 w-7 shrink-0" />
                <div class="min-w-0">
                  <h3 class="text-xs font-semibold">Video Calls</h3>
                  <p class="text-[10px] text-dosttMuted leading-tight mt-0.5">Earn points by calling</p>
                </div>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section class="mx-3 mt-4 mb-2 flex flex-col" style="flex:1 1 0;min-height:clamp(280px,40vh,500px)">
        <div class="flex min-h-0 flex-1 flex-col rounded-3xl border border-white/10 bg-[#1a2230] shadow-soft overflow-hidden">
          <div class="px-4 pt-4 pb-2 shrink-0">
            <h2 class="text-base font-semibold">Free Rewards</h2>
          </div>
          <div class="reward-scroll flex-1 min-h-0 space-y-3 overflow-y-auto pl-3 pr-4 pb-4">
            ${TIER_DATA.map(t => tierCard(t, t.id === firstUnclaimedId)).join("")}
          </div>
        </div>
      </section>
      </div>

      <div class="flex flex-col items-center gap-3 py-10">
        <button id="logout-btn" class="text-sm font-semibold text-white tracking-wide px-6 py-2">
          Log out
        </button>
        <button id="terms-btn-rewards" class="text-xs text-white/40">
          Terms &amp; Conditions
        </button>
      </div>

      ${
        state.toast
          ? `<div id="toast-pill" class="pointer-events-none fixed inset-x-0 bottom-6 z-50 mx-auto w-fit max-w-[90vw] rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_4px_24px_rgba(139,92,246,0.45)]">${state.toast}</div>`
          : ""
      }
    </div>
  `;
}

// ─── Terms page ───────────────────────────────────────────────────────────────

function termsPage() {
  return `
    <div class="mx-auto flex h-[100svh] w-full max-w-md flex-col bg-noise">
      <header class="shrink-0 flex items-center gap-3 px-4 pt-5 pb-4 border-b border-white/8">
        <button id="terms-back-btn" class="flex items-center justify-center w-9 h-9 rounded-xl bg-white/8 active:bg-white/15">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M11 14L6 9L11 4" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div>
          <h1 class="text-base font-semibold">Terms &amp; Conditions</h1>
          <p class="text-[10px] text-white/40">Dostt Free Rewards Programme</p>
        </div>
      </header>
      <div class="flex-1 min-h-0 overflow-y-auto px-5 py-5 space-y-5 text-sm leading-relaxed text-white/75">

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">FREE REWARDS – TERMS &amp; CONDITIONS</h2>
          <p>These Terms apply to your use of our website (available at: www.dostt.in) and mobile application (App) (available on Google Play Store and Apple App Store) (collectively, Dostt App) and the "Free Rewards" programme ("Programme").</p>
          <p class="mt-2">The App is operated by Behtar Technology Private Limited (Company), a company registered in India with its office at 1501, 19th Main, HSR Layout Sector 1, Bangalore, Karnataka – 560102.</p>
          <p class="mt-2">"We", "our" or "us" refers to Behtar Technology Private Limited, and "you" or "your" refers to any user of the Dostt App.</p>
          <p class="mt-2">These Terms must be read together with the Dostt App <a href="https://www.dostt.in/terms" target="_blank" rel="noopener noreferrer" class="text-violet-300 underline">Terms of Use</a>, <a href="https://www.dostt.in/privacypolicy" target="_blank" rel="noopener noreferrer" class="text-violet-300 underline">Privacy Policy</a> &amp; <a href="https://www.dostt.in/guidelines" target="_blank" rel="noopener noreferrer" class="text-violet-300 underline">Community Guidelines</a> (collectively, the Platform Policies). In the event of any inconsistency between these Terms and the Platform Policies, these Terms shall prevail solely with respect to the Programme, to the extent permitted under applicable law. By using this Feature, you confirm that you have read, understood, and accepted these Terms. If you do not agree, please do not participate.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">1. About the Programme</h2>
          <p>The Programme is an in-app incentive initiative that allows eligible users to earn free coins based on their engagement on the Dostt App. The Programme is a promotional engagement initiative and does not constitute a financial product, investment scheme, or deposit-taking activity under applicable law. As users accumulate Dostt Points based on their engagement, they become eligible claim rewards at milestone thresholds. Claiming is not automatic and is subject to system validation and compliance with these Terms.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">2. Eligibility</h2>
          <p>Participation in the Programme is available exclusively to registered users of the Dostt App who are callers (non-Listeners/non-experts). To be eligible, you must:</p>
          <ul class="mt-2 space-y-1.5 list-disc list-inside text-white/65">
            <li>Hold a verified Dostt account linked to an active mobile number</li>
            <li>Be at least 18 years of age</li>
            <li>Be legally permitted to access the Dostt App under the laws of your jurisdiction and not be located in jurisdictions where such promotional activities are restricted or prohibited under applicable law.</li>
            <li>Be in good standing, i.e, accounts that are suspended, restricted, or under review are not eligible</li>
          </ul>
          <p class="mt-2">We reserve the right to verify eligibility at any time and to restrict or revoke participation at our sole discretion. The Company may request additional documentation for verification in compliance with applicable laws and may suspend reward eligibility pending such verification.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">3. Earning Dostt Points</h2>
          <p>One (1) Dostt Point is credited for every one (1) coin spent on audio or video calls made through the Dostt App. Points are computed based on your coin spend activity and are displayed within the Programme interface. Points are updated periodically and may reflect activity from up to two (2) hours prior to the time of viewing.</p>
          <p class="mt-2">The Company's records relating to coin spend and point accrual shall be final and binding, except in cases of manifest error. Dostt Points have no monetary value. Dostt Points do not constitute property, vested rights, or legally enforceable claims outside the Programme.</p>
          <p class="mt-2">Dostt Points have no monetary value, cannot be transferred, and cannot be exchanged for cash or any item of value outside the Programme.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">4. Reward Milestones &amp; Claiming</h2>
          <p>The Programme is structured across seventeen (17) milestone tiers. Each tier has a defined Dostt Points threshold. Upon reaching a threshold, the corresponding reward becomes available for you to claim. A milestone is unlocked only when your total Dostt Points meet or exceed that tier's threshold.</p>
          <p class="mt-2">Reward claims are subject to verification, and the Company may delay, withhold, or reverse rewards in cases of suspected fraud, abuse, or technical anomalies.</p>
          <p class="mt-2">Each milestone reward may be claimed once per programme cycle (see Section 5 below). Upon a successful claim, the corresponding free coins are credited directly to your Dostt wallet. Claimed rewards cannot be reversed, transferred, or exchanged.</p>
          <p class="mt-2">The Company shall not be liable for loss of rewards due to technical issues beyond its reasonable control; however, nothing in this clause shall limit liability where such limitation is prohibited under applicable law.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">5. Programme Cycle &amp; Points Reset</h2>
          <p>The Programme operates on a rolling thirty (30) day cycle. At the end of each cycle, your Dostt Points balance and all milestone claim statuses will reset to zero. A new cycle begins immediately thereafter, and you may begin earning and claiming again from the first milestone. The exact cycle timeline shall be displayed within the Programme interface and may be subject to system configuration.</p>
          <p class="mt-2">Points reset after each cycle. Unclaimed rewards at the time of a cycle reset are forfeited and cannot be carried over to the next cycle. We recommend claiming your available rewards before the cycle reset date, which is displayed within the Programme interface.</p>
          <p class="mt-2">The cycle reset date is visible on your rewards progress screen. We are not liable for rewards forfeited as a result of a cycle reset.</p>
          <p class="mt-2">The Company will take reasonable steps to notify users of upcoming cycle resets, however, failure to claim rewards prior to reset shall not create liability on the Company. Cycle resets are an integral part of the Programme structure and are accepted by you as a condition of participation.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">6. Validity of Rewarded Coins</h2>
          <p>Coins credited to your wallet through this Programme are subject to the standard coin expiry policy applicable to all coins on the Dostt App, as set out in the Dostt App Terms of Use. Expiry timelines shall be governed strictly by the Dostt Platform Terms of Use. Expired coins are forfeited without notice, refund, or compensation. Such forfeiture shall occur without compensation, to the extent permitted under applicable law.</p>
          <p class="mt-2">If your account is suspended or terminated for breach of the Platform Policies or applicable law, all coins including those earned through this Programme will be forfeited without refund or compensation.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">7. Prohibited Conduct</h2>
          <p>You must not attempt to manipulate, misuse, or exploit this Programme in any manner. Prohibited conduct includes, but is not limited to:</p>
          <ul class="mt-2 space-y-1.5 list-disc list-inside text-white/65">
            <li>Making fake, automated, or artificially generated calls to inflate Dostt Points</li>
            <li>Self-calling, circular calling, or coordinated activity intended to artificially inflate usage</li>
            <li>Using bots, scripts, or any automated tools to interact with the Programme</li>
            <li>Creating multiple accounts to gain additional Programme benefits</li>
            <li>Exploiting technical errors or vulnerabilities within the Programme</li>
            <li>Any other conduct intended to gain rewards in a manner not contemplated by these Terms</li>
          </ul>
          <p class="mt-2">The Company reserves the right to:</p>
          <ul class="mt-2 space-y-1.5 list-disc list-inside text-white/65">
            <li>Reverse points and rewards</li>
            <li>Disqualify participation</li>
            <li>Suspend or terminate accounts</li>
            <li>Take legal action where necessary</li>
          </ul>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">8. Modifications to the Programme</h2>
          <p>We may modify, suspend, or permanently terminate the Programme, or any part of it, at any time and at our sole discretion. This includes changes to milestone thresholds, reward values, cycle duration, eligibility criteria, and programme rules. Where any change materially affects your rights, we will take reasonable steps to notify you through the Dostt App.</p>
          <p class="mt-2">Your continued participation in the Programme following any modification constitutes your acceptance of the revised Terms.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">9. Privacy</h2>
          <p>Your participation is governed by Dostt's Privacy Policy. Data related to your spins, rewards, and activity is used solely to operate and improve the Feature and is handled in accordance with applicable laws.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">10. Disclaimers &amp; Limitation of Liability</h2>
          <p>The Programme is provided on an as is, where is basis. We make no representations or warranties, express or implied, regarding the availability, accuracy, or continuity of the Programme. We do not guarantee that the Programme will be uninterrupted or error-free.</p>
          <p class="mt-2">To the fullest extent permitted by law, we are not liable for any direct, indirect, incidental, or consequential loss or damage arising from your participation or inability to participate in the Programme, including loss of unclaimed rewards due to technical failures or cycle resets. Where liability cannot be excluded by law, our total liability shall not exceed the value of the unclaimed rewards in your account at the time of the relevant event.</p>
        </section>

        <section>
          <h2 class="text-sm font-semibold text-white mb-2">11. Governing Law &amp; Disputes</h2>
          <p>These Terms shall be governed by the laws of India. All disputes shall be subject to the exclusive jurisdiction of the courts in Bengaluru, Karnataka.</p>
        </section>

        <section class="pb-6">
          <h2 class="text-sm font-semibold text-white mb-2">12. Contact &amp; Grievance Redressal</h2>
          <p>For any queries or concerns:</p>
          <p class="mt-2">In-App Support: Help &amp; Support section in the Dostt App</p>
          <p class="mt-1">Email Support: <a href="mailto:support@dostt.in" class="text-violet-300 underline">support@dostt.in</a></p>
          <p class="mt-2">Grievance Officer:</p>
          <p class="mt-1">Shruti Gupta</p>
          <p class="mt-1"><a href="mailto:grievance.officer@dostt.in" class="text-violet-300 underline">grievance.officer@dostt.in</a></p>
          <p class="mt-1">1501, 19th Main Road, Sector 1, HSR Layout, Bengaluru – 560102, India</p>
        </section>

      </div>
    </div>
  `;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  if (state.showTestModal) {
    root.innerHTML = testModeModal();
    wireTestModal();
    return;
  }
  if (state.view === "login") {
    root.innerHTML = loginPage();
    wireLoginEvents();
  } else if (state.view === "terms") {
    root.innerHTML = termsPage();
    document.getElementById("terms-back-btn")?.addEventListener("click", () => {
      state.view = state.prevView;
      render();
    });
  } else {
    root.innerHTML = rewardsPage();
    initLottie();
    if (!rewardsRendered && state.totalSpent > 0) {
      rewardsRendered = true;
      sweepProgressBar();
    }
    // Wire tester toolbar claim-type toggle
    document.getElementById("claim-type-toggle")?.addEventListener("click", () => {
      state.claimType = state.claimType === "real" ? "dummy" : "real";
      render();
      initLottie();
    });
  }
}

let rewardsRendered = false;

function sweepProgressBar() {
  requestAnimationFrame(() => {
    const bar = document.getElementById("progress-bar-fill");
    if (!bar) return;
    const target = bar.dataset.target;
    bar.style.transition = "none";
    bar.style.width = "0%";
    bar.classList.add("bar-glow");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bar.style.transition = "width 1.5s cubic-bezier(0.25, 1.1, 0.5, 1)";
        bar.style.width = target;
        bar.addEventListener("transitionend", () => {
          bar.style.transition = "";
          bar.classList.remove("bar-glow");
        }, { once: true });
      });
    });
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(text) {
  state.toast = text;
  render();
  initLottie();
  requestAnimationFrame(() => {
    const toast = document.getElementById("toast-pill");
    if (toast) spawnCoinsAt(
      toast.getBoundingClientRect().left + toast.getBoundingClientRect().width / 2,
      toast.getBoundingClientRect().top + toast.getBoundingClientRect().height / 2,
      6
    );
  });
  window.clearTimeout(showToast._timer);
  showToast._timer = window.setTimeout(() => {
    state.toast = "";
    render();
    initLottie();
  }, 1800);
}

// ─── Coin burst animation ─────────────────────────────────────────────────────

function spawnCoinsAt(cx, cy, count = 5) {
  const angles = count === 4
    ? [-50, -15, 15, 50]
    : [-70, -35, 0, 35, 70, 105];
  angles.slice(0, count).forEach((angle, i) => {
    const coin = document.createElement("img");
    coin.src = "assets/dostt-coin.png";
    coin.className = "coin-burst";
    const rad = (angle - 90) * Math.PI / 180;
    const dist = 60 + Math.random() * 35;
    coin.style.cssText = `left:${cx - 14}px;top:${cy - 14}px;--tx:${Math.cos(rad) * dist}px;--ty:${Math.sin(rad) * dist}px;--rot:${angle * 1.5}deg;animation-delay:${i * 0.06}s`;
    document.body.appendChild(coin);
    coin.addEventListener("animationend", () => coin.remove(), { once: true });
  });
}

// ─── Coin audio ───────────────────────────────────────────────────────────────

const _coinAudio = new Audio("assets/Coins dropping in Piggy Bank Sound Effect  Coins Sound Effect.mp3");
_coinAudio.preload = "auto";

function playCoinClink() {
  try {
    let plays = 0;
    const deadline = Date.now() + 2000;

    function playOnce() {
      if (plays >= 3 || Date.now() >= deadline) {
        _coinAudio.pause();
        _coinAudio.currentTime = 0;
        return;
      }
      plays++;
      _coinAudio.currentTime = 0;
      _coinAudio.play().catch(() => {});
    }

    clearTimeout(playCoinClink._timer);
    _coinAudio.removeEventListener("ended", playCoinClink._onEnded);
    playCoinClink._onEnded = playOnce;
    _coinAudio.addEventListener("ended", playCoinClink._onEnded);

    playOnce();
    playCoinClink._timer = setTimeout(() => {
      _coinAudio.removeEventListener("ended", playCoinClink._onEnded);
      _coinAudio.pause();
      _coinAudio.currentTime = 0;
    }, 2000);
  } catch (e) { /* audio not available */ }
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadRewardsData() {
  if (state.testMode === "bypass") {
    state.totalSpent = 24350;
    state.claimed = new Set();
    return;
  }
  try {
    const data = await api(`/rewards/me?phone=${encodeURIComponent(state.phone)}&countryCode=${encodeURIComponent(state.country.code)}`);
    state.totalSpent      = data.totalSpent      || 0;
    state.lastRefreshedAt = data.lastRefreshedAt  || null;
    state.cycleEndDate    = data.cycle?.endDate   || null;
    state.claimed         = new Set(data.claimedTiers || []);
    state.isTester        = data.isTester         || state.isTester;
  } catch (err) {
    console.error("[rewards] Failed to load rewards data:", err.message);
  }
}

// ─── Event delegation ─────────────────────────────────────────────────────────

window.addEventListener("click", async (event) => {
  const claimButton = event.target.closest(".claim-btn");
  if (claimButton && !claimButton.disabled) {
    const tierId = Number(claimButton.dataset.tier);

    claimButton.disabled = true;
    claimButton.textContent = "Claiming…";

    if (state.testMode === "bypass") {
      state.claimed.add(tierId);
      playCoinClink();
      showToast("Coins added to your wallet!");
      sweepProgressBar();
      return;
    }

    try {
      const result = await api("/rewards/claim", {
        method: "POST",
        body: JSON.stringify({
          tierId,
          phone: state.phone,
          countryCode: state.country.code,
          claimMode: state.testMode === "direct_select" ? "direct_select" : "api",
          claimType: state.claimType || "real",
        }),
      });

      state.claimed.add(tierId);
      playCoinClink();
      showToast(state.claimType === "dummy" ? "Dummy claim logged!" : "Coins added to your wallet!");
      sweepProgressBar();
    } catch (err) {
        claimButton.disabled = false;
      claimButton.textContent = "Claim";
      showToast(err.message || "Failed to claim. Try again.");
    }
  }

  if (event.target.closest("#logout-btn")) {
    localStorage.removeItem("dostt_session");
    state.view = "login";
    state.phone = "";
    state.country = COUNTRIES[0];
    state.claimed = new Set();
    state.totalSpent = 0;
    state.lastRefreshedAt = null;
    state.isTester = false;
    state.testMode = null;
    state.claimType = "real";
    state.showTestModal = false;
    rewardsRendered = false;
    render();
  }

  if (event.target.closest("#terms-btn-rewards")) {
    state.prevView = state.view;
    state.view = "terms";
    render();
  }
});

// ─── Session restore ──────────────────────────────────────────────────────────

(async function restoreSession() {
  try {
    const saved = localStorage.getItem("dostt_session");
    if (saved) {
      const s = JSON.parse(saved);
      state.phone   = s.phone   || "";
      state.country = s.country || COUNTRIES[0];
      state.isTester = TEST_PHONES.includes(state.phone);
      state.view    = "rewards";
      render();        // Show rewards page immediately — don't wait for Redash
      initLottie();
      await loadRewardsData(); // Load data in background
    }
  } catch (e) { /* ignore */ }
  render();            // Re-render once data is ready
  initLottie();
})();

// ─── Lottie ───────────────────────────────────────────────────────────────────

function initLottie() {
  const container = document.getElementById("coins-lottie");
  if (!container || container.dataset.ready === "true") return;
  if (!window.lottie) return;
  window.lottie.loadAnimation({
    container,
    renderer: "svg",
    loop: true,
    autoplay: true,
    path: "assets/coins-rain.json",
    rendererSettings: {
      preserveAspectRatio: "xMidYMid slice",
    },
  });
  container.dataset.ready = "true";
}

window.addEventListener("load", () => {
  initLottie();
});
