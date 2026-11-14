# datathon-2026

# Datathon FME 2026: challenge brief for AI agents

Context for AI agents helping our team. It describes the challenges presented at the opening ceremony on Sat 14 Nov 2026. Read the whole file before planning any work.

## How to read this file

Every fact carries a confidence tag:

- **[confirmed]**: read from an official page. The source is listed at the end.
- **[transcript]**: from an automatic transcript of the opening talks (raw text in `notes.md`). The wording is noisy and numbers or names may be wrong.
- **[unverified]**: inference or background knowledge. Check it before relying on it.

If you need a fact that is not [confirmed], say so and ask the human instead of guessing.

## Event

- Datathon FME 2026, UPC Barcelona, Sat 14 to Sun 15 Nov 2026. All times are CET (UTC+1). [confirmed]
- The official site says "48 hores i 3 reptes" (48 hours, 3 challenges) but does not name them. From the talks, the three are **RawTree/Tinybird**, **UPC Sostenible** and **Qualcomm**. [confirmed: count; transcript: names]
- Side challenges also exist: a RawTree side challenge and a data visualization side challenge. [transcript]
- Key times [confirmed]:
  - Sat 15:00, 16:00 and 19:00: sponsor talks (Qualcomm, Innovamat, Novartis). The Qualcomm technical talk is at 15:00. [transcript]
  - Sun 12:00: final call for submissions.
  - Sun 14:00: demos.
  - Sun 17:30: awards ceremony.
- Prizes: more than €2000 in total. No per-challenge breakdown is published. [confirmed]
- Team size and the number of challenges a team may enter are not published. The 2025 edition allowed teams of up to 4. [unverified for 2026]
- **The team has not chosen a challenge yet.** The option under discussion is UPC Sostenible as the main challenge, plus the RawTree side challenge and the visualization side challenge. The idea is that one dashboard built on RawTree would serve all three. The alternative is the RawTree main challenge.

## Name map (transcript errors)

| Transcript says | Means |
|---|---|
| Worktree, Rotary, RotDB, Tinyverse | **RawTree** (new database by **Tinybird**) |
| Tiger, TinyBird | Tinybird (the company) |
| Bercel | Vercel |
| QRP2210 | Qualcomm **QRB2210** (Dragonwing) |
| Dragonfly | Dragonwing (Qualcomm product line) [unverified] |
| Arduino UCO, "un U" | **Arduino UNO Q** |
| "algoritme MCP" | probably "Arduino UNO Q" or "MCU" [unverified] |
| M3CAN | unclear. A dataset of 1000+ labelled math exam problems, 2007–2024 (possibly the Cangur/Kangaroo contest) [unverified] |

---

## Challenge A: RawTree (Tinybird), real-time recommendations

Sources: repo README and landing page. [confirmed unless tagged]

### Background

- Tinybird is a Spanish real-time analytics company of about 35 people, built on ClickHouse. [transcript]
- RawTree is their new database: a fork of ClickHouse with an "ingest first, analyze later" model. [transcript]
  - It is schemaless: every column is `Dynamic`. [confirmed]
  - It builds projections and indexes automatically from the query patterns it sees. This is deterministic C++, not an LLM. [transcript]
  - "Real-time" means millisecond queries; anything over 1 s is too slow.

### Task

- A simulated marketplace sends shopper requests at about **3 per second**, around the clock.
- For each request, insert an **ordered list of exactly 10 distinct, active product IDs** within **3 s** of the request `ts`.
- Only one answer per request counts. Order matters: the first slots get much more attention than the last.
- A late, invalid or missing answer is replaced by the fallback (baseline) and is reported in feedback.

### Tables

| Table | Content |
|---|---|
| `shop.requests` (append-only) | `request_id`, `ts` (UTC), `user_id`, `is_new_user`, `context` {`device`: web/ios/android, `region`, `page`: home/product/category}, `recent_views` [{`product_id`, `ts`}] |
| `shop.catalog` | ~5,000 products, 10 categories, 90 subcategories: `product_id`, `category`, `subcategory`, `brand`, `price_eur`, `description`, `created_at`, `is_active` |
| `shop.catalog_updates` (append-only) | `new_product`, `price_change`, `out_of_stock`, `back_in_stock`. The current catalog is the latest update per product. |
| `shop.history_sessions` | ~2M rows, 60 days of impressions from the old carousel: `shown`, `propensity`, `clicked`, `purchased`, `revenue_eur` |
| `shop.history_events` | ~12M rows, 60 days of view, add_to_cart and purchase events outside the carousel |
| `shop.events` | live events, ~50/s. Trends show up here first. |
| `team_NN.submissions` | your answers: `{"request_id", "items": [10 ids], "model_version"}` |
| `team_NN.feedback` (private) | arrives a few seconds after each deadline: `shown`, `served_by`, `fallback_reason`, `latency_ms`, `clicked`, `purchased`, `revenue_eur`. The first row (`request_id` = `"__init__"`) is a placeholder. |
| `team_NN.scratch` | free-form JSON storage |

