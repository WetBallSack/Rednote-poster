// xhs-poster/index.ts
// Uses Playwright to automate 小红书 posting
// IMPORTANT: Run on a Chinese IP or VPN for best results
//
// Setup:
// npm install playwright @supabase/supabase-js sharp canvas
// npx playwright install chromium
// npx ts-node index.ts

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import { createCanvas } from "canvas";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Image Generation ──────────────────────────────────────────
// Generates simple but clean carousel images from slide text
// No external image API needed — pure canvas

interface Slide {
  slide: number;
  type: "cover" | "content" | "cta";
  heading: string;
  subtext?: string;
  body?: string;
  image_prompt?: string;
}

const THEMES = [
  { bg: "#1a1a2e", accent: "#e94560", text: "#ffffff", sub: "#a8a8b3" },
  { bg: "#0f3460", accent: "#e94560", text: "#ffffff", sub: "#a8d8ea" },
  { bg: "#16213e", accent: "#0f3460", text: "#ffffff", sub: "#a8a8b3" },
  { bg: "#f5f0e8", accent: "#d4a853", text: "#2c2c2c", sub: "#666666" },
  { bg: "#f8f9fa", accent: "#6c63ff", text: "#2c2c2c", sub: "#666666" },
];

function wrapText(ctx: ReturnType<typeof createCanvas>['getContext'], text: string, maxWidth: number): string[] {
  const words = text.split("");
  const lines: string[] = [];
  let currentLine = "";

  for (const char of words) {
    const testLine = currentLine + char;
    const metrics = (ctx as CanvasRenderingContext2D).measureText(testLine);
    if (metrics.width > maxWidth && currentLine !== "") {
      lines.push(currentLine);
      currentLine = char;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

async function generateSlideImage(slide: Slide, themeIndex: number): Promise<Buffer> {
  const WIDTH = 1080;
  const HEIGHT = 1350; // XHS standard 4:5 ratio
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  const theme = THEMES[themeIndex % THEMES.length];

  // Background
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Decorative element (top-right corner accent)
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.arc(WIDTH + 100, -100, 380, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.arc(WIDTH + 50, -50, 250, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Slide number indicator
  ctx.fillStyle = theme.accent;
  ctx.font = "bold 28px sans-serif";
  ctx.fillText(`${slide.slide} / 5`, 80, 100);

  // Heading
  ctx.fillStyle = theme.text;
  const headingSize = slide.type === "cover" ? 72 : 58;
  ctx.font = `bold ${headingSize}px sans-serif`;
  const headingLines = wrapText(ctx as any, slide.heading, WIDTH - 160);
  headingLines.forEach((line, i) => {
    const y = slide.type === "cover" ? 520 + i * (headingSize * 1.3) : 280 + i * (headingSize * 1.3);
    ctx.fillText(line, 80, y);
  });

  // Subtext (cover only)
  if (slide.type === "cover" && slide.subtext) {
    const subY = 520 + headingLines.length * (headingSize * 1.3) + 40;
    ctx.fillStyle = theme.sub;
    ctx.font = "36px sans-serif";
    const subLines = wrapText(ctx as any, slide.subtext, WIDTH - 160);
    subLines.forEach((line, i) => {
      ctx.fillText(line, 80, subY + i * 50);
    });
  }

  // Body text (content/cta slides)
  if (slide.body && slide.type !== "cover") {
    const bodyY = 280 + headingLines.length * (headingSize * 1.3) + 80;
    ctx.fillStyle = theme.sub;
    ctx.font = "38px sans-serif";
    const bodyLines = wrapText(ctx as any, slide.body, WIDTH - 160);
    bodyLines.forEach((line, i) => {
      ctx.fillText(line, 80, bodyY + i * 58);
    });
  }

  // Bottom accent bar
  ctx.fillStyle = theme.accent;
  ctx.fillRect(0, HEIGHT - 8, WIDTH, 8);

  // Bottom branding text
  ctx.fillStyle = theme.sub;
  ctx.font = "26px sans-serif";
  ctx.fillText("理财学习笔记", 80, HEIGHT - 40);

  return canvas.toBuffer("image/jpeg", { quality: 0.92 });
}

async function generateCarouselImages(slides: Slide[], postId: string): Promise<string[]> {
  const themeIndex = Math.floor(Math.random() * THEMES.length);
  const imagePaths: string[] = [];
  const tmpDir = `/tmp/xhs_${postId}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  for (const slide of slides) {
    const buffer = await generateSlideImage(slide, themeIndex);
    const imagePath = path.join(tmpDir, `slide_${slide.slide}.jpg`);
    fs.writeFileSync(imagePath, buffer);
    imagePaths.push(imagePath);
  }

  return imagePaths;
}

// ── XHS Session Management ────────────────────────────────────

async function loadXHSSession(context: BrowserContext, cookieJson: string) {
  const cookies = JSON.parse(cookieJson);
  await context.addCookies(cookies);
}

async function saveXHSSession(context: BrowserContext, accountPhone: string) {
  const cookies = await context.cookies();
  await supabase
    .from("xhs_accounts")
    .update({ cookie_json: JSON.stringify(cookies) })
    .eq("phone", accountPhone);
}

async function loginXHS(page: Page, phone: string): Promise<boolean> {
  await page.goto("https://www.xiaohongshu.com", { waitUntil: "networkidle" });

  // Check if already logged in
  const isLoggedIn = await page.$('[data-testid="user-avatar"]') !== null;
  if (isLoggedIn) return true;

  console.log("Not logged in — attempting login...");
  // Click login button
  const loginBtn = await page.$("text=登录");
  if (!loginBtn) return false;
  await loginBtn.click();

  // Wait for QR code or phone login modal
  // Note: XHS often requires manual QR scan — we handle this by using saved cookies
  console.warn("⚠️ Manual login required. Please scan QR code within 60 seconds.");
  try {
    await page.waitForSelector('[data-testid="user-avatar"]', { timeout: 60000 });
    console.log("✅ Login successful");
    return true;
  } catch {
    console.error("Login timeout");
    return false;
  }
}

// ── XHS Post Submission ───────────────────────────────────────

async function postToXHS(
  page: Page,
  post: {
    id: string;
    title: string;
    body: string;
    hashtags: string[];
    carousel_slides: Slide[];
    xhs_topic_tags: string[];
  }
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    // Navigate to creator center
    await page.goto("https://creator.xiaohongshu.com/publish/publish", {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    // Wait for upload button
    await page.waitForSelector('input[type="file"]', { timeout: 15000 });

    // Generate carousel images
    console.log("Generating carousel images...");
    const imagePaths = await generateCarouselImages(post.carousel_slides, post.id);
    console.log(`Generated ${imagePaths.length} slide images`);

    // Upload images
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(imagePaths);

    // Wait for images to upload
    await page.waitForTimeout(3000 + Math.random() * 2000);

    // Fill title
    const titleInput = page.locator('input[placeholder*="标题"], input[placeholder*="title"]').first();
    if (await titleInput.isVisible()) {
      await titleInput.click();
      await titleInput.fill(post.title);
    }

    // Fill body/description
    const bodyInput = page.locator(
      'textarea[placeholder*="描述"], div[contenteditable="true"][class*="ql-editor"], .editor-container'
    ).first();
    await bodyInput.click();
    await bodyInput.fill(post.body);

    // Add hashtags
    await page.waitForTimeout(500);
    for (const tag of post.hashtags.slice(0, 5)) {
      await bodyInput.type(`#${tag} `);
      await page.waitForTimeout(300);
    }

    // Add topic tags if available
    const topicBtn = page.locator('text=添加话题, text=话题').first();
    if (await topicBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await topicBtn.click();
      for (const tag of post.xhs_topic_tags.slice(0, 2)) {
        const tagInput = page.locator('input[placeholder*="搜索话题"]').first();
        await tagInput.fill(tag);
        await page.waitForTimeout(1000);
        const firstResult = page.locator('.topic-item, [class*="topicItem"]').first();
        if (await firstResult.isVisible({ timeout: 2000 }).catch(() => false)) {
          await firstResult.click();
        }
      }
    }

    // Human-like delay before submitting
    await page.waitForTimeout(2000 + Math.random() * 3000);

    // Click publish
    const publishBtn = page.locator('button:has-text("发布"), button:has-text("Publish")').first();
    await publishBtn.click();

    // Wait for success
    await page.waitForURL(/\/publish\/success|\/note\//, { timeout: 15000 });
    const url = page.url();

    // Clean up temp images
    imagePaths.forEach((p) => fs.unlinkSync(p));

    return { success: true, url };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] XHS poster starting...`);

  // 1. Get ready XHS post
  const { data: posts } = await supabase
    .from("posts")
    .select("*")
    .eq("platform", "xhs")
    .eq("status", "ready")
    .order("created_at")
    .limit(1);

  if (!posts?.length) { console.log("No XHS posts ready"); return; }
  const post = posts[0];

  // 2. Get available XHS account
  const { data: accounts } = await supabase
    .from("xhs_accounts")
    .select("*")
    .eq("active", true)
    .eq("banned", false)
    .eq("shadowbanned", false)
    .lt("posts_today", 2)
    .order("last_post_at", { ascending: true, nullsFirst: true })
    .limit(1);

  if (!accounts?.length) { console.log("No available XHS accounts"); return; }
  const account = accounts[0];

  // 3. Launch browser
  const browser: Browser = await chromium.launch({
    headless: process.env.NODE_ENV === "production",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--lang=zh-CN",
    ],
  });

  const context = await browser.newContext({
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  // Load saved session if available
  if (account.cookie_json) {
    await loadXHSSession(context, account.cookie_json);
  }

  const page = await context.newPage();

  // Stealth: remove webdriver property
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    (window as any).chrome = { runtime: {} };
  });

  try {
    // 4. Login / verify session
    const loggedIn = await loginXHS(page, account.phone);
    if (!loggedIn) {
      console.error("Could not log in to XHS");
      await browser.close();
      return;
    }

    // Save fresh session
    await saveXHSSession(context, account.phone);

    // 5. Mark post as publishing
    await supabase.from("posts").update({ status: "publishing" }).eq("id", post.id);

    // 6. Post
    const result = await postToXHS(page, {
      id: post.id,
      title: post.title,
      body: post.body,
      hashtags: post.hashtags ?? [],
      carousel_slides: post.carousel_slides ?? [],
      xhs_topic_tags: post.xhs_topic_tags ?? [],
    });

    if (result.success) {
      await supabase.from("posts").update({
        status: "published",
        platform_url: result.url,
        published_at: new Date().toISOString(),
      }).eq("id", post.id);

      await supabase.from("xhs_accounts").update({
        last_post_at: new Date().toISOString(),
        posts_today: account.posts_today + 1,
      }).eq("id", account.id);

      await supabase.from("analytics").insert({
        post_id: post.id,
        platform: "xhs",
      });

      console.log(`✅ Posted to XHS: ${result.url}`);
    } else {
      const isBanned = result.error?.includes("违规") || result.error?.includes("封禁");
      await supabase.from("posts").update({
        status: isBanned ? "banned" : "failed",
        failure_reason: result.error,
        retry_count: (post.retry_count ?? 0) + 1,
      }).eq("id", post.id);

      if (isBanned) {
        await supabase.from("xhs_accounts").update({ banned: true }).eq("id", account.id);
        console.warn(`⚠️ Account ${account.phone} banned`);
      } else {
        console.error(`❌ Post failed: ${result.error}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
