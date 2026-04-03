import { useState, useEffect, useCallback } from "react";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── CONFIG — replace these ────────────────────────────────────
const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";
// ─────────────────────────────────────────────────────────────

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const STATUS_STYLES = {
  queued:      { bg: "#F1EFE8", color: "#5F5E5A", label: "Queued" },
  generating:  { bg: "#E6F1FB", color: "#185FA5", label: "Generating" },
  ready:       { bg: "#EAF3DE", color: "#3B6D11", label: "Ready" },
  publishing:  { bg: "#FAEEDA", color: "#854F0B", label: "Publishing" },
  published:   { bg: "#EAF3DE", color: "#3B6D11", label: "Published" },
  failed:      { bg: "#FCEBEB", color: "#A32D2D", label: "Failed" },
  banned:      { bg: "#FAECE7", color: "#993C1D", label: "Banned" },
};

const PLATFORM_COLOR = {
  reddit: { bg: "#FAECE7", color: "#993C1D", dot: "#D85A30" },
  xhs:    { bg: "#FBEAF0", color: "#993556", dot: "#D4537E" },
};

function Badge({ text, style }) {
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 20,
      fontSize: 11, fontWeight: 500, background: style.bg, color: style.color,
    }}>{text}</span>
  );
}

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)",
      padding: "14px 18px", flex: 1, minWidth: 0,
    }}>
      <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 500, color: accent || "var(--color-text-primary)", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function PostCard({ post, onView }) {
  const statusStyle = STATUS_STYLES[post.status] ?? STATUS_STYLES.queued;
  const platformStyle = PLATFORM_COLOR[post.platform] ?? PLATFORM_COLOR.reddit;
  const isXHS = post.platform === "xhs";
  const timeAgo = (ts) => {
    if (!ts) return "—";
    const d = Math.floor((Date.now() - new Date(ts)) / 1000);
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d/60)}m ago`;
    if (d < 86400) return `${Math.floor(d/3600)}h ago`;
    return `${Math.floor(d/86400)}d ago`;
  };

  return (
    <div style={{
      background: "var(--color-background-primary)",
      border: "0.5px solid var(--color-border-tertiary)",
      borderRadius: "var(--border-radius-lg)", padding: "14px 16px",
      display: "flex", flexDirection: "column", gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: platformStyle.dot, flexShrink: 0,
          display: "inline-block",
        }} />
        <span style={{ fontSize: 12, fontWeight: 500, color: platformStyle.color }}>
          {post.platform === "reddit" ? `r/${post.subreddit ?? "crypto"}` : "小红书"}
        </span>
        <Badge text={statusStyle.label} style={statusStyle} />
        {post.status === "published" && (
          <Badge text="Live" style={{ bg: "#EAF3DE", color: "#3B6D11" }} />
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--color-text-tertiary)" }}>
          {timeAgo(post.created_at)}
        </span>
      </div>

      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)", lineHeight: 1.4 }}>
        {post.title || "(no title)"}
      </div>

      <div style={{
        fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
      }}>
        {post.body}
      </div>

      {isXHS && post.carousel_slides && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {post.carousel_slides.map((s, i) => (
            <span key={i} style={{
              fontSize: 10, padding: "2px 8px", borderRadius: 12,
              background: "var(--color-background-secondary)",
              color: "var(--color-text-tertiary)",
            }}>
              Slide {s.slide}: {s.type}
            </span>
          ))}
        </div>
      )}

      {post.substitutions_applied?.length > 0 && (
        <div style={{
          fontSize: 11, color: "#854F0B",
          background: "#FAEEDA", borderRadius: 6, padding: "4px 10px",
        }}>
          🔄 {post.substitutions_applied.length} word(s) substituted for XHS compliance
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button onClick={() => onView(post)} style={{
          fontSize: 12, padding: "5px 14px", cursor: "pointer",
          border: "0.5px solid var(--color-border-secondary)",
          borderRadius: "var(--border-radius-md)", background: "transparent",
          color: "var(--color-text-secondary)",
        }}>View full post</button>
        {post.platform_url && (
          <a href={post.platform_url} target="_blank" rel="noreferrer" style={{
            fontSize: 12, padding: "5px 14px", cursor: "pointer",
            border: "0.5px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-md)", background: "transparent",
            color: "var(--color-text-info)", textDecoration: "none",
          }}>View live ↗</a>
        )}
      </div>
    </div>
  );
}

function PostModal({ post, onClose }) {
  if (!post) return null;
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
    }} onClick={onClose}>
      <div style={{
        background: "var(--color-background-primary)", borderRadius: "var(--border-radius-lg)",
        padding: 24, width: "90%", maxWidth: 640, maxHeight: "80vh",
        overflow: "auto", position: "relative",
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>{post.title}</div>
          <button onClick={onClose} style={{
            border: "none", background: "none", cursor: "pointer",
            fontSize: 20, color: "var(--color-text-tertiary)", lineHeight: 1,
          }}>✕</button>
        </div>

        {post.platform === "xhs" && post.carousel_slides && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 8 }}>CAROUSEL SLIDES</div>
            {post.carousel_slides.map((s, i) => (
              <div key={i} style={{
                border: "0.5px solid var(--color-border-tertiary)",
                borderRadius: "var(--border-radius-md)", padding: 12, marginBottom: 8,
              }}>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 4 }}>
                  Slide {s.slide} — {s.type}
                </div>
                <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>{s.heading}</div>
                {s.subtext && <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{s.subtext}</div>}
                {s.body && <div style={{ fontSize: 13, color: "var(--color-text-primary)", marginTop: 4 }}>{s.body}</div>}
                {s.image_prompt && (
                  <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 6, fontStyle: "italic" }}>
                    Image: {s.image_prompt}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 6 }}>BODY</div>
        <div style={{
          fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap",
          color: "var(--color-text-primary)",
          background: "var(--color-background-secondary)",
          borderRadius: "var(--border-radius-md)", padding: 12,
        }}>{post.body}</div>

        {post.original_body && post.original_body !== post.body && (
          <>
            <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", margin: "12px 0 6px" }}>ORIGINAL (pre-filter)</div>
            <div style={{
              fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap",
              color: "var(--color-text-secondary)",
              background: "#FAEEDA", borderRadius: "var(--border-radius-md)", padding: 12,
            }}>{post.original_body}</div>
          </>
        )}

        {post.hashtags?.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 4 }}>
            {post.hashtags.map((t, i) => (
              <span key={i} style={{
                fontSize: 11, padding: "2px 8px", borderRadius: 12,
                background: "var(--color-background-secondary)", color: "var(--color-text-secondary)",
              }}>#{t}</span>
            ))}
          </div>
        )}

        {post.substitutions_applied?.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 12 }}>
            <div style={{ color: "var(--color-text-tertiary)", marginBottom: 6 }}>WORD SUBSTITUTIONS APPLIED</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  {["Original", "Replaced With", "Times"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "4px 8px", color: "var(--color-text-tertiary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {post.substitutions_applied.map((s, i) => (
                  <tr key={i}>
                    <td style={{ padding: "4px 8px", color: "#A32D2D" }}>{s.word}</td>
                    <td style={{ padding: "4px 8px", color: "#3B6D11" }}>{s.replacement}</td>
                    <td style={{ padding: "4px 8px", color: "var(--color-text-secondary)" }}>{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [posts, setPosts] = useState([]);
  const [stats, setStats] = useState({ total: 0, published: 0, failed: 0, banned: 0, ready: 0 });
  const [analytics, setAnalytics] = useState({ clicks: 0, signups: 0, commission: 0 });
  const [accounts, setAccounts] = useState({ reddit: [], xhs: [] });
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [selectedPost, setSelectedPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setTab] = useState("posts");
  const [triggering, setTriggering] = useState(false);

  const fetchData = useCallback(async () => {
    const [
      { data: postsData },
      { data: analyticsData },
      { data: redditAccounts },
      { data: xhsAccounts },
      { data: logsData },
    ] = await Promise.all([
      supabase.from("posts").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("analytics").select("*"),
      supabase.from("reddit_accounts").select("username,active,banned,posts_today,karma,last_post_at"),
      supabase.from("xhs_accounts").select("phone,active,banned,shadowbanned,posts_today,last_post_at"),
      supabase.from("cron_logs").select("*").order("run_at", { ascending: false }).limit(10),
    ]);

    const p = postsData ?? [];
    setPosts(p);
    setStats({
      total: p.length,
      published: p.filter(x => x.status === "published").length,
      failed: p.filter(x => x.status === "failed").length,
      banned: p.filter(x => x.status === "banned").length,
      ready: p.filter(x => x.status === "ready").length,
    });

    const a = analyticsData ?? [];
    setAnalytics({
      clicks: a.reduce((s, x) => s + (x.clicks ?? 0), 0),
      signups: a.reduce((s, x) => s + (x.signups ?? 0), 0),
      commission: a.reduce((s, x) => s + (x.commission_usd ?? 0), 0),
    });

    setAccounts({ reddit: redditAccounts ?? [], xhs: xhsAccounts ?? [] });
    setLogs(logsData ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const filteredPosts = posts.filter(p => {
    const statusOk = filter === "all" || p.status === filter;
    const platformOk = platformFilter === "all" || p.platform === platformFilter;
    return statusOk && platformOk;
  });

  const triggerCron = async () => {
    setTriggering(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/cron-generator`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
      });
      const data = await res.json();
      alert(data.success ? `✅ Generated ${data.postsGenerated} posts` : `❌ Error: ${JSON.stringify(data.errors)}`);
      await fetchData();
    } catch (e) {
      alert("Error triggering cron: " + e.message);
    }
    setTriggering(false);
  };

  const TAB_STYLE = (active) => ({
    padding: "7px 16px", fontSize: 13, cursor: "pointer",
    border: "none", background: "none",
    borderBottom: active ? "2px solid var(--color-text-primary)" : "2px solid transparent",
    color: active ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
    fontWeight: active ? 500 : 400,
  });

  return (
    <div style={{ padding: "20px 0", maxWidth: 900, margin: "0 auto", fontFamily: "var(--font-sans)" }}>
      <PostModal post={selectedPost} onClose={() => setSelectedPost(null)} />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 500 }}>KOL Automation</div>
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 2 }}>
            Reddit + 小红书 pipeline
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={fetchData} style={{
            fontSize: 12, padding: "7px 14px", cursor: "pointer",
            border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)",
            background: "transparent", color: "var(--color-text-secondary)",
          }}>↻ Refresh</button>
          <button onClick={triggerCron} disabled={triggering} style={{
            fontSize: 12, padding: "7px 16px", cursor: triggering ? "not-allowed" : "pointer",
            border: "0.5px solid var(--color-border-secondary)", borderRadius: "var(--border-radius-md)",
            background: triggering ? "var(--color-background-secondary)" : "var(--color-text-primary)",
            color: triggering ? "var(--color-text-tertiary)" : "var(--color-background-primary)",
          }}>{triggering ? "Generating..." : "▶ Run generator now"}</button>
        </div>
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <StatCard label="Total posts" value={stats.total} />
        <StatCard label="Published" value={stats.published} accent="#3B6D11" />
        <StatCard label="Ready to post" value={stats.ready} accent="#185FA5" />
        <StatCard label="Failed / Banned" value={`${stats.failed} / ${stats.banned}`} accent="#A32D2D" />
        <StatCard label="Est. clicks" value={analytics.clicks} sub="across all posts" />
        <StatCard label="Commission" value={`$${analytics.commission.toFixed(2)}`} accent="#854F0B" />
      </div>

      {/* Tabs */}
      <div style={{ borderBottom: "0.5px solid var(--color-border-tertiary)", marginBottom: 16, display: "flex" }}>
        {["posts", "accounts", "logs"].map(t => (
          <button key={t} style={TAB_STYLE(activeTab === t)} onClick={() => setTab(t)}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Posts tab */}
      {activeTab === "posts" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
            {["all", "ready", "published", "failed", "banned"].map(s => (
              <button key={s} onClick={() => setFilter(s)} style={{
                fontSize: 11, padding: "4px 12px", cursor: "pointer",
                borderRadius: 20, border: "0.5px solid var(--color-border-secondary)",
                background: filter === s ? "var(--color-text-primary)" : "transparent",
                color: filter === s ? "var(--color-background-primary)" : "var(--color-text-secondary)",
              }}>{s}</button>
            ))}
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {["all", "reddit", "xhs"].map(p => (
                <button key={p} onClick={() => setPlatformFilter(p)} style={{
                  fontSize: 11, padding: "4px 12px", cursor: "pointer",
                  borderRadius: 20, border: "0.5px solid var(--color-border-secondary)",
                  background: platformFilter === p ? "var(--color-background-secondary)" : "transparent",
                  color: "var(--color-text-secondary)",
                  fontWeight: platformFilter === p ? 500 : 400,
                }}>{p === "all" ? "All platforms" : p}</button>
              ))}
            </div>
          </div>
          {loading ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-tertiary)" }}>Loading posts...</div>
          ) : filteredPosts.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-tertiary)" }}>
              No posts found. Click "Run generator now" to create your first posts.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {filteredPosts.map(post => (
                <PostCard key={post.id} post={post} onView={setSelectedPost} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Accounts tab */}
      {activeTab === "accounts" && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-tertiary)", marginBottom: 10 }}>REDDIT ACCOUNTS</div>
            {accounts.reddit.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>No Reddit accounts added yet. Insert into reddit_accounts table.</div>
            ) : accounts.reddit.map((a, i) => (
              <div key={i} style={{
                background: "var(--color-background-primary)",
                border: "0.5px solid var(--color-border-tertiary)",
                borderRadius: "var(--border-radius-md)", padding: "12px 14px", marginBottom: 8,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>u/{a.username}</div>
                  <Badge
                    text={a.banned ? "Banned" : a.active ? "Active" : "Inactive"}
                    style={a.banned ? STATUS_STYLES.banned : a.active ? STATUS_STYLES.published : STATUS_STYLES.failed}
                  />
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 6 }}>
                  Posts today: {a.posts_today} · Karma: {a.karma ?? "—"}
                </div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 280 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-tertiary)", marginBottom: 10 }}>小红书 ACCOUNTS</div>
            {accounts.xhs.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>No XHS accounts added yet. Insert into xhs_accounts table.</div>
            ) : accounts.xhs.map((a, i) => (
              <div key={i} style={{
                background: "var(--color-background-primary)",
                border: "0.5px solid var(--color-border-tertiary)",
                borderRadius: "var(--border-radius-md)", padding: "12px 14px", marginBottom: 8,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{a.phone}</div>
                  <Badge
                    text={a.banned ? "Banned" : a.shadowbanned ? "Shadowbanned" : a.active ? "Active" : "Inactive"}
                    style={a.banned ? STATUS_STYLES.banned : a.shadowbanned ? STATUS_STYLES.failed : a.active ? STATUS_STYLES.published : STATUS_STYLES.failed}
                  />
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 6 }}>
                  Posts today: {a.posts_today}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Logs tab */}
      {activeTab === "logs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {logs.length === 0 ? (
            <div style={{ textAlign: "center", padding: 40, color: "var(--color-text-tertiary)" }}>No cron runs yet.</div>
          ) : logs.map((log, i) => (
            <div key={i} style={{
              background: "var(--color-background-primary)",
              border: "0.5px solid var(--color-border-tertiary)",
              borderRadius: "var(--border-radius-md)", padding: "12px 16px",
              display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap",
            }}>
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", minWidth: 140 }}>
                {new Date(log.run_at).toLocaleString()}
              </div>
              <div style={{ fontSize: 13, flex: 1 }}>{log.topic_used ?? "—"}</div>
              <Badge
                text={`+${log.posts_generated} generated`}
                style={log.posts_generated > 0 ? STATUS_STYLES.published : STATUS_STYLES.queued}
              />
              {log.errors?.length > 0 && (
                <Badge text={`${log.errors.length} errors`} style={STATUS_STYLES.failed} />
              )}
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>
                {log.duration_ms}ms
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
