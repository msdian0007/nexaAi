import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";
import { parseChatAnswer } from "./chat.types";
import type { ChatAnswer } from "./chat.types";
import { ConversationList } from "./ConversationList";
import { isId, parseMessages } from "./history.types";
import type { HistoryMessage } from "./history.types";

const labels = {
  answered: "Answer found",
  insufficient_information: "Not enough information",
  conflicting_evidence: "Conflicting information",
};
type Exchange = { id: string; question: string; answer: ChatAnswer };

// Render stored and newly generated answers the same way. React escapes all text,
// including filenames; passage numbers represent chunks, not PDF pages.
function AnswerView({
  answer,
  focus = false,
}: {
  answer: ChatAnswer;
  focus?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus a newly appended answer once, not on every draft keystroke/re-render.
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  return (
    <article className="answer-panel">
      <h2 tabIndex={-1} ref={heading}>
        {labels[answer.status]}
      </h2>
      <p className="answer-text">{answer.answer}</p>
      {answer.sources.length ? (
        <section aria-label="Answer sources">
          <h3>Sources</h3>
          <ul className="source-list">
            {answer.sources.map((source) => (
              <li key={source.sourceId}>
                <strong>
                  [{source.sourceId}] {source.documentName}
                </strong>
                <span>Passage {source.chunkIndex + 1}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p>No supporting sources were returned for this question.</p>
      )}
    </article>
  );
}

function ConversationChat({
  initialId,
  onSaved,
}: {
  initialId?: string;
  onSaved: (id: string) => void;
}) {
  const { request } = useAuth();
  const [conversationId, setConversationId] = useState(initialId);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(!!initialId);
  const [historyError, setHistoryError] = useState("");
  const [historyReady, setHistoryReady] = useState(!initialId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);

  const loadMessages = useCallback(
    (id: string, after: string | null, controller: AbortController) => {
      return request(`/chat/conversations/${id}/messages`, {
        query: { limit: 20, ...(after ? { cursor: after } : {}) },
        signal: controller.signal,
      })
        .then((response) => {
          const page = parseMessages(response, id);
          if (controller.signal.aborted) return;
          setMessages((old) => [
            ...new Map(
              [...(after ? old : []), ...page.messages].map((m) => [m.id, m]),
            ).values(),
          ]);
          setCursor(page.page.nextCursor);
          setHistoryReady(true);
          setHistoryError("");
        })
        .catch((failure: unknown) => {
          if (controller.signal.aborted) return;
          setHistoryError(
            failure instanceof ApiError && failure.status === 404
              ? "This conversation is no longer available."
              : "Could not load messages. Please try again.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted) setHistoryLoading(false);
        });
    },
    [request],
  );

  // The parent keys this component by selection. Unmounting clears drafts and
  // cancels both kinds of requests, preventing replies from crossing conversations.
  useEffect(() => {
    if (!initialId) return;
    const controller = new AbortController();
    historyRequest.current = controller;
    void loadMessages(initialId, null, controller);
    return () => controller.abort();
  }, [initialId, loadMessages]);
  useEffect(
    () => () => {
      active.current?.abort();
      historyRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (error) errorElement.current?.focus();
  }, [error]);

  function moreMessages() {
    if (!initialId || historyLoading) return;
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryLoading(true);
    setHistoryError("");
    void loadMessages(initialId, cursor, controller);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      active.current ||
      historyLoading ||
      !historyReady ||
      cursor ||
      historyError
    )
      return;
    const trimmed = question.trim();
    if (!trimmed || trimmed.length > 1000) {
      setError("Enter a question between 1 and 1,000 characters.");
      return;
    }
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError("");
    try {
      const response = await request("/chat/query", {
        method: "POST",
        body: {
          question: trimmed,
          ...(conversationId ? { conversationId } : {}),
        },
        signal: controller.signal,
      });
      const answer = parseChatAnswer(response, trimmed);
      const saved = response as {
        conversationId?: unknown;
        userMessageId?: unknown;
        assistantMessageId?: unknown;
      };
      // Persistence IDs are required for continuation. Never silently start another
      // conversation because the server returned an incomplete save response.
      if (
        !isId(saved.conversationId) ||
        !isId(saved.userMessageId) ||
        !isId(saved.assistantMessageId) ||
        (conversationId && saved.conversationId !== conversationId)
      )
        throw new Error("Invalid saved exchange");
      if (controller.signal.aborted) return;
      setConversationId(saved.conversationId);
      setExchanges((old) => [
        ...old,
        { id: saved.assistantMessageId as string, question: trimmed, answer },
      ]);
      onSaved(saved.conversationId);
      setQuestion("");
    } catch (failure) {
      if (
        controller.signal.aborted ||
        (failure instanceof DOMException && failure.name === "AbortError")
      )
        return;
      // Preserve existing messages and the draft on errors. Reads do not call Gemini,
      // but retrying a submission can: no generation request is retried automatically.
      setError(
        failure instanceof ApiError
          ? failure.code === "GENERATION_UNAVAILABLE"
            ? "Answer generation is temporarily unavailable. Please try again later."
            : failure.status === 404
              ? "This conversation is no longer available. Start a new conversation."
              : failure.message
          : "The answer could not be displayed. Reload history before retrying; it may already have been saved.",
      );
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  const blocked =
    pending || historyLoading || !historyReady || !!cursor || !!historyError;
  return (
    <div className="conversation-content">
      <h2>{conversationId ? "Conversation" : "New conversation"}</h2>
      {historyLoading && <p role="status">Loading messages...</p>}
      {historyError && (
        <p role="alert">
          {historyError}{" "}
          <button className="text-button" onClick={moreMessages}>
            Retry messages
          </button>
        </p>
      )}
      {messages.map((message) =>
        message.role === "USER" ? (
          <p className="asked-question" key={message.id}>
            <strong>You asked:</strong> {message.content}
          </p>
        ) : (
          <AnswerView
            key={message.id}
            answer={{
              question: "",
              status: message.answerStatus!,
              answer: message.content,
              citations: message.citations,
              sources: message.sources,
            }}
          />
        ),
      )}
      {cursor && (
        <button
          className="secondary-button"
          disabled={historyLoading}
          onClick={moreMessages}
        >
          Load more messages
        </button>
      )}
      {cursor && (
        <p>Load the remaining messages before continuing this conversation.</p>
      )}
      {exchanges.map((exchange, index) => (
        <div key={exchange.id}>
          <p className="asked-question">
            <strong>You asked:</strong> {exchange.question}
          </p>
          <AnswerView
            answer={exchange.answer}
            focus={index === exchanges.length - 1}
          />
        </div>
      ))}
      <form className="question-panel" onSubmit={submit} aria-busy={pending}>
        <label htmlFor="question">Your question</label>
        <textarea
          id="question"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={blocked}
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
          disabled={blocked || !question.trim()}
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
    </div>
  );
}

export function ChatPage() {
  const { session } = useAuth();
  const [selection, setSelection] = useState<{ key: string; id?: string }>({
    key: "new",
  });
  const [highlighted, setHighlighted] = useState<string>();
  const [listVersion, setListVersion] = useState(0);
  return (
    <section className="workspace chat-page" aria-labelledby="chat-heading">
      <p className="eyebrow">ASK YOUR DOCUMENTS</p>
      <h1 id="chat-heading">Chat</h1>
      <p>
        Ask about {session?.organization.name}&apos;s documents.{" "}
        <Link to="/documents">Upload a document</Link> to add knowledge.
      </p>
      <button
        className="secondary-button"
        onClick={() => {
          setSelection({ key: crypto.randomUUID() });
          setHighlighted(undefined);
        }}
      >
        New conversation
      </button>
      <div className="history-layout">
        <ConversationList
          key={listVersion}
          selected={highlighted}
          onSelect={(id) => {
            setSelection({ key: id, id });
            setHighlighted(id);
          }}
        />
        <ConversationChat
          key={selection.key}
          initialId={selection.id}
          onSaved={(id) => {
            // Refresh list ordering after a save without remounting the active composer.
            setHighlighted(id);
            setListVersion((version) => version + 1);
          }}
        />
      </div>
      <p className="session-note">
        Saved history is private to your account in this organization. Earlier
        messages are not yet used as model context.
      </p>
    </section>
  );
}
