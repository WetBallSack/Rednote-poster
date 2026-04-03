// xhs-login-helper/index.ts
// One-time XHS login helper — deploy on Render (free tier).
// Visit in your iPad browser to scan the QR code.
// Cookies are saved to Supabase automatically after login.
//
// IMPORTANT: Uses chromium.executablePath() so Playwright uses the exact
// browser installed during the Render build step — avoids version mismatch errors.

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
}
const sessions = new Map<string, SessionState>();

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

  sessions.set(phone, { qrDataUrl: null, status: "starting" });

  (async () => {
    let browser: import("playwright").Browser | undefined;
    try {
      // executablePath() points to the browser installed by `npx playwright install chromium`
      // during the Render build — this prevents the "Executable doesn't exist" version mismatch error
      const execPath = chromium.executablePath();
      console.log("Using Chromium at:", execPath);

      browser = await chromium.launch({
        executablePath: execPath,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--lang=zh-CN",
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

      await page.goto("https://www.xiaohongshu.com", { waitUntil: "networkidle", timeout: 30000 });
      const loginBtn = await page.$("text=登录");
      if (loginBtn) await loginBtn.click();
      await page.waitForTimeout(2500);

      const qrSelectors = [
        '[class*="qrcode"] canvas',
        '[class*="qr-code"] canvas',
        'canvas[class*="qr"]',
        '[class*="loginQrcode"]',
        '.qrcode-img',
        'img[src*="qrcode"]',
      ];

      const getQRBuffer = async (): Promise<Buffer | null> => {
        for (const sel of qrSelectors) {
          const el = await page.$(sel);
          if (el) return await el.screenshot() as Buffer;
        }
        return await page.screenshot({ fullPage: false }) as Buffer;
      };

      const qrBuffer = await getQRBuffer();
      if (qrBuffer) {
        sessions.set(phone, {
          qrDataUrl: `data:image/png;base64,${qrBuffer.toString("base64")}`,
          status: "waiting_scan",
        });
      }

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await page.waitForTimeout(2000);

        const refreshBuffer = await getQRBuffer();
        const currentState = sessions.get(phone);
        if (refreshBuffer && currentState?.status === "waiting_scan") {
          sessions.set(phone, {
            ...currentState,
            qrDataUrl: `data:image/png;base64,${refreshBuffer.toString("base64")}`,
          });
        }

        const loggedIn = await page.$(
          '[data-testid="user-avatar"], .user-avatar, [class*="userAvatar"], .reds-avatar'
        );
        if (loggedIn) {
          const cookies = await context.cookies();
          const { error } = await supabase
            .from("xhs_accounts")
            .upsert({ phone, cookie_json: JSON.stringify(cookies), active: true }, { onConflict: "phone" });
          sessions.set(phone, {
            qrDataUrl: null,
            status: error ? "error" : "success",
            error: error?.message,
          });
          console.log(error ? `Error saving cookies for ${phone}: ${error.message}` : `Saved cookies for ${phone}`);
          break;
        }
      }

      if (sessions.get(phone)?.status === "waiting_scan") {
        sessions.set(phone, { qrDataUrl: null, status: "timeout" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sessions.set(phone, { qrDataUrl: null, status: "error", error: msg });
      console.error("Login error:", msg);
    } finally {
      if (browser) await browser.close();
    }
  })();

  res.send(`
    <html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Cache-Control" content="no-cache">
      <style>
        body{font-family:sans-serif;padding:24px;text-align:center;background:#f9f9f9;color:#333}
        h2{color:#e94560}
        #qr{max-width:260px;width:100%;border:3px solid #e94560;border-radius:16px;margin:20px auto;display:none}
        .status{font-size:18px;margin:16px 0}
        .success{color:#22c55e;font-weight:bold;font-size:22px}
        .error{color:#e94560}
        .hint{color:#999;font-size:14px;margin-top:24px}
        a.back{display:inline-block;margin-top:20px;color:#6c63ff;font-size:16px}
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
              if (data.qrDataUrl) { qrEl.src = data.qrDataUrl; qrEl.style.display = 'block'; }
              var msgs = {
                starting: 'Starting browser...',
                waiting_scan: 'Open XHS app and scan the QR code above',
                success: 'Login successful! Cookies saved.',
                timeout: 'Timed out. Refresh and try again.',
                error: 'Error: ' + (data.error || 'unknown'),
              };
              statusEl.textContent = msgs[data.status] || data.status;
              if (data.status === 'success') { statusEl.className='status success'; qrEl.style.display='none'; }
              else if (data.status === 'timeout' || data.status === 'error') { statusEl.className='status error'; }
              else { setTimeout(poll, data.status==='starting' ? 1500 : 2000); }
            })
            .catch(function(){ setTimeout(poll, 3000); });
        }
        window.onload = function(){ setTimeout(poll, 800); };
      </script>
    </head>
    <body>
      <h2>XHS Login</h2>
      <p>Logging in: <strong>${phone}</strong></p>
      <img id="qr" alt="QR Code" />
      <p class="status" id="status">Starting browser on Render...</p>
      <p class="hint">Keep this page open. It auto-updates until login completes.</p>
      <a class="back" href="/accounts${token ? '?token=' + encodeURIComponent(token) : ''}">Back to accounts</a>
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
      ? '<span style="color:green">Active</span>'
      : '<span style="color:orange">Needs login</span>';
    const loginUrl = `/login?phone=${encodeURIComponent(String(a.phone))}${token ? "&token=" + encodeURIComponent(token) : ""}`;
    const lastPost = a.last_post_at ? new Date(String(a.last_post_at)).toLocaleString() : "Never";
    return `<tr>
      <td>${a.phone}</td><td>${a.active ? "Yes" : "No"}</td><td>${a.banned ? "Banned" : "OK"}</td>
      <td>${a.shadowbanned ? "Shadowbanned" : "OK"}</td><td>${lastPost}</td>
      <td>${a.posts_today}</td><td>${sessionStatus}</td>
      <td><a href="${loginUrl}">Login / Refresh</a></td>
    </tr>`;
  }).join("");

  res.send(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body{font-family:sans-serif;padding:20px;background:#f9f9f9}h2{color:#e94560}
      table{width:100%;border-collapse:collapse;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
      th{background:#1a1a2e;color:white;padding:10px 8px;text-align:left;font-size:13px}
      td{padding:10px 8px;border-bottom:1px solid #eee;font-size:14px}a{color:#6c63ff}
      .add-btn{display:inline-block;margin-top:16px;padding:12px 24px;background:#e94560;color:white;text-decoration:none;border-radius:8px;font-size:16px}
    </style></head><body>
      <h2>XHS Accounts</h2>
      <table><tr><th>Phone</th><th>Active</th><th>Banned</th><th>Shadowbanned</th><th>Last Post</th><th>Posts Today</th><th>Session</th><th>Action</th></tr>
      ${rows || '<tr><td colspan="8" style="text-align:center;color:#999">No accounts yet</td></tr>'}
      </table>
      <a class="add-btn" href="/login${tokenQuery}">+ Add / Re-login Account</a>
    </body></html>`);
});

app.get("/", function(_req, res) {
  res.send(`<html><body style="font-family:sans-serif;padding:32px;text-align:center">
    <h2>XHS Login Helper is running</h2><p><a href="/accounts">View Accounts</a></p>
  </body></html>`);
});

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, "0.0.0.0", function() {
  console.log("XHS login helper running on port " + PORT);
  console.log("Chromium path:", chromium.executablePath());
});