export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly data?: unknown;

  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
  // Keep query values separate from the validated path; URLSearchParams escapes cursors.
  query?: Record<string, string | number>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// VITE_ settings are public browser configuration. Never put provider keys here.
const defaultBaseUrl =
  import.meta.env?.VITE_API_BASE_URL || "http://localhost:5000/api/v1";

export function createApiClient(
  baseUrl = defaultBaseUrl,
  fetchImpl: typeof fetch = fetch,
) {
  const base = baseUrl.replace(/\/+$/, "");

  return async function request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    // Prevent accidentally sending a Bearer token to a caller-supplied external URL.
    if (!/^\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(path)) {
      throw new ApiError("Invalid API path", 0, "INVALID_PATH");
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    const multipart = options.body instanceof FormData;
    if (options.body !== undefined && !multipart)
      headers["Content-Type"] = "application/json";
    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    const timeout = AbortSignal.timeout(60000);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    try {
      const query = new URLSearchParams(
        Object.entries(options.query ?? {}).map(([key, value]) => [
          key,
          String(value),
        ]),
      );
      const response = await fetchImpl(
        `${base}${path}${query.size ? `?${query}` : ""}`,
        {
          method: options.method ?? "GET",
          headers,
          body: multipart
            ? (options.body as FormData)
            : options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined;
        // Known codes get actionable, locally written text. Never display a
        // server's arbitrary error message, even for upload/validation failures.
        const inputMessages: Record<string, string> = {
          USAGE_UNAVAILABLE: "Request allowance verification is unavailable. Nothing was submitted. Please try again later.",
          ORIGIN_NOT_ALLOWED: "Open NexaAI from an allowed frontend address.",
          UPLOAD_TOO_LARGE: "The file must be 10 MiB or smaller.",
          UNSUPPORTED_FILE_TYPE: "Choose a PDF, DOCX, or TXT file with a matching file type.",
          INVALID_FILE_CONTENT: "The file content does not match its format. Choose a valid PDF, DOCX, or UTF-8 TXT file.",
          EMPTY_UPLOAD: "This file is empty. Choose a file containing content.",
          INVALID_UPLOAD: "Upload exactly one document file without additional fields.",
          UPLOAD_SAVE_UNCONFIRMED: "File saving could not be confirmed. Refresh the document library before uploading again.",
        };
        const inputMessage = code && Object.prototype.hasOwnProperty.call(inputMessages, code) ? inputMessages[code] : undefined;
        // Show bounded integer seconds rather than arbitrary server text.
        const retryValue = response.headers.get("Retry-After") ?? (isRecord(payload) ? payload.retryAfterSeconds : undefined);
        const retrySeconds = typeof retryValue === "number" ? retryValue : typeof retryValue === "string" && /^[0-9]{1,5}$/.test(retryValue) ? Number(retryValue) : 0;
        const retryMessage = Number.isSafeInteger(retrySeconds) && retrySeconds >= 1 && retrySeconds <= 86400
          ? `Too many requests. Try again in ${retrySeconds} seconds.` : "Too many requests. Please try again later.";
        // Backend auth handlers may return internal error messages. Use safe UI text.
        const message =
          response.status === 401
            ? "Please sign in again or check your email and password."
            : response.status === 403
              ? "You do not have permission to perform this action."
              : response.status === 429
                ? retryMessage
                : response.status >= 500
                  ? "The service is currently unavailable. Please try again later."
                  : "The request could not be completed. Please check your details.";
        throw new ApiError(
          inputMessage || (response.status === 413 ? "The request is too large. Use a smaller request or file." : response.status === 415 ? "The file or request format is not supported." : message),
          response.status,
          code,
          // Views must validate this before use. A failed queue submission can
          // still include a safely scoped, saved document that the user can recover.
          isRecord(payload) && payload.code === "DOCUMENT_QUEUE_UNAVAILABLE"
            ? payload.data
            : undefined,
        );
      }
      if (
        !isRecord(payload) ||
        payload.success !== true ||
        !("data" in payload)
      ) {
        throw new ApiError(
          "The server returned an unexpected response.",
          response.status,
          "INVALID_RESPONSE",
        );
      }
      return payload.data as T;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (timeout.aborted)
        throw new ApiError(
          "The request timed out. Please try again.",
          0,
          "TIMEOUT",
        );
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        "Unable to connect to NexaAI. Check your connection and try again.",
        0,
        "NETWORK",
      );
    }
  };
}

export const apiRequest = createApiClient();
