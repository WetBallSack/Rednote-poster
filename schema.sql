-- ============================================================
-- KOL Automation Schema
-- Paste this entire file into Supabase SQL Editor and Run
-- ============================================================

-- Enable pg_cron and pg_net extensions (needed for scheduling + HTTP calls)
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists "uuid-ossp";

-- ============================================================
-- PLATFORM CONFIG
-- Stores per-platform settings, prompts, banned words
-- ============================================================
create table platform_config (
  id uuid primary key default uuid_generate_v4(),
  platform text not null unique, -- 'reddit' | 'xhs'
  enabled boolean default true,
  post_interval_hours int default 8,
  daily_post_limit int default 3,
  system_prompt text not null,
  banned_words jsonb default '[]', -- [{"word": "...", "replacement": "..."}]
  settings jsonb default '{}', -- platform-specific settings
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- TOPICS
-- Input queue of trending crypto topics to write about
-- ============================================================
create table topics (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  description text,
  source text, -- 'manual' | 'coingecko' | 'rss' | 'auto'
  used boolean default false,
  used_at timestamptz,
  created_at timestamptz default now()
);

-- ============================================================
-- POSTS
-- All generated posts with full lifecycle tracking
-- ============================================================
create table posts (
  id uuid primary key default uuid_generate_v4(),
  topic_id uuid references topics(id),
  platform text not null, -- 'reddit' | 'xhs'

  -- Content
  title text,
  body text not null,
  hashtags text[],
  carousel_slides jsonb, -- for xhs: [{slide: 1, text: "...", image_prompt: "..."}, ...]
  image_urls text[], -- stored in supabase storage after generation

  -- Targeting
  subreddit text, -- reddit only
  xhs_topic_tags text[], -- xhs only

  -- Banned word audit (xhs)
  original_body text, -- pre-substitution version
  substitutions_applied jsonb, -- log of what was swapped

  -- Status lifecycle
  status text not null default 'queued',
  -- queued → generating → ready → publishing → published | failed | banned

  -- Publishing results
  platform_post_id text, -- reddit post id or xhs post id
  platform_url text,
  published_at timestamptz,
  failure_reason text,
  retry_count int default 0,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- ANALYTICS
-- Click and conversion tracking per post
-- ============================================================
create table analytics (
  id uuid primary key default uuid_generate_v4(),
  post_id uuid references posts(id),
  platform text not null,
  bitly_link text,
  clicks int default 0,
  signups int default 0, -- estimated from Binance dashboard
  commission_usd numeric(10,2) default 0,
  last_synced_at timestamptz,
  created_at timestamptz default now()
);

-- ============================================================
-- CRON LOGS
-- Every cron run is logged for debugging
-- ============================================================
create table cron_logs (
  id uuid primary key default uuid_generate_v4(),
  run_at timestamptz default now(),
  platform text,
  topic_used text,
  posts_generated int default 0,
  posts_published int default 0,
  errors text[],
  duration_ms int
);

-- ============================================================
-- REDDIT ACCOUNTS
-- Store multiple Reddit accounts for rotation
-- ============================================================
create table reddit_accounts (
  id uuid primary key default uuid_generate_v4(),
  username text not null unique,
  -- OAuth tokens (encrypted at app level before storing)
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  -- Health tracking
  active boolean default true,
  last_post_at timestamptz,
  posts_today int default 0,
  karma int default 0,
  banned boolean default false,
  created_at timestamptz default now()
);

-- ============================================================
-- XHS ACCOUNTS
-- Store multiple 小红书 accounts for rotation
-- ============================================================
create table xhs_accounts (
  id uuid primary key default uuid_generate_v4(),
  phone text not null unique,
  cookie_json text, -- playwright session cookies (encrypted)
  active boolean default true,
  last_post_at timestamptz,
  posts_today int default 0,
  shadowbanned boolean default false,
  banned boolean default false,
  created_at timestamptz default now()
);

-- ============================================================
-- INDEXES
-- ============================================================
create index idx_posts_status on posts(status);
create index idx_posts_platform on posts(platform);
create index idx_posts_created on posts(created_at desc);
create index idx_topics_unused on topics(used) where used = false;
create index idx_analytics_post on analytics(post_id);

-- ============================================================
-- UPDATED AT TRIGGERS
-- ============================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger posts_updated_at before update on posts
  for each row execute function set_updated_at();

create trigger platform_config_updated_at before update on platform_config
  for each row execute function set_updated_at();

-- ============================================================
-- DAILY RESET: posts_today counter (runs at midnight UTC)
-- ============================================================
select cron.schedule(
  'reset-daily-post-counts',
  '0 0 * * *',
  $$
    update reddit_accounts set posts_today = 0;
    update xhs_accounts set posts_today = 0;
  $$
);

-- ============================================================
-- SEED: Platform configs with prompts + banned word lists
-- ============================================================
insert into platform_config (platform, post_interval_hours, daily_post_limit, system_prompt, banned_words, settings)
values (
  'reddit',
  8,
  3,
  'You are a helpful crypto enthusiast sharing genuine personal experience on Reddit. Write in a casual, authentic first-person voice. NEVER sound like an ad. Format: title (max 100 chars) then body. Include a subtle mention that you use a particular exchange and it has a sign-up bonus — but keep it natural, 1 sentence max at the END. Use markdown formatting. No emojis. Write 250-400 words.',
  '[]'::jsonb,
  '{"subreddits": ["CryptoCurrency", "CryptoBeginners", "BitcoinBeginners", "binance"], "post_types": ["tutorial", "personal_story", "question_answered"]}'::jsonb
),
(
  'xhs',
  12,
  2,
  '你是一位分享海外理财学习笔记的年轻人。用小红书的风格写作：口语化、真实、有温度。绝对不能使用任何被审查的词汇。内容要以"学习记录"或"理财笔记"的形式呈现。在文末可以提到"我用的那个平台"有开户福利，但要极其自然，不能像广告。生成轮播图格式：第一页是封面（标题+钩子），第2-5页是内容，最后一页是总结+行动号召。每页50-80字。',
  '[
    {"word": "币安", "replacement": "B平台"},
    {"word": "Binance", "replacement": "那个平台"},
    {"word": "加密货币", "replacement": "数字资产"},
    {"word": "cryptocurrency", "replacement": "新型资产"},
    {"word": "交易所", "replacement": "平台"},
    {"word": "exchange", "replacement": "工具"},
    {"word": "注册", "replacement": "开户"},
    {"word": "推广链接", "replacement": "学习资源"},
    {"word": "返佣", "replacement": "福利"},
    {"word": "比特币", "replacement": "BTC"},
    {"word": "Bitcoin", "replacement": "数字黄金"},
    {"word": "以太坊", "replacement": "ETH"},
    {"word": "炒币", "replacement": "配置数字资产"},
    {"word": "韭菜", "replacement": "新手"},
    {"word": "暴富", "replacement": "资产增值"},
    {"word": "合约", "replacement": "衍生品"},
    {"word": "杠杆", "replacement": "放大工具"}
  ]'::jsonb,
  '{"image_style": "minimal_infographic", "cover_template": "gradient_text"}'::jsonb
);

-- ============================================================
-- SEED: Starter topics
-- ============================================================
insert into topics (title, description, source) values
('How to earn passive income with crypto in 2025', 'Focus on staking, savings products, and yield', 'manual'),
('Beginner''s guide to buying your first crypto safely', 'Step by step, focusing on safety and avoiding scams', 'manual'),
('Why I moved from a bank savings account to crypto savings', 'Personal story angle, compare APY rates', 'manual'),
('Understanding crypto fees and how to minimize them', 'Compare maker/taker fees, withdrawal fees', 'manual'),
('How to dollar-cost average into crypto automatically', 'DCA strategy explanation for beginners', 'manual'),
('新手如何开始海外理财', '从零开始的数字资产学习记录', 'manual'),
('我是如何每个月稳定获得理财收益的', '分享我的被动收入策略', 'manual'),
('海外打工人的理财笔记：数字资产入门', '针对海外华人的理财内容', 'manual');
