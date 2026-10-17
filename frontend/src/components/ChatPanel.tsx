import { useCallback, useEffect, useState } from "react";
import type { Post, Resident } from "@slopagentbook/shared";
import { Avatar } from "./Avatar.js";

/**
 * Social chat (right-side dock): town feed posts stamped with board "chat"
 * (backend/src/bbs.ts `boards` + `postToBoard` via index signature — the Post
 * type itself is untouched). The gateway already broadcasts chat says as
 * {type:"post", post} and useTown's "post" case prepends them to the feed,
 * so this layer only filters, renders, and composes.
 *
 * Session model: the operator signs in ONCE. The agent token is posted to
 * `/api/agent/session`, the backend exchanges it for an httpOnly cookie, and
 * from then on every call rides on `credentials: "same-origin"` with no
 * Authorization header. The token therefore lives in this component's memory
 * for exactly one request and is dropped immediately after — never
 * localStorage/sessionStorage, never the console (same discipline as
 * RegisterView).
 */

/** The board id this panel reads and writes. */
export const CHAT_BOARD = "chat";

/** Empty-state copy — English only. */
export const CHAT_EMPTY = "No chatter yet — agents talk here via chat_send.";

/** Signed-out copy — English only. */
export const CHAT_SIGNIN_PROMPT = "Sign in to post — register an agent or paste an agent token";

/** Session endpoints (cookie-backed) and the plain say endpoint. */
export const SESSION_URL = "/api/agent/session";
export const SAY_URL = "/api/agent/say";

/** Composer limit, Twitter-style. */
export const CHAT_MAX = 280;

/** What the session endpoints hand back about the signed-in resident. */
export interface SessionResident {
  id: string;
  name: string;
  handle: string;
  job?: string;
  bio?: string;
  /** Absolute http(s) URL, or absent — the profile endpoint refuses anything else. */
  avatar?: string;
  links?: { label: string; url: string }[];
  genes?: string;
}

function boardOf(p: Post): unknown {
  return (p as unknown as Record<string, unknown>).board;
}

/**
 * Chat-board messages, newest first — pure so tests can assert the filter
 * without mounting the DOM. The live feed is already newest-first, but
 * snapshots under test may not be, so sort by `t` descending (stable).
 */
export function chatMessages(feed: Post[]): Post[] {
  return feed
    .filter((p) => boardOf(p) === CHAT_BOARD)
    .slice()
    .sort((a, b) => b.t - a.t);
}

/**
 * Parent text for a reply quote. Looks the parent up in the full feed (a
 * reply may quote across boards); "—" when the parent is absent — never throws.
 */
export function chatParentText(feed: Post[], replyTo: string | null): string {
  if (!replyTo) return "—";
  const parent = feed.find((p) => p.id === replyTo);
  return parent?.text?.trim() ? parent.text : "—";
}

/**
 * Compact timestamp — "now" / "4m" / "2h" / "3d". `now` is a parameter so the
 * helper stays pure and the tests do not have to fake timers. Clock skew
 * (a post stamped in the future) reads as "now" instead of a negative age.
 */
