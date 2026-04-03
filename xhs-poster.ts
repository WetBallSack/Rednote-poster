// supabase/functions/xhs-poster/index.ts
// Runs as a Supabase Edge Function — no Playwright, no VPS needed.
// Uses XHS internal web API with session cookies saved in DB.
//
// Deploy via Supabase Dashboard → Edge Functions → New Function → paste this file
// OR: supabase functions deploy xhs-poster
//
// Schedule: Supabase Dashboard → Edge Functions → xhs-poster → Schedules
// Cron: 0 4,16 * * *  (runs at 4am and 4pm UTC)
//
// Prerequisites:
//   - Supabase Storage bucket named "post-images" set to Public
//   - xhs_accounts table populated and cookies saved via xhs-login-helper on Render

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ── Image Generation ──────────────────────────────────────────
// Generates carousel slides as SVG, uploads to Supabase Storage.
// No native canvas bindings — pure SVG converted to PNG via resvg-js WASM.

interface Slide {
  slide: number;
  type: "cover" | "content" | "cta";
  heading: string;
  subtext?: string;
  body?: string;
}

const THEMES = [
  { bg: "#1a1a2e", accent: "#e94560", text: "#ffffff", sub: "#a8a8b3" },
  { bg: "#0f3460", accent: "#e94560", text: "#ffffff", sub: "#a8d8ea" },
  { bg: "#f5f0e8", accent: "#d4a853", text: "#2c2c2c", sub: "#666666" },
  { bg: "#f8f9fa", accent: "#6c63ff", text: "#2c2c2c", sub: "#666666" },
];

function wrapTextSVG(text: string, maxCharsPerLine = 18): string[] {
  const lines: string[] = [];
  for (let i = 0; i < text.length; i += maxCharsPerLine) {
    lines.push(text.slice(i, i + maxCharsPerLine));
  }
  return lines;
}

function generateSlideSVG(slide: Slide, themeIndex: number): string {
  const theme = THEMES[themeIndex % THEMES.length];
  const W = 1080;
  const H = 1350;
  const headingLines = wrapTextSVG(slide.heading, 16);
  const headingFontSize = slide.type === "cover" ? 72 : 58;
  const headingY = slide.type === "cover" ? 520 : 280;

  const headingElems = headingLines
    .map((line, i) =>
      `<text x="80" y="${headingY + i * headingFontSize * 1.3}" font-size="${headingFontSize}" font-weight="bold" fill="${theme.text}" font-family="sans-serif">${line}</text>`
    ).join("\n");

  const subtextElem = slide.type === "cover" && slide.subtext
    ? `<text x="80" y="${headingY + headingLines.length * headingFontSize * 1.3 + 60}" font-size="36" fill="${theme.sub}" font-family="sans-serif">${slide.subtext}</text>`
    : "";

  const bodyLines = slide.body ? wrapTextSVG(slide.body, 20) : [];
  const bodyY = headingY + headingLines.length * headingFontSize * 1.3 + 80;
  const bodyElems = bodyLines
    .map((line, i) =>
      `<text x="80" y="${bodyY + i * 58}" font-size="38" fill="${theme.sub}" font-family="sans-serif">${line}</text>`
    ).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="${theme.bg}"/>
    <circle cx="${W + 100}" cy="-100" r="380" fill="${theme.accent}"/>
    <circle cx="${W + 50}" cy="-50" r="250" fill="${theme.accent}" opacity="0.15"/>
    <text x="80" y="100" font-size="28" font-weight="bold" fill="${theme.accent}" font-family="sans-serif">${slide.slide} / 5</text>
    ${headingElems}
    ${subtextElem}
    ${bodyElems}
    <rect x="0" y="${H - 8}" width="${W}" height="8" fill="${theme.accent}"/>
    <text x="80" y="${H - 40}" font-size="26" fill="${theme.sub}" font-family="sans-serif">理财学习笔记</text>
  </svg>`;
}

async function svgToPng(svg: string): Promise<Uint8Array> {
  const { Resvg } = await import("npm:@resvg/resvg-js@2");
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1080 } });
  return resvg.render().asPng();
}

async function generateAndUploadCarousel(slides: Slide[], postId: string): Promise<string[]> {
  const themeIndex = Math.floor(Math.random() * THEMES.length);
  const uploadedUrls: string[] = [];

  for (const slide of slides) {
    const png = await svgToPng(generateSlideSVG(slide, themeIndex));
    const filePath = `xhs/${postId}/slide_${slide.slide}.png`;

    const { error } = await supabase.storage
      .from("post-images")
      .upload(filePath, png, { contentType: "image/png", upsert: true });

    if (error) throw new Error(`Storage upload failed: ${error.message}`);

    const { data: urlData } = supabase.storage.from("post-images").getPublicUrl(filePath);
    uploadedUrls.push(urlData.publicUrl);
  }

  return uploadedUrls;
}

// ── XHS API Client ─────────────────────────────────────────────
// Calls XHS creator web API directly using session cookies.
// Cookies are obtained via xhs-login-helper (Render) and stored in xhs_accounts.

interface XHSCookie { name: string; value: string; domain: string; }

function cookiesToHeader(cookieJson: string): string {
  const cookies: XHSCookie[] = JSON.parse(cookieJson);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function uploadImageToXHS(imageUrl: string, cookieHeader: string): Promise<string | null> {
  const imageResp = await fetch(imageUrl);
  const imageBlob = await imageResp.blob();

  const tokenResp = await fetch("https://creator.xiaohongshu.com/api/galaxy/upload/token", {
    headers: {
      Cookie: cookieHeader,
      Referer: "https://creator.xiaohongshu.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!tokenResp.ok) return null;
  const { data: { token, uploadUrl } } = await tokenResp.json();

  const formData = new FormData();
  formData.append("file", imageBlob, "slide.png");
  formData.append("token", token);

  const uploadResp = await fetch(uploadUrl, { method: "POST", body: formData });
  if (!uploadResp.ok) return null;
  const uploadData = await uploadResp.json();
  return uploadData.data?.fileId ?? null;
}

async function publishXHSPost(
  post: { id: string; title: string; body: string; hashtags: string[]; carousel_slides: Slide[]; xhs_topic_tags: string[] },
  cookieHeader: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const imageUrls = await generateAndUploadCarousel(post.carousel_slides, post.id);
    const fileIds: string[] = [];

    for (const url of imageUrls) {
      const fileId = await uploadImageToXHS(url, cookieHeader);
      if (!fileId) throw new Error("Image upload to XHS CDN failed");
      fileIds.push(fileId);
    }

    const hashtagStr = post.hashtags.slice(0, 5).map((t) => `#${t}`).join(" ");
    const description = `${post.body}\n\n${hashtagStr}`;

    const publishResp = await fetch("https://creator.xiaohongshu.com/api/sns/v1/note/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader,
        Referer: "https://creator.xiaohongshu.com/publish/publish",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-B3-TraceId": crypto.randomUUID().replace(/-/g, "").slice(0, 16),
      },
      body: JSON.stringify({
        common: {
          type: 1,
          title: post.title,
          note_id: "",
          ats: [],
          hash_tag: post.xhs_topic_tags.slice(0, 3).map((name) => ({ name })),
        },
        image_info: { images: fileIds.map((id, idx) => ({ file_id: id, index: idx })) },
        post_info: { desc: description, privacy_info: { op_type: 0 } },
      }),
    });

    if (!publishResp.ok) {
      const err = await publishResp.text();
      return { success: false, error: `XHS API error ${publishResp.status}: ${err}` };
    }

    const data = await publishResp.json();
    if (data.code !== 0) return { success: false, error: `XHS error code ${data.code}: ${data.msg}` };

    const noteId = data.data?.note_id;
    return { success: true, url: noteId ? `https://www.xiaohongshu.com/explore/${noteId}` : undefined };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Main Handler ───────────────────────────────────────────────

