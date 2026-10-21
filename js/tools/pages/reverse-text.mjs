import { reverseText } from "../text.mjs";
import { bindConverter, bindCopyAndClear } from "../common.mjs";

bindConverter("reverse", reverseText);
bindCopyAndClear();
