# B2B Weekly MoM portal: launch guide (no terminal)

The portal runs as a **Cloudflare Worker** with a **Cloudflare D1** database. Everything below happens in your web browser. Each push to the `main` branch of this repository goes live by itself.

## What's in this repository

| Path | What it is |
|---|---|
| `public/index.html` | The web app |
| `src/worker.js`, `src/api.js` | The server part (sign-in, saving data) |
| `wrangler.jsonc` | Worker name and the link to the `b2b-mom` database (binding `DB`) |
| `schema.sql` | The setup text you paste into the database console |

## Step 1. Create the database

1. Cloudflare dashboard → **Storage & Databases → D1 SQL Database → Create**, named `b2b-mom`.
2. Open it → **Console** tab. Paste the whole of `schema.sql` and press **Execute**.
3. Copy its **Database ID** into `database_id` in `wrangler.jsonc` (already done for this project).

## Step 2. Create the Worker

1. **Workers & Pages → Create → Import a repository**, pick `valeo-b2b-mom`, and deploy.
2. The Worker name in the dashboard must match `name` in `wrangler.jsonc` (`valeo-b2b-mom`).

## Step 3. Use your own address

Open the Worker → **Settings → Domains & Routes → Add → Custom domain**, enter `b2bmom.valeoautomation.com`.

## Step 4. First sign-in

Open the address **before sharing it**. The first person to open it creates the admin account. Then:
- add your team on the **Members** tab, with a temporary password for each person;
- set up your regular meetings on the **Settings** tab (one meeting type per weekly meeting, each with its own name, day, time and location).

## Updates

Database changes needed by new features (such as meeting types) are applied by the portal itself on its first request after an update, so there is nothing to run in the console.
