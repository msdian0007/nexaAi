import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.middleware';
import { ConversationMembershipError, ConversationNotFoundError, deleteOwnedConversation } from './conversation.service';
import { listConversations, readConversation } from './conversation.history';
import { HistoryInputError, parseLimit, conversationCursor, messageCursor, UUID } from './conversation.pagination';

// Share validation/error handling while keeping the two read operations explicit.
// Logs and error responses never contain message text, tokens, or database details.
async function history(req: AuthenticatedRequest, res: Response, detail: boolean) {
  res.setHeader('Cache-Control', 'no-store');
  const userId = req.user?.userId;
  const organizationId = req.user?.organizationId;
  if (typeof userId !== 'string' || !userId.trim() || typeof organizationId !== 'string' || !organizationId.trim()) {
    return res.status(401).json({ success: false, message: 'User and organization context are required' });
  }
  try {
    const limit = parseLimit(req.query.limit);
    let data;
    if (detail) {
      const id = req.params.conversationId;
      if (typeof id !== 'string' || !UUID.test(id)) throw new HistoryInputError('conversationId must be a UUID');
      data = await readConversation({ userId, organizationId }, id, limit, messageCursor(req.query.cursor, id));
    } else {
      data = await listConversations({ userId, organizationId }, limit, conversationCursor(req.query.cursor));
    }
    return res.status(200).json({ success: true, data });
  } catch (error) {
    if (error instanceof HistoryInputError) return res.status(400).json({ success: false, message: error.message });
    if (error instanceof ConversationNotFoundError) return res.status(404).json({ success: false, code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
    if (error instanceof ConversationMembershipError) return res.status(403).json({ success: false, code: 'MEMBERSHIP_REQUIRED', message: 'You are no longer a member of this organization' });
    console.error('Conversation history read failed');
    return res.status(500).json({ success: false, message: 'Unable to load conversation history' });
  }
}

export const conversationList = (req: AuthenticatedRequest, res: Response) => history(req, res, false);
export const conversationMessages = (req: AuthenticatedRequest, res: Response) => history(req, res, true);

export const conversationDelete = async (req: AuthenticatedRequest, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  const userId = req.user?.userId, organizationId = req.user?.organizationId;
  if (typeof userId !== 'string' || !UUID.test(userId) || typeof organizationId !== 'string' || !UUID.test(organizationId))
    return res.status(401).json({ success: false, message: 'Valid user and organization context are required' });
  const id = req.params.conversationId;
  if (typeof id !== 'string' || !UUID.test(id) || Object.keys(req.query).length ||
      (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)))
    return res.status(400).json({ success: false, message: 'Provide only the conversation ID in the URL' });
  try {
    return res.json({ success: true, data: await deleteOwnedConversation({ userId, organizationId }, id) });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) return res.status(404).json({ success: false, code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' });
    if (error instanceof ConversationMembershipError) return res.status(403).json({ success: false, code: 'MEMBERSHIP_REQUIRED', message: 'Current organization membership is required' });
    console.error('Conversation deletion failed');
    return res.status(500).json({ success: false, message: 'Could not confirm conversation deletion' });
  }
};
