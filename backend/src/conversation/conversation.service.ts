import prisma from '../config/database';
import { answerDocumentQuestion } from '../rag/rag.service';

export class ConversationNotFoundError extends Error {}
export class ConversationMembershipError extends Error {}
type Answer = Awaited<ReturnType<typeof answerDocumentQuestion>>;
type Owner = { organizationId: string; userId: string };

// Check ownership before retrieval or a provider call. Inaccessible and missing
// conversations deliberately have the same response, avoiding history disclosure.
async function checkAccess(owner: Owner, conversationId?: string) {
  if (conversationId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, ...owner }, select: { id: true },
    });
    if (!conversation) throw new ConversationNotFoundError();
  }
  const membership = await prisma.organizationMember.findUnique({
    where: { userId_organizationId: owner }, select: { id: true },
  });
  if (!membership) throw new ConversationMembershipError();
}

async function saveExchange(owner: Owner, question: string, answer: Answer, conversationId?: string) {
  return prisma.$transaction(async tx => {
    // Recheck membership after generation and lock it briefly against deletion.
    // No transaction or database lock stays open during the Gemini request.
    const membership = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "OrganizationMember"
      WHERE "userId" = ${owner.userId} AND "organizationId" = ${owner.organizationId}
      FOR KEY SHARE`;
    if (!membership.length) throw new ConversationMembershipError();
    let id = conversationId;
    if (id) {
      // Prisma has no SELECT FOR UPDATE option. Parameterized SQL locks this
      // parent row so concurrent writers cannot allocate the same message numbers.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Conversation"
        WHERE "id" = ${id} AND "organizationId" = ${owner.organizationId} AND "userId" = ${owner.userId}
        FOR UPDATE`;
      if (!locked.length) throw new ConversationNotFoundError();
    } else {
      const conversation = await tx.conversation.create({ data: {
        ...owner,
        // Shorten the first question without cutting a Unicode character in half.
        title: Array.from(question).slice(0, 200).join(''),
      }, select: { id: true } });
      id = conversation.id;
    }
    // The parent lock serializes saves. Order reflects completed saves, not the
    // order in which concurrent model requests were started.
    const last = await tx.message.aggregate({
      where: { conversationId: id, organizationId: owner.organizationId }, _max: { sequence: true },
    });
    const sequence = (last._max.sequence ?? -1) + 1;
    const userMessage = await tx.message.create({ data: {
      conversationId: id, organizationId: owner.organizationId, role: 'USER', content: question, sequence,
    }, select: { id: true } });
    const assistantMessage = await tx.message.create({ data: {
      conversationId: id, organizationId: owner.organizationId, role: 'ASSISTANT',
      content: answer.answer, answerStatus: answer.status, sequence: sequence + 1,
    }, select: { id: true } });
    // Only server-validated citations are persisted. Both messages, these
    // snapshots, and the parent timestamp succeed or roll back together.
    if (answer.sources.length) await tx.messageSource.createMany({ data: answer.sources.map(source => ({
      messageId: assistantMessage.id, organizationId: owner.organizationId,
      sourceId: source.sourceId, documentId: source.documentId, chunkId: source.chunkId,
      documentName: source.documentName, chunkIndex: source.chunkIndex, similarity: source.similarity,
    })) });
    await tx.conversation.update({ where: { id }, data: { updatedAt: new Date() } });
    return { conversationId: id, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id };
  });
}

export async function answerAndSaveQuestion(
  owner: Owner, question: string, topK: number, minSimilarity: number, conversationId?: string,
) {
  await checkAccess(owner, conversationId);
  // Generation/validation failure leaves no empty conversation or orphan question.
  const answer = await answerDocumentQuestion(owner.organizationId, question, topK, minSimilarity);
  const saved = await saveExchange(owner, question, answer, conversationId);
  return { ...answer, ...saved };
}
