// /share/<id> (bot_filter.html.j2): link previews don't run JS, so only real
// browsers get forwarded to the paste, keeping the key in the hash.

import { readPageData } from "../ui.mjs";

const { paste_id: pasteId } = readPageData();

// replace() keeps /share/ out of history, so Back doesn't bounce forward again.
window.location.replace(`/paste/${pasteId}${window.location.hash}`);
