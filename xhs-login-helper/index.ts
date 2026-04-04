// xhs-login-helper/index.ts
// One-time XHS login helper — deploy on Render (free tier, Docker).
// Visit in your iPad browser to scan the QR code.
// Cookies are saved to Supabase automatically after login.

import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const LOGIN_SECRET = process.env.LOGIN_SECRET || "";

function checkAuth(req: express.Request, res: express.Response): boolean {
  if (LOGIN_SECRET && req.query.token !== LOGIN_SECRET) {
    res.status(401).send("<h2>Unauthorized — add ?token=YOUR_LOGIN_SECRET to the URL</h2>");
    return false;
  }
  return true;
}

interface SessionState {
  qrDataUrl: string | null;
  status: "starting" | "waiting_scan" | "success" | "timeout" | "error";
  error?: string;
  cookieCount?: number;
}
const sessions = new Map<string, SessionState>();

function isLoggedInFromCookies(cookies: { name: string; value: string }[]): boolean {
  const authCookieNames = ["web_session", "xsecappid", "a1"];
  return authCookieNames.some(name =>
    cookies.some(c => c.name === name && c.value.length > 10)
  );
}

async function saveCookies(phone: string, cookies: object[]): Promise<void> {
  const { error } = await supabase
    .from("xhs_accounts")
    .upsert({ phone, cookie_json: JSON.stringify(cookies), active: true }, { onConflict: "phone" });
  sessions.set(phone, {
    qrDataUrl: null,
    status: error ? "error" : "success",
    error: error?.message,
    cookieCount: cookies.length,
  });
  console.log(error ? `Supabase error: ${error.message}` : `Saved ${cookies.length} cookies for ${phone}`);
}

app.get("/login", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const phone = (req.query.phone as string) || "";
  const token = (req.query.token as string) || "";
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";

  if (!phone) {
    return res.send(`
      <html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font-family:sans-serif;padding:32px;background:#f5f5f5}input,button{font-size:18px;padding:10px;margin:8px 0;width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #ccc}button{background:#e94560;color:white;border:none;cursor:pointer}</style>
      </head><body>
        <h2>XHS Login Helper</h2>
        <form action="/login" method="get">
          ${token ? `<input type="hidden" name="token" value="${token}" />` : ""}
          <label>Phone number:</label>
          <input name="phone" placeholder="+86 138 xxxx xxxx" type="tel" />
          <button type="submit">Start Login</button>
        </form>
      </body></html>`);
  }

  const existing = sessions.get(phone);
  if (existing?.status === "starting" || existing?.status === "waiting_scan") {
    return res.redirect(`/wait?phone=${encodeURIComponent(phone)}${tokenParam}`);
  }

  sessions.set(phone, { qrDataUrl: null, status: "starting" });

  (async () => {
    let browser: import("playwright").Browser | undefined;
    try {
      const execPath = chromium.executablePath();
      console.log("Chromium path:", execPath);

      browser = await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--lang=zh-CN",
          "--font-render-hinting=none",
        ],
      });

      const context = await browser.newContext({
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1280, height: 800 },
      });

      const page = await context.newPage();

      await page.addInitScript(`
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
      `);

      // Use domcontentloaded instead of networkidle — much faster on Render free tier
      console.log("Navigating to XHS...");
      await page.goto("https://www.xiaohongshu.com", { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000); // let JS settle without waiting for all network

      const loginBtn = await page.$("text=登录");
      if (loginBtn) {
        await loginBtn.click();
        console.log("Clicked login button");
      }
      await page.waitForTimeout(3000);

      const qrSelectors = [
        '[class*="qrcode"] canvas',
        '[class*="qr-code"] canvas',
        'canvas[class*="qr"]',
        '[class*="loginQrcode"]',
        '.qrcode-img',
        'img[src*="qrcode"]',
        'canvas',
      ];

      // Wrapped in try/catch — screenshot timeouts must not crash the session
      const getQRBuffer = async (): Promise<Buffer | null> => {
        try {
          for (const sel of qrSelectors) {
            const el = await page.$(sel);
            if (el) {
              console.log("QR element found:", sel);
              return await el.screenshot({ timeout: 8000 }) as Buffer;
            }
          }
          return await page.screenshot({ fullPage: false, timeout: 8000 }) as Buffer;
        } catch (e) {
          console.log("Screenshot failed (non-fatal):", (e as Error).message);
          return null;
        }
      };

      const qrBuffer = await getQRBuffer();
      sessions.set(phone, {
        qrDataUrl: qrBuffer ? `data:image/png;base64,${qrBuffer.toString("base64")}` : null,
        status: "waiting_scan",
      });

      // Poll up to 3 minutes using 3 detection strategies
      const deadline = Date.now() + 180_000;
      let detected = false;

      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);

        const cookies = await context.cookies();
        console.log(`[${new Date().toISOString()}] Cookies (${cookies.length}): ${cookies.map(c => c.name).join(", ")}`);

        // Refresh QR (non-fatal)
        const refreshBuffer = await getQRBuffer();
        const currentState = sessions.get(phone);
        if (refreshBuffer && currentState?.status === "waiting_scan") {
          sessions.set(phone, {
            ...currentState,
            qrDataUrl: `data:image/png;base64,${refreshBuffer.toString("base64")}`,
          });
        }

        // Strategy 1: auth cookie detection
        if (isLoggedInFromCookies(cookies)) {
          console.log("Login detected via auth cookies");
          detected = true;
          await saveCookies(phone, cookies);
          break;
        }

        // Strategy 2: URL change
        const currentUrl = page.url();
        console.log("URL:", currentUrl);
        if (
          currentUrl.includes("xiaohongshu.com") &&
          !currentUrl.includes("/login") &&
          !currentUrl.includes("/signin") &&
          currentUrl !== "about:blank"
        ) {
          console.log("Login detected via URL change:", currentUrl);
          detected = true;
          await saveCookies(phone, cookies);
          break;
        }

        // Strategy 3: DOM element
        const loggedIn = await page.$(
          '[data-testid="user-avatar"], .user-avatar, [class*="userAvatar"], .reds-avatar, [class*="HeaderAvatar"]'
        );
        if (loggedIn) {
          console.log("Login detected via DOM");
          detected = true;
          await saveCookies(phone, cookies);
          break;
        }
      }

      // Last resort: save whatever cookies exist
      if (!detected) {
        const cookies = await context.cookies();
        console.log(`Timeout. Final cookie count: ${cookies.length}`);
        if (cookies.length > 3) {
          console.log("Saving cookies as last resort");
          await saveCookies(phone, cookies);
        } else {
          sessions.set(phone, { qrDataUrl: null, status: "timeout" });
        }
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sessions.set(phone, { qrDataUrl: null, status: "error", error: msg });
      console.error("Login error:", msg);
    } finally {
      if (browser) await browser.close();
    }
  })();

  res.redirect(`/wait?phone=${encodeURIComponent(phone)}${tokenParam}`);
});

