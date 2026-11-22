import { BunRedis, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { CircuitBreaker, RateLimiter } from "effect/persistence";
import { cli } from "./cli";
import { PgLive } from "./db/Db";
import { Embedder } from "./embed/Embedder";
import { Gdelt } from "./gdelt/Gdelt";
import { PoliteClient } from "./http/PoliteClient";
import { Backfill } from "./pipeline/Backfill";
import { Cluster } from "./pipeline/Cluster";
import { Embed } from "./pipeline/Embed";
import { Fetcher } from "./pipeline/Fetcher";
import { Ingest } from "./pipeline/Ingest";
import { Reports } from "./pipeline/Reports";
import { Summaries } from "./pipeline/Summaries";
import { Topics } from "./pipeline/Topics";
import { BullMq } from "./queue/BullMq";
import { FetchQueue } from "./queue/FetchQueue";
import { Schedulers } from "./queue/Schedulers";
import { Articles } from "./repos/Articles";
import { Embeddings } from "./repos/Embeddings";
import { Feed } from "./repos/Feed";
import { Outlets } from "./repos/Outlets";
import { Stories } from "./repos/Stories";
import { Urls } from "./repos/Urls";
import { Summarizer } from "./summaries/Summarizer";
import { Classifier } from "./topics/Classifier";

// Per-domain rate-limit and circuit-breaker state lives in Redis, so every worker process shares it.
const RedisLive = BunRedis.layerConfig({ url: Config.String("REDIS_URL").pipe(Config.withDefault("redis://localhost:6380")) });
const Resilience = Layer.mergeAll(
  RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreRedis({ prefix: "news:rl:" }))),
  CircuitBreaker.layerStoreRedis({ prefix: "news:cb:" }),
).pipe(Layer.provide(RedisLive));

const Infra = Layer.mergeAll(PgLive, FetchHttpClient.layer, BunServices.layer);

const Leaves = Layer.mergeAll(Urls.layer, Articles.layer, Embeddings.layer, Stories.layer, Outlets.layer, Feed.layer, Embedder.layer, Classifier.layer, Summarizer.layer, Gdelt.layer, BullMq.layer, PoliteClient.layer.pipe(Layer.provide(Resilience))).pipe(
  Layer.provideMerge(Infra),
);

const AppLayer = Schedulers.layer.pipe(
  Layer.provideMerge(Summaries.layer),
  Layer.provideMerge(Reports.layer),
  Layer.provideMerge(Topics.layer),
  Layer.provideMerge(Backfill.layer),
  Layer.provideMerge(Cluster.layer),
  Layer.provideMerge(Embed.layer),
  Layer.provideMerge(Ingest.layer),
  Layer.provideMerge(FetchQueue.layer),
  Layer.provideMerge(Fetcher.layer),
  Layer.provideMerge(Leaves),
);

cli.pipe(Effect.provide(AppLayer), BunRuntime.runMain);