Deno.serve(async () => {
  console.log(`[${new Date().toISOString()}] XHS poster Edge Function starting...`);

  const { data: posts } = await supabase
    .from("posts").select("*").eq("platform", "xhs").eq("status", "ready")
    .order("created_at").limit(1);

  if (!posts?.length) {
    return new Response(JSON.stringify({ message: "No XHS posts ready" }), { status: 200 });
  }
  const post = posts[0];

  const { data: accounts } = await supabase
    .from("xhs_accounts").select("*")
    .eq("active", true).eq("banned", false).eq("shadowbanned", false)
    .lt("posts_today", 2).not("cookie_json", "is", null)
    .order("last_post_at", { ascending: true, nullsFirst: true }).limit(1);

  if (!accounts?.length) {
    return new Response(
      JSON.stringify({ message: "No XHS accounts with valid sessions. Visit your Render login helper to re-authenticate." }),
      { status: 200 }
    );
  }
  const account = accounts[0];

  await supabase.from("posts").update({ status: "publishing" }).eq("id", post.id);

  const result = await publishXHSPost(
    {
      id: post.id, title: post.title, body: post.body,
      hashtags: post.hashtags ?? [], carousel_slides: post.carousel_slides ?? [],
      xhs_topic_tags: post.xhs_topic_tags ?? [],
    },
    cookiesToHeader(account.cookie_json)
  );

  if (result.success) {
    await supabase.from("posts").update({
      status: "published", platform_url: result.url,
      published_at: new Date().toISOString(),
    }).eq("id", post.id);

    await supabase.from("xhs_accounts").update({
      last_post_at: new Date().toISOString(),
      posts_today: account.posts_today + 1,
    }).eq("id", account.id);

    await supabase.from("analytics").insert({ post_id: post.id, platform: "xhs" });
    console.log(`Posted to XHS: ${result.url}`);
    return new Response(JSON.stringify({ success: true, url: result.url }), { status: 200 });
  } else {
    const isBanned = result.error?.includes("违规") || result.error?.includes("封禁");
    await supabase.from("posts").update({
      status: isBanned ? "banned" : "failed",
      failure_reason: result.error,
      retry_count: (post.retry_count ?? 0) + 1,
    }).eq("id", post.id);

    if (isBanned) await supabase.from("xhs_accounts").update({ banned: true }).eq("id", account.id);
    return new Response(JSON.stringify({ success: false, error: result.error }), { status: 200 });
  }
});