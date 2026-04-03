// supabase/functions/cron-generator/index.ts
// Deploy with: supabase functions deploy cron-generator
// Schedule via Supabase Dashboard > Edge Functions > Schedules: every 8 hours
//
// This function:
// 1. Picks an unused topic
// 2. Generates platform-appropriate content via Groq API
// 3. Applies banned word substitutions (xhs)
// 4. Stores posts in Supabase with status 'ready'
// 5. Triggers the poster functions
//
// Groq model options (pick one):
//   "llama-3.3-70b-versatile"   ← best quality, recommended
//   "llama-3.1-8b-instant"      ← fastest, use if hitting rate limits
//   "mixtral-8x7b-32768"        ← good for long-form content
//
// Secret already configured in Supabase: GROQ_API_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY")!;
const GROQ_MODEL = "llama-3.3-70b-versatile"; // swap to "llama-3.1-8b-instant" if rate limited

// ── Helpers ──────────────────────────────────────────────────

async function callGroq(systemPrompt: string, userPrompt: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 2000,
      temperature: 0.8,      // slightly creative for varied posts
      response_format: { type: "json_object" }, // Groq supports JSON mode — no more regex cleaning!
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Groq API error: ${JSON.stringify(data)}`);
  return data.choices[0].message.content;
}

function applyBannedWordSubstitutions(
  text: string,
  bannedWords: { word: string; replacement: string }[]
): { cleaned: string; log: { word: string; replacement: string; count: number }[] } {
  let cleaned = text;
  const log: { word: string; replacement: string; count: number }[] = [];

  for (const { word, replacement } of bannedWords) {
    const regex = new RegExp(word, "gi");
    const matches = cleaned.match(regex);
    if (matches && matches.length > 0) {
      cleaned = cleaned.replace(regex, replacement);
      log.push({ word, replacement, count: matches.length });
    }
  }
  return { cleaned, log };
}

// ── Reddit Post Generator ─────────────────────────────────────

async function generateRedditPost(
  topic: { title: string; description: string },
  config: { system_prompt: string; settings: Record<string, unknown> },
  referralNote: string
) {
  const subreddits = (config.settings.subreddits as string[]) ?? ["CryptoCurrency"];
  const subreddit = subreddits[Math.floor(Math.random() * subreddits.length)];

  const userPrompt = `
Topic: ${topic.title}
Context: ${topic.description}
Target subreddit: r/${subreddit}

Write a Reddit post for this topic. At the very end, naturally mention: "${referralNote}"

Return ONLY valid JSON in this exact format:
{
  "title": "post title here",
  "body": "full post body with markdown",
  "hashtags": [],
  "subreddit": "${subreddit}"
}`;

  // Groq returns clean JSON via json_object mode — parse directly
  const raw = await callGroq(config.system_prompt, userPrompt);
  return JSON.parse(raw);
}

// ── XHS Carousel Generator ────────────────────────────────────

async function generateXHSPost(
  topic: { title: string; description: string },
  config: { system_prompt: string; settings: Record<string, unknown>; banned_words: { word: string; replacement: string }[] },
  referralNote: string
) {
  const userPrompt = `
主题：${topic.title}
背景：${topic.description}
在最后一页自然地提到："${referralNote}"

返回严格的JSON格式，不要有其他内容：
{
  "title": "封面标题（15字以内，有吸引力）",
  "body": "帖子的完整文字内容（用于搜索索引）",
  "hashtags": ["标签1", "标签2", "标签3", "标签4", "标签5"],
  "carousel_slides": [
    {
      "slide": 1,
      "type": "cover",
      "heading": "封面大标题",
      "subtext": "副标题或钩子语句",
      "image_prompt": "minimal infographic style: [describe what to show]"
    },
    {
      "slide": 2,
      "type": "content",
      "heading": "第二页标题",
      "body": "正文内容50-80字",
      "image_prompt": "minimal infographic style: [describe]"
    },
    {
      "slide": 3,
      "type": "content",
      "heading": "第三页标题",
      "body": "正文内容50-80字",
      "image_prompt": "minimal infographic style: [describe]"
    },
    {
      "slide": 4,
      "type": "content",
      "heading": "第四页标题",
      "body": "正文内容50-80字",
      "image_prompt": "minimal infographic style: [describe]"
    },
    {
      "slide": 5,
      "type": "cta",
      "heading": "总结",
      "body": "总结+行动号召，自然提到平台福利",
      "image_prompt": "minimal infographic style: summary visual"
    }
  ],
  "xhs_topic_tags": ["数字资产", "海外理财", "理财笔记"]
}`;

  // Groq returns clean JSON via json_object mode — parse directly
  const raw = await callGroq(config.system_prompt, userPrompt);
  const parsed = JSON.parse(raw);

  // Apply banned word substitutions
  const originalBody = parsed.body;
  const { cleaned: cleanedBody, log: bodyLog } = applyBannedWordSubstitutions(
    parsed.body,
    config.banned_words
  );

  // Also clean slide content
  for (const slide of parsed.carousel_slides) {
    if (slide.body) {
      const { cleaned: cb } = applyBannedWordSubstitutions(slide.body, config.banned_words);
      slide.body = cb;
    }
    if (slide.heading) {
      const { cleaned: ch } = applyBannedWordSubstitutions(slide.heading, config.banned_words);
      slide.heading = ch;
    }
  }

  return {
    ...parsed,
    body: cleanedBody,
    original_body: originalBody,
    substitutions_applied: bodyLog,
  };
}

// ── Main Handler ──────────────────────────────────────────────

Deno.serve(async (_req) => {
  const startTime = Date.now();
  const errors: string[] = [];
  let postsGenerated = 0;

  try {
    // 1. Get enabled platform configs
    const { data: configs, error: cfgErr } = await supabase
      .from("platform_config")
      .select("*")
      .eq("enabled", true);
    if (cfgErr) throw cfgErr;

    // 2. Get an unused topic
    const { data: topics, error: topicErr } = await supabase
      .from("topics")
      .select("*")
      .eq("used", false)
      .order("created_at")
      .limit(3);
    if (topicErr) throw topicErr;
    if (!topics?.length) {
      return new Response(JSON.stringify({ message: "No unused topics available" }), { status: 200 });
    }

    const REFERRAL_NOTE_EN = "If you're looking for where to start, the exchange I use has a sign-up bonus right now — happy to share the link in the comments.";
    const REFERRAL_NOTE_ZH = "我用的那个平台最近新用户有开户福利，感兴趣可以评论区找我要链接～";

    // 3. Generate posts for each platform
    for (const config of configs ?? []) {
      const topic = topics[Math.floor(Math.random() * topics.length)];

      // Check daily post limit
      const today = new Date().toISOString().split("T")[0];
      const { count } = await supabase
        .from("posts")
        .select("*", { count: "exact", head: true })
        .eq("platform", config.platform)
        .gte("created_at", `${today}T00:00:00Z`);

      if ((count ?? 0) >= config.daily_post_limit) {
        console.log(`Daily limit reached for ${config.platform}`);
        continue;
      }

      try {
        let postData;
        if (config.platform === "reddit") {
          postData = await generateRedditPost(topic, config, REFERRAL_NOTE_EN);
        } else if (config.platform === "xhs") {
          postData = await generateXHSPost(topic, config, REFERRAL_NOTE_ZH);
        } else {
          continue;
        }

        // 4. Insert post
        const { error: insertErr } = await supabase.from("posts").insert({
          topic_id: topic.id,
          platform: config.platform,
          title: postData.title,
          body: postData.body,
          hashtags: postData.hashtags ?? [],
          carousel_slides: postData.carousel_slides ?? null,
          subreddit: postData.subreddit ?? null,
          xhs_topic_tags: postData.xhs_topic_tags ?? null,
          original_body: postData.original_body ?? null,
          substitutions_applied: postData.substitutions_applied ?? null,
          status: "ready",
        });
        if (insertErr) throw insertErr;
        postsGenerated++;
      } catch (platformErr) {
        const msg = `Failed to generate ${config.platform} post: ${platformErr.message}`;
        console.error(msg);
        errors.push(msg);
      }
    }

    // 5. Mark topic as used if we generated posts
    if (postsGenerated > 0) {
      const usedTopicId = topics[0].id;
      await supabase
        .from("topics")
        .update({ used: true, used_at: new Date().toISOString() })
        .eq("id", usedTopicId);
    }

    // 6. Log the run
    await supabase.from("cron_logs").insert({
      platform: "all",
      topic_used: topics[0]?.title,
      posts_generated: postsGenerated,
      errors,
      duration_ms: Date.now() - startTime,
    });

    return new Response(
      JSON.stringify({ success: true, postsGenerated, errors }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Cron generator fatal error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
