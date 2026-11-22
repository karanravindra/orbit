import { BunHttpServer } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Site } from "../repos/Site";
import { Home, ListPage, NotFound, RecipePage, SearchPage } from "./views/pages";

const page = (node: { toString(): string }, status = 200) =>
  HttpServerResponse.html(`<!doctype html>${node.toString()}`).pipe(HttpServerResponse.setStatus(status));

const slugParam = Effect.map(HttpRouter.params, (p) => p.slug ?? "");

const Routes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/",
    Effect.gen(function* () {
      const site = yield* Site;
      const { recent, groups } = yield* site.home;
      return page(<Home recent={recent} groups={groups} drafts={site.includeDrafts} />);
    }),
  ),
  HttpRouter.add(
    "GET",
    "/r/:slug",
    Effect.gen(function* () {
      const site = yield* Site;
      const r = yield* site.recipe(yield* slugParam);
      return r ? page(<RecipePage r={r} drafts={site.includeDrafts} />) : page(<NotFound drafts={site.includeDrafts} />, 404);
    }),
  ),
  HttpRouter.add(
    "GET",
    "/tags/:slug",
    Effect.gen(function* () {
      const site = yield* Site;
      const t = yield* site.byTag(yield* slugParam);
      return t ? page(<ListPage title={t.name} kicker={t.kind} items={t.recipes} drafts={site.includeDrafts} />) : page(<NotFound drafts={site.includeDrafts} />, 404);
    }),
  ),
  HttpRouter.add(
    "GET",
    "/ingredients/:slug",
    Effect.gen(function* () {
      const site = yield* Site;
      const i = yield* site.byIngredient(yield* slugParam);
      return i ? page(<ListPage title={i.name} kicker="Recipes using" items={i.recipes} drafts={site.includeDrafts} />) : page(<NotFound drafts={site.includeDrafts} />, 404);
    }),
  ),
  HttpRouter.add(
    "GET",
    "/search",
    Effect.gen(function* () {
      const site = yield* Site;
      const params = yield* HttpServerRequest.ParsedSearchParams;
      const raw = params.q;
      const q = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 100).trim() ?? "";
      return page(<SearchPage q={q} items={q ? yield* site.search(q) : []} drafts={site.includeDrafts} />);
    }),
  ),
  HttpRouter.add("GET", "/healthz", HttpServerResponse.text("ok")),
);

/** The public site. Needs `Site`. */
export const serve = (port: number) => HttpRouter.serve(Routes).pipe(Layer.provide(BunHttpServer.layer({ port })));
