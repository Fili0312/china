import "./env";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Nginx raggiunge Nest soltanto da loopback: in questo modo `request.ip`
  // usa X-Forwarded-For solo quando arriva dal proxy fidato, non dal client.
  app.getHttpAdapter().getInstance().set("trust proxy", "loopback");
  const configuredOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const publicApiUrl = process.env.NEXT_PUBLIC_API_URL;
  const publicOrigin = publicApiUrl
    ? (() => {
        try {
          return new URL(publicApiUrl).origin;
        } catch {
          return null;
        }
      })()
    : null;
  app.enableCors({
    // Dashboard locale + origine del deploy. Override esplicito con
    // CORS_ORIGINS (lista separata da virgole) per altri frontend autorizzati.
    origin: [
      "http://localhost:3020",
      "http://127.0.0.1:3020",
      ...(publicOrigin ? [publicOrigin] : []),
      ...configuredOrigins,
    ],
  });
  app.setGlobalPrefix("api");

  const port = Number(process.env.API_PORT || 3021);
  await app.listen(port);
  console.log(`API in ascolto su http://localhost:${port}/api`);
}

bootstrap();
