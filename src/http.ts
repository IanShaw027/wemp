import type { IncomingMessage } from "node:http";

export async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`Request body too large (limit=${maxBytes})`));
        try {
          req.destroy();
        } catch {
          // ignore
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (err) => {
      reject(err);
    });
  });
}

