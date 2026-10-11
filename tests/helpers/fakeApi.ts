import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

/** LinguaManager API ning soxta nusxasi: so'rovlarni yig'adi, javob kodini boshqarish mumkin. */
export function startFakeApi(initialStatus = 200) {
  const calls: Captured[] = [];
  const state = { status: initialStatus };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch { /* json emas */ }
      calls.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(state.status, { "content-type": "application/json" });
      res.end(JSON.stringify(state.status < 300 ? { ok: true } : { detail: "xato" }));
    });
  });
  return new Promise<{ url: string; calls: Captured[]; state: { status: number }; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        state,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
