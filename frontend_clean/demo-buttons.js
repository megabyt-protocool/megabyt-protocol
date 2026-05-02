(function () {
  "use strict";

  function $(id) {
    return document.getElementById(id);
  }

  function now() {
    return new Date().toLocaleTimeString();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function log(msg) {
    const box = $("demoStepLog");
    if (!box) return;

    const d = document.createElement("div");
    d.textContent = "[" + now() + "] " + msg;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function txLog(msg, cls) {
    const box = $("lg");
    if (!box) return;
    const d = document.createElement("div");
    d.className = "le " + (cls || "lei");
    d.textContent = "[" + now() + "] " + msg;
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function txLogOutput(outputText) {
    const lines = String(outputText || "")
      .replace(/\r/g, "")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    if (!lines.length) {
      txLog("(no backend output)", "lew");
      return;
    }
    lines.forEach((line) => txLog(line, "lei"));
  }

  async function runFullDemo() {
    const log = document.getElementById("lg");

    function write(msg) {
      if (log) log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
    }

    try {
      write("🚀 FULL DEMO started");

      const res = await fetch("http://127.0.0.1:3001/open-draw");
      const text = await res.text();

      write(text);
      write("✅ FULL DEMO finished");
    } catch (err) {
      write("❌ ERROR: " + err.message);
    }
  }

  function copy(text, label) {
    const box = $("cmdBox");
    if (box) box.value = text;

    try {
      navigator.clipboard.writeText(text);
      log((label || "Command") + " copied");
    } catch {
      log("Copy manually");
    }
  }

  function ensurePreviewBox() {
    if ($("selectedTicketBox")) return;

    const counter = $("nC");
    if (!counter) return;

    counter.insertAdjacentHTML(
      "afterend",
      `
      <div id="selectedTicketBox" style="text-align:center;margin-top:12px;padding:10px;border:1px solid #1a1a3a;border-radius:10px;background:#06060e;">
        <div style="font-size:10px;color:#5a5a80;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">
          Selected Ticket
        </div>
        <div style="font-family:monospace;font-size:13px;color:#00e6b8;margin-bottom:4px;">
          Numbers: <span id="selectedNumbersPreview">—</span>
        </div>
        <div style="font-family:monospace;font-size:13px;color:#ffaa33;">
          Crypto: <span id="selectedCryptoPreview">—</span>
        </div>
      </div>
      `
    );
  }

  function updatePreview() {
    ensurePreviewBox();

    const nums = Array.from(document.querySelectorAll(".nm.sel"))
      .map((el) => Number(el.dataset.n))
      .filter(Boolean)
      .sort((a, b) => a - b);

    const cryptoEl = document.querySelector(".ch.sel");

    if (Array.isArray(window.selectedNumbers)) {
      window.selectedNumbers.length = 0;
      nums.forEach((n) => window.selectedNumbers.push(n));
    } else {
      window.selectedNumbers = nums;
    }

    if (cryptoEl) {
      window.selectedCrypto = Number(cryptoEl.dataset.c || cryptoEl.dataset.n || cryptoEl.getAttribute("data-c") || 0);
    }

    const numsBox = $("selectedNumbersPreview");
    const cryptoBox = $("selectedCryptoPreview");

    if (numsBox) {
      numsBox.textContent =
        nums.length > 0
          ? nums.map((n) => String(n).padStart(2, "0")).join(" · ")
          : "—";
    }

    if (cryptoBox) {
      cryptoBox.textContent = cryptoEl ? cryptoEl.textContent.trim() : "—";
    }

    if (typeof window.updateBuyButton === "function") {
      window.updateBuyButton();
    }
  }

  function ensureNumberGrid() {
    const grid = $("numGrid");
    if (!grid) return;

    if (grid.children.length > 0) return;

    for (let i = 1; i <= 72; i++) {
      const el = document.createElement("div");
      el.className = "nm";
      el.dataset.n = String(i);
      el.textContent = String(i).padStart(2, "0");

      el.addEventListener("click", function () {
        const selected = document.querySelectorAll(".nm.sel");

        if (el.classList.contains("sel")) {
          el.classList.remove("sel");
        } else {
          if (selected.length >= 6) return;
          el.classList.add("sel");
        }

        const counter = $("nC");
        if (counter) {
          counter.textContent =
            document.querySelectorAll(".nm.sel").length + " / 6 selected";
        }

        updatePreview();
      });

      grid.appendChild(el);
    }
  }

  function clearSelection() {
    document.querySelectorAll(".nm.sel").forEach((el) => {
      if (typeof el.click === "function") {
        el.click();
      } else {
        el.classList.remove("sel");
      }
    });
    document.querySelectorAll(".ch.sel").forEach((el) => {
      if (typeof el.click === "function") {
        el.click();
      } else {
        el.classList.remove("sel");
      }
    });

    const counter = $("nC");
    if (counter) counter.textContent = "0 / 6 selected";

    updatePreview();
  }

  function randomUniqueNumbers(total, count) {
    const picked = [];
    while (picked.length < count) {
      const n = Math.floor(Math.random() * total) + 1;
      if (!picked.includes(n)) picked.push(n);
    }
    return picked.sort((a, b) => a - b);
  }

  async function cinematicSelectTicket() {
    ensureNumberGrid();
    ensurePreviewBox();
    clearSelection();

    const picked = randomUniqueNumbers(72, 6);
    for (const n of picked) {
      const el = document.querySelector('.nm[data-n="' + n + '"]');
      if (el) el.click();
      await sleep(180);
    }

    const crypto = Math.floor(Math.random() * 10) + 1;
    const chip = document.querySelector('.ch[data-c="' + crypto + '"]');
    if (chip) chip.click();

    const counter = $("nC");
    if (counter) counter.textContent = "6 / 6 selected";

    updatePreview();
    return { picked, crypto };
  }

  async function waitForPhantomCycle(buyBtn) {
    const start = Date.now();
    const timeoutMs = 120000;
    let sawActiveStep = false;

    while (Date.now() - start < timeoutMs) {
      const text = (buyBtn.textContent || "").toLowerCase();
      const cls = (buyBtn.className || "").toLowerCase();

      if (
        text.indexOf("awaiting signature") !== -1 ||
        text.indexOf("sending") !== -1 ||
        text.indexOf("confirm") !== -1 ||
        cls.indexOf("loading") !== -1
      ) {
        sawActiveStep = true;
      }

      if (cls.indexOf("success") !== -1 || text.indexOf("ticket minted") !== -1) {
        return { ok: true, state: "success" };
      }

      if (cls.indexOf("error") !== -1 || text.indexOf("error") !== -1 || text.indexOf("cancel") !== -1) {
        return { ok: false, state: "error", reason: buyBtn.textContent || "Buy failed" };
      }

      if (sawActiveStep && cls.indexOf("ready") !== -1 && text.indexOf("buy ticket") !== -1) {
        return { ok: true, state: "ready" };
      }

      await sleep(300);
    }

    return { ok: false, state: "timeout", reason: "Timed out waiting for Phantom confirmation" };
  }

  function autoPick() {
    ensureNumberGrid();
    ensurePreviewBox();

    log("🎲 AUTO PICK started");

    clearSelection();

    const picked = randomUniqueNumbers(72, 6);

    picked.forEach((n) => {
      const el = document.querySelector('.nm[data-n="' + n + '"]');
      if (el) el.click();
    });

    const crypto = Math.floor(Math.random() * 10) + 1;
    const chip = document.querySelector('.ch[data-c="' + crypto + '"]');
    if (chip) chip.click();

    const counter = $("nC");
    if (counter) counter.textContent = "6 / 6 selected";

    updatePreview();

    log("✅ Numbers selected: " + picked.map((n) => String(n).padStart(2, "0")).join(" · "));
    log("✅ Crypto selected");

    const buyBtn = $("bBtn");
    if (buyBtn) {
      buyBtn.disabled = false;
      buyBtn.className = "bb ready";
      if (buyBtn.textContent.indexOf("Buy Ticket") === -1) {
        buyBtn.textContent = "⚡ Buy Ticket";
      }
    }
  }

  function build() {
    if ($("demoPanel")) return;

    ensureNumberGrid();
    ensurePreviewBox();

    const html = `
    <div class="card" id="demoPanel" style="margin-bottom:20px;">
      <div class="ct">⚙️ DEMO CONTROLLER</div>

      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">

        <button class="w-btn" style="background:#00e6b8;color:#000;font-size:11px;padding:8px;font-weight:900;" onclick="MegaBytDemo.manual()">
          🎯 DEMO MANUAL
        </button>

        <button class="w-btn" style="background:#6c5ce7;color:white;font-size:11px;padding:8px;" onclick="MegaBytDemo.auto5()">
          🎲 COMPRA AUTOMÁTICA 5X
        </button>

        <button id="fullDemoBtn" class="w-btn" style="background:#3b82f6;color:white;font-size:11px;padding:8px;" onclick="MegaBytDemo.run()">
          ▶ FULL DEMO
        </button>

        <button class="w-btn" style="background:#00b894;color:white;font-size:11px;padding:8px;" onclick="MegaBytDemo.refresh()">
          🔄 REFRESH
        </button>

        <button class="w-btn" onclick="MegaBytDemo.balance()" style="background:#fdcb6e;color:black;font-size:11px;padding:8px;">
          💰 DEV SOL
        </button>

        <button class="w-btn" onclick="MegaBytDemo.explorer()" style="background:#0984e3;color:white;font-size:11px;padding:8px;">
          🔎 ON-CHAIN PROOF
        </button>

        <button class="w-btn" onclick="MegaBytDemo.drawTx()" style="background:#e17055;color:white;font-size:11px;padding:8px;">
          🧾 DRAW TX
        </button>

      </div>

      <textarea id="cmdBox" style="width:100%;margin-top:12px;height:90px;background:#06060e;color:#44ccff;border:1px solid #1a1a3a;border-radius:10px;padding:10px;font-family:monospace;font-size:10px;"></textarea>

      <div id="demoStepLog" style="font-size:10px;margin-top:10px;color:#00e6b8;max-height:130px;overflow-y:auto;font-family:monospace;"></div>
    </div>
    `;

    const stats = document.querySelector(".stats");
    if (stats) stats.insertAdjacentHTML("afterend", html);

    document.addEventListener("click", function (e) {
      if (e.target && (e.target.classList.contains("nm") || e.target.classList.contains("ch"))) {
        setTimeout(updatePreview, 50);
      }
    });

    log("Demo ready");
    try {
      if(window.MegaBytFlight){
        MegaBytFlight.ok("🧪 Manual demo ready");
      }
    } catch(e) {}

    updatePreview();
  }

  window.MegaBytDemo = {
    autoPick,

    manual: async () => {
      try {
        if(window.MegaBytFlight){
          MegaBytFlight.info("🧪 Manual demo started");
        }
      } catch(e) {}

      window.__closingTriggered = false;
      log("🎯 DEMO MANUAL mode — opening new draw");
      txLog("🎯 DEMO MANUAL mode — opening new draw", "lei");

      const res = await fetch("http://127.0.0.1:3001/open-draw");
      const txt = await res.text();

      if (!res.ok) {
        log("❌ Failed to open draw");
        txLog("❌ Failed to open draw: " + txt.slice(0, 160), "ler");
        if(window.MegaBytFlight) MegaBytFlight.err("Failed to open draw");
        return;
      }

      log("✅ New draw opened");
      txLog("✅ New draw opened — select numbers + crypto, then buy ticket", "lok");

      if(window.forceLoadOnChainData){
        await window.forceLoadOnChainData();
      }

      try {
        if(window.MegaBytFlight){
          MegaBytFlight.ok("🎯 Draw opened — ready for manual ticket purchase");
        }
      } catch(e) {}
      const grid = $("numGrid");
      if (grid && typeof grid.scrollIntoView === "function") {
        grid.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      log("Select numbers + crypto manually, then click Buy Ticket");
    },

    auto5: async () => {
      if (window.__megabytDemoRunning) {
        log("ℹ️ Demo flow already running");
        return;
      }
      window.__megabytDemoRunning = true;

      log("🚀 Automatic 5-ticket purchase started");

      const box = $("cmdBox");
      if (box) box.value = "Automatic 5-ticket Phantom flow running...";

      try {
        const buyBtn = $("bBtn");
        if (!buyBtn) {
          throw new Error("Buy button not found");
        }

        for (let i = 1; i <= 5; i++) {
          const ticket = await cinematicSelectTicket();
          log(
            "Ticket " +
              i +
              "/5 selected: " +
              ticket.picked.map((n) => String(n).padStart(2, "0")).join(" · ")
          );
          await sleep(700);

          if (buyBtn.disabled) {
            const reason = buyBtn.textContent || "Buy button is disabled";
            log("❌ " + reason);
            if (box) box.value = reason;
            return;
          }

          log("Opening Phantom signature for ticket " + i + "/5...");
          buyBtn.click();
          log("Waiting Phantom signature");

          const cycle = await waitForPhantomCycle(buyBtn);
          if (!cycle.ok) {
            throw new Error(cycle.reason || "Phantom confirmation failed");
          }

          log("Moving to next ticket");
          await sleep(1200);
        }

        log("Automatic 5-ticket purchase flow completed");
        if (box) box.value = "Automatic 5-ticket purchase flow completed";
      } catch (e) {
        const msg = e.message || String(e);
        log("❌ " + msg);
        if (box) box.value = msg;
      } finally {
        window.__megabytDemoRunning = false;
      }
    },

    runBackend: async () => {
      const fullDemoBtn = $("fullDemoBtn");
      const oldText = fullDemoBtn ? fullDemoBtn.textContent : "";
      if (fullDemoBtn) {
        fullDemoBtn.disabled = true;
        fullDemoBtn.textContent = "RUNNING...";
      }

      log("🚀 FULL DEMO started");
      txLog("🚀 FULL DEMO started", "lei");

      const box = $("cmdBox");
      if (box) box.value = "Running backend demo automation...";

      try {
        log("backend command started");
        txLog("backend command started", "lei");
        const r = await fetch("http://127.0.0.1:3001/open-draw");
        if (!r.ok) {
          throw new Error("Demo server offline — start backend");
        }

        const txt = await r.text();
        txLog("backend output received:", "lei");
        txLogOutput(txt);

        log("✅ FULL DEMO finished");
        txLog("✅ FULL DEMO finished", "lok");

        if (box) box.value = txt;

        if (window.forceLoadOnChainData) {
          await window.forceLoadOnChainData();
        } else {
          location.reload();
        }
      } catch (e) {
        const msg =
          e.message === "Failed to fetch"
            ? "Demo server offline — start backend"
            : e.message;

        log("❌ " + msg);
        txLog("❌ " + msg, "ler");
        if (box) box.value = msg;
      } finally {
        if (fullDemoBtn) {
          fullDemoBtn.disabled = false;
          fullDemoBtn.textContent = oldText || "▶ FULL DEMO";
        }
        window.__megabytDemoRunning = false;
      }
    },

    run: async () => {
      return window.MegaBytDemo.runBackend();
    },

    refresh: () =>
      window.forceLoadOnChainData
        ? window.forceLoadOnChainData()
        : location.reload(),

    balance: async () => {
      const addr = "AueuFaAd9RYPdnc3aB3RmWPzni3XZiYUqoS3a1mgcvzb";
      const connection = new solanaWeb3.Connection(
        "https://api.devnet.solana.com",
        "confirmed"
      );

      const lamports = await connection.getBalance(
        new solanaWeb3.PublicKey(addr)
      );

      const sol = lamports / 1e9;

      const box = $("cmdBox");
      if (box) {
        box.value =
          "Dev Balance (SOL)\nCarteira: " +
          addr +
          "\nSaldo: " +
          sol.toFixed(6) +
          " SOL";
      }

      log("Dev Balance: " + sol.toFixed(6) + " SOL");
    },

    explorer: () => {
      const el = $("eL");
      if (!el) return;
      copy(el.href, "Explorer");
    },

    drawTx: () => {
      const el = $("eL");
      if (!el || !el.href) {
        log("Draw not loaded");
        return;
      }
      copy(el.href, "Draw TX");
    },
  };

  build();
})();