### API and tooling

- HTTP at `api.rawtree.com` with Bearer auth.
  - Queries: `POST /v1/query`
  - Inserts: `POST /v1/tables/{table}?database=team_NN`, with a JSON array as the body
- There is also a CLI (`rtree query ...`) and an MCP server at `mcp.rawtree.com`.
- Agent-oriented docs: `rawtree.com/llms.txt`. Read them before writing queries.
- Credentials: one API key and a `TEAM_ID` per team, collected at the RawTree stand. Copy `.env.example` to `.env`. **Never commit or share the key.**
- Because columns are `Dynamic`, cast join keys, e.g. `product_id::String`.
- Live tables were empty before Sat 10:00. Until then, queries on them fail with "Unknown expression identifier".

### Starter kit

The `starter/` folder in the repo contains:

- `recommender.py`: a pull → predict → push loop. Replace `recommend()`. It polls every 0.3 s and answers in about 1 s.
- `queries.sql`
- `offline_eval.ipynb`: offline evaluation on `history_sessions`, including an inverse-propensity estimate.
- `requirements.txt`

The README and the landing page describe the baseline differently: all-time best sellers in stock vs. best sellers in the category of the last viewed product. Read the code to know which.

### Scoring

The final grade is **70 points from the stream + 30 points from the jury**.

**Stream (70 points).** Only the **final round** counts (Sun 10:00–12:00); practice does not.

| Component | Points | What it measures |
|---|---|---|
| Conversion | 50 | Expected purchases per 100 requests, using the simulator's hidden purchase probabilities |
| Cold start | 10 | The same metric, restricted to cold requests: `is_new_user`, or `recent_views` containing a product added during the event |
| Reliability | 10 | Share of requests answered validly and on time |

Each component is scored as `100 × (team − baseline) / (oracle − baseline)`, clipped to [0, 100]:

- baseline = the 10 all-time best sellers that are in stock
- oracle = the 10 products the hidden model would pick

An organizer reference recommender appears on the leaderboard and "can be beaten".

**Jury (30 points).** Short presentation with a demo on Sunday afternoon.

| Criterion | Points |
|---|---|
| Method, validated offline before going live | 10 |
| Learning from the stream (exploration, trends, price changes, cold start) | 10 |
| Use of RawTree (SQL features, embeddings, pipeline) | 5 |
| Communication | 5 |

Tie-breaker: expected revenue per request in the final round.

### Timeline

- Sat 10:00 to Sun 10:00: practice round. The public leaderboard updates every 10 min (the landing page says it "shows the last hour").
- Sun 10:00 to 12:00: final round, with new shoppers, products and trends. The leaderboard is hidden; each team only sees a green or red status light (green = more than 90% of answers in the last 5 min were valid and on time).
- Sun 12:00: the stream stops and the final ranking is published automatically.
- There is nothing to upload: **the running system is the submission**. It must run unattended, so prefer a cloud VM to a laptop that might sleep.

### Rules and gotchas

- Code must generate the recommendations. Hand-picked lists are not allowed. Top teams share their repo with the jury.
- Products go out of stock and come back during the event. Always filter by the latest `catalog_updates` status.
- The history log is biased toward best sellers. Use `propensity` for inverse propensity weighting.
- A shopper who bought a product rarely wants it again. Don't recommend items they already purchased.
- Batch your inserts (e.g. every 0.5 s). The organizers poll every 0.5 s.
- "Teams that generalise beat teams that memorise." Exploration is a graded criterion.

### Approach ideas [unverified]

- Item-to-item co-occurrence (co-view and co-purchase) from `history_events`, seeded by `recent_views`.
- A trend boost from a sliding window over `shop.events`.
- Cold start: popularity by category and region. For new products, use similarity on the `description` text or embeddings.
- Re-rank by expected purchase probability. Small exploration slots in low positions.
- Precompute heavy tables. Keep the request path to a lookup plus a cheap re-rank.

---

## Challenge A′: RawTree side challenge

[transcript only, details unconfirmed]

- Only for teams that are **not** entering the RawTree main challenge.
- Get a user and a small cluster at the RawTree stand.
- Build something that uses RawTree. Present how and why you used it, and post a tweet about it.
- One winner, with a prize.

---

## Challenge B: UPC Sostenible, campus battery scheduling

