# Publish a shared event

The website runs on GitHub Pages. Supabase stores events, checks submitted sequences, measures round duration, and supplies the shared leaderboard. Players need a browser and the event link; they do not need an account. The host signs in to create and close events.

## 1. Prepare Supabase

This game's Supabase project URL is `https://unlgkvjarhvxrvabangt.supabase.co`. Open that project in the Supabase dashboard for the steps below.

1. Open **SQL Editor** in that project.
2. Copy the contents of `supabase/migrations/202610290001_shared_events.sql` into a new query and run it once. The migration creates the private game tables and the public functions used by the website.
3. Under **Authentication → Providers → Email**, keep email/password sign-in enabled. In the authentication settings, disable **Allow new users to sign up** and anonymous sign-ins. Players do not use Supabase Auth; these settings limit who can become an event host.
4. Under **Authentication → Users**, add the host's email address and password. Mark the email confirmed using the dashboard's auto-confirm option. Keep this password private; it belongs only in the host's sign-in form.
5. Find the **Project URL** and **publishable key** in the project's Connect dialog or API settings. A key beginning with `sb_publishable_` is intended for browsers. The older **anon** key also works. Never use a secret key beginning with `sb_secret_`, a **service_role** key, a personal access token, or a database password in this website.

The migration blocks direct access to the game tables. Players use limited functions to join an event, start a round, submit a sequence, and read that event's leaderboard. Host functions require an authenticated account and check ownership. Disable public sign-up before opening the site to participants.

## 2. Connect the website

The public connection settings belong in the repository's `config.json`:

```json
{
  "supabaseUrl": "https://unlgkvjarhvxrvabangt.supabase.co",
  "supabaseKey": "YOUR_BROWSER_PUBLISHABLE_KEY"
}
```

These two values are sent to every browser. They identify the project and do not grant host permissions. Access is controlled by the database functions and the host's sign-in session.

As an alternative to editing `config.json`, add repository **Actions variables** in **Settings → Secrets and variables → Actions → Variables**:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

The Pages build uses nonempty Actions variables in preference to `config.json`. Changing Actions variables does not update an existing deployment until the workflow runs again. If both settings are blank, the website supports local play only. If one is missing or a privileged key is supplied, the build fails.

## 3. Enable GitHub Pages

In `Justchan005/matching-game`:

1. Open **Settings → Pages**.
2. Set the build and deployment **Source** to **GitHub Actions**.
3. Open **Actions → Publish game to GitHub Pages** and choose **Run workflow** on `main`, or push a change to `main`.
4. Wait for both the **build** and **deploy** jobs to succeed.
5. Open the website address shown by the successful deployment or by **Settings → Pages**.

The build copies only public browser assets to `dist/`. Repository metadata, SQL migrations, tests, and other development files are not published as website files. A successful code push alone does not prove that GitHub Pages is enabled or that the website is deployed.

## 4. Run an event

1. Open the deployed game and use **Host event** to sign in with the host account.
2. Choose or prepare the scenario, then create an event.
3. Share its participant link or code. All players joining that event use the same stored scenario.
4. Ask players to enter the name or team name they want displayed on the shared leaderboard, then play and submit.
5. Open the same event on the projector's browser to show the leaderboard. It refreshes every five seconds while the page is visible.
6. Close the event when you want to stop new rounds. Rounds already started can still be submitted. Events stop accepting new rounds after seven days.

The leaderboard contains the best 20 completed rounds for that event, ordered by score and then elapsed time. Repeat plays appear as separate rounds; names are display labels, not verified identities. A submitted round is recorded only once, including when a browser retries after a connection failure. A connection is required for shared events; local practice remains available separately.

Only the server calculates a shared round's score and elapsed time. Editing browser score values cannot change the recorded result. This is an event game rather than an exam platform: participants can still share answers with one another after seeing their results.

## Verify the deployment

Use two separate browsers or devices:

1. Create an event as the host and join its participant link on both devices.
2. Play as two different names and submit both rounds.
3. Verify both names appear on both devices after the next refresh.
4. Refresh a browser and confirm the shared results remain.
5. Verify the intended nine-step diagnosis order earns 100.
6. Close the event as the host and confirm a new round cannot be started.

The host's computer does not need to keep PowerShell or a local server running after deployment. Hosting the game does not synchronize custom scenarios or scores previously saved in browser-only practice mode; create a shared event from the scenario to use it across devices.

For development, `npm test` checks game logic, the browser API client, and the Pages build. Run `npm run test:db` to test the migration and RPC permissions against PostgreSQL; that check requires a running Docker daemon. Database tests do not provision or modify the hosted Supabase project.

## Troubleshooting

- **Shared features unavailable:** check the deployed `config.json` and confirm that the Pages workflow ran after changing its configuration.
- **A function is missing or permission is denied:** confirm the migration ran successfully in the same Supabase project used by the website.
- **Host sign-in fails:** confirm the host exists in Supabase Auth, its email is confirmed, and email/password sign-in is enabled. Do not enable public registration as a workaround.
- **Pages deployment fails:** confirm the repository's Pages source is GitHub Actions and inspect the failed workflow job. Account or repository plan restrictions may also affect Pages availability.
- **Supabase is paused or unavailable:** resume the project in its dashboard and retry. Check the project's current usage and limits before the event.

For local Windows use, the existing command remains `py -3 -m http.server 3000 --bind 0.0.0.0` from the repository folder. `npm start` uses the `python3` command available in the prepared cloud environment. Neither local command is needed to keep the deployed website online.
