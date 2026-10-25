-- Match the tenant filter and stable creation-time ordering used by library pages.
CREATE INDEX "Document_organizationId_createdAt_id_idx" ON "Document"("organizationId", "createdAt", "id");
