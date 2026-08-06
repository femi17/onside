"use client";

// Community feed (Phase B + E). Join with a handle, post notes, attach one of your recent results as a
// slip pill, like posts, report, and block members. Posting/opt-in/rate-limit are enforced server-side
// by the community_post / join_community RPCs; likes go straight to community_reactions (RLS-scoped).
// Phase E: live via Supabase realtime on community_posts, plus an own-only block list.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useConfirm } from "@/components/ConfirmDialog";

export type PickLine = { match: string; market: string | null; edge: number | null; ko: string | null };
export type Attachment = { match?: string; league?: string | null; market?: string; result?: string; agent?: string; picks?: PickLine[] } | null;
export type CommunityPost = {
  id: string;
  author_handle: string;
  author_color: string | null;
  body: string | null;
  kind: string;
  attachment: Attachment;
  like_count: number;
  comment_count: number;
  created_at: string;
};
export type ShareItem = { key: string; match: string; league: string | null; market: string; result: string };
type Me = { handle: string | null; opt_in: boolean; avatar_color: string | null };
type Comment = { id: string; author_handle: string; author_color: string | null; body: string; created_at: string };

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 172800) return "yesterday";
  return `${Math.floor(s / 86400)}d`;
}

// an agent's published picks — one compact mono row per game, nothing else
function PicksCard({ picks }: { picks: PickLine[] }) {
  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-ink/10 bg-ink/[0.04] font-mono text-[12px] text-ink">
      {picks.map((x, i) => (
        <div key={i} className="flex items-center gap-2 border-b border-ink/5 px-3 py-2 last:border-0">
          {x.ko && <span className="flex-none text-ink-mute">{x.ko}</span>}
          <span className="min-w-0 flex-1 truncate">
            {x.match} · <b>{x.market}</b>
          </span>
          {x.edge != null && (
            <span className={`flex-none font-bold ${x.edge >= 0 ? "text-grass-deep" : "text-brick"}`}>
              {x.edge >= 0 ? "+" : ""}{x.edge}%
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Avatar({ handle, color }: { handle: string; color: string | null }) {
  return (
    <span
      className="grid h-[34px] w-[34px] flex-none place-items-center rounded-full font-disp text-sm font-extrabold text-white"
      style={{ backgroundColor: color ?? "#2f6bff" }}
    >
      {(handle[0] ?? "?").toUpperCase()}
    </span>
  );
}

export default function CommunityFeed({
  userId,
  me: meProp,
  initialPosts,
  myLikes,
  blockedHandles,
  shareable,
}: {
  userId: string;
  me: Me;
  initialPosts: CommunityPost[];
  myLikes: string[];
  blockedHandles: string[];
  shareable: ShareItem[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const confirm = useConfirm();
  const [me, setMe] = useState<Me>(meProp);
  const [posts, setPosts] = useState<CommunityPost[]>(initialPosts);
  const [liked, setLiked] = useState<Set<string>>(() => new Set(myLikes));
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set(blockedHandles));
  const [showBlocked, setShowBlocked] = useState(false);
  // keep a live ref of the block set so the realtime handler filters against the latest value
  const blockedRef = useRef(blocked);
  useEffect(() => { blockedRef.current = blocked; }, [blocked]);

  const [handleInput, setHandleInput] = useState("");
  const [body, setBody] = useState("");
  const [attach, setAttach] = useState<ShareItem | null>(null);
  const [showAttach, setShowAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // comments drawer
  const [openPost, setOpenPost] = useState<CommunityPost | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loadingC, setLoadingC] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [cbusy, setCbusy] = useState(false);
  const [cmsg, setCmsg] = useState<string | null>(null);

  // resync from the server when it re-renders (after post/join refresh)
  useEffect(() => { setPosts(initialPosts); }, [initialPosts]);
  useEffect(() => { setLiked(new Set(myLikes)); }, [myLikes]);
  useEffect(() => { setMe(meProp); }, [meProp]);
  useEffect(() => { setBlocked(new Set(blockedHandles)); }, [blockedHandles]);

  // live feed — new posts appear, and like/comment counts (and hides) track without a refresh.
  // RLS is enforced per-subscriber, so we only ever receive rows we're allowed to see.
  useEffect(() => {
    const ch = supabase
      .channel("community-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "community_posts" }, (payload) => {
        const row = payload.new as CommunityPost & { hidden?: boolean };
        if (row.hidden || blockedRef.current.has(row.author_handle)) return;
        setPosts((ps) => (ps.some((x) => x.id === row.id) ? ps : [row, ...ps]));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "community_posts" }, (payload) => {
        const row = payload.new as CommunityPost & { hidden?: boolean };
        setPosts((ps) =>
          row.hidden
            ? ps.filter((x) => x.id !== row.id)
            : ps.map((x) => (x.id === row.id ? { ...x, like_count: row.like_count, comment_count: row.comment_count } : x)),
        );
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function join() {
    setBusy(true); setMsg(null);
    const { error } = await supabase.rpc("join_community", { p_handle: handleInput.trim() });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setMe((m) => ({ ...m, opt_in: true, handle: handleInput.trim().toLowerCase() }));
    router.refresh();
  }

  async function submit() {
    if (!body.trim() && !attach) return;
    setBusy(true); setMsg(null);
    const attachment = attach ? { match: attach.match, league: attach.league, market: attach.market, result: attach.result } : null;
    const { error } = await supabase.rpc("community_post", { p_body: body, p_kind: attach ? "result" : "note", p_attachment: attachment });
    setBusy(false);
    if (error) { setMsg(error.message); return; }
    setBody(""); setAttach(null); setShowAttach(false);
    router.refresh();
  }

  async function toggleLike(p: CommunityPost) {
    const on = liked.has(p.id);
    // optimistic
    setLiked((s) => { const n = new Set(s); on ? n.delete(p.id) : n.add(p.id); return n; });
    setPosts((ps) => ps.map((x) => (x.id === p.id ? { ...x, like_count: Math.max(0, x.like_count + (on ? -1 : 1)) } : x)));
    const q = on
      ? supabase.from("community_reactions").delete().eq("post_id", p.id).eq("user_id", userId)
      : supabase.from("community_reactions").insert({ post_id: p.id, user_id: userId });
    const { error } = await q;
    if (error) router.refresh(); // revert to server truth on failure
  }

  async function report(p: CommunityPost) {
    if (!(await confirm({ title: "Report this post?", body: "It'll be hidden from your feed and sent to our moderators.", confirmLabel: "Report", tone: "danger" }))) return;
    setDismissed((s) => new Set(s).add(p.id));
    await supabase.from("community_reports").insert({ target_type: "post", target_id: p.id, reporter_id: userId });
  }

  async function block(handle: string) {
    if (!(await confirm({ title: `Block @${handle}?`, body: "You won't see their posts or comments.", confirmLabel: "Block", tone: "danger" }))) return;
    setBlocked((s) => new Set(s).add(handle)); // filters the feed immediately
    const { error } = await supabase.from("community_blocks").insert({ blocker_id: userId, blocked_handle: handle });
    if (error) setBlocked((s) => { const n = new Set(s); n.delete(handle); return n; });
  }
  async function unblock(handle: string) {
    setBlocked((s) => { const n = new Set(s); n.delete(handle); return n; });
    const { error } = await supabase.from("community_blocks").delete().eq("blocker_id", userId).eq("blocked_handle", handle);
    if (error) { setBlocked((s) => new Set(s).add(handle)); return; }
    router.refresh(); // pull back any of their posts we filtered out server-side
  }

  async function loadComments(postId: string) {
    const { data } = await supabase
      .from("community_comments")
      .select("id, author_handle, author_color, body, created_at")
      .eq("post_id", postId)
      .eq("hidden", false)
      .order("created_at", { ascending: true });
    setComments(((data as Comment[]) ?? []).filter((c) => !blockedRef.current.has(c.author_handle)));
  }
  async function openComments(p: CommunityPost) {
    setOpenPost(p); setComments([]); setCommentBody(""); setCmsg(null); setLoadingC(true);
    await loadComments(p.id);
    setLoadingC(false);
  }
  async function submitComment() {
    if (!openPost || !commentBody.trim()) return;
    setCbusy(true); setCmsg(null);
    const { error } = await supabase.rpc("community_comment", { p_post_id: openPost.id, p_body: commentBody });
    setCbusy(false);
    if (error) { setCmsg(error.message); return; }
    setCommentBody("");
    await loadComments(openPost.id);
    setPosts((ps) => ps.map((x) => (x.id === openPost.id ? { ...x, comment_count: x.comment_count + 1 } : x)));
  }

  const visible = posts.filter((p) => !dismissed.has(p.id) && !blocked.has(p.author_handle));
  const blockedList = Array.from(blocked);

  return (
    <>
      {/* compose / join */}
      {me.opt_in ? (
        <div className="rounded-2xl bg-chalk p-4 text-ink shadow-lg">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Share a result, a read, or what's landing this week…"
            rows={2}
            maxLength={1000}
            className="w-full resize-none rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-flood"
          />
          {attach && (
            <div className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 bg-ink/[0.04] px-3 py-2 font-mono text-[12px] text-ink">
              <span className="font-bold">{attach.market}</span>
              <span className="text-ink-mute">·</span>
              <span>{attach.match}</span>
              <span className={attach.result === "won" ? "font-bold text-grass-deep" : "font-bold text-brick"}>
                {attach.result === "won" ? "✓ landed" : "✕ missed"}
              </span>
              <button onClick={() => setAttach(null)} className="ml-1 text-ink-mute hover:text-brick" aria-label="Remove attachment">×</button>
            </div>
          )}
          {showAttach && !attach && (
            <div className="no-scrollbar mt-2 max-h-40 overflow-y-auto rounded-lg border border-ink/10">
              {shareable.length ? shareable.map((s) => (
                <button key={s.key} onClick={() => { setAttach(s); setShowAttach(false); }} className="flex w-full items-center gap-2 border-b border-ink/5 px-3 py-2 text-left last:border-0 hover:bg-ink/[0.03]">
                  <span className={`h-2 w-2 flex-none rounded-full ${s.result === "won" ? "bg-grass" : "bg-brick"}`} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{s.market} · {s.match}</span>
                </button>
              )) : <div className="px-3 py-3 font-mono text-[11px] text-ink-mute">No settled results to attach yet.</div>}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            {!attach && (
              <button onClick={() => setShowAttach((v) => !v)} className="rounded-lg border border-ink/20 px-3 py-2 font-mono text-[12px] font-bold text-ink hover:border-ink/40">
                {showAttach ? "Cancel" : "＋ Attach a result"}
              </button>
            )}
            <button onClick={submit} disabled={busy || (!body.trim() && !attach)} className="ml-auto rounded-lg bg-flood px-4 py-2 font-bold text-ink disabled:opacity-40">
              {busy ? "Posting…" : "Post"}
            </button>
          </div>
          {msg && <p className="mt-2 font-mono text-xs text-brick">{msg}</p>}
        </div>
      ) : (
        <div className="rounded-2xl bg-chalk p-5 text-ink shadow-lg">
          <div className="font-disp text-lg font-bold text-ink">Join the conversation.</div>
          <p className="mt-1 text-[13.5px] text-ink-mute">Pick a handle to post slips and results to the squad. This is your public name.</p>
          <div className="mt-3 flex items-center gap-2">
            <span className="font-mono text-ink-mute">@</span>
            <input
              value={handleInput}
              onChange={(e) => setHandleInput(e.target.value)}
              placeholder="your_handle"
              maxLength={20}
              className="min-w-0 flex-1 rounded-lg border border-ink/15 bg-white px-3 py-2 font-mono text-sm text-ink focus:outline-none focus:ring-2 focus:ring-flood"
            />
            <button onClick={join} disabled={busy || handleInput.trim().length < 3} className="flex-none rounded-lg bg-flood px-4 py-2 font-bold text-ink disabled:opacity-40">
              {busy ? "…" : "Join"}
            </button>
          </div>
          {msg && <p className="mt-2 font-mono text-xs text-brick">{msg}</p>}
        </div>
      )}

      {/* feed */}
      <div className="mt-4 flex flex-col gap-2.5">
        {visible.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-white/15 bg-pitch-2 p-6 text-center text-[13.5px] text-onpitch-mute">
            Nothing shared yet — be the first to post.
          </p>
        ) : visible.map((p) => {
          const on = liked.has(p.id);
          return (
            <div key={p.id} className="rounded-2xl bg-chalk p-4 text-ink shadow-lg">
              <div className="flex items-center gap-2.5">
                <Avatar handle={p.author_handle} color={p.author_color} />
                <span className="font-bold text-ink">{p.author_handle}</span>
                <span className="ml-auto font-mono text-[11px] text-ink-mute">{ago(p.created_at)}</span>
              </div>
              {p.body && <div className="mt-2.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{p.body}</div>}
              {p.kind === "picks" && p.attachment?.picks?.length ? <PicksCard picks={p.attachment.picks} /> : null}
              {p.attachment && (p.kind === "result" || p.kind === "slip") && (
                <div className="mt-2.5 inline-flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 bg-ink/[0.04] px-3 py-2 font-mono text-[12px] text-ink">
                  {p.attachment.market && <span className="font-bold">{p.attachment.market}</span>}
                  {p.attachment.match && <><span className="text-ink-mute">·</span><span>{p.attachment.match}</span></>}
                  {p.attachment.result && (
                    <span className={p.attachment.result === "won" ? "font-bold text-grass-deep" : p.attachment.result === "lost" ? "font-bold text-brick" : "text-ink-mute"}>
                      {p.attachment.result === "won" ? "✓ landed" : p.attachment.result === "lost" ? "✕ missed" : "pending"}
                    </span>
                  )}
                </div>
              )}
              <div className="mt-3 flex items-center gap-4 font-mono text-[12px] text-ink-mute">
                <button onClick={() => toggleLike(p)} className={`transition-colors hover:text-ink ${on ? "font-bold text-brick" : ""}`} aria-pressed={on}>
                  {on ? "♥" : "♡"} {p.like_count}
                </button>
                <button onClick={() => openComments(p)} className="transition-colors hover:text-ink">💬 {p.comment_count}</button>
                <div className="ml-auto flex items-center gap-3">
                  <button onClick={() => report(p)} className="text-ink-mute/70 transition-colors hover:text-brick">Report</button>
                  {p.author_handle !== me.handle && (
                    <button onClick={() => block(p.author_handle)} className="text-ink-mute/70 transition-colors hover:text-brick">Block</button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* blocked members — manage / unblock */}
      {blockedList.length > 0 && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-pitch-2 p-4">
          <button onClick={() => setShowBlocked((v) => !v)} className="flex w-full items-center gap-2 font-mono text-[12px] text-onpitch-mute">
            <span>{showBlocked ? "▾" : "▸"}</span>
            <span>Blocked · {blockedList.length}</span>
          </button>
          {showBlocked && (
            <div className="mt-3 flex flex-wrap gap-2">
              {blockedList.map((h) => (
                <span key={h} className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-pitch px-3 py-1.5 font-mono text-[12px] text-chalk">
                  @{h}
                  <button onClick={() => unblock(h)} className="text-flood transition-colors hover:text-flood-deep">unblock</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* comments drawer */}
      {openPost && (
        <div className="fixed inset-0 z-50">
          <div onClick={() => setOpenPost(null)} className="absolute inset-0 bg-ink/60" />
          <div role="dialog" aria-label="Comments" className="absolute right-0 top-0 flex h-full w-[92%] max-w-md flex-col bg-chalk text-ink shadow-2xl">
            <div className="flex items-center justify-between border-b border-ink/10 px-4 py-3">
              <span className="font-disp text-lg font-extrabold text-ink">Comments</span>
              <button onClick={() => setOpenPost(null)} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink/5 font-mono text-lg text-ink-mute">×</button>
            </div>

            <div className="no-scrollbar flex-1 overflow-y-auto px-4 py-4">
              {/* the post being discussed */}
              <div className="rounded-xl border border-ink/10 bg-ink/[0.03] p-3">
                <div className="flex items-center gap-2.5">
                  <Avatar handle={openPost.author_handle} color={openPost.author_color} />
                  <span className="font-bold text-ink">{openPost.author_handle}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-mute">{ago(openPost.created_at)}</span>
                </div>
                {openPost.body && <div className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{openPost.body}</div>}
                {openPost.kind === "picks" && openPost.attachment?.picks?.length ? <PicksCard picks={openPost.attachment.picks} /> : null}
                {openPost.attachment && (openPost.kind === "result" || openPost.kind === "slip") && (
                  <div className="mt-2 inline-flex flex-wrap items-center gap-2 rounded-lg border border-ink/10 bg-white px-3 py-2 font-mono text-[12px] text-ink">
                    {openPost.attachment.market && <span className="font-bold">{openPost.attachment.market}</span>}
                    {openPost.attachment.match && <><span className="text-ink-mute">·</span><span>{openPost.attachment.match}</span></>}
                    {openPost.attachment.result && (
                      <span className={openPost.attachment.result === "won" ? "font-bold text-grass-deep" : openPost.attachment.result === "lost" ? "font-bold text-brick" : "text-ink-mute"}>
                        {openPost.attachment.result === "won" ? "✓ landed" : openPost.attachment.result === "lost" ? "✕ missed" : "pending"}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* comments */}
              <div className="mt-4 flex flex-col gap-4">
                {loadingC ? (
                  <p className="font-mono text-[12px] text-ink-mute">Loading…</p>
                ) : comments.length === 0 ? (
                  <p className="font-mono text-[12px] text-ink-mute">No comments yet — start the thread.</p>
                ) : comments.map((c) => (
                  <div key={c.id} className="flex gap-2.5">
                    <Avatar handle={c.author_handle} color={c.author_color} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-ink">{c.author_handle}</span>
                        <span className="font-mono text-[11px] text-ink-mute">{ago(c.created_at)}</span>
                      </div>
                      <div className="mt-0.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{c.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* composer */}
            <div className="border-t border-ink/10 p-3">
              {me.opt_in ? (
                <>
                  <div className="flex items-end gap-2">
                    <textarea
                      value={commentBody}
                      onChange={(e) => setCommentBody(e.target.value)}
                      placeholder="Add a comment…"
                      rows={1}
                      maxLength={1000}
                      className="min-h-[42px] flex-1 resize-none rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-mute focus:outline-none focus:ring-2 focus:ring-flood"
                    />
                    <button onClick={submitComment} disabled={cbusy || !commentBody.trim()} className="flex-none rounded-lg bg-flood px-4 py-2.5 font-bold text-ink disabled:opacity-40">
                      {cbusy ? "…" : "Send"}
                    </button>
                  </div>
                  {cmsg && <p className="mt-2 font-mono text-xs text-brick">{cmsg}</p>}
                </>
              ) : (
                <p className="font-mono text-[12px] text-ink-mute">Join the community (above) to comment.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
