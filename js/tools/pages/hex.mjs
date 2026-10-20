import { hexDecode, hexEncode } from "../text.mjs";
import { bindConverter, bindCopyAndClear } from "../common.mjs";

bindConverter("encode", hexEncode);
bindConverter("decode", hexDecode);
bindCopyAndClear();
