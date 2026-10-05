# Frontend integration — Step 4: Document upload

## What this step delivers

The protected /documents page accepts one PDF, DOCX or TXT file, up to 10 MiB (10 × 1024 × 1024 bytes). It shows uploading/processing state, the returned document status and a manual Refresh status button. Access it from the Documents navigation link after login.

The backend already performs text extraction, chunking, local embeddings and vector storage. This step connects that existing pipeline to the browser. It does not call Gemini.

## How the upload travels

1. Selecting a file gives React a File object with its name, MIME type, size and bytes. The page rejects unsupported extensions, known unsupported MIME types, empty files and files over the size limit. These checks improve feedback; they do not replace backend validation.
2. The page appends that file to FormData under the name `document`, matching Multer's `upload.single("document")`. If the browser supplies no MIME type, a transport hint is chosen from the extension; this is not content verification.
3. The shared authenticated request helper adds the current Bearer token. It does not send organizationId in the form. Express gets the organization from the verified token.
4. The API client sends FormData directly rather than JSON.stringify. It deliberately leaves Content-Type unset, allowing the browser to generate `multipart/form-data; boundary=...`. That boundary is how Multer separates multipart fields and file bytes.
5. Express saves and processes the document before returning 201. The page therefore says Uploading and processing, without inventing a progress percentage.
6. The response contains ID, original filename, status and last-updated timestamp. Only COMPLETED is displayed as Ready for questions. UPLOADED and PROCESSING remain pending; FAILED is explicitly not ready.

## Small backend compatibility change

The upload success response previously had `{ message, document }`, while the shared client expects `{ success, data }`. Upload now adds `success: true` and `data: completedDocument` and retains the existing document field. Existing consumers continue to work. The real pipeline test checks that both fields agree.

## Failure and cancellation behavior

There are no automatic upload retries. The existing 60-second API timeout still applies. If the request fails after it has been sent, the browser cannot reliably tell whether the server saved or continued processing the file. The page reports an unconfirmed result rather than claiming the upload was rolled back. The current failure response does not include the created document ID, so the page cannot recover its status automatically after that failure. A document listing/recovery flow is future work.

A successful response supplies an ID, enabling Refresh status through GET /documents/:id/status. A refresh failure retains the last known status with an explanatory error. A 404 clears the unavailable document. A 401 clears the session through the shared authentication layer.

Navigating away aborts the browser request and ignores late results. It does not cancel processing already running on the server. Keep the page open during the upload when possible.

## Try it with the sample

Start both backend and frontend. Sign in, open Documents, select `samples/nexaai-employee-handbook.txt` from the repository, and choose Upload document. Wait for Ready for questions. Refresh status should still show readiness. You can later ask about the handbook using the existing Postman chat endpoint with the same organization's token.

This page shows only the latest upload while it remains mounted. Navigating away or refreshing clears its display, not the saved document. It is not a complete document library yet. There is no delete/reprocess UI in this step. PDF/DOCX are accepted, but the live pipeline check for this step uses TXT; scanned-image OCR is not implemented.

## Verification

- API/file tests cover multipart bytes and headers, optional MIME types, and exact size boundaries.
- Chrome tests cover selected file content, Bearer headers, pending state, successful processing, status refresh to FAILED, invalid files, upload failure, session expiration and navigation during upload. They use controlled HTTP responses.
- The backend pipeline test performs a real TXT multipart upload against PostgreSQL with local embeddings, verifies persisted text/chunks/384-dimensional vectors and the response envelope, and removes its isolated fixtures.

Commands from frontend:

```powershell
npm.cmd run build
npm.cmd run lint
node --experimental-strip-types --test tests/api.test.mjs tests/upload.test.mjs
npx.cmd playwright test
```

Commands from backend, waiting for the build before the test:

```powershell
npm.cmd run build
node --test tests/document.pipeline.e2e.test.cjs
```

Next: a protected chat page that sends questions to the existing RAG API and renders validated answers and source metadata.
