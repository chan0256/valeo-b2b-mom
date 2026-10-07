# B2B Weekly MoM portal: launch guide (no terminal)

The portal runs on **Cloudflare Pages** with a **Cloudflare D1** database. Everything below happens in your web browser.

## What's in this folder

| Path | What it is |
|---|---|
| `public/index.html` | The web app |
| `functions/api/[[route]].js` | The server part (sign-in, saving data) |
| `schema.sql` | The setup text you paste into the database console |

## Step 1. Put the code on GitHub

1. Sign in at github.com and create a new **private** repository named `valeo-b2b-mom`. Leave it empty (no README).
2. Connect GitHub to Claude at https://claude.ai/connect-github and allow it access to that repository. Claude then uploads the files for you.
   - If you'd rather upload them yourself, open the repository, choose **Add file → Upload files**, and drag in the `public` and `functions` folders and `schema.sql`.

## Step 2. Create the database

1. Open the Cloudflare dashboard → **Storage & Databases → D1 SQL Database → Create**.
2. Name it `b2b-mom` and press **Create**.
3. Open the new database → **Console** tab. Paste the whole of `schema.sql` and press **Execute**.

## Step 3. Create the website

1. Go to **Workers & Pages → Create → Pages → Connect to Git**, then pick the `valeo-b2b-mom` repository.
2. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `public`
3. Press **Save and Deploy**. Wait for it to finish.

## Step 4. Connect the database to the website

1. Open the Pages project → **Settings → Bindings → Add → D1 database**.
2. Variable name: `DB`. D1 database: `b2b-mom`. Save.
3. Go to **Deployments**, open the menu (⋯) on the latest one and press **Retry deployment**, so the website picks up the database.

## Step 5. Use your own address

1. In the Pages project → **Custom domains → Set up a custom domain**.
2. Enter `b2bmom.valeoautomation.com` and continue.
   - **Domain already on Cloudflare:** Cloudflare adds the DNS record for you. Press **Activate domain**.
   - **Domain elsewhere (GoDaddy and similar):** add the CNAME record Cloudflare shows (name `b2bmom`, value `<project>.pages.dev`) at your domain provider, then wait for it to turn **Active**.

## Step 6. First sign-in

Open your new address **before sharing it**. The first person to open it creates the admin account. Then add your team on the **Members** tab, with a temporary password for each person.

## Later changes

Once the code is on GitHub, every update Claude pushes to the repository goes live by itself within a minute or two.
