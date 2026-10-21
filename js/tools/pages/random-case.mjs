import { randomCase } from "../text.mjs";
import { bindConverter, bindCopyAndClear } from "../common.mjs";

const rerun = bindConverter("random", randomCase);
document.getElementById("rerandomize").addEventListener("click", rerun);
bindCopyAndClear();
