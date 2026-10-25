import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/auth.context";
import {
  parseDocumentLibrary,
  processingState,
  PROCESSING_LABELS,
} from "./document.types";
import type { LibraryDocument, DocumentStatus } from "./document.types";

export function DocumentLibrary({
  revision,
  latest,
}: {
  revision: number;
  latest: DocumentStatus | null;
}) {
  const { session, request } = useAuth();
  const organizationId = session?.organization.id ?? "";
  const [items, setItems] = useState<LibraryDocument[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const retryCursor = useRef<string | null>(null);
  const load = useCallback(
    (after: string | null, controller: AbortController) => {
      return request("/documents", {
        query: { limit: 10, ...(after ? { cursor: after } : {}) },
        signal: controller.signal,
      })
        .then((response) => {
          const data = parseDocumentLibrary(response, organizationId);
          if (controller.signal.aborted) return;
          if (after && data.page.nextCursor === after)
            throw new Error("Non-advancing cursor");
          // Stable creation ordering plus ID deduplication keeps Load more safe when
          // uploads are added between requests. Refresh starts again at the newest page.
          setItems((old) => [
            ...new Map(
              [...(after ? old : []), ...data.documents].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          ]);
          setCursor(data.page.nextCursor);
          setError("");
          setLoaded(true);
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              "Could not load the document library. Previously loaded information is kept; retry to check the latest state.",
            );
        })
        .finally(() => {
          if (active.current === controller) active.current = null;
          if (!controller.signal.aborted) setLoading(false);
        });
    },
    [request, organizationId],
  );

  useEffect(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    retryCursor.current = null;
    void load(null, controller);
    return () => controller.abort();
  }, [load, revision]);
  useEffect(() => () => active.current?.abort(), []);

  function fetchPage(after: string | null) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    retryCursor.current = after;
    setLoading(true);
    setError("");
    void load(after, controller);
  }
  return (
    <section className="document-library" aria-labelledby="library-heading">
      <h2 id="library-heading">Document library</h2>
      <p>
        Saved documents in {session?.organization.name}, newest first. Refresh
        to see recent uploads and processing changes.
      </p>
      <button
        className="secondary-button"
        disabled={loading}
        onClick={() => fetchPage(null)}
      >
        Refresh library
      </button>
      {loading && <p role="status">Loading document library...</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}{" "}
          <button
            className="text-button"
            disabled={loading}
            onClick={() => fetchPage(retryCursor.current)}
          >
            Retry library
          </button>
        </p>
      )}
      {loaded && !loading && !error && !items.length && (
        <p>No saved documents yet. Upload your first document above.</p>
      )}
      {items.length > 0 && (
        <p>
          Showing {items.length} saved{" "}
          {items.length === 1 ? "document" : "documents"}.
        </p>
      )}
      {items.map((item) => {
        // The latest upload already polls on this page. Share that fresher state
        // with its library card without extra requests or changing its metadata.
        const document =
          latest?.id === item.id &&
          Date.parse(latest.updatedAt) >= Date.parse(item.updatedAt)
            ? latest
            : item;
        const state = processingState(document);
        return (
          <article
            key={item.id}
            className="upload-result document-card"
            aria-label={`Document ${item.originalName}`}
          >
            <h3 className="document-name">{item.originalName}</h3>
            <p>
              <strong>{PROCESSING_LABELS[state]}</strong>
            </p>
            <p>
              {item.mimeType} · {Math.ceil(item.size / 1024)} KiB
            </p>
            <p>Uploaded: {new Date(item.createdAt).toLocaleString()}</p>
            <p>Last updated: {new Date(document.updatedAt).toLocaleString()}</p>
            {state === "FAILED" && (
              <p>This document is not ready for questions.</p>
            )}
            {state === "UNAVAILABLE" && (
              <p>
                Your file is saved. Refresh the library when processing status
                is available.
              </p>
            )}
            {state === "RETRYING" && (
              <p>Another processing attempt is scheduled automatically.</p>
            )}
          </article>
        );
      })}
      {cursor && !error && (
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => fetchPage(cursor)}
        >
          Load more documents
        </button>
      )}
    </section>
  );
}
