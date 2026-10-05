export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
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
      const response = await fetchImpl(`${base}${path}`, {
        method: options.method ?? "GET",
        headers,
        body:
          multipart ? options.body as FormData : options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // Backend auth handlers may return internal error messages. Use safe UI text.
        const message =
          response.status === 401
            ? "Please sign in again or check your email and password."
            : response.status === 403
              ? "You do not have permission to perform this action."
              : response.status === 429
                ? "Too many requests. Please try again later."
                : response.status >= 500
                  ? "The service is currently unavailable. Please try again later."
                  : "The request could not be completed. Please check your details.";
        throw new ApiError(
          message,
          response.status,
          isRecord(payload) && typeof payload.code === "string"
            ? payload.code
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
