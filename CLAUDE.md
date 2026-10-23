# Xland world — working rules

- This repo is the live xland.world. Every push to `main` is built and deployed by Cloudflare Workers Builds.
- Edit `src/`, then run `node tools/build.mjs` and commit `dist/index.html` with the change.
- Game rules, economy and the API must not change as a side effect of UI work. Before pushing, run the local server (`node test/dev-server.mjs`) and check `#/tests`: all rule tests must pass.
- The emblems and ornaments in `src/sprite.svg` are hand-drawn and approved by the founder. Regenerate only with `tools/build-sprite.sh`; never redraw them.
- `wrangler.toml` has no routes on purpose: the xland.world domain and the `ADMIN_KEY` secret live in the Cloudflare dashboard.
- The House on the River (Aquax) is the founder's: keep it tiny and unobtrusive.
