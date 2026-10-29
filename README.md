# Flow State

A browser game for an event: read a scenario, arrange shuffled steps, and check the sequence. The included patient journey uses the nine steps supplied by the event organiser.

## Run

Requires Node.js 20+ (for npm commands and tests), Python 3, and a modern browser. There are no third-party packages, API keys, databases, or build steps.

```sh
cd matching-game
npm start
```

Run these commands from the parent folder of your checkout. In the prepared cloud environment, the checkout is at `/workspace/matching-game`. This serves the app on port 3000. Stop it with Ctrl+C. To use a different port, run `python3 -m http.server 3001 --bind 0.0.0.0` from the repository directory. Live server processes need to be restarted after a cloud environment is restored.

## Play at an event

1. Choose a scenario and optionally enter a player or team name.
2. Start the round. Put the cards in order by dragging with a mouse or using the up/down buttons with touch or keyboard.
3. Check the flow to receive a score and see the intended answer.
4. Change the name and choose **Play again** for the next player or team.

Each correct position earns an equal share of 100 points, rounded to the nearest whole number. For nine steps, seven correct positions score 78. Elapsed time breaks leaderboard ties; there is no time limit. Reset discards an unfinished round without recording a score.

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

For a shared-device event, prepare the scenarios in the same browser used by players. This prototype has no accounts, host authentication, synchronized multiplayer, or shared leaderboard. Custom scenarios on one device do not appear on another. For scenarios included on every device, update `SAMPLE_SCENARIOS` in `game-core.mjs` before hosting the static site.

## Validate

```sh
npm test
```

The six Node tests cover shuffling, scoring, nine-step rounding, movement, the diagnosis data, and input validation. Browser checks during development also exercised dragging, arrow controls, submission, answer reveal, timer/reset, persistence, custom scenarios, and responsive layouts in Chromium. Browser checks require Python Playwright and system Chromium; these are validation tools, not app dependencies.

The application is plain HTML, CSS, and JavaScript modules. `index.html`, `styles.css`, `app.mjs`, and `game-core.mjs` can be hosted together on a static host; no public deployment has been made.
