# Xland world — working rules

- This repo is the live xland.world. Every push to `main` is built and deployed by Cloudflare Workers Builds.
- Edit `src/`, then run `node tools/build.mjs` and commit `dist/index.html` with the change.
- Game rules, economy and the API must not change as a side effect of UI work. Before pushing, run the local server (`node test/dev-server.mjs`) and check `#/tests`: all rule tests must pass.
- The emblems and ornaments in `src/sprite.svg` are hand-drawn and approved by the founder. Regenerate only with `tools/build-sprite.sh`; never redraw them.
- `wrangler.toml` has no routes on purpose: the xland.world domain and the `ADMIN_KEY` secret live in the Cloudflare dashboard.
- The House on the River (Aquax, parcel AQX-01) is the founder's: keep it tiny and unobtrusive. It is eternal: no code may ever sell, transfer, tax, divide or reassign it, and the server refuses any claim on it.
- Founder decisions on population (21,000,000 in five stages, shares per territory, Xasteland at 90% of open homes), shop costs per territory and the QuarX daily sale limit live in `POP`, `SHOP_TERR` (index.html) and `SHOPS` (worker.js). Change them only on the founder's word.
- Since r52 the server holds every citizen's official wallet (`xl_wallets`, `xl_ledger` in worker.js). The page only proposes operations through its outbox; value may enter a wallet only through `walletPropose` rules or a server endpoint that credits it (seams, harvests, the order book, the sandbox mint). Any new feature that gives citizens value must add its server rule, or the server will refuse it and the page will be aligned back.
