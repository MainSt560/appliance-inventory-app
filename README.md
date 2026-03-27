# Appliance Inventory Manager

A Vercel-ready Next.js app for shared appliance inventory tracking with a Supabase cloud database.

## What this build includes

- showroom floor + warehouse counts
- reserved / sold not delivered / delivered tracking
- Monday reorder list
- order point and target stock manager
- on-order protection so items do not get reordered twice
- Excel import and export
- Supabase cloud database for live team updates
- shared-device workflow for iPad or desktop in the store

## 1. Create a Supabase project

1. Go to https://supabase.com
2. Create a new project
3. Open the SQL Editor
4. Paste in `supabase/schema.sql`
5. Run it
6. Open **Project Settings > API**
7. Copy:
   - Project URL
   - anon public key

## 2. Set environment variables

Copy `.env.example` to `.env.local` and fill in:

```bash
NEXT_PUBLIC_SUPABASE_URL=your-project-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

## 3. Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000

## 4. Deploy to Vercel

1. Create a GitHub repo and upload this project folder
2. Go to https://vercel.com
3. Click **Add New Project**
4. Import the GitHub repo
5. Add these environment variables in Vercel:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
6. Click **Deploy**

## 5. Add to iPad home screen

On the iPad:

1. Open the deployed Vercel URL in Safari
2. Tap the Share button
3. Tap **Add to Home Screen**
4. Name it something like `Inventory`
5. Tap **Add`

## Notes about security

This project is configured for a shared in-store device, which means the Supabase schema currently allows read/write using the public anon key.

That is the fastest way to go live for your team.

If you later want named staff logins, audit trails by person, or tighter security, the next upgrade should be:

- Supabase Auth
- authenticated row-level policies
- staff user table

## Suggested launch steps

1. Deploy to Vercel
2. Import your current spreadsheet once
3. Test Monday ordering workflow
4. Test Thursday receiving workflow
5. Put on iPad home screen
6. Use the app as the main system going forward
