import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * Lettura del corpo di una richiesta come stream binario.
 *
 * I parser JSON e urlencoded di Nest ignorano `application/octet-stream`,
 * quindi lo stream è ancora leggibile nel controller e non serve un parser
 * multipart: `express` non è risolvibile da `apps/api` con pnpm, e aggiungerlo
 * solo per l'upload di un file non varrebbe la dipendenza.
 */
export interface BinaryRequest {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  destroy(error?: Error): void;
}

export function readBinaryBody(
  request: BinaryRequest,
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        rejectPromise(
          new HttpException(
            `File troppo grande: il limite è ${Math.floor(maxBytes / (1024 * 1024))} MB.`,
            HttpStatus.PAYLOAD_TOO_LARGE
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks)));
    request.on("error", (error) => rejectPromise(error));
  });
}
