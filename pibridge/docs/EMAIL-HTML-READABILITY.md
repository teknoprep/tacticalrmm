# Email HTML readability (mandatory)

**Problem:** Many email clients (and some portals) strip `background` / gradients.
White or light text on a navy/gradient header becomes **invisible** on a white page.

**Rule for every `send_email` HTML body (internal manuals, quotes, reports):**

- Body text: dark `#24292f` / `#1a1a1a` / `#333` on light `#ffffff` / `#f4f6f9` / `#f0f2f5`
- Headings: dark blue `#1a3c6e` on **white** (not white text on navy)
- Prefer a light header bar with dark-blue title over white-on-navy heroes
- If a `<th>` has `background-color:#1a3c6e`, it must also have `color:#ffffff` on the **same** `<th>`
- Never rely on gradient backgrounds for contrast
- Plain-text `body` must be fully readable alone

Enforced in product prompts: `server.js` → `EMAIL HTML READABILITY` in `DEFAULT_DECISION_POLICY`,
and `send_email` tool descriptions in `tools.js`.