app.get("/wait", function(req, res) {
  if (!checkAuth(req, res)) return;
  const phone = (req.query.phone as string) || "";
  const token = (req.query.token as string) || "";
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";

  res.send(`
    <html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Cache-Control" content="no-cache">
      <style>
        body{font-family:sans-serif;padding:24px;text-align:center;background:#f9f9f9;color:#333}
        h2{color:#e94560}
        #qr{max-width:280px;width:100%;border:3px solid #e94560;border-radius:16px;margin:20px auto;display:none}
        .status{font-size:18px;margin:16px 0}
        .success{color:#22c55e;font-weight:bold;font-size:22px}
        .error{color:#e94560}
        .hint{color:#888;font-size:14px;margin-top:24px;line-height:1.7}
        a.back{display:inline-block;margin-top:20px;color:#6c63ff;font-size:16px}
        .cookie-count{color:#888;font-size:12px;margin-top:8px}
      </style>
      <script>
        var phone = ${JSON.stringify(phone)};
        var tokenParam = ${JSON.stringify(tokenParam)};
        function poll() {
          fetch('/status?phone=' + encodeURIComponent(phone) + tokenParam)
            .then(function(r){ return r.json(); })
            .then(function(data) {
              var statusEl = document.getElementById('status');
              var qrEl = document.getElementById('qr');
              var countEl = document.getElementById('cookie-count');
              if (data.qrDataUrl) { qrEl.src = data.qrDataUrl; qrEl.style.display = 'block'; }
              var msgs = {
                starting: '⏳ Starting browser on Render...',
                waiting_scan: '📱 Open XHS app → scan QR → tap 确认登录 (Confirm)',
                success: '✅ Login successful! Cookies saved.',
                timeout: '⏱ Timed out. <a href="/login?phone=' + encodeURIComponent(phone) + tokenParam + '">Try again</a>',
                error: '❌ Error: ' + (data.error || 'unknown'),
                not_started: '⏳ Starting...',
              };
              statusEl.innerHTML = msgs[data.status] || data.status;
              if (data.cookieCount) countEl.textContent = data.cookieCount + ' cookies saved';
              if (data.status === 'success') {
                statusEl.className = 'status success';
                qrEl.style.display = 'none';
              } else if (data.status === 'timeout' || data.status === 'error') {
                statusEl.className = 'status error';
              } else {
                setTimeout(poll, data.status === 'starting' ? 1500 : 2000);
              }
            })
            .catch(function(){ setTimeout(poll, 3000); });
        }
        window.onload = function(){ setTimeout(poll, 800); };
      </script>
    </head>
    <body>
      <h2>XHS Login</h2>
      <p>Phone: <strong>${phone}</strong></p>
      <img id="qr" alt="QR Code" />
      <p class="status" id="status">Starting...</p>
      <p id="cookie-count" class="cookie-count"></p>
      <p class="hint">
        1. Wait for the QR code to appear (up to 60s on cold start)<br>
        2. Open XHS app → tap the scan icon<br>
        3. Scan the QR code<br>
        4. Tap <strong>确认登录 (Confirm Login)</strong> in the app<br>
        5. Wait 5–10 seconds for this page to update
      </p>
      <a class="back" href="/accounts${token ? '?token=' + encodeURIComponent(token) : ''}">← Back to accounts</a>
    </body></html>`);
});

