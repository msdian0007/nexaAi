import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/auth.context";
import { parseConversations } from "./history.types";
import type { Conversation } from "./history.types";

export function ConversationList({
  selected,
  onSelect,
}: {
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const { request } = useAuth();
  const [items, setItems] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const retryCursor = useRef<string | null>(null);

  const load = useCallback(
    (after: string | null, controller: AbortController) => {
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
    const controller = new AbortController();
    active.current = controller;
    void load(null, controller);
    return () => controller.abort();
  }, [load]);
  useEffect(() => () => active.current?.abort(), []);

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
      <h2>Conversations</h2>
      <button
        className="text-button"
        disabled={loading}
        onClick={() => fetchPage(null)}
      >
        Refresh conversations
      </button>
      {loading && <p role="status">Loading conversations...</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="text-button"
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
              onClick={() => onSelect(c.id)}
            >
              {c.title}
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => fetchPage(cursor)}
        >
          Load more conversations
        </button>
      )}
    </aside>
  );
}
