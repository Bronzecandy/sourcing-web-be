import { Agent, fetch as undiciFetch } from "undici";

/** Node fetch mặc định connect timeout ~10s — quá ngắn cho Railway cold start / mạng chậm. */
const externalAgent = new Agent({
  connect: { timeout: 120_000 },
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
});

export async function fetchWithLongConnect(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  return undiciFetch(url, {
    ...init,
    dispatcher: externalAgent,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Response;
}
