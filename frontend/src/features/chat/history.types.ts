import { parseChatAnswer } from "./chat.types";
import type { ChatAnswer } from "./chat.types";

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}
export interface HistoryMessage {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  sequence: number;
  answerStatus: ChatAnswer["status"] | null;
  citations: string[];
  sources: ChatAnswer["sources"];
}
export interface PageInfo {
  hasMore: boolean;
  nextCursor: string | null;
}
export interface ConversationPage {
  conversations: Conversation[];
  page: PageInfo;
}
export interface MessagePage {
  conversation: Conversation;
  messages: HistoryMessage[];
  page: PageInfo;
}
export const isId = (id: unknown): id is string =>
  typeof id === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

function validConversation(value: Conversation) {
  return (
    value &&
    isId(value.id) &&
    typeof value.title === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isFinite(Date.parse(value.updatedAt))
  );
}
function validPage(value: PageInfo) {
  return (
    value &&
    typeof value.hasMore === "boolean" &&
    (value.hasMore
      ? typeof value.nextCursor === "string" &&
        /^[A-Za-z0-9_-]{1,1024}$/.test(value.nextCursor)
      : value.nextCursor === null)
  );
}
// Runtime checks keep malformed data out of the history UI and prevent an invalid
// conversation ID from becoming a request path. The server still owns authorization.
export function parseConversations(value: unknown): ConversationPage {
  const data = value as ConversationPage;
  if (
    !data ||
    !validPage(data.page) ||
    !Array.isArray(data.conversations) ||
    data.conversations.some((c) => !validConversation(c))
  )
    throw new Error("Invalid history");
  return data;
}
export function parseMessages(value: unknown, id: string): MessagePage {
  const data = value as MessagePage;
  if (
    !data ||
    !validConversation(data.conversation) ||
    data.conversation.id !== id ||
    !validPage(data.page) ||
    !Array.isArray(data.messages)
  )
    throw new Error("Invalid messages");
  let previous = -1;
  for (const message of data.messages) {
    if (
      !message ||
      !isId(message.id) ||
      !Number.isInteger(message.sequence) ||
      message.sequence <= previous ||
      typeof message.content !== "string"
    )
      throw new Error("Invalid message");
    previous = message.sequence;
    if (message.role === "ASSISTANT") {
      parseChatAnswer(
        {
          question: "",
          status: message.answerStatus,
          answer: message.content,
          citations: message.citations,
          sources: message.sources,
        },
        "",
      );
    } else if (
      message.role !== "USER" ||
      message.answerStatus !== null ||
      !Array.isArray(message.sources) ||
      message.sources.length ||
      !Array.isArray(message.citations) ||
      message.citations.length
    )
      throw new Error("Invalid question");
  }
  return data;
}
