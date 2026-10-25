import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";
import { parseDocument, processingState } from "./document.types";
import type { DocumentStatus } from "./document.types";

const activeStates = ["QUEUED", "PROCESSING", "RETRYING", "UNAVAILABLE"];
export function LibraryProcessingActions({ document, disabled, onUpdate }: {
  document: DocumentStatus; disabled: boolean; onUpdate: (next: DocumentStatus) => void;
}) {
  const { request } = useAuth();
  const [pending, setPending] = useState(false);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState("");
  const [needsRead, setNeedsRead] = useState(false);
  const mutation = useRef<AbortController | null>(null);
  const state = processingState(document);
  const deleting = state === "DELETING";
  const canRetry = document.canRetry === true && ["FAILED", "NOT_QUEUED"].includes(state);
  useEffect(() => () => mutation.current?.abort(), []);

  useEffect(() => {
    if (!watching || disabled || pending || !activeStates.includes(state)) return;
    const controller = new AbortController();
    // Only documents explicitly retried/refreshed here are watched. Schedule the
    // next read after a response; never automatically repeat a POST or overlap polls.
    const timer = setTimeout(async () => {
      try {
        const next = parseDocument(await request(`/documents/${document.id}/status`, { signal: controller.signal }));
        if (next.id !== document.id) throw new Error("Mismatched document");
        if (controller.signal.aborted) return;
        onUpdate(next);
        if (!activeStates.includes(processingState(next))) setWatching(false);
      } catch {
        if (controller.signal.aborted) return;
        setWatching(false); setNeedsRead(true);
        setError("Automatic checks paused. Refresh this document's processing status to continue.");
      }
    }, state === "UNAVAILABLE" ? 5000 : 2000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [document, state, watching, disabled, pending, request, onUpdate]);

  async function run(retry: boolean) {
    if (mutation.current || disabled || deleting || (retry && (!canRetry || needsRead))) return;
    const controller = new AbortController(); mutation.current = controller;
    setPending(true); setWatching(false); setError("");
    try {
      const next = parseDocument(await request(`/documents/${document.id}/${retry ? "reprocess" : "status"}`, {
        method: retry ? "POST" : "GET", signal: controller.signal,
      }));
      if (next.id !== document.id) throw new Error("Mismatched document");
      if (controller.signal.aborted) return;
      onUpdate(next); setNeedsRead(false);
      setWatching(activeStates.includes(processingState(next)));
    } catch (failure) {
      if (controller.signal.aborted) return;
      // A lost acknowledgement may still mean the job was queued. Require GET
      // before another POST, preserving the existing card and saved file.
      setNeedsRead(true);
      const status = failure instanceof ApiError ? failure.status : 0;
      setError(status === 403 ? "Your permission to process this document has changed. Reload the library."
        : status === 404 ? "This document is no longer available. Reload the library."
        : status === 409 ? "Processing or deletion state changed. Refresh processing status before trying again."
        : retry ? "Could not confirm the retry. Refresh processing status before trying again; it may already be queued."
        : "Could not refresh processing status. The last successful information is still shown.");
    } finally {
      if (mutation.current === controller) mutation.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  if (deleting) return null;
  return <div className="library-processing-actions">
    {error && <p role="alert" className="form-error">{error}</p>}
    {watching && activeStates.includes(state) && <p>Checking this document's progress automatically.</p>}
    {canRetry && <button className="secondary-button" disabled={disabled || pending || needsRead} onClick={() => void run(true)}>
      {pending ? "Submitting..." : state === "NOT_QUEUED" ? "Start processing" : "Retry processing"} {document.originalName}
    </button>}{" "}
    <button className="text-button" disabled={disabled || pending} onClick={() => void run(false)}>Refresh processing status for {document.originalName}</button>
  </div>;
}
