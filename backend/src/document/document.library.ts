import prisma from "../config/database";
import { getDocumentQueue, QueueProvider } from "./document.queue.runtime";
import { resolveDocumentStatus } from "./document.service";

export class DocumentLibraryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const libraryUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Cursor = { id: string; createdAt: Date };

export function libraryPageInput(
  query: Record<string, unknown>,
  organizationId: string,
) {
  if (Object.keys(query).some((key) => key !== "limit" && key !== "cursor"))
    throw new DocumentLibraryError(400, "Only limit and cursor are supported");
  const limit =
    query.limit === undefined
      ? 10
      : typeof query.limit === "string" && /^[1-9]\d?$/.test(query.limit)
        ? Number(query.limit)
        : 0;
  if (limit < 1 || limit > 50)
    throw new DocumentLibraryError(400, "Limit must be between 1 and 50");
  let cursor: Cursor | undefined;
  if (query.cursor !== undefined) {
    try {
      if (
        typeof query.cursor !== "string" ||
        query.cursor.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(query.cursor)
      )
        throw new Error();
      const data = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      );
      if (
        !data ||
        data.kind !== "documents" ||
        data.organizationId !== organizationId ||
        typeof data.id !== "string" ||
        !libraryUuid.test(data.id) ||
        typeof data.createdAt !== "string" ||
        !Number.isFinite(Date.parse(data.createdAt)) ||
        new Date(data.createdAt).toISOString() !== data.createdAt
      )
        throw new Error();
      cursor = { id: data.id, createdAt: new Date(data.createdAt) };
    } catch {
      throw new DocumentLibraryError(400, "Invalid document cursor");
    }
  }
  return { limit, cursor };
}

export async function listOrganizationDocuments(
  organizationId: string,
  userId: string,
  limit: number,
  cursor?: Cursor,
  queueProvider: QueueProvider = getDocumentQueue,
) {
  // Check CURRENT membership and read metadata from one database snapshot.
  // The signed organization remains a filter even when a cursor is edited.
  const rows = await prisma.$transaction(
    async (tx) => {
      const membership = await tx.organizationMember.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
        select: { id: true },
      });
      if (!membership)
        throw new DocumentLibraryError(
          403,
          "Current organization membership is required",
        );
      return tx.document.findMany({
        where: {
          organizationId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        // Never load file paths, extracted text, chunks, provider errors or vectors for a list.
        select: {
          id: true,
          organizationId: true,
          originalName: true,
          mimeType: true,
          size: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    },
    { isolationLevel: "RepeatableRead" },
  );
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  // Reuse one producer connection (including one failed connection attempt) for
  // this bounded page. Completed documents do not need Redis at all.
  let queue: ReturnType<QueueProvider> | undefined;
  const sharedQueue: QueueProvider = () => (queue ??= queueProvider());
  const documents = await Promise.all(
    visible.map(async (row) => ({
      ...(await resolveDocumentStatus(row, organizationId, sharedQueue)),
      organizationId,
      mimeType: row.mimeType,
      size: row.size,
      createdAt: row.createdAt,
    })),
  );
  const last = visible.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            kind: "documents",
            organizationId,
            id: last.id,
            createdAt: last.createdAt.toISOString(),
          }),
        ).toString("base64url")
      : null;
  return { organizationId, documents, page: { limit, hasMore, nextCursor } };
}
