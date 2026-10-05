import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";
import { DOCUMENT_ACCEPT, parseDocument, validateFile } from "./document.types";
import type { DocumentStatus } from "./document.types";

const labels = {
  UPLOADED: "Waiting for processing",
  PROCESSING: "Processing",
  COMPLETED: "Ready for questions",
  FAILED: "Processing failed",
};

export function DocumentsPage() {
  const { request, session } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [document, setDocument] = useState<DocumentStatus | null>(null);
  const [pending, setPending] = useState<"upload" | "status" | null>(null);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);

  async function run(kind: "upload" | "status") {
    if (active.current) return;
    if (kind === "upload") {
      const invalid = file ? validateFile(file) : "Choose a document first.";
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    if (kind === "status" && !document) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(kind);
    setError("");
    if (kind === "upload") setDocument(null);
    try {
      let result: unknown;
      if (kind === "upload" && file) {
        const form = new FormData();
        // Some browsers omit MIME type; use the selected extension as a transport hint.
        // The backend remains responsible for checking and parsing the file.
        const type = file.name.toLowerCase().endsWith(".pdf")
          ? "application/pdf"
          : file.name.toLowerCase().endsWith(".docx")
            ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            : "text/plain";
        form.append(
          "document",
          file.type ? file : new File([file], file.name, { type }),
          file.name,
        );
        result = await request("/documents/upload", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
      } else if (document) {
        result = await request(`/documents/${document.id}/status`, {
          signal: controller.signal,
        });
      }
      const next = parseDocument(result);
      if (controller.signal.aborted) return;
      setDocument(next);
      if (kind === "upload") {
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
      }
    } catch (failure) {
      if (
        controller.signal.aborted ||
        (failure instanceof DOMException && failure.name === "AbortError")
      )
        return;
      if (
        kind === "status" &&
        failure instanceof ApiError &&
        failure.status === 404
      ) {
        setDocument(null);
        setError("This document is no longer available in your organization.");
      } else if (kind === "upload") {
        setError(
          "We could not confirm that this upload completed. The server may have saved it. Do not repeatedly upload the same file; check its status before trying again.",
        );
      } else {
        setError(
          "Could not refresh the document status. The information below is from the last successful response.",
        );
      }
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setPending(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run("upload");
  }

  return (
    <section className="workspace" aria-labelledby="documents-heading">
      <p className="eyebrow">ORGANIZATION KNOWLEDGE</p>
      <h1
        id="documents-heading"
        tabIndex={-1}
        ref={(element) => element?.focus()}
      >
        Documents
      </h1>
      <p>
        Upload a document to {session?.organization.name} so its contents can be
        used to answer questions.
      </p>
      <form
        className="upload-panel"
        onSubmit={submit}
        aria-busy={pending === "upload"}
      >
        <label htmlFor="document-file">Select a document</label>
        <input
          ref={fileInput}
          id="document-file"
          type="file"
          accept={DOCUMENT_ACCEPT}
          disabled={!!pending}
          aria-describedby="upload-help"
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            setFile(selected);
            setError(selected ? (validateFile(selected) ?? "") : "");
          }}
        />
        <p id="upload-help">
          PDF, DOCX, or TXT. Maximum 10 MiB. Use a text-based document; scanned
          images may not contain extractable text.
        </p>
        {file && (
          <p>
            Selected: {file.name} ({Math.ceil(file.size / 1024)} KiB)
          </p>
        )}
        <button
          type="submit"
          className="primary-button"
          disabled={!!pending || !file || !!(file && validateFile(file))}
        >
          {pending === "upload"
            ? "Uploading and processing..."
            : "Upload document"}
        </button>
        {pending === "upload" && (
          <p role="status">
            Extracting text and preparing your document for questions. Please
            keep this page open.
          </p>
        )}
      </form>
      {error && (
        <p ref={errorElement} className="form-error" role="alert" tabIndex={-1}>
          {error}
        </p>
      )}
      {document && (
        <section className="upload-result" aria-labelledby="latest-upload">
          <h2 id="latest-upload">Latest upload</h2>
          <p className="document-name">{document.originalName}</p>
          <p role="status">
            <strong>{labels[document.status]}</strong>
          </p>
          {document.status === "FAILED" && (
            <p>
              The document could not be processed. It is not ready for
              questions.
            </p>
          )}
          <p>
            Document ID: <span className="document-name">{document.id}</span>
          </p>
          <p>Last updated: {new Date(document.updatedAt).toLocaleString()}</p>
          <button
            className="secondary-button"
            disabled={!!pending}
            onClick={() => void run("status")}
          >
            {pending === "status" ? "Refreshing..." : "Refresh status"}
          </button>
        </section>
      )}
      <p className="session-note">
        This page shows your latest upload while you stay here. Previously saved
        documents are not listed yet.
      </p>
    </section>
  );
}
