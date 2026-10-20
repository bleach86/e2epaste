import { base64Decode, base64Encode } from "../text.mjs";
import { bindConverter, bindCopyAndClear } from "../common.mjs";

bindConverter("encode", base64Encode);
bindConverter("decode", base64Decode);
bindCopyAndClear();
