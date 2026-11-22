/** The news sections. Flat on purpose: a 2B model is reliable with ~10 well-separated labels, not with a two-level tree. */
export const TOPICS = [
  { id: "politics", label: "Politics", hint: "elections, legislatures, government policy, courts and rulings, politicians, White House, Congress, parties (any country's domestic politics)" },
  { id: "world", label: "World", hint: "foreign affairs, wars and conflict, diplomacy, international relations, events in other countries, migration, terrorism" },
  { id: "business", label: "Business", hint: "economy, markets, companies, earnings, jobs, inflation, trade, retail, real estate, personal finance, energy prices" },
  { id: "tech", label: "Tech", hint: "technology companies, AI, software, gadgets, cybersecurity, internet, social media platforms" },
  { id: "science", label: "Science", hint: "research and discoveries, space, climate science, environment, nature, animals, archaeology" },
  { id: "health", label: "Health", hint: "medicine, disease, outbreaks, healthcare, nutrition, mental health, drugs" },
  { id: "sports", label: "Sports", hint: "games, athletes, teams, leagues, coaches, tournaments, sports business" },
  { id: "entertainment", label: "Entertainment", hint: "film, TV, music, celebrities, royals, awards, books, culture, lifestyle, food, travel" },
  { id: "crime", label: "Crime", hint: "crime, police, shootings, trials of private individuals, accidents, fires, disasters casualties" },
  { id: "weather", label: "Weather", hint: "forecasts, storms, floods, heat, snow, travel disruption from weather" },
] as const;

/** Sections where "who is not covering this" is a meaningful bias signal. A hockey game or a film remake is not a blindspot. */
export const BLINDSPOT_TOPICS: ReadonlyArray<string> = ["politics", "world", "business"];
export const blindspotEligible = (topic: string | null): boolean => topic !== null && BLINDSPOT_TOPICS.includes(topic);

export type TopicId = (typeof TOPICS)[number]["id"];
export const TOPIC_IDS: ReadonlyArray<TopicId> = TOPICS.map((t) => t.id);
export const isTopic = (s: string): s is TopicId => (TOPIC_IDS as ReadonlyArray<string>).includes(s);
