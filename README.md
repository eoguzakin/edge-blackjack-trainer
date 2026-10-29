# Edge — Blackjack Trainer

A blackjack and card-counting trainer with saved wallets and invite-only friend tables. Practice chips have no monetary value.

Use Node 24 and the pinned pnpm version. Run `pnpm install`, then `pnpm dev` and open http://127.0.0.1:4173. The local server applies migrations to `.local-data/blackjack.sqlite`; it never touches production data. `pnpm test` runs the rule and API checks. `pnpm build` bundles the Worker and copies the client and migration assets into `dist` for Sites.

## Training

- **One-screen practice:** the casino table stays in place, with running and true counts visible above it. Hide/show and count checks work directly on the table. Choose Solo or Full table with four simulated players, including doubles and splits. Hints, dealing pace, results, and rules live under Table options.
- **Counting drills:** an inline panel with 10, 20, or 40 cards, three speeds, pause/resume, final-count checks, and card review. Opening it preserves the current hand; returning to play pauses the drill.
- **How to count:** a short inline Hi-Lo guide and four optional knowledge checks, replacing separate lesson pages.
- **Music:** an optional, original 53-second lounge loop with electric piano, bass, and brushed percussion, rendered with Web Audio and a seamless wrapped reverb tail. Music starts only after a click. Volume is remembered on this device; no external music service or audio download is needed.

## Saved chips and friends

Guest wallets and unfinished solo hands are saved in D1, identified by an HttpOnly, SameSite cookie that persists for one year. Clearing that cookie loses access to an unregistered guest wallet. Creating a username/password account upgrades the current wallet without replacing its chips. Signing in restores that account's saved game on another device. Only audio preferences use local storage. Playing and saving require an internet connection; “solo” does not mean disconnected play.

Chip buttons add 1, 5, 10, 25, 100, or 500 to a wager. The amount can also be entered directly, cleared, undone, or set to the available whole-chip maximum. Whole-chip wagers have no fixed ceiling beyond the wallet. Blackjack payouts retain half chips. Bots have independent bankrolls, vary their wagers between rounds, and can double or split only when they can cover the extra stake. Switching table modes or choosing a fresh shoe preserves the user's chips. An explicit 1,000-chip practice refill is available only below one chip, outside a friend room.

Friends opens a compact account/table panel. A signed-in host chooses a minimum bet and gets a random 8-character invitation code and shareable link. Up to five accounts can join. Each player marks their wager ready; the host deals when at least two are ready. Unready players sit out that round. New arrivals during a round join the next hand. Turns expire after 60 seconds and automatically stand; the next authenticated poll advances overdue turns after a disconnection. A leaving host transfers hosting to the next player. Leave between hands to return the same balance to solo play. Reopening the browser restores the active room.

