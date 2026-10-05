import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";
import { parseChatAnswer } from "./chat.types";
import type { ChatAnswer } from "./chat.types";

const statusLabels = {
  answered: "Answer found",
  insufficient_information: "Not enough information",
  conflicting_evidence: "Conflicting information",
};

// Provider failures are different from a valid "not enough information" answer.
// Keep those states separate and never turn an outage into an evidence claim.
function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return "The answer could not be displayed. Please try again.";
  if (error.code === "GENERATION_TIMEOUT" || error.code === "TIMEOUT")
    return "The answer took too long. You can try the question again.";
  if (error.code === "GENERATION_BLOCKED")
    return "The answer provider could not process this question. Try rephrasing it.";
  if (error.code === "INVALID_ANSWER" || error.code === "GENERATION_FAILED")
    return "The provider did not return a usable answer. Please try again.";
  if (error.code === "GENERATION_UNAVAILABLE")
    return "Answer generation is temporarily unavailable. Please try again later.";
  return error.message;
}

export function ChatPage() {
  const { request, session } = useAuth();
  const [question, setQuestion] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);

  // Leaving the page cancels our wait and prevents a late response updating this view.
  // The provider may already be working; browser cancellation cannot undo that call.
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (answer) resultHeading.current?.focus();
  }, [answer]);
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return; // Stops duplicate submissions before React re-renders.
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > 1000) {
      setError("Enter a question between 1 and 1,000 characters.");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setSubmitted(trimmed);
    setPending(true);
    setAnswer(null); // Do not leave a previous answer beneath a new question.
    setError("");
    try {
      // The shared helper supplies the token and handles 401. Organization and
      // source selection stay on the server; the browser sends only this question.
      const response = await request("/chat/query", {
        method: "POST",
        body: { question: trimmed },
        signal: controller.signal,
      });
      const validated = parseChatAnswer(response, trimmed);
      if (!controller.signal.aborted) setAnswer(validated);
    } catch (failure) {
      if (
        controller.signal.aborted ||
        (failure instanceof DOMException && failure.name === "AbortError")
      )
        return;
      setError(errorMessage(failure)); // Preserve input for a deliberate retry; no automatic model calls.
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <section className="workspace chat-page" aria-labelledby="chat-heading">
      <p className="eyebrow">ASK YOUR DOCUMENTS</p>
      <h1 id="chat-heading" tabIndex={-1} ref={(element) => element?.focus()}>
        Chat
      </h1>
      <p>
        Ask a question about {session?.organization.name}&apos;s processed
        documents. <Link to="/documents">Upload a document</Link> if you have
        not added one yet.
      </p>
      <form className="question-panel" onSubmit={submit} aria-busy={pending}>
        <label htmlFor="question">Your question</label>
        <textarea
          id="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={pending}
          maxLength={1000}
          rows={4}
          aria-describedby="question-help"
          required
        />
        <p id="question-help">
          {question.length}/1,000 characters. Each question is answered
          independently; include the details it needs.
        </p>
        <button
          className="primary-button"
          disabled={pending || !question.trim()}
          type="submit"
        >
          {pending ? "Finding an answer..." : "Ask question"}
        </button>
      </form>
      {pending && (
        <p role="status">Searching your documents and preparing an answer...</p>
      )}
      {error && (
        <p className="form-error" role="alert" tabIndex={-1} ref={errorElement}>
          {error}
        </p>
      )}
      {answer && (
        <article className="answer-panel" aria-labelledby="answer-heading">
          <p className="asked-question">
            <strong>You asked:</strong> {submitted}
          </p>
          <h2 id="answer-heading" ref={resultHeading} tabIndex={-1}>
            {statusLabels[answer.status]}
          </h2>
          {/* React escapes both answer text and filenames. Do not interpret model output as HTML. */}
          <p className="answer-text">{answer.answer}</p>
          {answer.sources.length > 0 ? (
            <section aria-label="Answer sources">
              <h3>Sources</h3>
              <ul className="source-list">
                {answer.sources.map((source) => (
                  <li key={source.sourceId}>
                    <strong>
                      [{source.sourceId}] {source.documentName}
                    </strong>
                    {/* Chunk indexes identify extracted passages, not original PDF page numbers. */}
                    <span>Passage {source.chunkIndex + 1}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p>No supporting sources were returned for this question.</p>
          )}
        </article>
      )}
      <p className="session-note">
        Only the latest answer is shown here. It is not saved as conversation
        history.
      </p>
    </section>
  );
}
