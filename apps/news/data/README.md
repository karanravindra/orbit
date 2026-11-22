# Outlet ratings

`outlets.csv` (`domain,name,bias,factuality,country`) is loaded with `bun run outlets:import`.

- Most rows come from the Hugging Face dataset
  [sergioburdisso/news_media_bias_and_factuality](https://huggingface.co/datasets/sergioburdisso/news_media_bias_and_factuality),
  which carries Media Bias/Fact Check labels (a third-party snapshot, not an official MBFC export; check its licence before
  any non-local use). Mapping: `left`→left, `left-center`→lean-left, `neutral`→center, `right-center`→lean-right, `right`→right.
  About 20 of its 3,920 rows could not be downloaded.
- Rows for domains the dataset lacks (and all display names) come from a small hand-written seed made from memory; it is unverified.

## Cross-check and owner groups

- `bun src/main.ts outlets import --crosscheck data/allsides.csv` averages in AllSides ratings (the `allsides_data.csv` from
  [favstats/AllSideR](https://github.com/favstats/AllSideR); git-ignored, as the data isn't ours to redistribute). Outlets are matched
  by name or by the domain's main label, ratings become the mean of the two sources (halves round toward the centre), and a gap of
  two or more steps marks the outlet "contested".
- `families.csv` holds regex rules that group domains of one owner or wire network, so 40 NPR stations running one wire story count
  as one outlet. `inherit_from` lends an unrated member that domain's rating. These rules are a judgment call, not ownership data:
  `.com.au` and `.co.uk` are coarse "regional papers" buckets, and the NPR rule (`k***.org`, `w***.org`) can catch a non-station.
