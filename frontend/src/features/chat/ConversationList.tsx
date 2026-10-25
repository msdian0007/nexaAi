import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/auth.context";
import { parseConversations } from "./history.types";
import type { Conversation } from "./history.types";
import { ApiError } from "../../services/api";

export function ConversationList({
  selected,
  onSelect,
  onDeleting,
  revision,
}: {
  selected?: string;
  onSelect: (id: string) => void;
  onDeleting: (id: string) => void;
  revision: number;
}) {
  const { request } = useAuth();
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const retryCursor = useRef<string | null>(null);
  const [target, setTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBlocked, setDeleteBlocked] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [notice, setNotice] = useState("");
  const deletion = useRef<AbortController | null>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(
    (after: string | null, controller: AbortController) => {
      // A list read started during a DELETE cannot resolve an uncertain DELETE
      // outcome; only an explicit later refresh should re-enable deletion.
      const afterDeletion = !deletion.current;
      return request("/chat/conversations", {
        query: { limit: 20, ...(after ? { cursor: after } : {}) },
        signal: controller.signal,
      })
        .then((response) => {
          const data = parseConversations(response);
          if (controller.signal.aborted) return;
          // The list is a live view. Deduplicate IDs if a conversation moved between pages.
          setItems((old) => [
            ...new Map(
              [...(after ? old : []), ...data.conversations].map((c) => [
                c.id,
                c,
              ]),
            ).values(),
          ]);
          setCursor(data.page.nextCursor);
          setError("");
          if (afterDeletion) { setDeleteBlocked(false); setDeleteError(""); }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError("Could not load conversations. Please try again.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    },
    [request],
  );

  useEffect(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    void load(null, controller);
    return () => controller.abort();
  }, [load, revision]);
  useEffect(() => () => { active.current?.abort(); deletion.current?.abort(); }, []);
  useEffect(() => { if (target) confirmation.current?.focus(); }, [target]);

  async function remove() {
    if (!target || deletion.current || deleteBlocked) return;
    active.current?.abort(); setLoading(false);
    const controller = new AbortController(); deletion.current = controller;
    setDeleting(true); setDeleteError(""); setNotice("");
    // Clear the open conversation at confirmation, cancelling its pending answer.
    // A failed request leaves the list entry available to reopen after refreshing.
    onDeleting(target.id);
    try {
      const result = await request<{ conversationId: string; deleted: boolean }>(`/chat/conversations/${target.id}`, { method: "DELETE", signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result?.conversationId !== target.id || result.deleted !== true) throw new Error("Invalid deletion response");
      setItems(old => old.filter(item => item.id !== target.id));
      setNotice("Conversation and its messages and saved source details deleted. Uploaded documents were kept.");
      setTarget(null); heading.current?.focus();
      fetchPage(null);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setTarget(null); setDeleteBlocked(true);
      setDeleteError(failure instanceof ApiError && failure.status === 403
        ? "Your membership no longer permits this action. Refresh conversations to check your access."
        : failure instanceof ApiError && failure.status === 404
          ? "This conversation is no longer available. Refresh conversations."
          : "Could not confirm deletion. Refresh conversations to check its saved state before trying again.");
    } finally {
      if (deletion.current === controller) deletion.current = null;
      if (!controller.signal.aborted) setDeleting(false);
    }
  }

  function fetchPage(after: string | null) {
    retryCursor.current = after;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError("");
    void load(after, controller);
  }
  return (
    <aside className="conversation-list" aria-label="Saved conversations">
      <h2 tabIndex={-1} ref={heading}>Conversations</h2>
      <button
        className="text-button"
        disabled={loading || deleting || !!target}
        onClick={() => fetchPage(null)}
      >
        Refresh conversations
      </button>
      {loading && <p role="status">Loading conversations...</p>}
      {notice && <p role="status">{notice}</p>}
      {deleteError && <p role="alert" className="form-error">{deleteError}</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="text-button"
            disabled={loading || deleting || !!target}
            onClick={() => fetchPage(retryCursor.current)}
          >
            Retry conversations
          </button>
        </p>
      )}
      {!loading && !error && !items.length && (
        <p>No saved conversations yet.</p>
      )}
      <ul>
        {items.map((c) => (
          <li key={c.id}>
            <button
              className="conversation-choice"
              aria-pressed={selected === c.id}
              disabled={deleting || !!target}
              onClick={() => onSelect(c.id)}
            >
              {c.title}
            </button>
            <button className="text-button conversation-delete" disabled={loading || deleting || !!target || deleteBlocked}
              onClick={() => setTarget(c)}>Delete conversation: {c.title}</button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          className="secondary-button"
          disabled={loading || deleting || !!target}
          onClick={() => fetchPage(cursor)}
        >
          Load more conversations
        </button>
      )}
      {target && <section className="upload-panel" aria-labelledby="conversation-delete-heading">
        <h3 id="conversation-delete-heading" tabIndex={-1} ref={confirmation}>Delete conversation?</h3>
        <p>Permanently delete “{target.title}” and all its messages and saved source details? Uploaded documents are kept. Any unsaved draft in this conversation will be cleared. This cannot be undone.</p>
        <button className="primary-button" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting conversation..." : "Confirm conversation deletion"}</button>
        <button className="text-button" disabled={deleting} onClick={() => { setTarget(null); heading.current?.focus(); }}>Cancel conversation deletion</button>
      </section>}
    </aside>
  );
}
