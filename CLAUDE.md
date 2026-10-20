# Scout

Scout is an AI growth operator for X/Twitter.

It learns a user's voice, interests, expertise, audience, and goals, then monitors selected accounts and finds conversations where the user should engage. It ranks opportunities and generates personalized replies based on the user's actual opinions and writing style.

## MVP Flow

1. User signs up
2. Completes onboarding
3. Connects/adds X account
4. Scout analyzes previous posts
5. Builds:
   - Voice Brain
   - Interest Brain
   - Goal Brain
6. User adds ~10–20 accounts to Watchlist
7. User clicks `Run Scout`
8. Scout fetches recent posts
9. Filters and scores opportunities
10. Shows ranked Opportunity Feed
11. Generates personalized replies
12. User can Copy / Edit / Regenerate / Skip

No automatic X posting in v0.

## Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Tailwind CSS 4
- Neon Postgres
- Drizzle ORM
- Drizzle Kit
- Neon Auth / Managed Better Auth
- @neondatabase/serverless
- OpenAI API
- X API
- Vercel

Do NOT use Supabase, Prisma, or React Router.

## Database Architecture

Neon Auth manages authentication users/sessions.

Application tables:

- profiles
- social_accounts
- posts
- watchlist_accounts
- scout_runs
- opportunities
- replies

Relationship:

Auth User
→ Profile
→ Social Accounts → Posts
→ Watchlist Accounts
→ Scout Runs → Opportunities → Replies

Do not create a duplicate application `users` table unless there is a clear reason. `profiles.userId` should reference/identify the authenticated Neon Auth user.

## Architecture Principles

- Server-first Next.js architecture.
- Use Server Components by default.
- Use Client Components only when necessary.
- Server Actions or Route Handlers for mutations/API boundaries.
- Database access through a dedicated Drizzle query/service layer.
- Do not query the database directly from UI components.
- Validate external/user input with Zod.
- AI responses should use structured outputs, not free-text parsing.
- Keep X API logic behind a dedicated client/service.
- Keep business logic separate from UI.

## Important

I am deliberately writing the important code myself to improve my full-stack skills.

When helping:

- Explain architecture and tradeoffs.
- Help debug.
- Review my code.
- Point me toward the correct approach.
- Do NOT generate entire features unless I explicitly ask.
- Do not unnecessarily abstract simple code.
- Prefer readable, explicit TypeScript.
- Challenge bad architectural decisions instead of blindly agreeing.
