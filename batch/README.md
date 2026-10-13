# Your Next Chapter: batch edition

The game plus a small backend, so each group gets its own link, answers are saved, and L&D can see the group view.

- `?batch=<id>` links, created from `/admin`
- Participant details first (name, company, department, role), then 15 cards, then the profile (can be saved as PDF)
- Answers and the profile summary are saved to a Cloudflare D1 database
- `/admin` (protected by your admin key): create/close batches, copy links, group charts, CSV export
- If the game is opened without the backend (GitHub Pages, a plain file), it still works and saves nothing

## Deploy (about 10 minutes, on your own Cloudflare account)

Needs Node.js. Run these inside this `batch` folder:

1. `npm install`
2. `npx wrangler login` (opens the browser so you can sign in to Cloudflare)
3. `npx wrangler d1 create your-next-chapter`, then copy the `database_id` it prints into `wrangler.toml`
4. `npm run db:init` (creates the tables)
5. `npx wrangler secret put ADMIN_KEY` and type a long passphrase. This is the key for `/admin`.
6. `npm run deploy`

Wrangler prints your address, for example `https://your-next-chapter.<your-subdomain>.workers.dev`.
Open `/admin`, enter the key, create a batch and copy its link.

## Local test
`npm run db:init:local`, put `ADMIN_KEY=test` in `.dev.vars`, then `npm run dev`.

## Notes
- The game file is `../index.html`. `npm run build` copies it into `public/`.
- Admin pages escape all text and the CSV export neutralises formula characters.
- Results are for development conversations, not performance evaluation. The intro screen says so.
