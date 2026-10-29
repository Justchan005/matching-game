# Flow State

A browser game for an event: read a scenario, arrange shuffled steps, and check the sequence. The included patient journey uses the nine steps supplied by the event organiser.

Shared events let people play from separate phones with one live leaderboard. A host signs in, creates an event, and shares its link. Supabase checks each submitted sequence and records the score and elapsed time. The leaderboard refreshes every five seconds and includes a projector view. Local practice still works on one device.

See [HOSTING.md](HOSTING.md) for GitHub Pages deployment, the Supabase database script, and host account setup. Public Supabase connection details are already in `config.json`; the database migration and host account must be set up in the dashboard before shared play works.

## Run

Local development requires Node.js 20+ (for npm commands and tests), Python 3, and a modern browser. There are no third-party npm packages to install. Shared events use the configured Supabase project; local practice needs no backend.

```sh
cd matching-game
npm start
```

Run these commands from the parent folder of your checkout. In the prepared cloud environment, the checkout is at `/workspace/matching-game`. This serves the app on port 3000. Stop it with Ctrl+C. To use a different port, run `python3 -m http.server 3001 --bind 0.0.0.0` from the repository directory. Live server processes need to be restarted after a cloud environment is restored.

On Windows, run `py -3 -m http.server 3000 --bind 0.0.0.0` from the game folder. Once deployed on GitHub Pages, no local server needs to keep running.

## Play on one device

1. Choose a scenario and optionally enter a player or team name.
2. Start the round. Put the cards in order by dragging with a mouse or using the up/down buttons with touch or keyboard.
3. Check the flow to receive a score and see the intended answer.
4. Change the name and choose **Play again** for the next player or team.

Each correct position earns an equal share of 100 points, rounded to the nearest whole number. For nine steps, seven correct positions score 78. Elapsed time breaks leaderboard ties. Local play has no time limit. Shared events expire after seven days. Reset abandons an unfinished round; if a shared submission was sent but its response was lost, retry it to retrieve the recorded result before starting again.

The default sequence is:

1. Schedule a medical appointment.
2. Arrive at the clinic and complete registration or check-in.
3. Wait in the waiting room for your appointment with the doctor.
4. See the doctor, who identifies the need for further tests.
5. Receive an X-ray referral from the doctor.
6. Book a date and time for the X-ray.
7. Attend the X-ray appointment.
8. Have the X-ray taken.
9. The doctor evaluates the X-ray results, confirms the diagnosis, and prescribes therapy.

## Customize

Use **Add your scenario** before the round to enter a title, description, and 3–12 distinct steps in the intended order. The game shuffles them for players. Scenarios and the best eight rounds per scenario are saved in this browser's local storage. If storage is unavailable, play continues in memory with a notice. Reloading the page abandons an unfinished round.

To share a custom scenario across devices, prepare it locally, choose **Host event**, sign in, then select that scenario when creating the event. The shared copy is stored on the server and cannot be edited mid-event. Players use the invite link without an account. Each event has its own top 20 rounds; local practice keeps its separate best eight rounds in browser storage. Names are display labels rather than verified identities, and repeat attempts appear separately.

## Validate

```sh
npm test
```

The Node tests cover game logic, Supabase requests and public-key validation, and static deployment output. `npm run test:db` uses Docker to run database permission and scoring tests against an isolated PostgreSQL container; it does not modify the hosted project. Browser checks during development exercise local and shared gameplay, reordering, submission retry, answer reveal, host controls, and responsive layouts. Python Playwright and Chromium are validation tools, not app dependencies. Live project checks require the dashboard setup in HOSTING.md.

With the local server running on port 3000, `python3 tests/browser_shared.py` runs the two-browser gameplay and connection-retry checks using simulated Supabase responses. It needs Python Playwright and `/usr/bin/chromium` in the prepared cloud environment. These tests never send scores to your real project.

Run `npm run build` to generate `dist/` with only the public website files. The GitHub Pages workflow tests and builds the site on pushes to `main`. It requires GitHub Pages source set to **GitHub Actions**. Database scripts, tests, and repository metadata are excluded from the published site. Only a browser-safe publishable or anon key belongs in `config.json`; never use a secret or service-role key.
