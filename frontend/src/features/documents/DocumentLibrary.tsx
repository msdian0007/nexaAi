import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/auth.context";
import {
  parseDocumentLibrary,
  processingState,
  PROCESSING_LABELS,
} from "./document.types";
import type { LibraryDocument, DocumentStatus } from "./document.types";
import { ApiError } from "../../services/api";

export function DocumentLibrary({
  revision,
  latest,
  onDeletion,
}: {
  revision: number;
  latest: DocumentStatus | null;
  onDeletion: (id: string) => void;
}) {
  const { session, request } = useAuth();
  const organizationId = session?.organization.id ?? "";
  const [items, setItems] = useState<LibraryDocument[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [canDelete, setCanDelete] = useState(false);
  const [target, setTarget] = useState<LibraryDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState("");
  const deletion = useRef<AbortController | null>(null);
  const confirmation = useRef<HTMLHeadingElement>(null);
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
          setCanDelete(data.canDelete);
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
  useEffect(() => () => { active.current?.abort(); deletion.current?.abort(); }, []);
  useEffect(() => { if (target) confirmation.current?.focus(); }, [target]);

  function fetchPage(after: string | null) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    retryCursor.current = after;
    setLoading(true);
    setError("");
    void load(after, controller);
  }
  async function remove() {
    if (!target || !canDelete || deletion.current) return;
    active.current?.abort();
    const controller = new AbortController(); deletion.current = controller;
    setDeleting(true); setError(""); setNotice("");
    try {
      const result = await request<{ documentId: string; organizationId: string; deleted: boolean; cleanupPending: boolean }>(`/documents/${target.id}`, {
        method: "DELETE", signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result?.documentId !== target.id || result.organizationId !== organizationId ||
          typeof result.deleted !== "boolean" || typeof result.cleanupPending !== "boolean" || result.deleted === result.cleanupPending)
        throw new Error("Invalid deletion response");
      onDeletion(target.id);
      if (result.deleted) setItems(old => old.filter(item => item.id !== target.id));
      else setItems(old => old.map(item => item.id === target.id ? { ...item, processingState: "DELETING", canRetry: false } : item));
      setNotice(result.deleted ? "Document, searchable chunks and stored file deleted. Saved answers and citation details were kept."
        : "Document is blocked from new questions. Cleanup is pending; use Finish deletion to retry cleanup.");
      setTarget(null);
      fetchPage(null);
    } catch (failure) {
      if (controller.signal.aborted) return;
      // Do not automatically repeat a DELETE after an uncertain response.
      setCanDelete(false); setTarget(null);
      setError(failure instanceof ApiError && failure.status === 409
        ? "The document is being processed or its storage needs attention. Wait, then refresh the library before trying again."
        : failure instanceof ApiError && failure.status === 403 ? "Your permission to delete documents has changed. Refresh the library."
        : "Could not confirm deletion. Refresh the library to check its saved state before trying again.");
    } finally {
      if (deletion.current === controller) deletion.current = null;
      if (!controller.signal.aborted) setDeleting(false);
    }
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
        disabled={loading || deleting || !!target}
        onClick={() => fetchPage(null)}
      >
        Refresh library
      </button>
      {loading && <p role="status">Loading document library...</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}{" "}
          <button
            className="text-button"
            disabled={loading || deleting || !!target}
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
          item.processingState !== "DELETING" && latest?.id === item.id &&
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
            {state === "DELETING" && <p>This document is excluded from new questions. File or queue cleanup still needs to finish.</p>}
            {canDelete && <button className="secondary-button" disabled={loading || deleting || !!target} onClick={() => setTarget(item)}>
              {state === "DELETING" ? "Finish deletion of" : "Delete"} {item.originalName}
            </button>}
          </article>
        );
      })}
      {cursor && !error && (
        <button
          className="secondary-button"
          disabled={loading || deleting || !!target}
          onClick={() => fetchPage(cursor)}
        >
          Load more documents
        </button>
      )}
      {target && <section className="upload-panel" aria-labelledby="confirm-document-deletion">
        <h3 id="confirm-document-deletion" tabIndex={-1} ref={confirmation}>Confirm document deletion</h3>
        <p>Delete {target.originalName} from {session?.organization.name}? This permanently removes its stored file and searchable chunks for everyone in this organization. Saved answers and their citation details remain. This cannot be undone.</p>
        <button className="primary-button" disabled={deleting} onClick={() => void remove()}>{deleting ? "Deleting..." : "Confirm deletion"}</button>{" "}
        <button className="secondary-button" disabled={deleting} onClick={() => setTarget(null)}>Cancel deletion</button>
      </section>}
    </section>
  );
}