app.get("/status", function(req, res) {
  if (!checkAuth(req, res)) return;
  const phone = (req.query.phone as string) || "";
  res.json(sessions.get(phone) ?? { qrDataUrl: null, status: "not_started" });
});

app.get("/accounts", async function(req, res) {
  if (!checkAuth(req, res)) return;
  const token = (req.query.token as string) || "";
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";

  const { data, error } = await supabase
    .from("xhs_accounts")
    .select("phone, active, banned, shadowbanned, last_post_at, posts_today, cookie_json");
  if (error) return res.status(500).send(`<h2>Supabase error: ${error.message}</h2>`);

  const rows = (data || []).map(function(a: Record<string, unknown>) {
    const sessionStatus = a.cookie_json
      ? '<span style="color:green">✓ Active</span>'
      : '<span style="color:orange">⚠ Needs login</span>';
    const loginUrl = `/login?phone=${encodeURIComponent(String(a.phone))}${token ? "&token=" + encodeURIComponent(token) : ""}`;
    const lastPost = a.last_post_at ? new Date(String(a.last_post_at)).toLocaleString() : "Never";
    return `<tr>
      <td>${a.phone}</td>
      <td>${a.active ? "Yes" : "No"}</td>
      <td>${a.banned ? "🚫 Banned" : "OK"}</td>
      <td>${a.shadowbanned ? "👻 Shadow" : "OK"}</td>
      <td>${lastPost}</td>
      <td>${a.posts_today ?? 0}</td>
      <td>${sessionStatus}</td>
      <td><a href="${loginUrl}">Login / Refresh</a></td>
    </tr>`;
  }).join("");

  res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{font-family:sans-serif;padding:20px;background:#f9f9f9}
      h2{color:#e94560}
      table{width:100%;border-collapse:collapse;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
      th{background:#1a1a2e;color:white;padding:10px 8px;text-align:left;font-size:13px}
      td{padding:10px 8px;border-bottom:1px solid #eee;font-size:14px}
      a{color:#6c63ff}
      .add-btn{display:inline-block;margin-top:16px;padding:12px 24px;background:#e94560;color:white;text-decoration:none;border-radius:8px;font-size:16px}
    </style></head><body>
      <h2>XHS Accounts</h2>
      <table>
        <tr><th>Phone</th><th>Active</th><th>Banned</th><th>Shadowbanned</th><th>Last Post</th><th>Posts Today</th><th>Session</th><th>Action</th></tr>
        ${rows || '<tr><td colspan="8" style="text-align:center;color:#999;padding:20px">No accounts yet</td></tr>'}
      </table>
      <a class="add-btn" href="/login${tokenQuery}">+ Add / Re-login Account</a>
    </body></html>`);
});

app.get("/", function(req, res) {
  const token = (req.query.token as string) || "";
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  res.send(`<html><body style="font-family:sans-serif;padding:32px;text-align:center">
    <h2 style="color:#e94560">XHS Login Helper</h2>
    <p><a href="/accounts${tokenQuery}" style="font-size:18px;color:#6c63ff">View Accounts</a></p>
  </body></html>`);
});

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", function() {
  console.log("XHS login helper running on port " + PORT);
  try { console.log("Chromium path:", chromium.executablePath()); } catch { /* ok */ }
});