import { binaryDecode, binaryEncode } from "../text.mjs";
import { bindConverter, bindCopyAndClear } from "../common.mjs";

bindConverter("encode", binaryEncode);
bindConverter("decode", binaryDecode);
bindCopyAndClear();