Organized by the datathon organizers together with UPC Sostenible (the university's sustainability office).

Statement, data, tutorials and submissions are at `https://repteupc.datathon.cat`. **That site is a Streamlit app, so plain HTTP fetches return an empty shell.** A human must copy the statement into this repo. Everything below is [transcript] until then.

### Task

- Campus Nord (UPC) has solar panels, a grid connection and an industrial battery. Campus demand must always be covered by some mix of solar, grid and battery.
- At each time step, choose one of three battery actions:
  - **charge**: take energy from the grid and store it
  - **discharge**: use stored energy to supply the campus
  - **standby**: do nothing

  For charge and discharge, also give the power in kW.
- Unknowns: the time step length, and whether solar surplus can charge the battery or be exported.

### Data provided

- Solar generation
- Hourly grid electricity price
- Battery specs, including efficiency (energy is lost when storing it)
- Campus demand, which varies by hour, day of week and season
- Training data covers the **first 3 weeks of each month**. The hidden evaluation set is the **last week of each month**.

### Information available at decision time

The policy may only use what a real operator would know at that moment:

- the temporal context
- historical campus demand
- the current battery state (state of charge)
- **REE (Red Eléctrica) forecasts of price and CO2 intensity for the next 24 h**

### Scoring

The exact formula is on the challenge site.

- **CO2 saved** compared with no battery: the main metric.
- **Cost saved** compared with no battery: secondary.
- Both components can be negative if the policy does worse than having no battery, but the total score cannot be negative.
- **Penalties** are subtracted for infeasible actions, e.g. charging above capacity or discharging below zero.

### Submission

- You submit code plus models, which run on the organizers' server against the hidden set.
- There are two ways to check the structure of a submission (neither gives a score):
  - a local validator script
  - a server structure check on non-representative data
- **Final leaderboard submissions are limited.** The quota renews during the event; the schedule is on the site.
- Our transcript of the leaderboard caveat is garbled. Assume the public score may not equal the final one.

### Approach ideas [unverified]

- Rolling-horizon optimization (MPC). At each step:
  1. Forecast demand and solar for the next 24 h.
  2. Take the REE price and CO2 forecasts.
  3. Solve an LP with constraints for state of charge, power limits and charge/discharge efficiency. The objective is CO2 weighted above cost.
  4. Apply only the first action.
- Enforce feasibility inside the policy itself so penalties can never trigger.
- Charging from the grid and discharging later only saves CO2 if the CO2 gap between the two moments beats the round-trip losses. The optimizer must account for this.
- Build a local evaluator that replicates the scoring formula before spending limited submissions.
- Check which solvers are available on the server before relying on scipy, cvxpy or pulp.

---

## Challenge C: Qualcomm, offline math tutor on the Arduino UNO Q

[transcript only, plus hardware background]

### Motivation

PISA results show math scores in Catalonia dropping sharply. Teachers lack resources. AI should help students **learn and memorize concepts and understand their mistakes**, not do their homework or projects for them.

### Task

Build an **offline math mentor or trainer** (EU-based, no cloud) running on the Arduino UNO Q. Two directions are welcome:

1. Find an innovative, real problem in classrooms, at university or in your own studies, and solve it so students strengthen their foundations through practice and error analysis.
2. Help students reason about **why** they get things wrong.

### What is provided

- One UNO Q board per participating team. Teams keep it.
- A dataset of more than 1000 labelled problems from math exams 2007–2024 (named something like "M3CAN" in the transcript), for fine-tuning or RAG on a small local generative model.
- A GitHub repo documenting how to deploy a small language model (SLM), RAG and embeddings on the board. It also includes agent "skills" so AI agents understand the platform. **We don't have the repo URL yet; ask at the Qualcomm stand.**

### Deliverables

- A GitHub repo.
- A post on the **Arduino Project Hub**. The sponsor wants anyone in the world to be able to reproduce the project.
- A presentation on Sunday. Judging is by jury; the criteria have not been published.

### Hardware [unverified, background knowledge]

- The UNO Q is a "dual brain" board:
  - an STM32 microcontroller, programmed with classic Arduino sketches
  - a Qualcomm Dragonwing QRB2210 processor (quad-core Cortex-A53) running Debian Linux
- Typically 2 GB of RAM. Expect only small quantized models (≤1–2B parameters) and slow generation. Design the demo around that: retrieval, short answers and precomputed hints.

---

## Side challenge: data visualization

Nothing is known yet. Ask the organizers for the brief, the deliverables and whether it can be combined with a main challenge.

---

## Open questions (for humans to ask the organizers)

1. Can a team enter more than one main challenge? What is the maximum team size?
2. What are the brief and rules of the visualization side challenge?
3. UPC Sostenible:
   - How many final submissions are there, and when do they renew?
   - What is the server environment (Python version, allowed libraries, LP solvers, time limits)?
   - What is the time step?
   - What is the exact scoring formula?
   - Can solar surplus charge the battery? Is grid export allowed?
4. Qualcomm: What are the repo URL, the dataset access, the judging criteria and the RAM of the board we get?
5. RawTree: What does the baseline actually do? How often does the leaderboard update? What are the side challenge rules and prize?

## Sources

- RawTree challenge repo: https://github.com/rawtreedb/datathon-fme-2026
- RawTree challenge page: https://datathon.rawtree.dev/
- Datathon FME site and schedule: https://datathon.cat/
- UPC Sostenible challenge (Streamlit; open in a browser): https://repteupc.datathon.cat
- Raw talk transcripts: `notes.md` in this folder
