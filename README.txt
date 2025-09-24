Refactor output for database.js

- Source length: 81611 bytes
- Removed duplicate function bytes: 476 bytes
- Total output files: 12

Suggested <script> inclusion order (non-module):
  1) cache-status.js
  1) cart.js
  1) categorize.js
  1) core-constants-and-helpers.js
  1) filters-search.js
  1) init-gapi.js
  1) persistence.js
  1) recompute-paint-safely-after-adding-windowrows.js
  1) render-table.js
  1) sheets-helpers.js
  1) ui-loading.js
  1) ui-utils.js

Notes:
- We deduplicated functions/consts by keeping the first declaration of each name and dropping later duplicates.
- Sections were split based on the big header comments (==== style). Content that appeared before the first header
  was placed in core-constants-and-helpers.js.
- You can concatenate these files in the order above (or convert them to ES modules) to preserve behavior.
- If anything is missing, it likely lived outside a recognized header; check 'core-constants-and-helpers.js' and 'misc' files.
