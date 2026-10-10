import prisma from '../config/database';
import { ConversationMembershipError, ConversationNotFoundError } from './conversation.service';
import { encodeCursor } from './conversation.pagination';

type Owner = { userId: string; organizationId: string };
const summary = { id: true, title: true, createdAt: true, updatedAt: true } as const;

export async function listConversations(owner: Owner, limit: number, cursor?: { id: string; updatedAt: Date }) {
  // Membership and data are read from the same database snapshot. This does not
  // lock rows or hold a transaction open across multiple HTTP pages.
  return prisma.$transaction(async tx => {
    const membership = await tx.organizationMember.findUnique({ where: { userId_organizationId: owner }, select: { id: true } });
    if (!membership) throw new ConversationMembershipError();
    const rows = await tx.conversation.findMany({
      where: { ...owner, ...(cursor ? { OR: [
        { updatedAt: { lt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
      ] } : {}) },
      // The ID breaks ties when several conversations share an updatedAt timestamp.
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: limit + 1, select: summary,
    });
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit);
    const last = conversations.at(-1);
    return { conversations, page: { limit, hasMore,
      nextCursor: hasMore && last ? encodeCursor({ kind: 'conversations', id: last.id, updatedAt: last.updatedAt.toISOString() }) : null,
    } };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function readConversation(owner: Owner, id: string, limit: number, afterSequence?: number) {
  return prisma.$transaction(async tx => {
    const membership = await tx.organizationMember.findUnique({ where: { userId_organizationId: owner }, select: { id: true } });
    if (!membership) throw new ConversationMembershipError();
    const conversation = await tx.conversation.findFirst({ where: { id, ...owner }, select: summary });
    if (!conversation) throw new ConversationNotFoundError();
    const rows = await tx.message.findMany({
      // Keep the ownership condition on the message query too, not only its preceding lookup.
      where: { conversationId: id, organizationId: owner.organizationId, conversation: { userId: owner.userId },
        ...(afterSequence === undefined ? {} : { sequence: { gt: afterSequence } }) },
      orderBy: { sequence: 'asc' }, take: limit + 1,
      select: { id: true, role: true, content: true, sequence: true, answerStatus: true, createdAt: true,
        sources: { orderBy: { sourceId: 'asc' }, select: {
          sourceId: true, documentId: true, chunkId: true, documentName: true, chunkIndex: true, similarity: true,
        } },
      },
    });
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).map(message => ({ ...message,
      // Labels come from stored snapshots; no live document join can rewrite them.
      citations: message.sources.map(source => source.sourceId),
    }));
    const last = messages.at(-1);
    return { conversation, messages, page: { limit, hasMore,
      nextCursor: hasMore && last ? encodeCursor({ kind: 'messages', conversationId: id, sequence: last.sequence }) : null,
    } };
  }, { isolationLevel: 'RepeatableRead' });
}
