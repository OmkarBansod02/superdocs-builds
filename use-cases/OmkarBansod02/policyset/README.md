# PolicySet

Synchronized four-document policy-set editor for a fictional physical-goods store (Northstar Goods).

PolicySet owns canonical facts and consistency. SuperDocs will later own document editing, review, and export.

## Documents

- Terms of Service
- Privacy Policy
- Warranty Policy
- Returns Policy

## Run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The intake form is prefilled with Northstar Goods. Click **Generate Policy Set** to open the four-document workspace.

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

## SuperDocs

Server-side adapter exists from Phase 2. Phase 3 does not call SuperDocs from the browser.