Friend invitations work when the Site's sharing settings permit the visitor to open the app. Each wallet requires its session; room state requires membership. An invitation code grants a seat, not access to another user's account. Passwords use salted scrypt (N=32768, r=8, p=3), with rate limits on authentication and joins. There is no self-service password recovery; the owner can reset a password through user management. Accounts intentionally collect no email address. Sessions expire after one year and sign-out revokes the current session. References: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt), [noble-hashes](https://github.com/paulmillr/noble-hashes).

The server owns cards, actions, payouts, and balances. D1 revision checks plus an assertion constraint in atomic batches roll back stale writes across rooms and wallets. Request IDs prevent immediate duplicate actions from charging twice. The server never sends the shoe or an unrevealed hole card. Clients poll friend tables every 1.5 seconds while visible; frames animate consecutive updates, while reconnects restore the latest authoritative snapshot. A failed save cannot silently become an unsaved local game.

API bodies are streamed with an 8 KiB byte limit before JSON decoding. A bounded in-memory guard admits at most 2,400 API requests per minute per Worker isolate, 600 per client IP, and 120 snapshot requests per session. Both snapshot routes also share a database-backed allowance of 120 reads per account per minute across sessions and isolates. These limits allow normal friend-table polling. Unchanged polls use authenticated revision tags; expired turns still advance, and revoked sessions still fail. Initial solo shoes are saved once. Saturated database counters stop writing, and the browser respects retry delays.

These application controls reduce resource abuse; they do not impose a global hosting or monetary ceiling. Per-isolate memory is not shared between Worker instances. Keep the Site's access restricted to the intended audience, and configure any available provider usage alerts, quotas, and spending limits separately before opening it more widely.

Game sounds are original Web Audio effects: a short, low-volume paper contact, chip clicks, and win/loss/push cues. They are independently optional and have a volume control. Cards slide from the shoe and turn face up, with reduced-motion support. The dealer cutout and whole-image shaking have been removed. Traditional illustrated card faces and backs are [Adrian Kennard's CC0 SVG deck](https://www.me.uk/cards/), served locally with source and license notes in `web/assets/cards`.

The table uses the available viewport height with a reserved action area so betting, Hit, Stand, Double, and Split stay visible without scrolling between hands. Full tables, friend tables, and split hands use the same responsive surface. Additional practice tools remain below the table.

## Owner user management

The owner opens **Manage users** from the account menu, or visits `/admin.html` and signs in with the existing owner account. The server environment variable `ADMIN_ACCOUNT_ID` grants access to one immutable account ID; there is no client-side role switch or username-based grant. Without that variable all management APIs deny access. The owner's username can change without transferring or losing privileges. For local development, explicitly set `ADMIN_ACCOUNT_ID` to a disposable local account ID before `pnpm dev`.

The panel searches and paginates registered and guest accounts. It can change usernames, set credits in half-chip increments, and set a new password. Existing passwords and hashes are never sent to the browser. Converting a guest requires both a username and password. Password resets atomically revoke every session for that account, including the current session on a self-reset. Login checks that the verified password hash is still current before creating a session.

Credits can change only between hands. Friend-table edits update the account and room together, clear the affected player's readiness, and discard stale animation frames. Revision checks reject concurrent edits or game actions without partially changing a wallet. Each successful edit is recorded in `admin_audit`, including before/after usernames and credits and a password-reset marker, never the password or hash. Request IDs prevent duplicate submissions. Every management endpoint checks the authenticated owner on the server; writes additionally require a same-origin JSON request and the expected owner account ID.

The owner can permanently delete any other registered or guest account with **Delete user** and one confirmation. Deletion removes the account, sessions, saved chips/game, related audit records, and account-specific rate limits together. It also removes their friend-table seats, transfers hosting, and continues or settles an affected turn while saving other players' wallets in the same transaction. Empty tables are removed. The owner account is protected from deletion. Revision checks reject conflicting changes without partial removals, and a retry after deletion cannot target a newly registered account with the same username.

For an owner locked out of the app, a Site operator can provision the secret `OWNER_RECOVERY_JOB` with a unique `recovery-<UUID>` ID, the existing `ADMIN_ACCOUNT_ID`, expected `usernameKey`, a scrypt `passwordHash`, SHA-256 `tokenHash` of a random 32-byte hexadecimal token, and an `expiresAt` timestamp within one hour. After deployment, `POST /api/maintenance/owner-recovery` with that token in `X-Owner-Recovery-Token` consumes the job atomically. The request cannot choose an account or password. The audit record prevents reuse; chips and game state stay intact, and all owner sessions are revoked. Remove the secret and redeploy immediately after recovery. The endpoint is disabled when unconfigured or expired. Never commit real recovery credentials or plaintext passwords.

## Rules

Six decks; shuffle before the next round once 75% is dealt; dealer stands on soft 17 and peeks for blackjack; natural blackjack pays 3:2. Double on any two-card hand, including after a split. Split equal values to at most four hands. Split aces get one card each and cannot be resplit; split 21 pays 1:1. No surrender or insurance. Play chips only.

The running count includes exposed cards only, including every other player's exposed cards. The table and its public state advance through deal snapshots, so cards and counts appear together. Solo dealing pauses while hidden; a reopened page recovers saved state. True count is running count divided by the exact number of undealt decks, shown to one decimal. Count checks are inline. Strategy accuracy measures the user's decisions, with S17/DAS basic strategy hints and no count-based deviations.

References: [Hi-Lo](https://wizardofodds.com/games/blackjack/card-counting/high-low/) and [4–8 deck basic strategy](https://wizardofodds.com/games/blackjack/strategy/4-decks/).

## Structure

- `web/game.js`: solo/bot blackjack engine and shared strategy/counting helpers.
- `src/friend-game.js`: human table turns, shared payouts, safe public snapshots, and persistence adapters.
- `src/worker.js`, `auth.js`, `storage.js`: authenticated API, password hashing, and transactional storage.
- `db/schema.ts`, `drizzle/`: source schema and generated, schema-only migrations. Production migrations are applied by Sites, never from request handlers.
- `web/table.js`, `session.js`, `social.js`: animations, saved game client, bets, accounts, and friend-table controls.
- `web/app.js`: inline guide, drills, and optional browser WebMCP tools.
- `web/music.js`, `sounds.js`: optional original lounge music and game sound effects.
- `web/*.css`: responsive casino table, cards, simplified controls, dialogs, and reduced-motion support.
- `tests/game.test.mjs`: payout, rule, counting, strategy, and seeded simulation checks.
- `tests/multiplayer.test.mjs`: turn order, guest doubles/splits, snapshot counts, independent bankrolls, and 1,000 seeded full-table rounds.
- `tests/persistence.test.mjs`: reloads, account login, invitations, wallet transfers, race/duplicate actions, turn timeouts, and 500 seeded human-table rounds.
- `src/admin.js`, `web/admin.html`, `web/admin.js`, `web/admin.css`: owner-only account editing and audit history.
- `tests/admin.test.mjs`: owner authorization, safe account projections, credit and name validation, atomic friend edits, concurrent changes, session revocation, login/reset races, guest conversion, and pagination.
- `src/admission.js`, `tests/security-resources.test.mjs`: bounded ingress, streaming body limits, shared quotas, denied-write controls, conditional polling, timeouts, and browser retry behavior.

H/S/D/P are table shortcuts; Enter deals when no control is focused. Native keyboard interaction works on every button and form. Optional WebMCP tools expose public training status and navigation, excluding hidden cards/counts.
