import type { TagKind } from "../../domain/Recipe";
import type { RecipeView } from "../../repos/Recipes";
import type { Card, TagGroup } from "../../repos/Site";
import { Layout } from "./Layout";

const KIND_LABEL: Record<TagKind, string> = { course: "Course", cuisine: "Cuisine", diet: "Diet", occasion: "Occasion" };

const Cards = ({ items }: { items: ReadonlyArray<Card> }) => (
  <ul class="cards">
    {items.map((c) => (
      <li>
        <a href={`/r/${c.slug}`}>
          <div class="t">
            {c.title}
            {c.status === "draft" ? <span class="badge">draft</span> : null}
          </div>
          {c.summary ? <div class="s">{c.summary}</div> : null}
        </a>
      </li>
    ))}
  </ul>
);

export const Home = (p: { recent: ReadonlyArray<Card>; groups: ReadonlyArray<TagGroup>; drafts: boolean }) => (
  <Layout title="holykhao" drafts={p.drafts}>
    <h1>Recipes</h1>
    {p.groups.map((g) => (
      <section>
        <h3>{KIND_LABEL[g.kind]}</h3>
        <div class="chips">
          {g.tags.map((t) => (
            <a class="chip" href={`/tags/${t.slug}`}>{t.name}<small>{t.count}</small></a>
          ))}
        </div>
      </section>
    ))}
    <h2>Latest</h2>
    {p.recent.length ? <Cards items={p.recent} /> : <p class="muted">No recipes yet.</p>}
  </Layout>
);

export const ListPage = (p: { title: string; kicker?: string; items: ReadonlyArray<Card>; drafts: boolean }) => (
  <Layout title={p.title} drafts={p.drafts}>
    {p.kicker ? <div class="muted">{p.kicker}</div> : null}
    <h1>{p.title}</h1>
    <Cards items={p.items} />
  </Layout>
);

export const SearchPage = (p: { q: string; items: ReadonlyArray<Card>; drafts: boolean }) => (
  <Layout title={p.q ? `Search: ${p.q}` : "Search"} q={p.q} drafts={p.drafts}>
    <h1>Search</h1>
    {p.q ? <p class="muted">{p.items.length} {p.items.length === 1 ? "result" : "results"} for “{p.q}”</p> : <p class="muted">Type a recipe name or an ingredient.</p>}
    <Cards items={p.items} />
  </Layout>
);

export const NotFound = (p: { drafts: boolean }) => (
  <Layout title="Not found" drafts={p.drafts}>
    <h1>Not found</h1>
    <p>We couldn't find that page. <a href="/">Back to all recipes</a>.</p>
  </Layout>
);

const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`);

export const RecipePage = ({ r, drafts }: { r: RecipeView; drafts: boolean }) => (
  <Layout title={r.title} drafts={drafts} cook>
    <h1>
      {r.title}
      {r.status === "draft" ? <span class="badge">draft</span> : null}
    </h1>
    <div class="meta">
      {r.servings ? <span>Serves {r.servings}</span> : null}
      {r.prepMinutes != null ? <span>Prep {minutes(r.prepMinutes)}</span> : null}
      {r.cookMinutes != null ? <span>Cook {minutes(r.cookMinutes)}</span> : null}
      {r.attribution ? <span>From {r.attribution}</span> : null}
    </div>
    {r.summary ? <p>{r.summary}</p> : null}
    {r.tags.length ? (
      <div class="chips hide-cook">
        {r.tags.map((t) => <a class="chip" href={`/tags/${t.slug}`}>{t.name}</a>)}
      </div>
    ) : null}
    <div class="toolbar">
      <button id="cook-toggle" type="button">Cook mode</button>
    </div>
    {drafts && r.warnings.length ? (
      <div class="warn hide-cook">
        <strong>Parse warnings</strong>
        <ul>{r.warnings.map((w) => <li>{w}</li>)}</ul>
      </div>
    ) : null}
    {r.sections.some((s) => s.ingredients.length) ? <h2>Ingredients</h2> : null}
    {r.sections.map((s) => (
      <section>
        {s.title ? <h3>{s.title}</h3> : null}
        <ul class="ing">
          {s.ingredients.map((l) => (
            <li data-check>
              {l.quantity || l.unit ? <span class="qty">{[l.quantity, l.unit].filter(Boolean).join(" ")}</span> : null}
              {l.ingredientSlug ? <a href={`/ingredients/${l.ingredientSlug}`} style="color:inherit;text-decoration:none">{l.item}</a> : l.item}
              {l.note || l.optional ? <span class="note">{l.note ? `, ${l.note}` : ""}{l.optional ? " (optional)" : ""}</span> : null}
            </li>
          ))}
        </ul>
      </section>
    ))}
    {r.steps.length ? <h2>Method</h2> : null}
    <ol class="steps">
      {r.steps.map((s) => <li data-check>{s}</li>)}
    </ol>
    {r.notes ? <div class="notes">{r.notes}</div> : null}
  </Layout>
);
