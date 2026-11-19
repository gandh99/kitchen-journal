# 🍳 Kitchen Journal

A web app for tracking what you cook and bake.

## Run it

Requires **Node.js 22.13+** (it uses Node's built-in SQLite, so there's no database server to install).

```powershell
npm install
npm start
```

Open <http://localhost:3000> and create an account. Use `npm run dev` to auto-restart on code changes.

Settings (environment variables): `PORT` (default `3000`) and `DATA_DIR` (default `./data`, which holds the SQLite database and uploaded photos).

## Features

| Feature | How it works |
|---|---|
| **Accounts** | Username + password. Passwords are hashed with scrypt; sessions live in an httpOnly cookie for 30 days. Repeated failed logins are rate-limited. |
| **Entries (create / read / update / delete)** | Name, category, date made, ingredients, method, notes, tags, recipe link, photos. |
| **Photo uploads** | Multiple photos per entry (JPG/PNG/WebP/GIF/AVIF, up to 12 MB). Large phone photos are shrunk in the browser before upload. Files are stored in `data/uploads`. |
| **Recipe import from a URL** | Reads the schema.org `Recipe` data most recipe sites publish. Falls back to microdata, then common food-blog recipe cards (WP Recipe Maker, Tasty, Mediavine Create), then "Ingredients"/"Method" headings. TheMealDB links work too. |
| **YouTube import** | Paste any YouTube link (watch, youtu.be or Shorts). The ingredients and method come from the video description. If the description only links to the written recipe, that page is imported instead, and chapter timestamps fill in a rough method. The entry page embeds the video. |
| **Sites that block imports (402/403)** | Some sites (Allrecipes, Serious Eats, Simply Recipes, Budget Bytes and others) refuse automated requests. The app respects that and offers two alternatives: the **📌 Clip to Kitchen Journal** bookmark, which sends the page your own browser already opened, and **📋 Paste recipe text**. |
| **🌟 Weekly Spotlight** | Each ISO week (Monday to Sunday, server time) one recipe is picked automatically from kitchens with sharing turned on. Complete entries with photos are preferred, and no entry or dish is repeated. Anyone signed in can **Cook along**, which copies the recipe into their kitchen so they can add their own photos and submit it, or submit an existing entry with a caption. There's one submission per person per week, which they can change or withdraw. Past spotlights stay browsable. |
| **Auto-tagging** | Offline rule engine (`server/tagger.js`) that recognises about 300 dishes and ingredient patterns. *Pasta alla Bolognese* → Italian, Beef, Pork, Cheese, Pasta, Tomato. Tags refresh as you type, and you can remove or add your own. |
| **Category tabs** | Mains, Baking, Desserts, Soups & Salads, Breakfast, Snacks & Sides, Drinks, Other. The category is guessed automatically and you can change it. |
| **Search** | Matches name, tags, ingredients, notes and category. Searching "chicken" finds every chicken dish. Clicking a tag searches for it. |
| **What can I cook?** | List what you have on hand. It ranks your own entries by how much of each recipe you already have, and searches [TheMealDB](https://www.themealdb.com) (a free recipe API) for online recipes, showing what else you'd need. One click saves an online recipe to your kitchen. |
| **Sharing** | Turn on sharing to get a private link. Anyone with the link can browse your collection read-only, without an account. Signed-in users see all shared kitchens under *Community* and can save a copy of any entry. You can regenerate the link to revoke old ones. |

## Project layout

```
server/
  index.js         Express app and all API routes
  db.js            SQLite schema (users, sessions, entries, photos)
  auth.js          password hashing, sessions, login rate limit
  tagger.js        auto-tagging and category guessing
  recipeImport.js  recipe import: links, clipped HTML, pasted text; SSRF-safe fetch
  textParse.js     ingredients/method from free text (descriptions, pasted pages)
  youtube.js       YouTube video details and description links
  spotlight.js     weekly Spotlight picking, cook-along submissions
  entries.js       shared entry helpers (serialising, copying)
  suggest.js       "What can I cook?" ranking and online search
public/
  index.html, styles.css, app.js   single-page frontend, no build step
```

## Deploying

Put it behind HTTPS (a reverse proxy such as Caddy or nginx). The session cookie is marked `Secure` automatically when the request arrives over HTTPS. Back up the `data/` folder, which contains everything.
