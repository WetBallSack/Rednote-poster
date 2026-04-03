// reddit-poster/index.ts
// Runs as a separate scheduled job (every 8 hours, offset from generator)
// Deploy on Railway / Fly.io / any Node host
//
// Setup:
// 1. Create a Reddit app at https://www.reddit.com/prefs/apps (choose "script")
// 2. Add credentials to .env
// 3. Run: npm install && npx ts-node index.ts

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ── Reddit OAuth ──────────────────────────────────────────────

interface RedditTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function getRedditToken(account: {
  username: string;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}): Promise<string> {
  // If token is still valid (with 5min buffer), use it
  if (
    account.access_token &&
    account.token_expires_at &&
    new Date(account.token_expires_at).getTime() > Date.now() + 300_000
  ) {
    return account.access_token;
  }

  // Refresh the token
  if (account.refresh_token) {
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
        ).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": process.env.REDDIT_USER_AGENT!,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: account.refresh_token,
      }),
    });

    const data: RedditTokens = await res.json();
    if (!res.ok) throw new Error(`Reddit token refresh failed: ${JSON.stringify(data)}`);

    // Update tokens in DB
    await supabase
      .from("reddit_accounts")
      .update({
        access_token: data.access_token,
        token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
      })
      .eq("username", account.username);

    return data.access_token;
  }

  // First-time auth: use password grant (for script type apps)
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
      ).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": process.env.REDDIT_USER_AGENT!,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: account.username,
      password: process.env[`REDDIT_PASSWORD_${account.username.toUpperCase()}`] ?? "",
    }),
  });

  const data: RedditTokens = await res.json();
  if (!res.ok) throw new Error(`Reddit auth failed: ${JSON.stringify(data)}`);

  await supabase
    .from("reddit_accounts")
    .update({
      access_token: data.access_token,
      token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    })
    .eq("username", account.username);

  return data.access_token;
}

async function submitRedditPost(
  token: string,
  subreddit: string,
  title: string,
  body: string
): Promise<{ id: string; url: string }> {
  // Add random delay to look human (2–8 seconds)
  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 6000));

  const res = await fetch("https://oauth.reddit.com/api/submit", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": process.env.REDDIT_USER_AGENT!,
    },
    body: new URLSearchParams({
      sr: subreddit,
      kind: "self",
      title,
      text: body,
      nsfw: "false",
      spoiler: "false",
      resubmit: "true",
    }),
  });

  const data = await res.json();
  if (!res.ok || data.json?.errors?.length) {
    throw new Error(`Reddit submit failed: ${JSON.stringify(data.json?.errors ?? data)}`);
  }

  const postData = data.json?.data;
  return {
    id: postData.id,
    url: `https://reddit.com${postData.url}`,
  };
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log(`[${new Date().toISOString()}] Reddit poster starting...`);

  // 1. Get a ready post
  const { data: posts, error } = await supabase
    .from("posts")
    .select("*")
    .eq("platform", "reddit")
    .eq("status", "ready")
    .order("created_at")
    .limit(1);

  if (error) { console.error("DB error:", error); process.exit(1); }
  if (!posts?.length) { console.log("No Reddit posts ready to publish"); return; }

  const post = posts[0];

  // 2. Get an available Reddit account (not banned, under daily limit)
  const { data: accounts } = await supabase
    .from("reddit_accounts")
    .select("*")
    .eq("active", true)
    .eq("banned", false)
    .lt("posts_today", 3) // max 3 posts per account per day
    .order("last_post_at", { ascending: true, nullsFirst: true })
    .limit(1);

  if (!accounts?.length) {
    console.log("No available Reddit accounts");
    return;
  }

  const account = accounts[0];

  // 3. Mark post as publishing
  await supabase.from("posts").update({ status: "publishing" }).eq("id", post.id);

  try {
    // 4. Get auth token
    const token = await getRedditToken(account);

    // 5. Submit the post
    const result = await submitRedditPost(
      token,
      post.subreddit ?? "CryptoCurrency",
      post.title,
      post.body
    );

    // 6. Mark as published
    await supabase.from("posts").update({
      status: "published",
      platform_post_id: result.id,
      platform_url: result.url,
      published_at: new Date().toISOString(),
    }).eq("id", post.id);

    // 7. Update account post count
    await supabase.from("reddit_accounts").update({
      last_post_at: new Date().toISOString(),
      posts_today: account.posts_today + 1,
    }).eq("id", account.id);

    // 8. Create analytics row
    await supabase.from("analytics").insert({
      post_id: post.id,
      platform: "reddit",
      bitly_link: null, // TODO: generate Bitly link via API
    });

    console.log(`✅ Posted to r/${post.subreddit}: ${result.url}`);

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("❌ Reddit post failed:", message);

    const isBanned = message.includes("banned") || message.includes("SUBREDDIT_NOTALLOWED");

    await supabase.from("posts").update({
      status: isBanned ? "banned" : "failed",
      failure_reason: message,
      retry_count: (post.retry_count ?? 0) + 1,
    }).eq("id", post.id);

    if (isBanned) {
      console.warn(`⚠️ Account ${account.username} may be banned from r/${post.subreddit}`);
    }
  }
}

main().catch(console.error);
