# BlueCloud brand (www.blueuc.com)

Source of truth for Pi.dev outbound HTML (emails, quotation Terms).

| Token | Hex | Notes |
|---|---|---|
| primary | `#00C4FF` | Site `--o-color-1` / `--primary` |
| primaryDark | `#007294` | Borders / links |
| text | `#212529` | On primary buttons + body |
| dark | `#1B1319` | Titles |
| light | `#F6F5F4` | Soft panels / alt rows |
| white | `#FFFFFF` | Cards |
| page | `#F0F2F5` | Outer email bg |
| border | `#dee2e6` | Hairlines |

**Logo (light backgrounds):**  
`https://www.blueuc.com/web/image/1330-24f164ad/blue_cloud_logo_A.png`

**Rules:** Dark text on light backgrounds. Never white-on-navy heroes. Table headers = cyan bg + dark text (readable if bg strips).

**Code:** `bridge/src/brand.js` → injected into decision policy via `brandEmailPolicy()`.  
Sales fallback HTML uses the same hex tokens in `ai_sales_code` (`const BC = {...}`).
