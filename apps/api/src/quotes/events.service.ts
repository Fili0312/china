import { Injectable } from "@nestjs/common";
import IORedis from "ioredis";
import { Observable } from "rxjs";
import { eventsChannel } from "@china/shared";

export interface SseMessage {
  data: string;
}

/**
 * Bridge Redis pub/sub → SSE. Una connessione subscriber dedicata per
 * stream: a questa scala è semplice e robusto (si chiude col client).
 */
@Injectable()
export class EventsService {
  stream(requestId: string): Observable<SseMessage> {
    return new Observable<SseMessage>((subscriber) => {
      const sub = new IORedis(
        process.env.REDIS_URL || "redis://localhost:6379"
      );
      const channel = eventsChannel(requestId);

      sub.subscribe(channel).catch((err) => subscriber.error(err));
      sub.on("message", (_ch, message) => {
        subscriber.next({ data: message });
      });
      sub.on("error", (err) => subscriber.error(err));

      // Heartbeat: evita che proxy/nginx chiudano la connessione inattiva.
      const heartbeat = setInterval(() => {
        subscriber.next({
          data: JSON.stringify({ type: "ping", ts: new Date().toISOString() }),
        });
      }, 25000);

      return () => {
        clearInterval(heartbeat);
        sub.quit().catch(() => {});
      };
    });
  }
}