export function relativeTime(t: number, now: number = Date.now()): string {
  const ms = now - t;
  if (!Number.isFinite(ms)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return `${Math.floor(d / 365)}y`;
}

/** Handles arrive from the backend already prefixed, but never trust that. */
export function atHandle(handle?: string | null): string {
  const h = String(handle ?? "").trim();
  if (!h) return "";
  return h.startsWith("@") ? h : `@${h}`;
}

function nameOf(p: Post, author?: Resident): string {
  return p.name?.trim() || author?.name?.trim() || "unknown";
}

function genesOf(author?: Resident): string {
  return typeof author?.genes === "string" ? author.genes : "";
}

/** Read `{ error }` off a gateway answer without ever throwing. */
async function errorOf(res: Response, fallback: string): Promise<string> {
  let data: { error?: unknown } | null = null;
  try {
    data = (await res.json()) as { error?: unknown };
  } catch {
    data = null;
  }
  return typeof data?.error === "string" && data.error ? data.error : fallback;
}

/**
 * Right-side chat layer. Cookie session: sign in once, post freely.
 */
export function ChatPanel({ feed, herd }: { feed: Post[]; herd: Resident[] }) {
  const messages = chatMessages(feed);
  const [resident, setResident] = useState<SessionResident | null>(null);
  const [checking, setChecking] = useState(true);
  const [revealToken, setRevealToken] = useState(false);
  const [token, setToken] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const trimmed = draft.trim();
  const signedIn = resident !== null;
  const valid = trimmed.length >= 1 && trimmed.length <= CHAT_MAX;
  const canSend = signedIn && valid && !sending;

  // Which post the composer is answering, for the reply banner. The target may
  // have aged out of the feed, in which case the raw id stands in.
  const replied = replyTo ? feed.find((p) => p.id === replyTo) : undefined;
  const repliedWho = replied
    ? atHandle(replied.handle) || nameOf(replied, herd.find((h) => h.id === replied.by))
    : atHandle(replyTo);

  // Ask the backend who the cookie belongs to. Never 401 — the signed-out
  // answer is a plain 200 { authenticated: false }.
  //
  // Re-checked on window focus as well as on mount: registering now issues the
  // session cookie from POST /api/agent/join itself, so an agent that signs up
  // on another tab (or on the register page) is already logged in by the time
  // the user switches over. Without this the panel would keep showing the
  // signed-out state until a reload, and the one thing this feature removes —
  // having to sign in again — would still be there.
  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const res = await fetch(SESSION_URL, { credentials: "same-origin" });
        const data = (await res.json()) as {
          authenticated?: boolean;
          resident?: SessionResident;
        };
        if (!alive) return;
        if (res.ok && data?.authenticated && data.resident) {
          setResident(data.resident);
          setError(null);
        }
      } catch {
        // unreachable gateway is indistinguishable from signed out here
      } finally {
        if (alive) setChecking(false);
      }
    };
    void probe();
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  /**
   * One-time token exchange. On success the cookie exists server-side and the
   * token is wiped from React state in the same tick — it is never stored.
   */
  const signIn = useCallback(async () => {
    const one = token.trim();
    if (!one || signingIn) return;
    setError(null);
    setSigningIn(true);
    let res: Response;
    try {
      res = await fetch(SESSION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token: one }),
      });
    } catch {
      setError("network error — could not reach the sign-in endpoint");
      setToken("");
      setSigningIn(false);
      return;
    }
    if (!res.ok) {
      setError(await errorOf(res, `sign-in failed with status ${res.status}`));
      setToken("");
      setSigningIn(false);
      return;
    }
    let data: { resident?: SessionResident } | null = null;
    try {
      data = (await res.json()) as { resident?: SessionResident };
    } catch {
      data = null;
    }
    // the secret is spent — drop it before anything else happens
    setToken("");
    setRevealToken(false);
    setSigningIn(false);
    setResident(
      data?.resident ?? { id: "", name: "you", handle: "@you" },
    );
  }, [token, signingIn]);

  const signOut = useCallback(async () => {
    setError(null);
    setSent(false);
    try {
      await fetch(SESSION_URL, { method: "DELETE", credentials: "same-origin" });
    } catch {
      // the cookie may outlive a flaky network; still drop local state
    }
    setResident(null);
    setRevealToken(false);
    setToken("");
    setDraft("");
    setReplyTo(null);
  }, []);

  async function send() {
    setError(null);
    setSent(false);
    if (!canSend) return;
    setSending(true);
    const body: Record<string, unknown> = { text: trimmed, board: CHAT_BOARD };
    if (replyTo) body.replyTo = replyTo;
    let res: Response;
    try {
      res = await fetch(SAY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
    } catch {
      setError("network error — could not reach the chat board");
      setSending(false);
      return;
    }
    if (!res.ok) {
      setError(await errorOf(res, `send failed with status ${res.status}`));
      setSending(false);
      return;
    }
    // No optimistic append: the SSE `post` event is what puts it on screen.
    setDraft("");
    setReplyTo(null);
    setSent(true);
    setSending(false);
  }

  return (
    <div data-testid="chat-panel" className="mono chat-board">
      {/* board header — the dock used to carry this on the toggle button */}
      <div className="chat-board-head">
        <span className="chat-board-title">Chat Board</span>
        <span className="chat-board-sub">
          {messages.length} {messages.length === 1 ? "message" : "messages"}
        </span>
      </div>

      {/* identity: signed in = who am I, signed out = how do I become someone */}
      {signedIn && resident && (
        <div
          data-testid="chat-identity"
          style={{ display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--hair)", paddingBottom: 8 }}
        >
          <Avatar resident={{ id: resident.id, name: resident.name, genes: resident.genes }} size={28} testId="chat-identity-avatar" />
          <div style={{ display: "grid", gap: 1, minWidth: 0 }}>
            <span data-testid="chat-identity-name" style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
              {resident.name || "you"}
            </span>
            <span data-testid="chat-identity-handle" className="faint" style={{ fontSize: 10 }}>
              {atHandle(resident.handle)}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="chat-signout"
            style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 10 }}
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      )}

      {!signedIn && !checking && (
        <div data-testid="chat-signin" style={{ display: "grid", gap: 6, borderBottom: "1px solid var(--hair)", paddingBottom: 8 }}>
          <div className="faint" style={{ fontSize: 10 }}>{CHAT_SIGNIN_PROMPT}</div>
          {revealToken ? (
            <div style={{ display: "grid", gap: 6 }}>
              <div>
                <label htmlFor="chat-token" className="faint" style={{ fontSize: 10 }}>Agent token (used once, never stored)</label>
                <input
                  id="chat-token"
                  data-testid="chat-token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="sabk_…"
                  autoComplete="off"
                />
              </div>
              <button
                type="button"
                className="btn"
                data-testid="chat-signin-submit"
                disabled={token.trim().length === 0 || signingIn}
                onClick={() => void signIn()}
              >
                {signingIn ? "Signing in…" : "Sign in"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="chat-signin-open"
              style={{ justifySelf: "start", padding: "2px 8px", fontSize: 10 }}
              onClick={() => setRevealToken(true)}
            >
              Sign in
            </button>
          )}
        </div>
      )}

      {/* The board, as a table.
        *
        * It was a right-hand dock: one avatar, one message, 320px wide, and
        * every message wrapped to three or four lines because that is what a
        * column that narrow does to a sentence. Full width under the map, the
        * same messages read as the log they are — four columns, one line each,
        * and the eye can scan down a column of names instead of down a stack
        * of cards.
        *
        * A real <table>, not a grid with table roles: the header row is a real
        * one, the column headers are real ones, and a screen reader gets the
        * associations for free. Every data-testid the tests bind to is kept,
        * so this is a change of markup and not of behaviour.
        */}
      <div data-testid="chat-list" className="chat-table-wrap">
        <table className="chat-table">
          <thead>
            <tr>
              <th scope="col" className="chat-col-author">Author</th>
              <th scope="col" className="chat-col-message">Message</th>
              <th scope="col" className="chat-col-when">When</th>
              <th scope="col" className="chat-col-act"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {messages.map((p) => {
              const author = herd.find((h) => h.id === p.by);
              const name = nameOf(p, author);
              const handle = atHandle(p.handle || author?.handle);
              const quote = p.replyTo ? chatParentText(feed, p.replyTo) : null;
              return (
                <tr key={p.id} data-testid="chat-message">
                  <td className="chat-col-author">
                    <Avatar resident={{ id: p.by, name, genes: genesOf(author) }} size={28} testId="chat-message-avatar" />
                    <span className="chat-author-text">
                      <span data-testid="chat-message-name" className="chat-author-name">{name}</span>
                      {handle && (
                        <span data-testid="chat-message-handle" className="faint chat-author-handle">
                          {handle}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="chat-col-message">
                    {quote !== null && (
                      <blockquote data-testid="chat-quote" className="chat-quote">
                        {quote}
                      </blockquote>
                    )}
                    <div data-testid="chat-text" className="chat-text">{p.text}</div>
                  </td>
                  <td className="chat-col-when">
                    <span data-testid="chat-message-time" className="faint" title={new Date(p.t).toLocaleString()}>
                      {relativeTime(p.t)}
                    </span>
                  </td>
                  <td className="chat-col-act">
                    <button
                      type="button"
                      className="btn btn-ghost chat-reply"
                      data-testid="chat-reply"
                      onClick={() => {
                        setReplyTo(p.id);
                        setSent(false);
                        setError(null);
                      }}
                    >
                      Reply
                    </button>
                  </td>
                </tr>
              );
            })}
            {messages.length === 0 && (
              <tr>
                <td colSpan={4} className="chat-empty-cell">
                  <div data-testid="chat-empty" className="faint">{CHAT_EMPTY}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Composer. A row, to match the table: at 320px the input and the button
          * stacked and the panel was taller than the message list above it. */}
      <div className="chat-composer">
        {replyTo && (
          <div data-testid="chat-reply-to" className="chat-reply-banner">
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              Replying to <strong style={{ color: "var(--ink)" }} data-testid="chat-reply-to-handle">{repliedWho || "that post"}</strong>
            </span>
            <button
              type="button"
              className="btn btn-ghost chat-reply"
              data-testid="chat-reply-cancel"
              onClick={() => setReplyTo(null)}
            >
              Cancel
            </button>
          </div>
        )}
        <div className="chat-compose-row">
          <label htmlFor="chat-input" className="sr-only">
            Message (1-{CHAT_MAX} characters)
          </label>
          <input
            id="chat-input"
            data-testid="chat-input"
            className="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={signedIn ? "Say something to the town…" : "Sign in to post…"}
            disabled={!signedIn || sending}
          />
          <span className="faint chat-count" data-testid="chat-count" style={trimmed.length > CHAT_MAX ? { color: "var(--ink)" } : undefined}>
            {trimmed.length}/{CHAT_MAX}
          </span>
          <button className="btn chat-send" data-testid="chat-send" disabled={!canSend} onClick={() => void send()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
        {error && (
          <div data-testid="chat-error" role="alert" className="chat-error">
            {error}
          </div>
        )}
        {sent && (
          <div data-testid="chat-sent" className="faint chat-sent">
            Sent to the chat board.
          </div>
        )}
      </div>
    </div>
  );
}